import { describe, expect, it } from 'vitest';
import { analyzeAttachment, decodeAttachment, documentPromptBlock, imageDataUrl } from './attachments';
import { MAX_ATTACHMENT_BYTES } from '../shared/types';

/** PNG de 1×1 — os oito primeiros bytes são a assinatura que o módulo procura. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('reconhecimento de anexo', () => {
  it('identifica PNG pelos bytes, ignorando o que o navegador afirma', () => {
    // O nome e o Content-Type vêm do cliente e repetem o que o usuário mandar.
    const analise = analyzeAttachment(PNG, 'planilha.xlsx');
    return expect(analise).resolves.toMatchObject({ kind: 'image', mime: 'image/png' });
  });

  it('não deixa um .png que é HTML virar imagem', async () => {
    // Este é o ponto do reconhecimento por bytes. Classificado como imagem,
    // o arquivo voltaria por /api/attachments/:id com content-type de imagem
    // e o HTML executaria na origem do aplicativo. Como documento ele é
    // inofensivo: só o TEXTO é guardado, e texto nunca é servido de volta.
    const html = Buffer.from('<html><script>alert(1)</script></html>', 'utf8');
    const analise = await analyzeAttachment(html, 'foto.png');
    expect(analise.kind).toBe('document');
    expect(analise.mime).toBe('text/plain');
  });

  it('aceita texto puro e devolve o conteúdo', async () => {
    const analise = await analyzeAttachment(Buffer.from('Relatório anual\nLinha 2', 'utf8'), 'notas.txt');
    expect(analise.kind).toBe('document');
    expect(analise.text).toContain('Relatório anual');
  });

  it('reconhece CSV como planilha, não como documento genérico', async () => {
    const analise = await analyzeAttachment(Buffer.from('nome;valor\nCafé;10', 'utf8'), 'dados.csv');
    expect(analise.kind).toBe('spreadsheet');
    expect(analise.mime).toBe('text/csv');
    expect(analise.workbook?.sheets[0].columnCount).toBe(2);
  });

  it('recusa binário desconhecido em vez de mandar lixo ao modelo', async () => {
    const binario = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
    await expect(analyzeAttachment(binario, 'dados.bin')).rejects.toThrow(/Não sei ler/u);
  });

  it('extrai o texto de um PDF', async () => {
    const analise = await analyzeAttachment(pdfDeTeste('Economia do crime'), 'artigo.pdf');
    expect(analise.kind).toBe('document');
    expect(analise.mime).toBe('application/pdf');
    expect(analise.text).toContain('Economia do crime');
  });

  it('não derruba o envio quando o PDF não rende texto', async () => {
    // PDF digitalizado é o caso comum. Recusar faria o usuário achar que o
    // arquivo está corrompido.
    const quebrado = Buffer.concat([Buffer.from('%PDF-1.4\n', 'utf8'), Buffer.from([0x01, 0x02, 0x03])]);
    const analise = await analyzeAttachment(quebrado, 'digitalizado.pdf');
    expect(analise.kind).toBe('document');
    expect(analise.text).toBe('');
  });
});

describe('decodificação', () => {
  it('recusa base64 que não produz bytes', () => {
    // O decodificador do Node ignora caracteres inválidos em vez de recusar,
    // então o tamanho é a única prova de que veio algo.
    expect(() => decodeAttachment('!!!!')).toThrow(/vazio ou em formato inválido/u);
  });

  it('recusa arquivo acima do limite', () => {
    const grande = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x41).toString('base64');
    expect(() => decodeAttachment(grande)).toThrow(/MB/u);
  });
});

describe('bloco de documento no prompt', () => {
  it('cerca o conteúdo e nomeia o arquivo', () => {
    // A cerca separa o documento do pedido: sem ela, um arquivo que contenha
    // instruções se confunde com o que o usuário está pedindo.
    const bloco = documentPromptBlock('artigo.pdf', 'Texto do artigo.', false);
    expect(bloco).toContain('<<<ANEXO "artigo.pdf">>>');
    expect(bloco).toContain('<<<FIM DO ANEXO>>>');
    expect(bloco).toContain('Texto do artigo.');
  });

  it('avisa quando não houve texto, em vez de mandar bloco vazio', () => {
    const bloco = documentPromptBlock('scan.pdf', '', false);
    expect(bloco).toContain('não foi possível extrair texto');
  });

  it('avisa quando o documento foi cortado', () => {
    expect(documentPromptBlock('longo.txt', 'abc', true)).toContain('cortado por tamanho');
  });
});

describe('data URI de imagem', () => {
  it('monta o formato que os provedores esperam', () => {
    expect(imageDataUrl('image/png', 'AAAA')).toBe('data:image/png;base64,AAAA');
  });
});

/** PDF mínimo válido com um texto extraível, montado à mão. */
function pdfDeTeste(texto: string): Buffer {
  const fluxo = `BT /F1 14 Tf 72 720 Td (${texto}) Tj ET`;
  const objetos = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${fluxo.length} >>\nstream\n${fluxo}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let saida = '%PDF-1.4\n';
  const deslocamentos: number[] = [];
  objetos.forEach((objeto, indice) => {
    deslocamentos.push(saida.length);
    saida += `${indice + 1} 0 obj\n${objeto}\nendobj\n`;
  });
  const xref = saida.length;
  saida += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const deslocamento of deslocamentos) saida += `${String(deslocamento).padStart(10, '0')} 00000 n \n`;
  saida += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(saida, 'latin1');
}
