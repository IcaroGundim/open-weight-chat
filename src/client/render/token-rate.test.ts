import { describe, expect, it } from 'vitest';
import { finalRate, gaugeArc, liveRate, needleAngle, scaleFor, trimSamples } from './token-rate';

describe('velocidade ao vivo', () => {
  it('mede pela janela deslizante, não pela média desde o início', () => {
    // Um modelo que raciocinou 20s e depois escreveu rápido marcaria uma
    // velocidade baixa por muito tempo se a média fosse desde o começo.
    const amostras = [
      { at: 0, chars: 0 },
      { at: 20_000, chars: 0 },      // 20s pensando, nada escrito
      { at: 21_000, chars: 400 },
      { at: 22_000, chars: 800 },
    ];
    const taxa = liveRate(amostras, 22_000)!;
    // 800 caracteres em 2s = 200 tokens em 2s = 100 tok/s. A média desde o
    // início daria 9 tok/s, escondendo o que está acontecendo agora.
    expect(taxa).toBeCloseTo(100, 0);
  });

  it('não inventa número com amostra de menos', () => {
    expect(liveRate([], 0)).toBeNull();
    expect(liveRate([{ at: 0, chars: 0 }], 0)).toBeNull();
  });

  it('não reporta rajada como velocidade', () => {
    // Dois chunks juntos no primeiro décimo de segundo dariam "300 tok/s".
    expect(liveRate([{ at: 0, chars: 0 }, { at: 80, chars: 400 }], 80)).toBeNull();
  });

  it('devolve null quando nada chegou na janela', () => {
    expect(liveRate([{ at: 0, chars: 500 }, { at: 4_000, chars: 500 }], 4_000)).toBeNull();
  });

  it('descarta amostras velhas mas guarda a base do intervalo', () => {
    const amostras = Array.from({ length: 40 }, (_, i) => ({ at: i * 500, chars: i * 100 }));
    const cortado = trimSamples(amostras, 19_500);
    expect(cortado.length).toBeLessThan(amostras.length);
    // A base precisa sobreviver, senão o intervalo começa no meio da janela.
    expect(cortado[0].at).toBeLessThanOrEqual(19_500 - 3_000 * 2);
  });
});

describe('velocidade final', () => {
  it('usa os tokens que o provedor reportou', () => {
    expect(finalRate(300, 6_000)).toBeCloseTo(50, 5);
  });

  it('recusa medida sem base', () => {
    expect(finalRate(0, 5_000)).toBeNull();
    expect(finalRate(300, 100)).toBeNull();
  });
});

describe('escala', () => {
  it('sobe em degraus conforme a velocidade', () => {
    // Escala fixa não serve: local faz 15 tok/s, endpoint rápido passa de 200.
    expect(scaleFor(12)).toBe(25);
    expect(scaleFor(80)).toBe(100);
    expect(scaleFor(350)).toBe(400);
  });

  it('nunca desce durante o turno', () => {
    // Se descesse, o ponteiro andaria para trás com velocidade constante.
    expect(scaleFor(10, 200)).toBe(200);
  });

  it('satura no último degrau em vez de estourar', () => {
    expect(scaleFor(5_000)).toBe(800);
  });
});

describe('ponteiro', () => {
  it('vai de -120° a +120° ao longo da escala', () => {
    expect(needleAngle(0, 100)).toBe(-120);
    expect(needleAngle(50, 100)).toBe(0);
    expect(needleAngle(100, 100)).toBe(120);
  });

  it('não passa dos limites do arco', () => {
    expect(needleAngle(500, 100)).toBe(120);
    expect(needleAngle(-5, 100)).toBe(-120);
  });

  it('o arco é um caminho SVG válido', () => {
    expect(gaugeArc(30, 30, 22, -120, 120)).toMatch(/^M [\d.-]+ [\d.-]+ A 22 22 0 [01] 1 [\d.-]+ [\d.-]+$/u);
  });
});
