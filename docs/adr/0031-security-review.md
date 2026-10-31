# ADR 0031: revisão de segurança antes do piloto

- **Status:** implementado em M7.3, checklist aguardando assinatura
- **Data:** 2026-10-31
- **Milestone:** M7.3

## Contexto

O critério de aceite da M7.3 pede checklist assinado, nenhuma rota sem guard, testes de isolamento cobrindo todas as tabelas e confirmação de que nenhum operador ativo está sem MFA. A entrega lista quatro frentes: matriz de isolamento completa, rate limits, cabeçalhos e revisão (não implementação) do MFA dos operadores.

A revisão do código em `main` (após a PR #46) encontrou:

- **Guards:** completo. `RouteAccessGuard` recusa toda rota sem declaração e `staff-auth.test.ts` falha nela (M1.4).
- **Isolamento:** a matriz de `tenant-isolation.test.ts` já listava todas as rotas de tenant, mas deixava `GET /customer/stores/{slug}/me/orders/{orderId}` entre as "listagens sem id", embora a rota receba um id. O teste de cobertura de RLS conferia política e `FORCE` em todas as tabelas com `tenant_id`, mas o teste de leitura sem contexto e entre lojas usava só as tabelas de sonda.
- **Rate limits:** a [visão geral](../architecture/system-overview.md#proteção-de-endpoints) pede limite por IP e por conta em login, refresh, recuperação de senha e criação de pedido. Só havia o bloqueio progressivo de falhas de login (equipe, MFA, cliente e a página de exclusão de conta). Refresh, cadastro e pedidos não tinham limite.
- **IP do cliente:** o bloqueio de login usava o par TCP. Atrás de um proxy reverso todos os clientes teriam o IP do proxy, e 30 falhas de qualquer pessoa bloqueariam o login de todas. Não havia como declarar o proxy confiável na API (a landing já tinha `LEADS_TRUSTED_PROXIES`, ADR 0003).
- **Cabeçalhos:** só o Caddy da landing (`ops/Caddyfile`) aplicava cabeçalhos de segurança, e as páginas legais da API (ADR 0030) os seus. As respostas JSON e as imagens da API não tinham nenhum, e não existe proxy da API versionado no repositório.
- **MFA de operadores:** em ordem (detalhes no [checklist](../operations/security-review.md)). Faltava um jeito de confirmar, num ambiente, que nenhum operador que ainda entra está sem MFA.

## Decisão

### Rate limits por requisição

- `RequestLimits` (`apps/api/src/security/request-limits.ts`): janelas fixas em memória, chaves SHA-256 (nenhum IP, e-mail ou token em claro). A resposta é `429 RATE_LIMITED` com `Retry-After`. Mesmo limite de escala do bloqueio de login: uma instância no MVP, rever antes de escalar horizontalmente. Semântica (revisada na PR #47):
  - **Verifica, depois consome.** A requisição só é admitida se todos os escopos ainda têm vaga; só então conta uma vez em cada escopo. **Requisição recusada não conta em nenhum escopo.** Assim um cliente que estourou o próprio limite não gasta a cota de IP que divide com outros clientes atrás do mesmo NAT. Como a janela é fixa, não contar recusas nunca encurta uma espera.
  - **`Retry-After`** é o tempo até todos os escopos esgotados reabrirem (o fim mais tardio entre eles); uma nova tentativa nesse momento é admitida, salvo se outra pessoa esgotar um escopo compartilhado nesse meio-tempo.
  - **Memória limitada sem descartar janela viva.** No máximo 100 mil janelas (cerca de 10 MB). Quando uma requisição precisa de janelas novas e o mapa está cheio, as janelas vencidas são removidas primeiro (uma varredura completa, repetida só depois do próximo vencimento possível). Se ainda não houver espaço, a requisição é **recusada** (fail closed) com o tempo até a primeira janela vencer, a mesma resposta para qualquer chave nova. Janelas vivas nunca são removidas: inundar o mapa com chaves novas não zera a cota de ninguém. Requisições cujas janelas já existem continuam decididas normalmente.
  - **Espaço de chaves pequeno:** IPv6 é limitado pelo prefixo /64 (um assinante costuma receber um /64 inteiro; por endereço, um único host criaria chaves sem fim), IPv4 por endereço, e a conta só depois da autenticação. Encher o mapa exige da ordem de 100 mil endereços IPv4 ou prefixos /64 distintos dentro de uma janela; nesse caso o efeito é recusar clientes novos até as janelas vencerem (no máximo 1 hora), nunca liberar quem está bloqueado.
- Limites (`LIMIT_POLICIES`):

| Limite            | Rotas                                          | Escopos e tetos                                                |
| ----------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| `staffRefresh`    | `POST /v1/admin/auth/refresh`                  | IP: 120 em 10 min                                              |
| `customerRefresh` | `POST /v1/customer/stores/{slug}/auth/refresh` | IP na loja: 120 em 10 min; IP em todas as lojas: 600 em 10 min |
| `customerSignup`  | `POST .../auth/register`                       | IP na loja: 30 por hora; IP em todas as lojas: 100 por hora    |
| `orderQuote`      | `POST .../me/orders/quote`                     | cliente: 120 em 10 min; IP na loja: 600 em 10 min              |
| `orderCreate`     | `POST .../me/orders`                           | cliente: 10 em 10 min; IP na loja: 60 em 10 min                |

- O refresh de cliente não tem escopo por conta: o token gira a cada uso e a conta só se conhece lendo o banco. O de equipe também não: o cookie identifica a sessão, e a sessão só se conhece lendo o banco. O IP basta para conter abuso; o token em si tem 256 bits e reuso revoga a sessão (ADR 0007/0017).
- Nos pedidos, o limite roda **depois** do guard de cliente: requisição anônima nunca gasta a cota de um cliente. Retentativa com a mesma `Idempotency-Key` conta, porque também custa uma transação; dez em dez minutos fica muito acima de um cliente real.
- O 429 do refresh de equipe **não** apaga o cookie: a sessão continua válida, só o IP espera.
- O app apagava o refresh token antes de enviá-lo (para nunca repetir um token gasto, ADR 0022). Como o 429 é respondido antes de a API ler o token, o app agora o grava de volta quando o refresh recebe 429, a menos que um login ou logout tenha assumido a sessão nesse meio-tempo. Qualquer outra falha continua consumindo o token.
- **Recuperação de senha** não existe (depende do provedor de e-mail, Q-12). Quando existir, entra em `LIMIT_POLICIES` por IP e por conta.
- Login de equipe, segundo fator, login de cliente e a página de exclusão continuam com o bloqueio progressivo de falhas (`LoginThrottle`), que conta só falhas e cresce até 15 minutos.

### IP do cliente e proxy confiável

- `API_TRUSTED_PROXIES`: lista de IPs exatos (nunca CIDR nem nome). Se o par TCP não é um deles, ele é o cliente e `X-Forwarded-For` é ignorado.
- De um par confiável, `X-Forwarded-For` é lido **da direita para a esquerda** (revisado na PR #47): cada endereço foi acrescentado pelo salto anterior. Endereços que também são proxies confiáveis são pulados; o primeiro que não é, é o cliente. O que estiver à esquerda dele foi escrito pelo próprio cliente ou por saltos não confiáveis e nunca é usado, então o cliente não escolhe o IP em que é contado. Uma entrada que não é IP válido interrompe a leitura e vale o último salto confiável (todas essas requisições dividem a cota do proxy, em vez de usar um endereço forjado). O mesmo vale sem cabeçalho ou com só proxies confiáveis nele. No máximo 16 saltos são lidos.
- **Configuração esperada do Caddy na frente da API:** o Caddy, sem `trusted_proxies`, já descarta o `X-Forwarded-For` que o cliente manda e escreve só o endereço que viu. Para deixar isso explícito, use `header_up X-Forwarded-For {client_ip}` no `reverse_proxy` (é o que o `ops/Caddyfile` da landing faz com `{remote_host}`), e em `API_TRUSTED_PROXIES` só o IP fixo do Caddy na rede do Docker. Se um dia houver CDN ou balanceador antes do Caddy, a confiança nele se configura no Caddy (`servers { trusted_proxies static <faixas da CDN> }`, que aceita CIDR); `{client_ip}` passa a ser o cliente real e a API continua confiando só no Caddy. Nunca listar em `API_TRUSTED_PROXIES` um endereço que clientes alcançam diretamente.
- Um middleware resolve o IP uma vez por requisição (`clientIpOf`). Todos os pontos que usavam `req.socket.remoteAddress` ou `req.ip` (bloqueio de login, página de exclusão, auditoria de plataforma) passam a usá-lo.

### Cabeçalhos na API

Um middleware, antes de todos os outros, põe em toda resposta (inclusive erros e rotas desconhecidas):

```text
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

JSON e imagens não precisam de script, estilo nem moldura. As páginas `/lojas/...` trocam a CSP pela sua (ADR 0030). `X-Powered-By` já era removido. **HSTS** fica no proxy que termina TLS, como na landing; o checklist exige conferir isso ao provisionar.

### Matriz de isolamento e tabelas

- `GET /customer/stores/{slug}/me/orders/{orderId}` entra na matriz: um cliente da loja A pedindo o pedido da loja B recebe 404 nas duas direções.
- Novo teste em `tenant-isolation.test.ts`: para **toda** tabela de produção com `tenant_id` (lida do catálogo do PostgreSQL, sem lista fixa), `whiteoven_app` não vê nenhuma linha da outra loja dentro do contexto de uma loja, nem nenhuma linha sem contexto. Tabela sem `SELECT` para o papel conta como isolada. O teste confere também que as fixtures povoam as tabelas que as rotas da matriz tocam.

### Confirmação de MFA dos operadores

- `pnpm api:check-operators-mfa`: conecta como `whiteoven_app`, só lê, lista quantos operadores ainda podem entrar (status diferente de `DISABLED`) e os **ids** dos que não têm MFA ativo. Sai com 0 quando todos têm, 2 quando algum não tem.
- Não muda a regra de M1.4: `PlatformGuard` já recusa toda rota de plataforma sem segundo fator.

## Consequências

- Clientes atrás de um mesmo NAT (Wi-Fi do shopping, rede da própria pizzaria) dividem o IP. Os tetos por IP foram escolhidos com folga para isso; se o piloto mostrar 429 legítimo, ajusta-se `LIMIT_POLICIES` com o motivo registrado aqui.
- Os testes que não tratam de limite usam `unlimitedRequestLimits()` (mesmos nomes e escopos, sem teto); `security.test.ts` usa tetos pequenos para provar cada rota.
- Com mais de uma instância da API, cada uma conta sozinha e o teto efetivo multiplica. Antes de escalar, mover limites e bloqueio para um armazenamento compartilhado.
- O checklist de [segurança](../operations/security-review.md) precisa ser assinado pelo responsável e repetido no ambiente do piloto (MFA, HSTS, proxy confiável).
