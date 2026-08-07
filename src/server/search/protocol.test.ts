import { describe, expect, it } from 'vitest';
import { createSearchScanner } from './protocol';

/** Junta o texto emitido, para comparar o que chegaria ao usuário. */
function textoDe(eventos: ReturnType<ReturnType<typeof createSearchScanner>['push']>): string {
  return eventos.filter((evento) => evento.kind === 'text').map((evento) => evento.text).join('');
}

describe('detector do marcador de busca', () => {
  it('passa texto sem marcador adiante', () => {
    const scanner = createSearchScanner();
    expect(textoDe(scanner.push('olá, tudo bem?'))).toBe('olá, tudo bem?');
  });

  it('extrai a consulta e não deixa o marcador vazar para o texto', () => {
    const scanner = createSearchScanner();
    const eventos = scanner.push('Vou verificar. <search>preço do café hoje</search>');
    expect(textoDe(eventos)).toBe('Vou verificar. ');
    expect(eventos.filter((e) => e.kind === 'search')).toEqual([
      { kind: 'search', query: 'preço do café hoje' },
    ]);
  });

  it('reconstrói o marcador partido entre vários chunks do SSE', () => {
    // É o caso real: o provedor manda token a token, e o marcador chega
    // picado. Sem segurar o sufixo, "<sea" iria para a tela.
    const scanner = createSearchScanner();
    const pedacos = ['antes ', '<sea', 'rch>', 'dólar ', 'hoje', '</sea', 'rch>', ' depois'];
    const eventos = pedacos.flatMap((pedaco) => scanner.push(pedaco));
    expect(textoDe(eventos)).toBe('antes  depois');
    expect(eventos.filter((e) => e.kind === 'search')).toEqual([
      { kind: 'search', query: 'dólar hoje' },
    ]);
  });

  it('não emite nada enquanto o marcador está aberto e sem fechamento', () => {
    const scanner = createSearchScanner();
    const eventos = scanner.push('texto <search>consulta em anda');
    expect(textoDe(eventos)).toBe('texto ');
    expect(eventos.some((e) => e.kind === 'search')).toBe(false);
  });

  it('devolve como texto um marcador que nunca fecha', () => {
    const scanner = createSearchScanner();
    scanner.push('<search>consulta sem fim');
    expect(textoDe(scanner.end())).toBe('<search>consulta sem fim');
  });

  it('não interrompe o round por consulta vazia', () => {
    // Marcador vazio é escorregão do modelo. Tratar como busca gastaria um
    // round e uma chamada ao buscador para pesquisar nada.
    const scanner = createSearchScanner();
    const eventos = scanner.push('<search>   </search> segue');
    expect(eventos.some((e) => e.kind === 'search')).toBe(false);
    expect(textoDe(eventos)).toBe('<search></search> segue');
  });

  it('desiste de segurar o stream quando o marcador aberto passa do limite', () => {
    // Sem esta válvula, um modelo que emite "<search>" e continua escrevendo
    // para sempre deixaria a tela congelada até o fim do turno.
    const scanner = createSearchScanner();
    const eventos = scanner.push(`<search>${'x'.repeat(600)}`);
    expect(textoDe(eventos)).toContain('<search>xxx');
  });

  it('encontra dois marcadores no mesmo chunk', () => {
    const scanner = createSearchScanner();
    const eventos = scanner.push('<search>um</search> meio <search>dois</search>');
    expect(eventos.filter((e) => e.kind === 'search').map((e) => (e as { query: string }).query)).toEqual(['um', 'dois']);
    expect(textoDe(eventos)).toBe(' meio ');
  });
});
