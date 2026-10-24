# ADR 0004 — Fundação da API (M1.1)

- **Status:** Aceito para M1.1
- **Data:** 2026-10-24

## Contexto

O [roadmap](../architecture/mvp-roadmap.md) abre M1 com uma API NestJS mínima em `apps/api`: configuração validada, `/health`, logs estruturados sem PII, erro padronizado e OpenAPI, subindo localmente e em um Compose de desenvolvimento. A stack (NestJS, TypeScript, PostgreSQL, MikroORM) e o estilo REST `/v1` com OpenAPI (D-09) já estão decididos em [system-overview](../architecture/system-overview.md). Banco, tenant e autenticação ficam para M1.2–M1.4.

## Decisão

- **NestJS 11 com Express**, compilado por `tsc` para CommonJS (`apps/api/dist`). Decorators e metadados de tipo exigem compilação; o strip de tipos do Node usado na landing não cobre decorators. Sem SWC, Jest ou CLI do Nest: `tsc` e `node:test` bastam e já são usados no monorepo.
- **Configuração** lida uma vez de `process.env` por `loadConfig`, validada à mão (sem nova dependência), congelada e injetada pelo token `API_CONFIG`. Qualquer valor inválido encerra o processo com código 1 antes de abrir a porta, listando todos os problemas pelo nome da variável, nunca pelo valor. Variáveis: `NODE_ENV`, `API_HOST`, `API_PORT`, `API_LOG_LEVEL`, `API_OPENAPI_ENABLED`. Variáveis `API_*` desconhecidas são ignoradas, porque ambientes de desenvolvimento e CI podem definir variáveis alheias com o mesmo prefixo.
- **Logs** em JSON por linha no stdout (`JsonLogger`, também usado como logger do Nest). O log de acesso grava `requestId`, método, **template da rota** (ou `<unmatched>`), status e duração. Não grava query string, corpo, cabeçalhos, IP nem user agent. Campos com nomes sensíveis (senha, token, cookie, e-mail, telefone, WhatsApp, CPF, endereço, nome) são mascarados em qualquer profundidade como segunda barreira. Erros inesperados registram só a classe e as linhas da pilha, não a mensagem, que pode conter SQL ou dados de entrada. Pino e similares foram descartados por enquanto: o volume do piloto não justifica a dependência.
- **Request id**: reaproveita `X-Request-Id` recebido apenas se tiver formato seguro (`[A-Za-z0-9._-]{8,128}`); caso contrário gera UUID. Sempre devolvido no cabeçalho e no corpo de erro.
- **Erro padronizado** `ApiErrorBody`: `{ code, message, details?, requestId }`, aplicado por um filtro global a toda exceção. `ApiError` carrega `code` e `details` de domínio. Mensagens de framework são substituídas por textos fixos (evita ecoar o caminho requisitado). Qualquer erro não HTTP vira `500 INTERNAL_ERROR` genérico. O tipo fica na API por ora; vai para `packages/contracts` quando o primeiro cliente (painel, M3.1) o consumir, pois `contracts` é ESM com fontes `.ts` e a API compila para CommonJS.
- **Rotas**: prefixo global `/v1`; `/health` fica fora do prefixo para os probes. `/health` é só liveness e não expõe versão, ambiente ou dependências; a prontidão com banco entra em M1.2.
- **OpenAPI** 3 gerado pelo `@nestjs/swagger` em `/v1/openapi.json`, sem Swagger UI (sem assets extras). Ligado por padrão fora de produção e desligado em produção, salvo `API_OPENAPI_ENABLED=true`.
- **Limites**: corpo JSON até 100 kB, `X-Powered-By` desativado, shutdown hooks do Nest para encerrar em `SIGTERM`.
- **Container e Compose**: `apps/api/Dockerfile` multi-stage na mesma base fixada por digest da landing, instalação filtrada (`--filter @whiteoven/api`), runtime como usuário `node`, healthcheck por `scripts/healthcheck.mjs`. `compose.dev.yaml` sobe só a API para desenvolvimento, em loopback, com filesystem somente leitura e capabilities removidas. O `compose.yaml` de produção não muda: deploy da API exige revisão própria.
- **CI**: `pnpm typecheck` e `pnpm test` da raiz passam a ser recursivos e incluem a API; o ESLint da raiz já cobre `apps/api`. O job `api-container` constrói a imagem, espera o healthcheck no Compose de desenvolvimento e confirma que configuração inválida impede o start.

## Consequências

- Novas variáveis exigem atualizar `loadConfig`, `.env.example` e testes no mesmo diff.
- Todo código novo deve lançar `ApiError` com código estável, não `HttpException` genérica.
- Logs não devem receber dados pessoais nem em `msg`; o mascaramento por chave é defesa adicional, não licença.
- O pacote `@scarf/scarf` (telemetria transitiva do `@nestjs/swagger`) fica com script de instalação negado em `pnpm-workspace.yaml`.
