import { AppError } from './errors';
import { MAX_ATTACHMENT_BYTES, type AttachmentKind, type SpreadsheetWorkbook } from '../shared/types';
import { analyzeSpreadsheet } from './spreadsheets';

/**
 * Recebimento de anexos: o que é aceito, como é reconhecido e como vira texto.
 *
 * **O tipo é lido dos bytes, não do nome nem do `Content-Type`.** Os dois vêm
 * do navegador, e o navegador repete o que o usuário mandar; um `.png` que na
 * verdade é HTML seria servido de volta como imagem e viraria XSS na origem do
 * app. A assinatura no começo do arquivo é a única fonte que não depende de
 * quem envia.
 *
 * Só entram formatos que têm para onde ir: imagens que os modelos com visão
 * aceitam, e documentos de onde se extrai texto. Um `.docx` seria possível
 * (é um zip com XML), mas exigiria descompactar entrada hostil — fica de fora
 * enquanto não houver necessidade real.
 */

export interface AttachmentAnalysis {
  readonly kind: AttachmentKind;
  readonly mime: string;
  /** Texto para o prompt. Vazio em imagem, que vai como imagem. */
  readonly text: string;
  readonly truncated: boolean;
  readonly workbook?: SpreadsheetWorkbook;
}

/**
 * Teto do texto extraído.
 *
 * Não é o limite do modelo — o aparo por janela de contexto já existe em
 * context.ts. É o limite do que vale a pena guardar por anexo: um PDF de mil
 * páginas encheria a linha do banco para depois ser aparado de qualquer jeito.
 */
const MAX_TEXT_CHARS = 120_000;

interface Assinatura {
  readonly mime: string;
  readonly kind: AttachmentKind;
  readonly bytes: readonly number[];
  /** Deslocamento da assinatura; WebP identifica no 8, não no 0. */
  readonly offset?: number;
}

const ASSINATURAS: readonly Assinatura[] = [
  { mime: 'image/png', kind: 'image', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', kind: 'image', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', kind: 'image', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', kind: 'image', bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  { mime: 'application/pdf', kind: 'document', bytes: [0x25, 0x50, 0x44, 0x46] },
];

function combina(dados: Buffer, assinatura: Assinatura): boolean {
  const inicio = assinatura.offset ?? 0;
  if (dados.length < inicio + assinatura.bytes.length) return false;
  return assinatura.bytes.every((byte, indice) => dados[inicio + indice] === byte);
}

/**
 * Texto puro é reconhecido pela ausência de bytes de controle, não por
 * assinatura — ele não tem uma. A verificação é conservadora: qualquer byte
 * nulo ou de controle fora de tabulação e quebra de linha reprova o arquivo.
 */
function pareceTexto(dados: Buffer): boolean {
  const amostra = dados.subarray(0, 8192);
  if (amostra.length === 0) return false;
  for (const byte of amostra) {
    if (byte === 0) return false;
    if (byte < 0x09) return false;
    if (byte > 0x0d && byte < 0x20) return false;
  }
  // UTF-8 inválido também reprova: o conteúdo iria para o prompt como
  // caracteres de substituição, sem significado nenhum.
  const texto = new TextDecoder('utf-8', { fatal: false }).decode(amostra);
  return !texto.includes('�');
}

function limitar(texto: string): { text: string; truncated: boolean } {
  const limpo = texto
    // Escape explícito: o NUL literal no fonte é invisível em diff e em
    // revisão. Os demais controles vêm de extração de PDF, não significam nada
    // no prompt e gastam token; tabulação e quebra de linha ficam.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
    // PDF costuma render dezenas de linhas vazias entre blocos de texto.
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  if (limpo.length <= MAX_TEXT_CHARS) return { text: limpo, truncated: false };
  return { text: limpo.slice(0, MAX_TEXT_CHARS), truncated: true };
}

async function extrairPdf(dados: Buffer): Promise<string> {
  // Importado sob demanda: o `unpdf` carrega o pdf.js inteiro, e uma
  // requisição que não tem PDF não deve pagar por isso.
  const { extractText, getDocumentProxy } = await import('unpdf');
  const documento = await getDocumentProxy(new Uint8Array(dados));
  const { text } = await extractText(documento, { mergePages: true });
  return Array.isArray(text) ? text.join('\n\n') : text;
}

export function decodeAttachment(base64: string): Buffer {
  // `base64` do Node ignora caracteres inválidos em vez de recusar, então o
  // tamanho decodificado é a única prova de que veio algo utilizável.
  const dados = Buffer.from(base64, 'base64');
  if (dados.length === 0) {
    throw new AppError('UNKNOWN', { status: 400, message: 'O arquivo chegou vazio ou em formato inválido.' });
  }
  if (dados.length > MAX_ATTACHMENT_BYTES) {
    const limite = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));
    throw new AppError('UNKNOWN', { status: 400, message: `Cada arquivo pode ter até ${limite} MB.` });
  }
  return dados;
}

