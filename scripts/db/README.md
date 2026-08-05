# Migração versionada do banco (`pnpm db:migrate`)

Substitui a antiga criação automática de schema por migrações versionadas,
executadas manualmente contra o Neon (produção) ou o SQLite local.

## Uso

```bash
pnpm db:migrate status            # versão atual, pendentes, contagens de linhas
pnpm db:migrate up --dry-run      # mostra o que seria feito, sem tocar no banco
pnpm db:migrate up                # aplica as migrações pendentes (transacional)
pnpm db:migrate down              # NÃO suportado — restaure o backup
```

Driver: `DATABASE_URL` (Neon/Postgres) tem prioridade; sem ela, usa o SQLite em
`CHAT_DB_PATH` (padrão `./chat.db`). O `.env` local é carregado, como o servidor.

Cada migração roda **dentro de uma transação**: se qualquer passo falhar, tudo
daquela migração reverte (no Postgres, `ROLLBACK`; no SQLite, `BEGIN/ROLLBACK`).
A tabela `schema_migrations` registra as versões aplicadas.

## Migrações

| Versão | Nome | O que faz |
|---|---|---|
| `001` | schema base | Cria o schema atual (idempotente — em bancos legados só cria o que falta) |
| `002` | multiusuário | `users`, `user_id` em conversas/provedores, PK composta `(user_id, id)` em `provider_settings`, atribuição do dono legado e recifragem `v1 → v2` |

A `002` faz, em ordem:

1. Cria a tabela `users` (id = `user_...` do Clerk).
2. Adiciona `user_id` em `conversations` e `provider_settings` (colunas novas,
   `DEFAULT ''` — o schema é aditivo).
3. Troca a PK de `provider_settings` para `(user_id, id)` (recriação da tabela
   no SQLite / `DROP CONSTRAINT` + `ADD PRIMARY KEY` no Postgres).
4. Atribui `LEGACY_OWNER_CLERK_USER_ID` a todas as linhas órfãs (`user_id = ''`).
   **Se houver dados órfãos e a variável não estiver definida, a migração falha**
   sem alterar nada.
5. Recifra as chaves `v1` → `v2` (AES-256-GCM com AAD `userId:providerId`).
   **Se qualquer chave v1 não puder ser decifrada com a `PROVIDER_SECRET_KEY`
   vigente, a migração é abortada** sem nenhuma alteração de chaves.
6. Cria o índice `idx_conversations_user` e garante o registro do proprietário
   em `users`.

## Checklist de execução no deploy (Neon + Vercel)

> ⚠️ Execute na ordem abaixo. A migração é aditiva (colunas com `DEFAULT ''`),
> então o deploy atual continua funcionando depois da migração — exceto pelo
> upsert de `provider_settings`, que passa a exigir a PK composta. **Evite
> cadastrar/editar provedores pela interface antiga no período entre migrar e
> fazer o novo deploy.**

1. **Proteja o deploy atual** — ative *Vercel Deployment Protection* (ou outra
   autenticação na frente) para ninguém usar o serviço durante a janela.
2. **Backup do Neon** — no painel Neon: *Branches* → crie uma branch de backup,
   ou use `pg_dump` na connection string. Guarde também o `.provider-secret`
   local, se existir (não é usado na Vercel, mas é a única cópia da chave-mestra
   de instalações antigas).
3. **Crie a conta do proprietário no Clerk** — faça login (Google ou e-mail)
   em uma aba anônima do app novo, ou crie o usuário pelo painel do Clerk
   (*Users* → *Create user*). Copie o ID `user_...` (painel → *Users* → a conta).
4. **Defina as variáveis no ambiente onde vai rodar o script**:
   - `DATABASE_URL` — connection string com pooling do Neon;
   - `PROVIDER_SECRET_KEY` — **a mesma** que está configurada na Vercel hoje
     (é ela que decifra as chaves v1);
   - `LEGACY_OWNER_CLERK_USER_ID` — o `user_...` do passo 3 (**só durante a
     migração; remova depois**).
5. **Confira o estado** — `pnpm db:migrate status` (mostra pendentes e
   contagens: users, conversations, providers, messages, artifacts).
6. **Prévia** — `pnpm db:migrate up --dry-run` e confira as contagens.
7. **Aplique** — `pnpm db:migrate up` e confira as contagens **depois**
   (conversas/provedores devem ter migrado para o proprietário).
8. **Faça o novo deploy na Vercel** com todas as variáveis (incluindo as
   `VITE_*`, que exigem novo build) — ver README.md na raiz.
9. **Valide** — login do proprietário mostra o histórico antigo e os
   provedores; um segundo usuário não vê nada; cada um usa as próprias chaves.
10. **Remova `LEGACY_OWNER_CLERK_USER_ID`** da Vercel e do ambiente local.

## Regras permanentes

- **NUNCA troque `PROVIDER_SECRET_KEY`** depois que houver chaves v2 no banco:
  as chaves ficam indecifráveis. A migração v1→v2 valida a chave vigente antes
  de recifrar e aborta se alguma chave antiga não puder ser lida.
- Não há rollback automático (`down`). Restaure a branch de backup do Neon.
- O SQLite local também usa as migrações; o `ChatDatabase` aplica um ajuste
  mínimo de compatibilidade (colunas `user_id`) ao abrir bancos antigos, mas o
  schema completo vem das migrações.
