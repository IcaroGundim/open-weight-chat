import { useEffect, useRef, useState } from 'react';
import { Camera, Mesh, Plane, Program, Renderer, RenderTarget } from 'ogl';

/**
 * Fundo de ondas cromáticas do cartão de artefato.
 *
 * Adaptado do "Chromatic Waves" da Originkit: um campo de ruído Perlin é
 * renderizado fora da tela e depois relido por um segundo shader, que troca
 * cada célula por um ponto cujo raio acompanha o brilho do ruído. O resultado
 * é uma trama de pontos que respira devagar.
 *
 * O que mudou em relação ao original, e por quê:
 *
 * - **Contexto WebGL só enquanto o cartão está visível.** Esta é a razão de
 *   existir o IntersectionObserver aqui. O navegador mantém um número pequeno
 *   de contextos WebGL vivos ao mesmo tempo (a ordem é de 8 a 16, e varia); ao
 *   passar do limite ele **descarta os mais antigos**, e cartões antigos da
 *   conversa apareceriam apagados sem erro nenhum no console. Montar e
 *   destruir conforme o cartão entra e sai da tela prende o número de
 *   contextos ao que cabe na janela, que é sempre um punhado.
 * - **Muito mais calmo.** Velocidade e frequência do ruído bem abaixo do
 *   padrão do componente, saturação baixa e a paleta vindo dos tokens do
 *   artefato — o original usa HSV saturado no talo, que num cartão pequeno
 *   atrás de texto vira confete.
 * - **24 quadros por segundo, não 60.** É fundo de textura em movimento lento;
 *   a diferença não se vê e o custo cai à metade quando há vários cartões.
 * - **Um laço de animação só.** O original monta o mesmo `requestAnimationFrame`
 *   em dois efeitos diferentes.
 */

const VERTEX = `#version 300 es
in vec2 uv;
in vec2 position;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0., 1.);
}`;

const RUIDO_FRAGMENT = `#version 300 es
precision mediump float;
uniform float uFrequency;
uniform float uTime;
uniform float uSpeed;
uniform float uSaturation;
uniform vec2 uResolution;
in vec2 vUv;
out vec4 fragColor;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2  C = vec2(1.0/6.0, 1.0/3.0);
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  uv = (uv - 0.5) * vec2(aspect, 1.0) + 0.5;
  float hue = abs(snoise(vec3(uv * uFrequency, uTime * uSpeed)));
  fragColor = vec4(hsv2rgb(vec3(hue, uSaturation, 1.0)), 1.0);
}`;

const PONTOS_FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform sampler2D uTexture;
uniform vec3 uPalette[3];
uniform float uPaletteAlpha[3];
uniform float uCellSize;
uniform float uGamma;
uniform float uPaletteBias;
out vec4 fragColor;