/**
 * Reconhece o arquivo e, se for documento, extrai o texto.
 *
 * Falha de extração NÃO derruba o envio: o anexo entra com texto vazio e a
 * interface diz que nada foi lido. Um PDF só de imagens digitalizadas é o caso
 * comum, e recusá-lo faria o usuário achar que o arquivo está corrompido.
 */
export async function analyzeAttachment(dados: Buffer, filename: string): Promise<AttachmentAnalysis> {
  // XLSX não é "um ZIP qualquer": spreadsheets.ts exige as entradas internas
  // do formato antes de entregar o conteúdo ao parser.
  const xlsx = await analyzeSpreadsheet(dados, filename, null);
  if (xlsx) return { kind: 'spreadsheet', mime: xlsx.mime, text: '', truncated: false, workbook: xlsx.workbook };

  const assinatura = ASSINATURAS.find((candidata) => combina(dados, candidata));

  if (assinatura?.kind === 'image') {
    return { kind: 'image', mime: assinatura.mime, text: '', truncated: false };
  }

  if (assinatura?.mime === 'application/pdf') {
    try {
      const bruto = await extrairPdf(dados);
      const { text, truncated } = limitar(bruto);
      return { kind: 'document', mime: 'application/pdf', text, truncated };
    } catch {
      return { kind: 'document', mime: 'application/pdf', text: '', truncated: false };
    }
  }

  if (pareceTexto(dados)) {
    const { text, truncated } = limitar(dados.toString('utf8'));
    const csv = await analyzeSpreadsheet(dados, filename, text);
    if (csv) return { kind: 'spreadsheet', mime: csv.mime, text: '', truncated, workbook: csv.workbook };
    return { kind: 'document', mime: 'text/plain', text, truncated };
  }

  throw new AppError('UNKNOWN', {
    status: 400,
    message: `Não sei ler "${filename}". Aceito imagens (PNG, JPEG, GIF, WebP), PDF, XLSX, CSV e arquivos de texto.`,
  });
}

/**
 * Bloco que representa o documento dentro do prompt.
 *
 * O nome do arquivo entra junto porque o usuário se refere a ele por nome
 * ("resume o segundo anexo"), e o modelo não teria como saber qual é qual.
 * A cerca marca onde o documento começa e termina: sem ela, um arquivo que
 * contenha instruções se confunde com o pedido de quem está conversando.
 */
export function documentPromptBlock(filename: string, text: string, truncated: boolean): string {
  if (!text.trim()) {
    return `[Anexo "${filename}": não foi possível extrair texto — o arquivo pode ser digitalizado ou conter apenas imagens.]`;
  }
  const aviso = truncated ? '\n[…documento cortado por tamanho…]' : '';
  return `<<<ANEXO "${filename}">>>\n${text}${aviso}\n<<<FIM DO ANEXO>>>`;
}

/** Data URI para o formato de conteúdo com imagem dos provedores. */
export function imageDataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}
