# ADR 0012: painel administrativo Angular

- **Status:** implementado em M3.1
- **Data:** 2026-10-25
- **Milestone:** M3.1

## Contexto

O painel (`apps/admin`) é usado por donos, gerentes e equipe das pizzarias e pelos operadores da plataforma. Ele consome a autenticação da equipe do [ADR 0007](0007-staff-authentication.md): access token EdDSA de 15 minutos no corpo da resposta e refresh token rotativo em cookie `__Secure-wo_staff_refresh` (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/v1/admin/auth`), aceito só com `Origin` listada em `API_ADMIN_ORIGINS`.

## Decisão

- **Angular 21** (standalone, zoneless, signals, guards e interceptors funcionais, Reactive Forms). Angular 22 exige TypeScript 6, e o monorepo segue em TypeScript 5.9; a atualização fica para uma PR própria do monorepo inteiro.
- **Mesma origem:** o painel é servido com `/v1` encaminhado para a API (em desenvolvimento, `proxy.conf.json` para `127.0.0.1:3000`; em produção, o mesmo proxy reverso). O cookie `SameSite=Strict` e o caminho `/v1/admin/auth` funcionam sem CORS, e o painel não precisa conhecer a URL da API.
- **Access token só em memória** (signal no serviço `Session`), nunca em `localStorage`, `sessionStorage` ou cookie legível. Ao abrir ou recarregar a página, `provideAppInitializer` chama `POST /v1/admin/auth/refresh`; o cookie restaura a sessão sem expor o token ao JavaScript.
- **Renovação:** o interceptor anexa o `Bearer` a `/v1/*` (exceto login, MFA, refresh e logout). Um `401 UNAUTHORIZED` dispara um único refresh compartilhado por todas as requisições concorrentes (o refresh token rota e o reuso revoga a família) e repete a requisição uma vez; falha no refresh limpa a sessão e leva a `/entrar`.
- **MFA:** o login responde token ou desafio; o desafio pede TOTP ou código de recuperação. Operador sem segundo fator (`403 MFA_REQUIRED` em `/v1/platform/me`) só acessa `/seguranca/mfa` até ativar, recebendo os códigos de recuperação uma vez.
- **Lojas e papéis:** `/lojas` lista as lojas da pessoa e ativa uma com `POST /active-tenant` (entrada direta quando há uma só). As rotas da loja (`/loja/...`) declaram os papéis permitidos (`OWNER`, `MANAGER`, `STAFF`); a navegação mostra só as seções do papel, e um guard redireciona quem abre outra pelo endereço. A API continua sendo a autoridade: os guards do painel só evitam telas que responderiam `403`.
- **Plataforma:** `/plataforma` exige operador com sessão de segundo fator. O conteúdo chega em M3.2.
- **Tokens visuais:** `@whiteoven/design-tokens` vira variáveis CSS `--wo-*` no boot, com a mesma nomenclatura da landing.
- **Testes:** unidade com Vitest via `ng test`; E2E com Playwright contra a API real e PostgreSQL 17 (`apps/api/test/e2e-server.ts` cria um banco descartável com lojas, equipe e operador sintéticos e o apaga ao encerrar).

## Alternativas descartadas

- **Token em `localStorage`:** sobrevive ao reload sem refresh, mas qualquer XSS o lê.
- **Painel em outra origem com CORS:** exigiria `SameSite=None` ou subdomínio e configuração de CORS com credenciais, sem ganho para o MVP.
- **Angular 22 já:** forçaria TypeScript 6 em todos os pacotes nesta PR.

## Consequências

- O deploy do painel precisa de um proxy reverso que sirva os estáticos e encaminhe `/v1` para a API na mesma origem, e essa origem entra em `API_ADMIN_ORIGINS`.
- Em desenvolvimento, `API_ADMIN_ORIGINS=http://localhost:4200` no `.env` da API habilita refresh e logout pelo `pnpm admin:dev`.
- Cada nova seção da loja declara seus papéis em `apps/admin/src/app/shell/navigation.ts`, e o endpoint correspondente mantém o `@AdminRoute(...)` equivalente.
