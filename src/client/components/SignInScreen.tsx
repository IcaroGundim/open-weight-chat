import { SignIn } from '@clerk/react';
import { Badge, Message, Prompt, ThinkingIndicator } from '@usefragments/ui';
import { ArrowRight, ArrowUp, Gauge, ShieldCheck } from 'lucide-react';
import { AgentOrb } from './AgentOrb';

/**
 * Tela exibida quando não há sessão (<SignedOut />).
 *
 * Identidade Hermes (DESIGN.md §4.5): o painel de marca usa a casca escura da
 * barra lateral, acento vinho, off-white como tinta, display grande e leve, e
 * a textura de ruído — a paleta é a própria decisão, não a média.
 *
 * O miolo do painel é uma **prévia viva do produto**, e não uma lista de
 * recursos: os três argumentos da bancada aparecem funcionando em vez de
 * descritos — o raciocínio como passos, o custo como valor medido em mono
 * (§5.3) e a janela de contexto no rodapé do campo. Substituiu a ficha de
 * modelo estática; a decisão está registrada em §3.3 e no histórico da §12.
 *
 * A espera usa o `AgentOrb` do próprio app, não o indicador da biblioteca:
 * o orb é a linguagem de espera daqui e aparece em todas as outras telas —
 * trocá-lo por três pontos genéricos seria exatamente o que a §13.5 proíbe.
 * Os passos ao lado vêm de `ThinkingIndicator.Steps`, que é presentacional e
 * funciona fora do componente-pai.
 */
const PROVIDERS = ['DeepSeek', 'GLM', 'Kimi', 'OpenRouter', 'Ollama'];

const THINKING_STEPS = [
  { id: 'ler', label: 'Lendo o catálogo do provedor', status: 'complete' as const },
  { id: 'comparar', label: 'Comparando preço por token', status: 'complete' as const },
  { id: 'medir', label: 'Somando o custo da resposta', status: 'active' as const },
];

export function SignInScreen() {
  return (
    <div className="login-screen">
      <aside className="login-panel">
        <div className="login-panel-inner">
          <p className="login-brand">
            <Gauge aria-hidden="true" size={18} strokeWidth={2} />
            Open Weight Chat
          </p>
          <h1 className="login-panel-title">Uma bancada para modelos abertos.</h1>
          <p className="login-panel-text">
            Escolha o provedor, traga a sua chave, leia a resposta — e veja exatamente o que cada mensagem custou.
          </p>

          {/* A prévia abaixo é `inert` + `aria-hidden`: sai do teclado e da árvore
              de acessibilidade, porque ler uma conversa encenada confunde. O que
              ela demonstra fica aqui, em prosa, para quem usa leitor de tela. */}
          <p className="sr-only">
            A bancada mostra os passos de raciocínio do modelo, o custo exato de cada resposta
            e a janela de contexto em uso. Ao lado há uma ilustração da interface.
          </p>

          <figure className="login-preview" inert aria-hidden="true">
            <Message role="user" avatar={null} className="login-preview-message">
              <Message.Content>Qual sai mais barato para resumir 40 páginas?</Message.Content>
            </Message>

            <div className="login-preview-thinking">
              <p className="login-preview-thinking-head">
                <AgentOrb activity="pensando" label="Raciocinando" />
                Raciocinando
              </p>
              <ThinkingIndicator.Steps>
                {THINKING_STEPS.map((step) => (
                  <ThinkingIndicator.Step key={step.id} label={step.label} status={step.status} />
                ))}
              </ThinkingIndicator.Steps>
            </div>

            <Message role="assistant" avatar={null} className="login-preview-message">
              <Message.Content>
                O V4 Flash resolve por uma fração do Pro: mesma janela, saída 3× mais barata.
              </Message.Content>
            </Message>

            <p className="login-preview-cost">
              <span>Custo desta resposta</span>
              <strong className="mono">US$ 0,0041</strong>
            </p>

            <Prompt
              className="login-preview-prompt"
              value="Compare os dois no meu histórico"
              placeholder="Pergunte alguma coisa"
            >
              <Prompt.Textarea />
              <Prompt.Toolbar>
                <Prompt.Info>
                  <span className="login-preview-model">DeepSeek V4 Flash</span>
                  <span className="login-preview-ctx mono">1.048.576 ctx</span>
                </Prompt.Info>
                <Prompt.Actions>
                  <Prompt.Submit aria-label="Enviar">
                    <ArrowUp size={15} strokeWidth={2.5} />
                  </Prompt.Submit>
                </Prompt.Actions>
              </Prompt.Toolbar>
            </Prompt>
          </figure>

          <ul className="login-providers" aria-label="Provedores suportados">
            {PROVIDERS.map((name) => (
              <li key={name}>
                <Badge variant="outline" size="sm">{name}</Badge>
              </li>
            ))}
          </ul>

          <p className="login-panel-foot">Suas conversas, chaves e custos ficam vinculados à sua conta.</p>
        </div>
      </aside>
      <main className="login-main">
        <div className="login-card">
          <p className="login-eyebrow">Continue de onde parou</p>
          <div className="login-clerk">
            <SignIn />
          </div>
          <p className="login-seal">
            <ShieldCheck aria-hidden="true" size={15} strokeWidth={2} />
            Suas chaves ficam cifradas no servidor — nunca voltam para o navegador.
          </p>
          <p className="login-hint">
            Ainda não tem conta? Crie uma pelo cartão acima — o primeiro acesso já abre a conversa.
            <ArrowRight aria-hidden="true" size={13} strokeWidth={2} className="login-hint-arrow" />
          </p>
        </div>
      </main>
    </div>
  );
}
