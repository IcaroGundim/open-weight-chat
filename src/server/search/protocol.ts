/**
 * Protocolo de busca: marcador no próprio stream, como os artefatos.
 *
 * A alternativa óbvia seria o `tools` da OpenAI. Ela foi descartada pela mesma
 * razão que `effort.ts` documenta sobre os parâmetros de raciocínio: "OpenAI-
 * compatible" para de valer exatamente nos extras. Suporte a tool calling
 * varia por provedor e por modelo, vários endpoints BYOK devolvem 400 diante
 * do campo, e alguns aceitam o campo mas nunca emitem uma chamada. Como a
 * premissa do produto é que o usuário aponta para QUALQUER endpoint
 * compatível, um recurso que só funciona na metade do catálogo não serve.
 *
 * Um marcador em texto funciona em todo modelo que sabe seguir instrução — o
 * mesmo terreno em que os artefatos já se apoiam neste projeto.
 *
 * O detector roda ANTES do parser de artefatos: uma busca interrompe o round,
 * e o parser de artefatos não tem — nem deveria ter — noção de interrupção.
 */

const OPEN = '<search>';
const CLOSE = '</search>';
const MAX_QUERY_LENGTH = 400;

export type SearchScannerEvent =
  | { kind: 'text'; text: string }
  | { kind: 'search'; query: string };

/**
 * Quantos caracteres do fim do buffer podem ser o começo do marcador.
 *
 * É a mesma técnica de `suffixThatCanStart` no parser de artefatos, e existe
 * pelo mesmo motivo: o marcador chega picado em vários chunks do SSE. Emitir
 * o texto sem segurar esse sufixo mandaria "<sea" para a tela e depois
 * deixaria "rch>" órfão.
 */
function suffixThatCanStart(value: string): number {
  const max = Math.min(value.length, OPEN.length);
  for (let length = max; length > 0; length -= 1) {
    if (OPEN.startsWith(value.slice(-length))) return length;
  }
  return 0;
}

export interface SearchScanner {
  push(chunk: string): SearchScannerEvent[];
  /** Descarta um marcador incompleto: fim de stream com `<search` pela metade. */
  end(): SearchScannerEvent[];
}

/**
 * Scanner que não procura nada: entrega o texto como veio.
 *
 * Existe porque procurar `<search>` sem ter busca externa configurada só pode
 * dar falso positivo. O marcador é uma convenção que este servidor **pede** ao
 * modelo no prompt; sem esse pedido, um `<search>` no texto é o modelo
 * *falando sobre* buscar — e a falha concreta que motivou isto: com a busca
 * nativa da OpenRouter ligada, o modelo escreveu "eu usaria
 * `<search>preço do café</search>`, mas já tenho a resposta", e o scanner
 * cortou a mensagem ali, jogou fora o resto e ainda colou um "Limite de 3
 * buscas por resposta atingido" que não fazia sentido nenhum.
 *
 * Vale também para quem não configurou busca alguma, que é o caso mais comum:
 * antes disto, qualquer resposta que mencionasse o marcador era truncada.
 */
export function createPassthroughScanner(): SearchScanner {
  return {
    push: (chunk) => (chunk ? [{ kind: 'text', text: chunk }] : []),
    end: () => [],
  };
}

export function createSearchScanner(): SearchScanner {
  let buffer = '';

  const drenar = (events: SearchScannerEvent[]): boolean => {
    const abertura = buffer.indexOf(OPEN);
    if (abertura < 0) {
      const reter = suffixThatCanStart(buffer);
      const texto = buffer.slice(0, buffer.length - reter);
      if (texto) events.push({ kind: 'text', text: texto });
      buffer = buffer.slice(buffer.length - reter);
      return false;
    }

    const fechamento = buffer.indexOf(CLOSE, abertura + OPEN.length);
    // Abriu mas ainda não fechou: segura tudo a partir da abertura. O texto
    // anterior já pode ir para a tela.
    if (fechamento < 0) {
      const texto = buffer.slice(0, abertura);
      if (texto) events.push({ kind: 'text', text: texto });
      buffer = buffer.slice(abertura);
      // Marcador aberto e sem fim à vista por tempo demais é modelo perdido:
      // devolve como texto em vez de segurar o stream indefinidamente.
      if (buffer.length > OPEN.length + MAX_QUERY_LENGTH + CLOSE.length) {
        events.push({ kind: 'text', text: buffer });
        buffer = '';
      }
      return false;
    }

    const anterior = buffer.slice(0, abertura);
    if (anterior) events.push({ kind: 'text', text: anterior });
    const consulta = buffer.slice(abertura + OPEN.length, fechamento).trim();
    buffer = buffer.slice(fechamento + CLOSE.length);
    // Consulta vazia ou absurda não vira busca: volta a ser texto, e o
    // modelo segue sem que o round seja interrompido à toa.
    if (!consulta || consulta.length > MAX_QUERY_LENGTH) {
      events.push({ kind: 'text', text: `${OPEN}${consulta}${CLOSE}` });
      return true;
    }
    events.push({ kind: 'search', query: consulta });
    return true;
  };

  return {
    push(chunk: string): SearchScannerEvent[] {
      if (!chunk) return [];
      buffer += chunk;
      const events: SearchScannerEvent[] = [];
      while (drenar(events)) {
        // `drenar` devolve true quando consumiu um marcador inteiro e pode
        // haver outro logo atrás.
      }
      return events;
    },
    end(): SearchScannerEvent[] {
      const events: SearchScannerEvent[] = [];
      if (buffer) events.push({ kind: 'text', text: buffer });
      buffer = '';
      return events;
    },
  };
}

/** Instrução injetada no sistema quando o usuário tem busca configurada. */
export function searchSystemPrompt(maxRounds: number): string {
  return [
    '## Busca na web',
    '',
    'Você pode consultar a web. Para isso, escreva exatamente:',
    '',
    '<search>os termos da consulta</search>',
    '',
    'Regras:',
    '',
    `- **Pare de escrever ao fechar o marcador.** O que vier depois dele no mesmo turno é descartado — os resultados ainda não chegaram, então qualquer resposta escrita ali seria um chute.`,
    '- Uma consulta por marcador. Escreva os termos como escreveria num buscador, não uma pergunta inteira.',
    `- Você tem no máximo ${maxRounds} ${maxRounds === 1 ? 'busca' : 'buscas'} por resposta. Use-as para o que muda com o tempo, para o que você não sabe e para o que precisa de fonte.`,
    '- **Não busque o que você já sabe.** Pergunta de raciocínio, de código ou sobre a própria conversa não precisa de web.',
    '- Depois dos resultados, cite as fontes que usou pela URL, no corpo da resposta.',
    '- Os resultados são trechos, não a página inteira. Se um trecho não sustenta a afirmação, diga que não encontrou em vez de completar de memória.',
  ].join('\n');
}
