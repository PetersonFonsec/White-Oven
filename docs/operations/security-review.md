# Checklist de segurança antes do piloto (M7.3)

Revisão feita sobre `main` após a PR #46 (M7.2), com as correções da M7.3 ([ADR 0031](../adr/0031-security-review.md)). Cada item diz como foi verificado. Itens marcados **no ambiente** só podem ser conferidos quando o ambiente do piloto existir (hoje não há produção provisionada) e devem ser refeitos lá antes do primeiro pedido real.

Legenda: `[x]` verificado no repositório, `[ ]` falta conferir no ambiente do piloto.

## 1. Rotas e guards

- [x] Toda rota declara acesso (`@PublicRoute`, `@StoreTenant`, `@CustomerRoute`, `@StaffRoute`, `@AdminRoute`, `@PlatformRoute`). `RouteAccessGuard` global recusa rota sem declaração com 403 e registra em log. Prova: `app.test.ts` ("refuses a route without an access declaration") e o teste de cobertura de rotas de `staff-auth.test.ts`.
- [x] Rotas públicas revisadas: health, login (equipe e cliente), segundo fator, refresh e logout por cookie (com `Origin` conferido contra `API_ADMIN_ORIGINS`), cardápio, status, marca, imagens públicas, documentos legais e páginas `/lojas/...`. Nenhuma devolve dado de outra loja nem dado pessoal.
- [x] OpenAPI desligado por padrão em produção (`API_OPENAPI_ENABLED`).
- [x] `GET /metrics` (M7.4, [ADR 0032](../adr/0032-observability.md)): 404 sem `API_METRICS_TOKEN`, 401 sem o bearer certo, só rótulos sem dado pessoal (`observability.test.ts`).
- [ ] **No ambiente:** o proxy público responde 404 em `/metrics`; o monitor lê pela rede interna ([runbook](observability.md#2-configurar-a-api)).

## 2. Isolamento entre lojas

- [x] Matriz de rotas completa: toda rota de tenant com id de recurso no caminho está na matriz de `tenant-isolation.test.ts` (A ataca B e B ataca A, 404 sem efeito colateral). Rotas sem id (listagens, configuração da própria loja, conta do próprio cliente) estão listadas com o teste que as cobre. Uma rota nova fora das duas listas reprova o teste. M7.3 moveu `GET .../me/orders/{orderId}` para a matriz.
- [x] Todas as tabelas com `tenant_id` têm RLS habilitada e forçada, só com políticas de tenant (`findUnprotectedTenantTables`), e a lista de tabelas de produção é conferida explicitamente.
- [x] Para toda tabela com `tenant_id`, `whiteoven_app` não vê linhas de outra loja dentro de um contexto nem linhas sem contexto (teste novo da M7.3, tabelas lidas do catálogo do PostgreSQL).
- [x] Tabelas globais sensíveis (`audit_events`, `customer_erasures`) inacessíveis ao papel da aplicação.
- [x] Chaves estrangeiras compostas, contexto por transação e reuso de conexão do pool (testes 4 e 5), token de uma loja em outra (teste 6), revogação de vínculo (teste 7).
- [x] O tenant nunca vem de cabeçalho, corpo ou query (testes "ignores tenant hints").

## 3. Rate limits

- [x] Login de equipe, segundo fator, login de cliente e página de exclusão de conta: bloqueio progressivo por conta e por IP (5 e 30 falhas; 30 s dobrando até 15 min), sem revelar se o e-mail existe.
- [x] Refresh de equipe e de cliente, cadastro de cliente, cotação e criação de pedido: limite por requisição, por IP e por conta onde a conta é conhecida, com `429 RATE_LIMITED` e `Retry-After` (`security.test.ts`). Tetos na ADR 0031.
- [x] Recuperação de senha: não existe (Q-12). Quando for criada, entra em `LIMIT_POLICIES`.
- [x] Requisição recusada não consome nenhum escopo (um cliente bloqueado não gasta a cota de IP compartilhada); `Retry-After` é o tempo até todos os escopos esgotados reabrirem.
- [x] Memória limitada (100 mil janelas) sem descartar janela viva: com o mapa cheio, janelas vencidas saem primeiro e, se ainda faltar espaço, a chave nova é recusada (fail closed). IPv6 é limitado por /64 (`security.test.ts`).
- [x] IP do cliente: par TCP, ou o `X-Forwarded-For` de um proxy listado em `API_TRUSTED_PROXIES`, lido da direita para a esquerda, pulando só proxies confiáveis e parando em entrada inválida; o que o cliente escreve à esquerda nunca é usado (`security.test.ts`).
- [ ] **No ambiente:** o Caddy da API usa `header_up X-Forwarded-For {client_ip}` (ou `{remote_host}`) e não confia em `X-Forwarded-For` de clientes; CDN ou balanceador, se houver, entra em `trusted_proxies` do Caddy, não na API (ADR 0031). Conferir com `curl -H 'X-Forwarded-For: 1.2.3.4'` que o limite não muda de balde.
- [ ] **No ambiente:** `API_TRUSTED_PROXIES` igual ao IP do proxy que a API realmente vê (como `LEADS_TRUSTED_PROXIES` na landing). Sem isso, todos os clientes dividem um IP e o bloqueio de login vira bloqueio geral.
- [ ] **No ambiente:** uma única instância da API (limites em memória). Se houver mais, rever antes.

## 4. Cabeçalhos e transporte

- [x] A API põe `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy` e `Permissions-Policy` em toda resposta, inclusive erros (`security.test.ts`). Páginas legais usam CSP própria sem script (ADR 0030).
- [x] Limites de corpo: JSON 100 KiB, formulário 4 KiB com 10 campos; upload de imagem 5 MiB e 30 MP (ADR 0010).
- [x] Cookie de refresh `HttpOnly`, `Secure`, `SameSite=Strict`, restrito ao caminho; access token só em memória no painel; respostas com token `Cache-Control: no-store`.
- [ ] **No ambiente:** o proxy que termina TLS da API envia `Strict-Transport-Security` e aplica tempos de leitura, como o `ops/Caddyfile` da landing. Conferir com `curl -sI https://<api>/health`.
- [ ] **No ambiente:** porta da API não publicada fora do proxy; `/v1/docs` e `/v1/openapi.json` respondem 404.

## 5. MFA dos operadores (revisão, sem mudança)

- [x] MFA obrigatório para operador desde M1.4: `PlatformGuard` exige `mfa` no token, sessão com segundo fator no banco e cadastro ativo; sem isso, 403 `MFA_REQUIRED` em toda rota de plataforma. Antes do cadastro, só as rotas de cadastro do segundo fator respondem (`staff-mfa.test.ts`).
- [x] Segredo TOTP cifrado com AES-256-GCM por chave fora do banco (`AUTH_MFA_ENCRYPTION_KEY`, obrigatória em produção); códigos de recuperação guardados como hash e de uso único; cada passo TOTP aceito uma vez (`mfa_last_used_step`, sob lock da linha), tolerância de um passo; comparação em tempo constante.
- [x] Desafio do segundo fator: token aleatório de 256 bits, 5 minutos, 5 tentativas, uma verificação por vez, e as falhas contam no bloqueio de login da conta.
- [x] Primeiro operador só por CLI (`pnpm api:create-operator`), sem MFA até o primeiro login; redefinir o MFA de outro operador exige operador com MFA, revoga as sessões e é auditado.
- [x] MFA para OWNER, MANAGER e STAFF continua opcional (decisão de produto em aberto, system-overview.md).
- [ ] **No ambiente:** `pnpm api:check-operators-mfa` (com o `.env` da API do ambiente) sai com 0 e mostra "operators without MFA: 0". Anotar a data e o total de operadores abaixo.

## 6. Dados pessoais e segredos

- [x] Logs JSON sem dados pessoais, query string, cabeçalhos nem corpo (`logging.test.ts`, `sanitize.test.ts`); métricas e mensagens do monitor também (`observability.test.ts`, `tests/deployment/api-monitor.test.mjs`).
- [x] API conecta só como `whiteoven_app`, sem `BYPASSRLS` nem DDL, e recusa iniciar com credencial de dono (`database.test.ts`, `startup.test.ts`).
- [x] Segredos obrigatórios em produção validados na partida (`AUTH_ACCESS_TOKEN_PRIVATE_KEY`, `AUTH_MFA_ENCRYPTION_KEY`, `OWNER_INVITE_SECRET`).
- [ ] **No ambiente:** backups cifrados e guardados fora do servidor dependem da Q-13 (aberta); ver [runbook de backup](api-backup-restore.md).

## Pendências fora do escopo da M7.3

- Recuperação de senha (Q-12).
- Limites e desafios de MFA em armazenamento compartilhado antes de escalar a API.
- Métricas e alertas por loja (M7.4).

## Assinatura

| Papel                    | Nome | Data | Ambiente conferido | Operadores / sem MFA |
| ------------------------ | ---- | ---- | ------------------ | -------------------- |
| Responsável pelo produto |      |      |                    |                      |
| Responsável técnico      |      |      |                    |                      |
