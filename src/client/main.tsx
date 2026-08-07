import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/react';
import { ptBR } from '@clerk/localizations';
import { configureTheme } from '@usefragments/ui';
import '@usefragments/ui/styles';
import { AuthenticatedApp } from './auth';
import './styles.css';

// Seeds globais da @usefragments/ui a partir de --wine (DESIGN.md), para
// qualquer componente da biblioteca nascer com o acento e o raio do projeto
// em vez do azul padrão. Não passe `neutral`: nesta versão (1.6.0),
// configureTheme() lê brand/density/radiusStyle mas nunca lê `neutral`
// (dist/components/Theme/index.js) — passá-lo é inofensivo, mas não faz
// nada, e fica lendo como se semeasse a paleta neutra sem semear. Os
// componentes usados na tela de login recebem, além disso, um ajuste fino
// por CSS em styles.css porque vivem sobre o painel escuro (--sidebar-bg),
// não sobre --paper — é esse CSS, não este seed, que garante a cor ali.
configureTheme({ brand: '#7a2338', radiusStyle: 'subtle' });

// Publishable key do Clerk (pública por definição). Em dev, defina no .env.local:
//   VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

/**
 * Português do Brasil, com os subtítulos reescritos.
 *
 * Os originais são "para continuar em {{applicationName}}", e essa variável
 * vem do nome cadastrado no painel do Clerk — que aqui é o slug do projeto.
 * O cartão exibia "para continuar em open-weight-chat". Reescrever aqui
 * resolve no código, sem depender de alguém lembrar de renomear no painel.
 */
const traducao = {
  ...ptBR,
  signIn: { ...ptBR.signIn, start: { ...ptBR.signIn?.start, subtitle: 'para continuar' } },
  signUp: { ...ptBR.signUp, start: { ...ptBR.signUp?.start, subtitle: 'para criar a sua conta' } },
};

/** Estado de configuração pendente: sem a chave o app não pode autenticar ninguém. */
function MissingClerkKey() {
  return (
    <div className="config-missing">
      <p className="config-missing-brand">Open Weight Chat</p>
      <h1>Chave do Clerk não configurada</h1>
      <p>
        Defina <code>VITE_CLERK_PUBLISHABLE_KEY</code> no arquivo <code>.env.local</code> da raiz do
        projeto para ativar a autenticação:
      </p>
      <pre>VITE_CLERK_PUBLISHABLE_KEY=pk_test_...</pre>
      <p className="config-missing-hint">Reinicie o servidor de desenvolvimento depois de salvar o arquivo.</p>
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Elemento #root não encontrado.');

createRoot(root).render(
  <StrictMode>
    {publishableKey ? (
      // `localization`: o cartão do Clerk é a peça mais visível da tela de
      // entrada e vinha inteiro em inglês, num app cuja convenção é interface
      // em português (CLAUDE.md). Traduz rótulos, erros e e-mails do fluxo.
      <ClerkProvider publishableKey={publishableKey} localization={traducao}>
        <AuthenticatedApp />
      </ClerkProvider>
    ) : (
      <MissingClerkKey />
    )}
  </StrictMode>,
);
