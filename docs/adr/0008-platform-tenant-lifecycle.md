# ADR 0008: operações de plataforma e ciclo de vida do tenant

- Status: aceita com a implementação M1.5.
- Data: 2026-10-24.
- Decisores: Product Owner e equipe WhiteOven.

## Contexto

O M1.5 precisa criar tenants, entregar ao operador um convite OWNER de uso único, suspender e reativar lojas e registrar as ações. O papel da API (`whiteoven_app`) não recebe DML nas tabelas globais `tenants` e `audit_events`, nem políticas RLS que leiam vários tenants. O M1.4 já exige MFA TOTP para qualquer rota `@PlatformRoute()`.

A suspensão também precisa rejeitar pedidos `PLACED` na mesma transação, embora o agregado completo de pedidos esteja planejado para M4.

## Decisões

1. A API continua conectando apenas como `whiteoven_app`. Três funções `SECURITY DEFINER` estreitas criam/listam tenants e alteram seu status; uma quarta resgata convites. O grant é só `EXECUTE`, nunca DML geral nas tabelas globais. As rotas de mutação usam `PlatformGuard`, que verifica operador, MFA habilitado e MFA na sessão. As funções definem `search_path` fixo e atualizam auditoria junto com a operação.
2. A criação exige `Idempotency-Key`; a chave e o pedido são persistidos apenas como SHA-256. Um HMAC sob `OWNER_INVITE_SECRET`, segredo exclusivo, persistente e independente da chave JWT, deriva o token para que retries idênticos retornem o mesmo link após restart. Reutilizar a chave com outro conteúdo responde conflito. O convite guarda somente SHA-256 do token, vence em 72 horas e é consumido sob lock. Uma tabela global de lookup indexada por hash mapeia para tenant/convite e pode ser acessada somente pelas funções privilegiadas; o resgate não enumera tenants. O fallback de Q-12 é mostrar o link ao operador, sem enviar e-mail. O resgate cria usuário e membership OWNER na mesma transação.
3. `audit_events` é append-only e global porque `tenant_id` é nulo para ações da plataforma. `whiteoven_app` não tem SELECT/INSERT/UPDATE/DELETE; apenas as funções de plataforma podem acrescentar os eventos necessários. A checagem de isolamento reconhece essa exceção explícita e falha se o app receber privilégio direto.
4. M1.5 introduz `orders` apenas com id, tenant, status e timestamps necessários ao efeito de suspensão. A função suspende o tenant, atualiza todos os `PLACED` para `REJECTED` com `STORE_SUSPENDED`, revoga somente sessões de MANAGER/STAFF com `active_tenant_id` igual à loja suspensa e grava auditoria sob locks e na mesma transação. Sessões globais ativas em outra loja e seus memberships permanecem válidos. Modelagem de itens, valores, idempotência e máquina completa de estados continua em M4.

## Consequências

- A criação, troca de status, rejeição de pedidos e auditoria são atômicas no PostgreSQL.
- Operadores autenticados por senha sem TOTP não alcançam as rotas de plataforma.
- Não há fornecedor ou envio externo de e-mail.
- A auditoria global não pode ser consultada diretamente pela API; exposição de leitura exigirá uma decisão e uma operação dedicada.
- Ao construir M4, a migration de pedidos amplia o esquema e substitui os estados mínimos sem renomear a migration M1.5.
