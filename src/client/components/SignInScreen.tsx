import { useEffect, useState } from 'react';
import { SignIn } from '@clerk/react';
import { Badge, usePrefersReducedMotion } from '@usefragments/ui';
import { KeyRound, ShieldCheck } from 'lucide-react';
import DigitalRain from './originkit/ui/ascii-rain';
import { useSettingsStore } from '../store/settings';

/**
 * Tela exibida quando não há sessão (<SignedOut />).
 *
 * O painel de marca é um campo de chuva ASCII (Originkit) sobre a casca
 * escura da barra lateral. Ele é o elemento definidor da tela, e por isso o
 * resto do painel foi enxugado: a prévia de conversa que morava aqui
 * disputava atenção com o fundo e as duas viravam ruído. Ficou o que carrega
 * a tese — o medidor de custo (§7.4) — e a identidade.
 *
 * O contraste do texto não vem do acaso: um véu sólido sobre a chuva devolve
 * o painel à mesma tinta sobre fundo dos outros temas, que é o par já
 * verificado por `pnpm design`.
 */
const PROVIDERS = ['DeepSeek', 'GLM', 'Kimi', 'OpenRouter', 'Ollama'];

/**
 * Marca em ASCII, gerada com figlet (fonte Small) e colada aqui íntegra.
 *
 * A fonte é a Small Slant, e a inclinação não é gosto: ela repete o ângulo
 * em que a chuva cai atrás (39°), então marca e fundo leem como uma coisa só.
 *
 * Empilhada em duas palavras de propósito: numa linha só a arte estouraria o
 * painel em telas médias, forçando um corpo abaixo do piso de 12px que a
 * §3.1 fixa.
 */
const MARCA_ASCII = `  ____  ___  _____  __  _      _________________ ________
 / __ \\/ _ \\/ __/ |/ / | | /| / / __/  _/ ___/ // /_  __/
/ /_/ / ___/ _//    /  | |/ |/ / _/_/ // (_ / _  / / /
\\____/_/  /___/_/|_/   |__/|__/___/___/\\___/_//_/ /_/

  _______ _____ ______
 / ___/ // / _ /_  __/
/ /__/ _  / __ |/ /
\\___/_//_/_/ |_/_/`;

/**
 * Chuva de fundo, com o desligamento que o componente não traz.
 *
 * Ele roda um `requestAnimationFrame` infinito, e as duas chaves de movimento
 * do app são CSS (`prefers-reduced-motion` e `[data-reduce-motion]`) — elas
 * zeram transição e animação de folha, mas não param um laço de JavaScript.
 * Sem isto, quem pede menos movimento receberia justamente a animação mais
 * agitada do produto na primeira tela. Desmontado, resta a textura de ruído
 * estática que o painel já tem.
 *
 * As cores saem dos tokens em tempo de execução porque `canvas` não entende
 * `var(--x)`: só aceita cor resolvida.
 */
/**
 * Glifos do embaralhamento. Só meia-largura de propósito: as katakana que a
 * chuva usa ocupam DUAS colunas em fonte mono, e trocá-las por um caractere
 * da arte desalinharia a marca inteira durante a revelação.
 */
const GLIFOS = '0123456789ABCDEF/\\|_-=+*<>';

/**
 * Marca em ASCII que se decodifica ao entrar.
 *
 * A revelação é da esquerda para a direita: os caracteres ainda não fixados
 * ficam trocando entre os glifos acima, e vão assentando na arte final. É a
 * mesma gramática da chuva atrás — a marca nasce do campo, em vez de aparecer
 * por cima dele.
 *
 * Sob movimento reduzido a arte final é pintada de uma vez: aqui o desenho é
 * feito em JavaScript, e as chaves globais de CSS não alcançariam este laço.
 */
