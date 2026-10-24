# ADR 0007 — Autenticação da equipe, sessões e vínculos (M1.4, D-02)

- **Status:** Proposto para M1.4 (parte A: identidade, sessões, vínculos e guards; parte B: MFA TOTP, `PlatformGuard` e CLI do primeiro operador)
- **Data:** 2026-10-24

## Contexto

O [roadmap](../architecture/mvp-roadmap.md) define M1.4 como: `StaffUser`, `Membership`, login, refresh rotativo, logout, troca de tenant ativo, guards e papéis, bloqueio por tentativas, MFA TOTP e CLI do primeiro operador, formalizando D-02 de [system-overview](../architecture/system-overview.md#decisões-arquiteturais-propostas). Critérios de aceite: senhas com Argon2id; reuso de refresh revoga a sessão; vínculo revogado perde acesso em até 60 s; rotas sem guard falham em teste; operador sem MFA recebe 403 em toda rota de plataforma. M1.3 ([ADR 0006](0006-tenant-isolation.md)) deixou pendente o teste obrigatório 7 (revogação), que depende de vínculos.

O escopo inteiro passa de "algumas centenas de linhas de produção" por PR, então M1.4 foi dividida em duas PRs:

- **M1.4 parte A:** identidade global da equipe, vínculos por tenant, sessões com refresh rotativo, troca de tenant, `StaffGuard` e papéis, declaração obrigatória de acesso em toda rota, bloqueio progressivo e teste 7.
- **M1.4 parte B:** MFA TOTP (cadastro, verificação no login, códigos de recuperação), `PlatformGuard` (403 sem `mfa = true`), restrição do operador sem MFA ao cadastro do segundo fator e CLI do primeiro operador. Nenhuma rota de plataforma existe antes dela.

## Decisão

### Dados (migration `Migration20261024020000_staff_identity`)

- **`staff_users`** (global, D-03): `email` único e normalizado (`lower(btrim())`, verificado por `CHECK`), `name`, `password_hash` (só `$argon2id$`), `platform_role` (`NONE`, `OPERATOR`), `status` (`INVITED`, `ACTIVE`, `DISABLED`), `last_login_at`. Colunas de MFA na parte B (abaixo).
- **`staff_sessions`** (global): uma linha por login, com `active_tenant_id`, `mfa`, `refresh_token_hash` (SHA-256 de 32 bytes), `idle_expires_at` (12 h deslizantes), `revoked_at` e `revoked_reason` (`LOGOUT`, `REFRESH_REUSE`, `USER_DISABLED`).
- **`memberships`** (tenant): `tenant_id`, `staff_user_id`, `role` (`OWNER`, `MANAGER`, `STAFF`), `status` (`INVITED`, `ACTIVE`, `REVOKED`), `unique (tenant_id, staff_user_id)`, `unique (tenant_id, id)`, RLS forçado por `tenantIsolationSql`, filtro `tenant` no ORM. É a primeira tabela de tenant de produção e entra nos testes 1, 2 e 7.
- `whiteoven_app` não tem `DELETE` nessas três tabelas: usuário é desativado, sessão e vínculo são revogados por status.
- **Listar vínculos de um usuário entre tenants** (seletor de loja depois do login): função `whiteoven_staff_memberships(staff_user_id)`, `security definer`. Como `FORCE ROW LEVEL SECURITY` filtra também o dono da tabela (o problema já descrito no ADR 0006), a função não contorna a política: percorre os tenants não `CLOSED`, define `app.tenant_id` (local à transação) para cada um, lê só as linhas daquele usuário sob a checagem normal de tenant e restaura o valor do chamador. Nenhuma política mais larga que a checagem de tenant foi criada, então o teste de cobertura de RLS continua sem exceções. Custo O(tenants) por chamada, aceitável no piloto; rever se o número de tenants crescer.

### Senhas

- Argon2id com os parâmetros mínimos da OWASP (m = 19 MiB, t = 2, p = 1) via `@node-rs/argon2` (binários pré-compilados, sem script de instalação). O `node:crypto` só tem Argon2 a partir do Node 24.7, e a CI e a imagem usam 22.
- Senhas são normalizadas em NFC antes de hash e verificação. Política para novas senhas (`passwordProblem`): 10 a 256 caracteres, sem regras de composição, recusadas as de uma lista local curta de senhas comuns. Ela será usada pela CLI e pelos convites; esta PR não cria senhas.
- E-mail inexistente também executa uma verificação Argon2id (hash fictício), para que o tempo de resposta não revele contas.

### Tokens e sessões

- **Access token**: JWS compacto EdDSA (Ed25519) assinado com `node:crypto`, sem biblioteca JWT. O cabeçalho é fixo e comparado byte a byte, então `alg: none` ou troca de algoritmo não são negociáveis. Claims: `sub`, `typ = staff`, `tid` (tenant ativo ou `null`), `sid`, `mfa`, `iss`, `aud`, `iat`, `exp` (15 min). Chave em `AUTH_ACCESS_TOKEN_PRIVATE_KEY` (PKCS#8 DER em base64), obrigatória em produção; fora dela, sem a variável, a API gera uma chave efêmera no boot (tokens morrem com o processo).
- **Refresh token**: `<sessionId>.<segredo>` com 32 bytes aleatórios; só o SHA-256 do segredo é guardado. Gira a cada uso dentro de uma transação com `select ... for update`. Um segredo que não confere com o atual é tratado como reuso de token já girado (ou roubado) e **revoga a sessão inteira** (`REFRESH_REUSE`); o token novo emitido antes também deixa de valer. Usuário desativado revoga a sessão no próximo refresh.
- **Cookie**: `__Secure-wo_staff_refresh`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/v1/admin/auth`. Refresh e logout exigem um cabeçalho `Origin` listado em `API_ADMIN_ORIGINS`; cabeçalho ausente ou origem não permitida recebe 403 `ORIGIN_NOT_ALLOWED`. A lista é vazia por padrão, então essas rotas recusam chamadas até que a origem do painel seja configurada. Clientes sem `Origin` (não navegadores) também são recusados nessas rotas de cookie.
- **Validade**: sessão de equipe desliza 12 h a cada refresh. Sem limite absoluto, como no system-overview; um teto absoluto pode ser decidido depois sem mudar o esquema.

### Rotas

| Método e caminho                    | Acesso     | Função                                                                    |
| ----------------------------------- | ---------- | ------------------------------------------------------------------------- |
| `POST /v1/admin/auth/login`         | `public`   | E-mail e senha; devolve access token (sem tenant) e cookie de refresh.    |
| `POST /v1/admin/auth/refresh`       | `public`   | Gira o cookie; mantém o tenant ativo enquanto o vínculo existir.          |
| `POST /v1/admin/auth/logout`        | `public`   | Revoga a sessão do cookie e o apaga; idempotente (204).                   |
| `GET /v1/admin/auth/tenants`        | `staff`    | Lojas em que o usuário pode entrar agora.                                 |
| `POST /v1/admin/auth/active-tenant` | `staff`    | Troca o tenant ativo e emite token com o novo `tid`.                      |
| `GET /v1/admin/me`                  | `admin`    | Usuário e papel no tenant ativo; primeira rota da superfície `/v1/admin`. |
| `POST /v1/admin/auth/login/mfa`     | `public`   | Segundo passo do login: código TOTP ou de recuperação (parte B).          |
| `POST /v1/admin/auth/mfa/setup`     | `staff`    | Inicia o cadastro do TOTP; permitido a operador sem MFA (parte B).        |
| `POST /v1/admin/auth/mfa/activate`  | `staff`    | Confirma com o primeiro código; devolve códigos de recuperação (parte B). |
| `GET /v1/platform/me`               | `platform` | Operador autenticado; primeira rota de plataforma (parte B).              |

- O `tenantId` da troca de tenant vem do corpo, mas não concede nada sozinho: precisa de vínculo `ACTIVE`, lido dentro do contexto daquele tenant. Tenant inexistente, sem vínculo, revogado ou que não admite o papel respondem o mesmo 404. Nas demais rotas o tenant vem só do `tid` do token verificado.
- Login aplica a linha de login da [matriz por status](../architecture/domain-model.md#capacidades-por-status-do-tenant): `ONBOARDING` e `ACTIVE` admitem todos os papéis, `SUSPENDED` só o OWNER, `CLOSED` ninguém. A matriz completa continua com `TenantStatusPolicy` em M1.5.
- Respostas de credencial inválida, usuário inexistente e usuário desativado são idênticas (401 `INVALID_CREDENTIALS`).

### Guards e declaração de acesso

- Toda rota declara acesso por metadado (`ROUTE_ACCESS`): `@PublicRoute()`, `@StoreTenant()`, `@StaffRoute()` ou `@AdminRoute(...papéis)`. Um `RouteAccessGuard` global, primeiro da fila, recusa com 403 e registra em log toda rota sem declaração (falha fechada), e um teste descobre todas as rotas e falha se alguma não declarar. Assim "rota sem guard" falha na CI e também em runtime.
- `StaffGuard` verifica o token e pergunta a `StaffAuth.authorize` se a sessão está viva e o usuário ativo; em rotas `admin`, também se o vínculo no `tid` está `ACTIVE` e o status do tenant admite o papel. Depois confere os papéis exigidos em código (403 `ROLE_FORBIDDEN`), registra `tenantId` no log de acesso e vincula o `TenantContext` (`actor: { type: "staff", staffUserId, sessionId, role }`), então `TenantTransactions.run` funciona como na superfície pública.
- **Sem cache de autorização**: `authorize` lê sessão, usuário e vínculo no PostgreSQL a cada requisição. A primeira versão guardava respostas positivas por até 60 s; a revisão de segurança removeu o cache porque ele deixava um papel antigo, um vínculo revogado, um usuário desativado ou uma sessão encerrada em outra instância valerem até o TTL. Custo: duas consultas indexadas por requisição autenticada, aceitável no MVP. Revogação, troca de papel, desativação e logout valem na próxima requisição de qualquer instância da API.
- **Recheck com lock na transação do tenant**: o guard verifica numa transação separada da que executa o trabalho. Para fechar essa janela, `TenantTransactions.run` com ator de equipe relê, dentro da própria transação e com `FOR SHARE`, a sessão, o usuário e o vínculo (com a mesma matriz de status do tenant). Se uma revogação, troca de papel, desativação ou logout comitou antes, o trabalho é recusado (403 `TENANT_ACCESS_DENIED` ou `ROLE_FORBIDDEN`, 401 `SESSION_INVALID`); se vier depois, espera o trabalho comitar. Um papel diferente do validado pelo guard é recusado mesmo que o novo também fosse permitido (o cliente repete a requisição). O status do tenant é relido, mas não travado, porque `whiteoven_app` só lê `tenants`; uma suspensão concorrente vale a partir da próxima transação.
- **Troca de tenant e refresh** rodam numa transação que trava a linha da sessão (`FOR UPDATE`) e lê o vínculo com `FOR SHARE` sob o contexto do tenant. Troca, refresh e logout da mesma sessão ficam serializados, e uma revogação concorrente ou comitou antes (a troca responde 404 e nada é gravado) ou espera a troca terminar (o token emitido para de funcionar na requisição seguinte). O refresh limpa o tenant ativo revogado dentro da mesma transação, então não sobrescreve uma troca concorrente.

### MFA TOTP e plataforma (parte B, migration `Migration20261024030000_staff_mfa`)

- **Algoritmo**: RFC 6238 com os padrões que todo aplicativo autenticador entende (SHA-1, 6 dígitos, 30 s), segredo de 160 bits, tolerância de um passo para cada lado. Implementado com `node:crypto` (validado pelos vetores do RFC), sem dependência. O passo aceito é guardado em `mfa_last_used_step` e só passos posteriores valem: o mesmo código não abre duas sessões.
- **Segredo em repouso**: AES-256-GCM com chave fora do banco (`AUTH_MFA_ENCRYPTION_KEY`, 32 bytes em base64, obrigatória em produção; fora dela, sem a variável, chave efêmera com aviso no log) e o id do usuário como dado associado, então um segredo copiado para outra linha não decifra. Formato `v1.<iv>.<cifrado>.<tag>`, verificado por `CHECK`. Durante o cadastro o segredo fica em `mfa_pending_secret` até a ativação; `CHECK` garante que MFA ativo sempre tem segredo.
- **Cadastro**: `mfa/setup` devolve o segredo e a URI `otpauth://` uma única vez (sem cache); `mfa/activate` exige um código válido, liga o MFA, gera 10 códigos de recuperação e promove a sessão atual a `mfa = true` com novo access token. Quem já tem MFA recebe 409. Desligar ou redefinir o MFA fica para quando houver `AuditEvent` (M1.5): a redefinição exige outro operador e auditoria.
- **Códigos de recuperação**: `xxxxx-xxxxx` (50 bits aleatórios), mostrados uma vez, guardados só como SHA-256 (alta entropia dispensa hash lento), aceitos com ou sem hífen e em qualquer caixa, removidos ao usar.
- **Login com MFA**: senha correta de quem tem MFA não cria sessão; devolve `{ mfaRequired: true, mfaToken, expiresIn: 300 }`. O `mfaToken` é opaco, de uso único, vale 5 min e 5 tentativas, guardado em memória por hash (como o bloqueio). Erros de código contam no bloqueio progressivo da conta. Toda verificação de código roda com `select ... for update` do usuário, então requisições concorrentes não aceitam o mesmo passo ou código de recuperação duas vezes.
- **Ciclo do desafio** (revisão de segurança): `beginVerification` reserva o desafio de forma síncrona antes de qualquer `await`, então só uma verificação por desafio roda por vez; uma concorrente recebe 401 `MFA_CHALLENGE_INVALID` sem tocar no banco (e não gasta um código de recuperação). O fator é consumido e a sessão criada **na mesma transação**: um erro de banco desfaz as duas coisas e libera o desafio sem contar tentativa (`release`); código errado conta tentativa (`recordFailure`); só depois do commit o desafio é consumido. Desafio expirado é recusado mesmo se ficou reservado.
- **Várias instâncias**: o MVP roda uma instância. Com mais de uma, o desafio só existe na instância que o emitiu e falha fechado nas outras (401, entrar de novo); os fatores continuam de uso único entre instâncias porque passo TOTP e códigos de recuperação são consumidos no PostgreSQL sob lock. Escalar exige roteamento fixo do login ou um armazenamento compartilhado para desafios e bloqueio; Redis não entra agora porque não há segunda instância.
- **Ativação**: trava a linha do usuário, liga o MFA e promove a sessão na mesma transação; a sessão precisa existir, pertencer ao usuário, não estar revogada nem expirada, e exatamente uma linha precisa ser atualizada. Senão a ativação inteira é desfeita e nenhum token é emitido (401 `SESSION_INVALID`). Duas ativações simultâneas: a segunda espera o lock e recebe 409.
- **Operador**: `platform_role = OPERATOR` só tem efeito com sessão `mfa = true`. Sem isso o `StaffGuard` responde 403 `MFA_REQUIRED` em toda rota, exceto as marcadas `@StaffRoute({ allowWithoutMfa: true })` (só `mfa/setup` e `mfa/activate`). `@PlatformRoute()` acrescenta o `PlatformGuard`: papel `OPERATOR` (senão 403 `PLATFORM_FORBIDDEN`) e `mfa = true` no token **e** na sessão do banco (senão 403 `MFA_REQUIRED`). Token emitido antes da ativação continua recusado nas rotas de plataforma.
- **Equipe da loja**: MFA opcional, pelo mesmo fluxo; obrigatoriedade para OWNER continua questão de produto.
- **CLI do primeiro operador**: `pnpm api:create-operator <email> <nome>` (ou `node dist/auth/create-operator.js` na imagem), senha pela entrada padrão, nunca por argumento ou variável. Usa a configuração da API (`whiteoven_app`, mesmas verificações de papel), valida e-mail, nome e política de senha e recusa (código 3) se já existir operador ou o e-mail; corridas são serializadas por `pg_advisory_xact_lock`. O operador nasce sem MFA e no primeiro login só alcança o cadastro do segundo fator.

### Bloqueio progressivo

- Por conta (SHA-256 do e-mail normalizado, exista a conta ou não) e por IP: depois de 5 falhas da conta ou 30 do IP, cada nova falha bloqueia por 30 s, dobrando até 15 min; falhas com mais de 1 h são esquecidas; sucesso limpa a conta. Bloqueado responde 429 `RATE_LIMITED` com `Retry-After`, inclusive com a senha correta.
- Memória do processo, como os limites da landing ([ADR 0002](0002-lead-capture.md)): uma instância no MVP, zera no restart, revisar antes de escalar. O IP é o par TCP até a API ser publicada atrás de um proxy confiável; essa configuração entra com o deploy da API.

### Testes (PostgreSQL real)

- `staff-auth.test.ts`: login e cookie, Argon2id, respostas idênticas, validação de corpo, bloqueio (conta existente e inexistente), seletor de lojas por status e vínculo, troca de tenant, contexto do tenant sob RLS, tokens adulterados ou de outra chave, papéis, rotação e reuso de refresh, vínculo revogado no refresh, sessão expirada, usuário desativado, `Origin`, logout, ausência de `DELETE` para a app e a função de vínculos.
- `tenant-isolation.test.ts`: `GET /v1/admin/me` entra na lista de rotas de tenant; `memberships` aparece como tabela de tenant de produção na cobertura de RLS; **teste 7** implementado: vínculo revogado responde 403 `TENANT_ACCESS_DENIED` já na requisição seguinte, e o token não consegue reativar o tenant nem trocar para outro.
- `staff-auth-consistency.test.ts`: troca de OWNER para STAFF, revogação, usuário desativado e sessão revogada valendo na requisição seguinte; tenant sem vínculo; trabalho de tenant que passou pelo guard recusado quando troca de papel ou revogação comita antes, e revogação esperando o trabalho em andamento; troca de tenant concorrente com revogação e com refresh (nas duas ordens, com a linha da sessão travada para forçar a disputa); duas instâncias da API com a mesma chave e nenhum estado compartilhado além do banco.
- `auth-units.test.ts`: tokens (expiração, chave, algoritmo, claims), progressão do bloqueio e política de senha.
- `staff-mfa-consistency.test.ts` (parte B, revisão de segurança): ciclo do desafio em unidade (reserva, uso único, tentativas, `release`, expiração); com PostgreSQL, mesmo desafio e mesmo TOTP ao mesmo tempo, TOTP e código de recuperação no mesmo desafio, mesmo fator em dois desafios em duas instâncias, reuso de código de recuperação, cinco erros, erro de banco ao criar a sessão (nada é gasto e o mesmo desafio funciona depois), desafio de outra instância, sessão revogada ou expirada durante a ativação, duas ativações simultâneas e operador sem segundo fator válido.
- `staff-mfa.test.ts` (parte B): cadastro, código errado, 409 de recadastro, segredo cifrado e preso ao usuário, login em dois passos, desafio de uso único, replay de código, códigos de recuperação de uso único, limite de tentativas, operador sem MFA restrito ao cadastro, plataforma só com segundo fator (token e banco), equipe da loja barrada na plataforma e a CLI (entrada padrão, códigos de saída, segundo operador recusado).
- `totp.test.ts`: vetores do RFC 6238, janela de tolerância, replay, base32, códigos de recuperação e `SecretBox`.

## Alternativas consideradas

- **Biblioteca JWT (`jose`, `jsonwebtoken`)**: resolveria o mesmo com mais superfície (vários algoritmos, JWK, JWE). Com um único algoritmo fixo, `node:crypto` basta e evita dependência.
- **Passport/`@nestjs/passport`**: estratégia de sessão e guards já são poucos e explícitos; Passport acrescentaria indireção sem ganho.
- **Refresh com tabela de tokens (família)**: guardar cada token emitido permite distinguir reuso de token antigo de um segredo aleatório. Com o identificador da sessão no token e um único hash atual, qualquer segredo errado para uma sessão viva revoga a sessão: mais simples e mais conservador. O custo é que um atacante que conheça o `sid` (presente só nos tokens do próprio usuário) consegue derrubar a sessão, não usá-la.
- **Política de RLS extra em `memberships` para listar vínculos por usuário**: exigiria abrir uma exceção no teste de cobertura; a função que percorre tenants mantém a regra de que toda política permissiva é a checagem de tenant.
- **Bloqueio por conta no banco**: sobrevive a restart, mas só existe para contas reais e revelaria quais e-mails estão cadastrados; em memória, por hash de e-mail, trata contas inexistentes igual.
- **Contratos em `packages/contracts`**: o pacote é ESM com fontes `.ts` e ainda não é consumido pela API (CommonJS compilada por `tsc`, imagem Docker filtrada). Ligar o pacote ao build da API é decisão de infraestrutura que fica para a primeira PR de catálogo (M2.3); por ora a validação dos corpos de autenticação fica na API, com a mesma regra de campos exatos.

## Questões em aberto e dependências

- **Q-12 (e-mail transacional)**: não bloqueia esta parte. Recuperação de senha e convite por e-mail ficam fora até a decisão; convite de OWNER (M1.5) exibirá o link ao operador, como o roadmap prevê.
- Redefinição de MFA por outro operador exige `AuditEvent` (M1.5); até lá, um operador que perder o autenticador e os códigos de recuperação precisa de intervenção manual no banco.
- Auditoria de login da equipe entra com `AuditEvent` em M1.5; até lá ficam `last_login_at` e os logs de acesso sem dados pessoais.

## Consequências

- Toda nova rota precisa de uma declaração de acesso; sem ela a rota responde 403 e a CI falha.
- Toda rota da equipe dentro de uma loja usa `@AdminRoute(...)`, que já entrega o `TenantContext`; ela entra na matriz de isolamento como qualquer rota de tenant.
- Produção exige `AUTH_ACCESS_TOKEN_PRIVATE_KEY` e `AUTH_MFA_ENCRYPTION_KEY`. Perder a chave de MFA invalida todos os segredos TOTP (os operadores precisariam recadastrar), então ela entra no mesmo cofre e backup dos demais segredos.
- Produção exige `AUTH_ACCESS_TOKEN_PRIVATE_KEY`. Trocar a chave invalida access tokens (no máximo 15 min de impacto); sessões continuam e emitem tokens novos no refresh.
