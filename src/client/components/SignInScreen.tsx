import { SignIn } from '@clerk/react';
import { Badge, Card } from '@usefragments/ui';
import { ArrowRight, Brain, Coins, Gauge, Scan, ShieldCheck } from 'lucide-react';

/**
 * Tela exibida quando não há sessão (<SignedOut />).
 *
 * Identidade Hermes (DESIGN.md §4.5): o painel de marca usa a linha visual do
 * Hermes Agent / Nous Research — bloco de azul elétrico sólido, acento
 * amarelo-limão, off-white como tinta, tipografia display grande e leve,
 * chips com borda e textura de ruído. Sem gradientes, sem sombras, sem
 * caixa alta — a paleta é a própria decisão, não a média.
 *
 * A ficha de modelo (§7.4, "a peça que carrega a tese") vira vitrine do que
 * o usuário vai medir. Mono é usado só para valores medidos (§5.3).
 */
const PROVIDERS = ['DeepSeek', 'GLM', 'Kimi', 'OpenRouter', 'Ollama'];

const FEATURES = [
  {
    icon: Coins,
    title: 'Custo por mensagem',
    text: 'Cada resposta mostra o valor exato, em vez de um saldo opaco.',
  },
  {
    icon: Scan,
    title: 'Janela de contexto',
    text: 'O histórico é cortado pelo tamanho real do modelo selecionado.',
  },
  {
    icon: Brain,
    title: 'Raciocínio visível',
    text: 'Modelos de raciocínio mostram o pensamento antes da resposta.',
  },
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

          <ul className="login-features" aria-label="O que a bancada mede">
            {FEATURES.map((feature) => (
              <li key={feature.title} className="login-feature">
                <span className="login-feature-icon" aria-hidden="true">
                  <feature.icon size={16} strokeWidth={2} />
                </span>
                <span className="login-feature-body">
                  <strong>{feature.title}</strong>
                  <span>{feature.text}</span>
                </span>
              </li>
            ))}
          </ul>

          <Card variant="stat" padding="md" className="login-meter" aria-label="Exemplo de ficha de modelo">
            <p className="login-meter-label">Ficha de modelo</p>
            <p className="login-meter-name">DeepSeek V4 Flash</p>
            <dl className="login-meter-grid">
              <div>
                <dt>Janela</dt>
                <dd className="mono">1.048.576</dd>
              </div>
              <div>
                <dt>Entrada / 1M</dt>
                <dd className="mono">US$ 0,14</dd>
              </div>
              <div>
                <dt>Saída / 1M</dt>
                <dd className="mono">US$ 0,28</dd>
              </div>
              <div>
                <dt>Raciocínio</dt>
                <dd>sim</dd>
              </div>
            </dl>
            <p className="login-meter-note">Valores ilustrativos — o catálogo real vem do servidor após o login.</p>
          </Card>

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
