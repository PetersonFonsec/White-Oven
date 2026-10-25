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
- **Login** com a mesma resposta para e-mail desconhecido e senha errada (uma verificação Argon2id em ambos) e bloqueio progressivo por conta e por IP. O bloqueio é uma instância separada da equipe, e a chave da conta inclui a loja.
- **Cadastro** grava `privacyPolicyVersion` e `acceptedAt`. A versão é a que o app mostrou; o texto e a validação da versão vigente chegam em M7.2. Um e-mail ou telefone já usado na loja responde `409 EMAIL_TAKEN` ou `PHONE_TAKEN`.
- **Exclusão da conta** (`DELETE me` com a senha de novo, para que um access token roubado não baste):
  - Numa transação, `name`, `email`, `phone` e `password_hash` viram nulos, o status vira `DELETED`, os endereços são apagados e todas as sessões são revogadas (`ACCOUNT_DELETED`).
  - O `id` fica para os pedidos.
  - Restrições `check` garantem que um cliente `DELETED` não guarda dado pessoal. A app não tem `DELETE` em `customers` nem em `customer_sessions`.
  - E-mail e telefone ficam livres para uma conta nova.
- **Endereços:** até 10 por conta, CEP guardado só com dígitos, UF em maiúsculas, sem geocodificação. Endereço de outro cliente ou de outra loja é `404`.

## Consequências

- **Recuperação de senha** por link de uso único (30 minutos) fica para quando a Q-12 (provedor de e-mail) for decidida. Até lá, quem esquece a senha não recupera a conta.
- **Cadastro e enumeração.** O cadastro revela se um e-mail já tem conta na loja (`409`). Sem e-mail de confirmação não há como evitar isso sem piorar o uso. O login não revela.
- **Rate limit** em memória, uma instância, como o da equipe (ADR 0002 e 0007). Rever antes de escalar.
- **Pedidos (M4.3)** usarão `customer:{customerId}` como escopo da `OrderCreationKey`, e o pedido copiará o endereço (snapshot).
