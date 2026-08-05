import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/react';
import { AuthenticatedApp } from './auth';
import './styles.css';

// Publishable key do Clerk (pública por definição). Em dev, defina no .env.local:
//   VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

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
      <ClerkProvider publishableKey={publishableKey}>
        <AuthenticatedApp />
      </ClerkProvider>
    ) : (
      <MissingClerkKey />
    )}
  </StrictMode>,
);
