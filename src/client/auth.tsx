import { useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/react';
import { ChatView } from './components/ChatView';
import { SignInScreen } from './components/SignInScreen';
import { useChatStore } from './store/chat';
import { getToken, setTokenProvider, setUserIdProvider } from './token-provider';

export { getToken, isAuthenticated } from './token-provider';

/**
 * Hook que expõe o `getToken` do Clerk (JWT da sessão ativa) para uso dentro
 * de componentes. Fora do React, use `getToken` de './token-provider', que
 * resolve o provider registrado por <AuthenticatedApp />.
 */
export function useAuthToken(): () => Promise<string | null> {
  const { getToken: clerkGetToken } = useAuth();
  return clerkGetToken;
}

/**
 * Ponte entre o Clerk e o resto do app:
 *
 * 1. Registra token e userId em um layout effect, antes de montar o chat.
 * 2. Só monta o chat depois que a ponte está pronta; assim o primeiro fetch
 *    nunca corre antes de existir um JWT.
 * 3. Ao trocar de usuário, reseta o Zustand antes de montar a nova ChatView.
 * 4. Roteia a UI: deslogado → tela de login; logado → chat.
 */
export function AuthenticatedApp() {
  const { isLoaded, isSignedIn, userId, getToken: clerkGetToken } = useAuth();
  const activeUserId = isLoaded && isSignedIn ? (userId ?? null) : null;
  const previousUserId = useRef<string | null | undefined>(undefined);
  const [bridgedUserId, setBridgedUserId] = useState<string | null | undefined>(undefined);

  useLayoutEffect(() => {
    if (!isLoaded) return;
    const provider = async (): Promise<string | null> => {
      if (!isSignedIn) return null;
      try {
        return (await clerkGetToken()) ?? null;
      } catch {
        // Sessão expirada ou ainda carregando: trata como deslogado.
        return null;
      }
    };
    setTokenProvider(provider);
    setUserIdProvider(() => activeUserId);

    if (previousUserId.current !== activeUserId) {
      previousUserId.current = activeUserId;
      useChatStore.getState().resetState();
    }
    setBridgedUserId(activeUserId);

    return () => {
      setTokenProvider(null);
      setUserIdProvider(null);
    };
  }, [activeUserId, clerkGetToken, isLoaded, isSignedIn]);

  // Enquanto a ponte troca de conta, não exibe dados do estado anterior nem
  // monta uma ChatView capaz de disparar fetch com o token ainda antigo.
  if (!isLoaded || bridgedUserId !== activeUserId) return null;

  return isSignedIn ? <ChatView key={activeUserId ?? 'sem-usuario'} /> : <SignInScreen />;
}
