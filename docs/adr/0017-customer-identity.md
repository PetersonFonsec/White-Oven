# ADR 0017: identidade e conta do cliente

- **Status:** implementado em M4.2
- **Data:** 2026-10-29
- **Milestone:** M4.2

## Contexto

A Q-05 foi decidida pelo PO em 2026-10-25: o cliente entra com **e-mail e senha** e a **conta é obrigatória** para pedir no MVP; não há pedido sem conta. O [modelo de domínio](../architecture/domain-model.md#customer) já prevê `Customer` por tenant (D-03), `customerId` obrigatório no pedido e exclusão por anonimização. O [system-overview](../architecture/system-overview.md#regras) fixa as regras de autenticação própria: Argon2id, access token de 15 minutos, refresh opaco com rotação e detecção de reuso, 30 dias para cliente. Ainda não há provedor de e-mail (Q-12).

## Decisão

- **Cliente pertence a uma loja.** `customers`, `customer_sessions` e `customer_addresses` são tabelas de tenant com RLS forçada e chaves estrangeiras compostas por `tenant_id`. O mesmo e-mail em duas lojas é dois clientes, com senhas independentes. E-mail (normalizado em minúsculas) e telefone (E.164, opcional) são únicos por loja.
- **Rotas:**
  - Sem token, com a loja vinda do slug (`@StoreTenant`):
    - `POST /v1/customer/stores/{slug}/auth/register`, só com a loja `ACTIVE` (capacidade `customerSignup`);
    - `auth/login`, `auth/refresh` e `auth/logout`, também com a loja `SUSPENDED` ou `CLOSED` (`customerAccount`), para o cliente poder ler e excluir a conta, como manda a matriz de status.
  - Com token de cliente (`@CustomerRoute`): `GET`/`DELETE me` e `me/addresses`. Escrever endereços exige loja `ACTIVE` (`customerAccountWrite`, nova capacidade).
- **Token de cliente.**
  - Mesmo `AccessTokens` (EdDSA, 15 minutos), com outra audiência (`whiteoven-app`) e `typ: customer`. `tid` é obrigatório e não há `mfa`.
  - Rotas de equipe recusam token de cliente e vice-versa, pela audiência e pelo `typ`.
  - O `CustomerTokenGuard` declara o `tid` e o `StoreTenantGuard` compara com o slug: token da loja A na URL da loja B responde 404 (T-03).
  - O `CustomerSessionGuard` lê a sessão e o cliente no PostgreSQL a cada requisição. `TenantTransactions.run` repete a verificação com `FOR SHARE` na transação do trabalho, como faz para a equipe. Logout e exclusão valem na requisição seguinte.
- **Refresh token no corpo, não em cookie.**
  - O app guarda o token no `expo-secure-store`.
  - Formato `<sessionId>.<segredo>`; só o SHA-256 do segredo fica no banco.
  - Gira a cada uso, e o reuso de um token já girado revoga a sessão (`REFRESH_REUSE`).
  - A sessão termina **30 dias depois do login**: o refresh troca o token, mas não estende o prazo. A resposta informa `refreshExpiresAt`.
  - Como a sessão é lida sob a RLS da loja do slug, o refresh token de A apresentado em B não encontra sessão.
- **Login** com a mesma resposta para e-mail desconhecido e senha errada (uma verificação Argon2id em ambos).
- **Bloqueio progressivo do login** (`CustomerLoginThrottle`, instância separada da equipe, cujos limites não mudam):
  - Por loja: 5 falhas por conta e 30 por IP, as duas chaves com o `tenant_id`. Falhas na loja A não atrasam o login na loja B a partir do mesmo IP (NAT, Wi-Fi compartilhado).
  - Entre lojas: um teto de 300 falhas por IP, sem loja na chave, para que espalhar tentativas por muitas lojas não escape do limite.
  - O IP é o par do socket (`req.socket.remoteAddress`), nunca um cabeçalho como `X-Forwarded-For`, que o cliente controla. Atrás de proxy, só muda quando houver proxy confiável configurado.
- **Concorrência.** Toda operação que muda o cliente como um todo toma primeiro `pg_advisory_xact_lock` sobre o id do cliente (`lockCustomer`), antes de qualquer lock de linha:
  - Ordem fixa: advisory do cliente, depois a linha do cliente e as sessões (`FOR SHARE` da verificação de sessão), depois a escrita. Nenhum lock é promovido de `FOR SHARE` para `FOR UPDATE`, o que causava deadlock entre duas criações de endereço.
  - Criar endereço conta e insere sob o advisory, então duas criações com 9 endereços dão um `201` e um `409 ADDRESS_LIMIT_REACHED`. Clientes diferentes têm locks diferentes e não esperam um pelo outro.
  - A exclusão da conta toma o mesmo advisory. O login confere a senha (Argon2id) sem nenhum lock e, só então, numa transação curta, toma o advisory, relê o cliente exigindo `ACTIVE` e o mesmo `password_hash` e só aí cria a sessão. Se a exclusão chegou antes, o login responde o mesmo `401` de credencial inválida; se o login chegou antes, a exclusão revoga a sessão nova junto com as outras.
  - O refresh não toma o advisory: trava a sessão com `FOR UPDATE`, e a revogação da exclusão espera por ele ou o vê, sem ciclo.
- **Cadastro** grava `privacyPolicyVersion` e `acceptedAt`. A versão é a que o app mostrou. Desde a M7.2 ([ADR 0030](0030-legal-documents.md)) o cadastro exige também `termsOfUseVersion`, as duas precisam ser as vigentes da loja e o aceite fica em `customer_legal_acceptances`. Um e-mail ou telefone já usado na loja responde `409 EMAIL_TAKEN` ou `PHONE_TAKEN`.
- **Exclusão da conta** (`DELETE me` com a senha de novo, para que um access token roubado não baste):
  - Numa transação, `name`, `email`, `phone` e `password_hash` viram nulos, o status vira `DELETED`, os endereços são apagados e todas as sessões são revogadas (`ACCOUNT_DELETED`).
  - O `id` fica para os pedidos.
  - Restrições `check` garantem que um cliente `DELETED` não guarda dado pessoal. A app não tem `DELETE` em `customers` nem em `customer_sessions`.
  - E-mail e telefone ficam livres para uma conta nova.
- **Endereços:** até 10 por conta, CEP guardado só com dígitos, UF em maiúsculas, sem geocodificação. Endereço de outro cliente ou de outra loja é `404`.

## Consequências

- **Recuperação de senha** por link de uso único (30 minutos) fica para quando a Q-12 (provedor de e-mail) for decidida. Até lá, quem esquece a senha não recupera a conta.
- **Cadastro e enumeração.** O cadastro revela se um e-mail já tem conta na loja (`409`). Sem e-mail de confirmação não há como evitar isso sem piorar o uso. O login não revela.
- **Rate limit** em memória, uma instância, como o da equipe (ADR 0002 e 0007). Rever antes de escalar. O teto entre lojas (300) é uma estimativa e pode precisar de ajuste com tráfego real.
- **Migração.** A migration `Migration20261028000000_customer_accounts` é só de avanço, como todas (ADR 0005): o `down()` recusa, e não haverá `DROP TABLE` para permitir rollback, porque apagaria contas e dados pessoais sem trilha. Ela só acrescenta tabelas, então a versão anterior da API roda sobre o novo schema sem mudança (não lê essas tabelas). Para desfazer uma release, volta-se o código e o schema fica. Uma correção de schema é uma nova migration de avanço; restaurar backup é o último recurso, avaliado caso a caso.
- **Pedidos (M4.3)** usarão `customer:{customerId}` como escopo da `OrderCreationKey`, e o pedido copiará o endereço (snapshot).
