# Plano — serviço multiusuário BYOK

## Resumo

Transformar o deploy em um serviço multiusuário: cada pessoa entra via Clerk (Google ou e-mail), cadastra suas próprias chaves e só acessa suas conversas, provedores, artefatos e custos. Não haverá créditos, cobrança ou chaves da plataforma no v1.

## Autenticação, isolamento e interface

- Adicionar `@clerk/react` no Vite e `@clerk/backend` no Hono; configurar `<ClerkProvider>`, tela de login e menu de conta/logout.
- Proteger toda rota `/api/*`, exceto um `/api/health` público e mínimo. Token Clerk será enviado em `Authorization` por todas as chamadas, inclusive streaming SSE; o servidor o valida e extrai o `userId`.
- Refatorar o cliente HTTP para receber um provedor de token. Ao trocar/logout de conta, limpar o estado Zustand em memória e usar preferência de modelo no `localStorage` por usuário.
- Manter a mesma API pública de conversas e provedores, mas todas as respostas passam a ser do usuário autenticado. Recursos de outro usuário retornam `404`, sem revelar que existem.
- Atualizar a CSP para permitir somente a origem Clerk configurada em `script-src`, `connect-src` e `frame-src`, preservando as demais restrições atuais. Configurar Google e e-mail verificado no painel do Clerk.

## Dados, provedores e chaves

- Criar `users`, usando o ID externo do Clerk como chave primária; criar/atualizar esse registro no primeiro acesso autenticado.
- Adicionar `user_id` às conversas e indexá-lo. Mensagens e artefatos continuam vinculados pela conversa, mas toda consulta/alteração deve verificar a propriedade via `conversations.user_id`.
- Tornar `provider_settings` privado por usuário, com chave composta `(user_id, id)`. Dois usuários poderão ter, por exemplo, um provedor `openrouter` com chaves e modelos diferentes.
- Alterar o contrato `ChatDatabaseAdapter` para receber `userId` em todas as operações expostas. Consultas de mensagens, artefatos, busca, custos e escrita durante SSE devem sempre ter escopo do dono.
- Remover o catálogo global mutável (`setRuntimeProviders`/cache global). Resolver o provedor, modelos, URL e chave dentro da própria requisição, a partir do usuário autenticado; isso elimina vazamento de chave em requisições simultâneas.
- Em produção, usar somente chaves cadastradas pelo usuário: nenhuma chave de ambiente de DeepSeek/OpenRouter etc. pode ser usada como fallback. Chaves de ambiente permanecem possíveis apenas em desenvolvimento/testes, com opt-in explícito.
- Evoluir a cifragem para formato `v2`, com AES-256-GCM e contexto autenticado `userId + providerId`. A chave mestra única `PROVIDER_SECRET_KEY` continua estável e jamais é enviada ao cliente ou registrada em logs.
- Manter provedores conhecidos como modelos pré-definidos e permitir endpoints OpenAI-compatíveis próprios. Para endpoints próprios: exigir HTTPS em produção, bloquear credenciais na URL, redirecionamentos e hosts/IPs privados, loopback, link-local, multicast e metadata; resolver DNS com agente de conexão restrito para evitar SSRF/DNS rebinding. Em desenvolvimento, permitir `http://localhost` somente.
- Limitar o catálogo descoberto a 500 modelos e aplicar limites por usuário no Postgres: 20 inícios de chat/minuto, 5 descobertas de modelos/minuto e no máximo 2 streams ativos. Contadores devem ser atômicos e compartilhados entre instâncias Vercel.

## Migração e deploy

- Substituir a criação automática de schema em requisições por migrações versionadas e um comando `pnpm db:migrate`, executado manualmente contra o Neon.
- Antes da migração: proteger temporariamente o deploy atual, fazer backup do Neon e criar a conta Clerk do proprietário.
- Definir `LEGACY_OWNER_CLERK_USER_ID` com o ID `user_...` da conta do proprietário. A migração deve atribuir a ela todas as conversas e provedores atuais.
- Durante a migração, validar que cada chave antiga `v1` pode ser decifrada com a `PROVIDER_SECRET_KEY` vigente e recifrá-la como `v2`; abortar sem alterações de chaves caso alguma não possa ser lida.
- Aplicar migração, conferir contagens antes/depois e validar que o proprietário vê seu histórico e suas configurações após login.
- Configurar na Vercel: `DATABASE_URL`, `PROVIDER_SECRET_KEY`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_FRONTEND_API_ORIGIN`, `APP_ORIGIN` e, apenas durante a migração, `LEGACY_OWNER_CLERK_USER_ID`. Variáveis `VITE_*` exigem novo build/deploy.
- Atualizar README e `.env.example` com o fluxo Clerk, recuperação de dados, regra de não trocar a chave mestra e instruções de migração.

## Testes e aceite

- Testar autenticação ausente, inválida e válida; verificar que todas as rotas privadas devolvem `401` antes de qualquer acesso ao banco.
- Criar dois usuários de teste com chaves, conversas e IDs de provedores iguais; confirmar isolamento em CRUD, busca, custos, artefatos, descoberta de modelos e streaming.
- Executar duas requisições concorrentes com chaves distintas e verificar que cada chamada ao upstream recebeu somente a chave de seu proprietário.
- Testar que nenhuma resposta, exceção ou log contém chave em texto puro; testar recifragem `v1 → v2` e falha ao trocar usuário/provedor no texto autenticado.
- Cobrir URLs seguras e rejeições de SSRF, limites de taxa, expiração de stream ativo e preservação dos dados legados.
- Aceite no deploy: login Google/e-mail funciona; cada conta vê apenas seus dados; ambas podem usar suas próprias chaves; o histórico existente aparece somente para o proprietário inicial; nenhum chat usa saldo de chave configurada pela plataforma.