function MarcaAscii() {
  const reduzirNoApp = useSettingsStore((state) => state.reduceMotion);
  const reduzirNoSistema = usePrefersReducedMotion();
  const reduzir = reduzirNoApp || reduzirNoSistema;
  const [texto, setTexto] = useState(MARCA_ASCII);

  useEffect(() => {
    if (reduzir) {
      setTexto(MARCA_ASCII);
      return;
    }
    const finais = [...MARCA_ASCII];
    // Espaço e quebra de linha são a forma da arte: mexer neles a desmancha.
    const moveis = finais.reduce<number[]>((acc, ch, i) => {
      if (ch !== ' ' && ch !== '\n') acc.push(i);
      return acc;
    }, []);
    const DURACAO = 850;
    let inicio: number | null = null;
    let raf = 0;

    const passo = (agora: number) => {
      inicio ??= agora;
      const avanco = Math.min(1, (agora - inicio) / DURACAO);
      const fixados = Math.floor(moveis.length * avanco);
      const quadro = [...finais];
      for (let k = fixados; k < moveis.length; k += 1) {
        quadro[moveis[k]] = GLIFOS[Math.floor(Math.random() * GLIFOS.length)];
      }
      setTexto(quadro.join(''));
      if (avanco < 1) raf = requestAnimationFrame(passo);
    };

    raf = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(raf);
  }, [reduzir]);

  // Duas camadas: a arte sólida e, por cima, uma cópia só-halo cuja opacidade
  // pulsa. Ver o porquê em styles.css — animar `text-shadow` custa caro.
  return (
    <div className="login-marca" role="img" aria-label="Open Weight Chat">
      <pre className="login-marca-arte" aria-hidden="true">{texto}</pre>
      <pre className="login-marca-halo" aria-hidden="true">{texto}</pre>
    </div>
  );
}

function ChuvaDeFundo() {
  const reduzirNoApp = useSettingsStore((state) => state.reduceMotion);
  const reduzirNoSistema = usePrefersReducedMotion();
  const [cores, setCores] = useState<{ head: string; trail: string } | null>(null);

  useEffect(() => {
    const raiz = getComputedStyle(document.documentElement);
    setCores({
      head: raiz.getPropertyValue('--sidebar-ink').trim() || '#f6efe7',
      trail: raiz.getPropertyValue('--sidebar-wine').trim() || '#e0899c',
    });
  }, []);

  if (reduzirNoApp || reduzirNoSistema || !cores) return null;

  return (
    <div className="login-chuva" aria-hidden="true">
      <DigitalRain
        headColor={cores.head}
        trailColor={cores.trail}
        glyphSize={13}
        trail={22}
        speed={13}
        angle={39}
        shuffle={false}
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}

export function SignInScreen() {
  return (
    <div className="login-screen">
      <aside className="login-panel">
        <ChuvaDeFundo />
        <div className="login-veu" aria-hidden="true" />
        {/* A arte é decoração: o nome acessível vai no aria-label, e o
            desenho sai da árvore de acessibilidade para não ser soletrado. */}
        <MarcaAscii />
        <div className="login-panel-inner">
          {/* Título e subtítulo são uma ideia só, e ficam juntos. */}
          <div className="login-bloco-titulo">
            <h1 className="login-panel-title">Uma bancada para modelos abertos.</h1>
            <p className="login-panel-text">
              Escolha o provedor, traga a sua chave, leia a resposta — e veja exatamente o que cada
              mensagem custou.
            </p>
          </div>

          {/* O medidor é a tese em uma peça só: valor medido, em mono tabular. */}
          <div className="login-medidor">
            <p className="login-medidor-rotulo">custo da última resposta</p>
            <p className="login-medidor-valor mono">US$ 0,0041</p>
            <p className="login-medidor-nota">
              Cada mensagem mostra o valor exato — não um saldo opaco.
            </p>
          </div>

          {/* Rodapé: provedores e a nota de conta são a mesma letra miúda, e
              ficam agrupados atrás de uma régua em vez de soltos na coluna. */}
          <div className="login-rodape">
            <ul className="login-providers" aria-label="Provedores suportados">
              {PROVIDERS.map((name) => (
                <li key={name}>
                  <Badge variant="outline" size="sm">{name}</Badge>
                </li>
              ))}
            </ul>
            <p className="login-panel-foot">Suas conversas, chaves e custos ficam vinculados à sua conta.</p>
          </div>
        </div>
      </aside>
      <main className="login-main">
        <div className="login-card">
          <p className="login-eyebrow">Entre para abrir a sua bancada</p>
          <div className="login-clerk">
            <SignIn />
          </div>
          {/* Com o cartão do Clerk em português, "ainda não tem conta?" virava
              eco do próprio widget. No lugar, o que ninguém adivinha sozinho:
              como o BYOK funciona e quem cobra de quem. */}
          <p className="login-seal">
            <ShieldCheck aria-hidden="true" size={15} strokeWidth={2} />
            A sua chave é cifrada com a sua conta e nunca volta para o navegador — nem para você.
          </p>
          <p className="login-hint">
            <KeyRound aria-hidden="true" size={15} strokeWidth={2} className="login-hint-icone" />
            Sem créditos e sem assinatura: você cadastra a chave do seu provedor depois de entrar, e
            paga direto a ele pelo que usar.
          </p>
        </div>
      </main>
    </div>
  );
}