void main() {
  vec2 pix = gl_FragCoord.xy;
  float cell = max(uCellSize, 1.0);

  vec2 cellIdx = floor(pix / cell);
  vec2 cellCenter = (cellIdx + 0.5) * cell;
  vec3 col = texture(uTexture, cellCenter / uResolution.xy).rgb;
  float gray = 0.3 * col.r + 0.59 * col.g + 0.11 * col.b;
  gray = pow(clamp(gray, 0.0001, 1.0), uGamma);

  vec2 cellUV = fract(pix / cell) - 0.5;
  float dist = length(cellUV);
  float g2 = clamp(gray + uPaletteBias, 0.0, 1.0);
  float radius = g2 * 0.5;
  float aa = fwidth(dist) + 1e-4;
  float mark = 1.0 - smoothstep(radius - aa, radius + aa, dist);

  float scaled = g2 * 2.0;
  int seg = clamp(int(floor(scaled)), 0, 1);
  float f = clamp(scaled - float(seg), 0.0, 1.0);
  vec3 dotCol = mix(uPalette[seg], uPalette[seg + 1], f);
  float dotOpacity = mix(uPaletteAlpha[seg], uPaletteAlpha[seg + 1], f);

  /* Cor JA multiplicada pelo alfa, para casar com premultipliedAlpha: true
     no renderer e com o blend ONE / ONE_MINUS_SRC_ALPHA la embaixo.
     (Sem crases e sem acentos: este comentario vive dentro de um template
     literal de JavaScript, e uma crase aqui fecha a string do shader.)
     Emitir cor solta com alfa separado — como faz o componente original —
     escreve rgb x alfa no buffer e depois pede ao navegador que trate esse
     valor como se nao estivesse multiplicado. O resultado é que todo ponto
     escurece na proporcao do proprio alfa: sobre a lasca bege eles viravam
     pontos escuros (que passam por "funcionando") e sobre a lasca escura
     sumiam por completo — medido, 1 em 255 de amplitude. */
  float alfa = mark * dotOpacity;
  fragColor = vec4(dotCol * alfa, alfa);
}`;

/* Ajustes de calma. Já são os valores do shader — o componente original passa
   por uma camada de mapeamento "valor de interface → valor de shader" que só
   fazia sentido quando havia controles deslizantes na tela. */
/* O cartão é pequeno e largo. Com a frequência baixa do original, a onda
   inteira não cabe dentro dele: os pontos saíam todos do mesmo tamanho e a
   trama lia como retícula de jornal parada, não como onda. */
const FREQUENCIA = 3.2;
const VELOCIDADE = 0.045;
const SATURACAO = 0.45;
const CELULA_CSS = 9;
/* Gama e viés definem o raio do ponto, e o raio tem um piso físico: com os
   valores do componente original (6 e -3 na escala dele) o raio ficava perto
   de meio pixel numa célula de 9px, e o antialiasing apagava a trama inteira
   — medido, sobrava uma amplitude de 1,7 em 255 sobre a lasca escura, que é
   o mesmo que nada. Estes valores mantêm os pontos entre ~12% e ~42% da
   célula: some nos vales, sem nunca encostar no vizinho. */
const GAMA = 1.6;
const VIES_PALETA = -0.14;
const QUADROS_POR_SEGUNDO = 24;
/* Acima de 1.5 o ganho não aparece numa trama de pontos deste tamanho, e o
   número de pixels a preencher cresce com o quadrado. */
const DPR_MAXIMO = 1.5;

type Cor = { rgb: [number, number, number]; alpha: number };

const COR_VAZIA: Cor = { rgb: [0, 0, 0], alpha: 0 };

/**
 * Aceita `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` e `rgba()` — que é o que
 * `getComputedStyle` devolve para uma custom property de cor.
 */
function lerCor(valor: string): Cor {
  const texto = valor.trim();
  if (!texto) return COR_VAZIA;

  const rgba = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/i.exec(texto);
  if (rgba) {
    return {
      rgb: [Number(rgba[1]) / 255, Number(rgba[2]) / 255, Number(rgba[3]) / 255],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }

  const hex = texto.replace(/^#/, '');
  const par = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  const solto = (i: number) => parseInt(hex[i] + hex[i], 16) / 255;
  if (hex.length === 8) return { rgb: [par(0), par(2), par(4)], alpha: par(6) };
  if (hex.length === 6) return { rgb: [par(0), par(2), par(4)], alpha: 1 };
  if (hex.length === 4) return { rgb: [solto(0), solto(1), solto(2)], alpha: solto(3) };
  if (hex.length === 3) return { rgb: [solto(0), solto(1), solto(2)], alpha: 1 };
  return COR_VAZIA;
}

/** Os três degraus da trama, lidos dos tokens para virarem junto com o tema. */
function lerPaleta(elemento: HTMLElement): Cor[] {
  const estilo = getComputedStyle(elemento);
  return ['--artifact-wave-1', '--artifact-wave-2', '--artifact-wave-3'].map((token) =>
    lerCor(estilo.getPropertyValue(token)),
  );
}

export function ArtifactWaves() {
  const hospedeiroRef = useRef<HTMLSpanElement>(null);
  // Só monta o WebGL quando o cartão aparece na tela — ver o comentário do topo
  // sobre o limite de contextos do navegador.
  const [visivel, setVisivel] = useState(false);
  // Trocar de tema não remonta o componente, então a paleta precisa de um
  // gatilho próprio para ser relida.
  const [temaVersao, setTemaVersao] = useState(0);

  useEffect(() => {
    const hospedeiro = hospedeiroRef.current;
    if (!hospedeiro || typeof IntersectionObserver === 'undefined') {
      setVisivel(true);
      return;
    }
    const observador = new IntersectionObserver(
      ([entrada]) => setVisivel(entrada.isIntersecting),
      // Uma margem generosa faz a trama já estar rodando quando o cartão
      // encosta na borda da tela, em vez de aparecer ligando.
      { rootMargin: '200px' },
    );
    observador.observe(hospedeiro);
    return () => observador.disconnect();
  }, []);

  useEffect(() => {
    const observador = new MutationObserver(() => setTemaVersao((v) => v + 1));
    observador.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observador.disconnect();
  }, []);

  useEffect(() => {
    const hospedeiro = hospedeiroRef.current;
    if (!hospedeiro || !visivel) return;

    // O contrato do resto do app: quem pediu menos movimento não recebe uma
    // trama pulsando atrás do texto.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    let renderer: Renderer;
    try {
      renderer = new Renderer({ dpr: Math.min(window.devicePixelRatio || 1, DPR_MAXIMO), alpha: true, premultipliedAlpha: true });
    } catch {
      // Sem WebGL o cartão simplesmente fica sem a trama. Não é degradação que
      // valha um aviso na interface.
      return;
    }

    const gl = renderer.gl;
    gl.canvas.style.width = '100%';
    gl.canvas.style.height = '100%';
    gl.canvas.style.display = 'block';
    hospedeiro.appendChild(gl.canvas);

    const camera = new Camera(gl, { near: 0.1, far: 100 });
    camera.position.set(0, 0, 3);

    const paleta = lerPaleta(hospedeiro);
    const programaRuido = new Program(gl, {
      vertex: VERTEX,
      fragment: RUIDO_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uFrequency: { value: FREQUENCIA },
        uSpeed: { value: VELOCIDADE },
        uSaturation: { value: SATURACAO },
        uResolution: { value: [gl.canvas.width, gl.canvas.height] },
      },
    });
    const malhaRuido = new Mesh(gl, { geometry: new Plane(gl, { width: 2, height: 2 }), program: programaRuido });

    const alvo = new RenderTarget(gl);
    const programaPontos = new Program(gl, {
      vertex: VERTEX,
      fragment: PONTOS_FRAGMENT,
      transparent: true,
      uniforms: {
        uResolution: { value: [gl.canvas.width, gl.canvas.height] },
        uTexture: { value: alvo.texture },
        uPalette: { value: paleta.map((cor) => cor.rgb) },
        uPaletteAlpha: { value: paleta.map((cor) => cor.alpha) },
        uCellSize: { value: CELULA_CSS * renderer.dpr },
        uGamma: { value: GAMA },
        uPaletteBias: { value: VIES_PALETA },
      },
    });
    // Fonte já premultiplicada — ver o comentário no fim do shader de pontos.
    programaPontos.setBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const malhaPontos = new Mesh(gl, { geometry: new Plane(gl, { width: 2, height: 2 }), program: programaPontos });

    const redimensionar = () => {
      const largura = hospedeiro.clientWidth;
      const altura = hospedeiro.clientHeight;
      if (!largura || !altura) return;
      renderer.setSize(largura, altura);
      camera.perspective({ aspect: gl.canvas.width / gl.canvas.height });
      alvo.setSize(gl.canvas.width, gl.canvas.height);
      const resolucao: [number, number] = [gl.canvas.width, gl.canvas.height];
      programaRuido.uniforms.uResolution.value = resolucao;
      programaPontos.uniforms.uResolution.value = resolucao;
    };

    let redimensionamentoPendente = false;
    const agendarRedimensionamento = () => {
      if (redimensionamentoPendente) return;
      redimensionamentoPendente = true;
      requestAnimationFrame(() => {
        redimensionamentoPendente = false;
        redimensionar();
      });
    };
    const observadorTamanho = new ResizeObserver(agendarRedimensionamento);
    observadorTamanho.observe(hospedeiro);
    redimensionar();

    const intervalo = 1000 / QUADROS_POR_SEGUNDO;
    let ultimoQuadro = 0;
    let quadro = requestAnimationFrame(function desenhar(tempo: number) {
      quadro = requestAnimationFrame(desenhar);
      if (tempo - ultimoQuadro < intervalo) return;
      ultimoQuadro = tempo;
      programaRuido.uniforms.uTime.value = tempo * 0.001;
      renderer.render({ scene: malhaRuido, camera, target: alvo });
      renderer.render({ scene: malhaPontos, camera });
    });

    return () => {
      cancelAnimationFrame(quadro);
      observadorTamanho.disconnect();
      gl.canvas.remove();
      // Devolve o contexto em vez de esperar o coletor: é justamente o recurso
      // escasso que este componente administra.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [visivel, temaVersao]);

  return <span className="artifact-card-waves" ref={hospedeiroRef} aria-hidden="true" />;
}
