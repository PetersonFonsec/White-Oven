# ADR 0032: observabilidade mínima da API

- **Status:** implementado em M7.4; ensaio do alerta no ambiente do piloto pendente
- **Data:** 2026-11-01
- **Milestone:** M7.4

## Contexto

A M7.4 pede métricas de pedidos, erros e latência por tenant e alertas de indisponibilidade, com o critério de aceite "alertas testados; logs sem PII".

O que já existia em `main` (após a PR #47):

- **Logs:** uma linha JSON por requisição (`requestContext`, M1.1) com id da requisição, método, template da rota, `tenantId` quando um guard de loja o definiu, status e duração. Sem query string, corpo, cabeçalhos, IP ou user agent. Toda mensagem passa por `sanitizeText`, campos sensíveis são mascarados por nome (`redact`) e erros viram só tipo e frames. Os jobs (timeout de aceite, push) registram falhas com `tenantId` e número do lote.
- **Saúde:** `/health` (processo vivo) e `/health/ready` (ida e volta ao banco, 2 s), sem versão nem detalhes.
- **Nada** de métricas, nada que avisasse alguém quando a API cai, e nenhum fornecedor de monitoramento aprovado (AGENTS.md: "No vendor without approval").

## Decisão

### Métricas na própria API, sem biblioteca

- `ApiMetrics` (`apps/api/src/observability/metrics.ts`) mantém contadores e um histograma em memória e os expõe no formato texto do Prometheus 0.0.4 em `GET /metrics` (fora de `/v1`). Nenhuma dependência nova: o formato é simples e o `prom-client` traria métricas de processo que não usamos.
- Séries:

  | Métrica                                                                                                 | Rótulos                               | Origem                                                                                             |
  | ------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------- |
  | `whiteoven_http_requests_total`                                                                         | `tenant`, `route`, `method`, `status` | toda resposta, no mesmo `finish` que escreve a linha de log                                        |
  | `whiteoven_http_request_duration_seconds` (histograma)                                                  | `tenant`, `route`, `method`           | idem; baldes 25 ms a 10 s                                                                          |
  | `whiteoven_orders_created_total`                                                                        | `tenant`                              | `OrderService.create` depois do commit; replay idempotente não conta                               |
  | `whiteoven_order_transitions_total`                                                                     | `tenant`, `to`, `actor`               | `transition` depois do commit (replay não conta), criação (`PLACED`) e o job de timeout (`SYSTEM`) |
  | `whiteoven_unhandled_errors_total`                                                                      | `tenant`                              | o filtro de exceções, quando responde `INTERNAL_ERROR`                                             |
  | `whiteoven_background_job_failures_total`                                                               | `job`                                 | falha de lote ou de execução dos jobs `order_accept_timeout` e `push_delivery`                     |
  | `whiteoven_metrics_series_dropped_total`, `process_start_time_seconds`, `process_resident_memory_bytes` |                                       | controle                                                                                           |

- **Por tenant:** o rótulo `tenant` é o UUID que o guard leu do banco (`setRequestTenant`), ou `none` em rotas sem loja (health, plataforma, login antes de escolher loja, rota inexistente). O UUID, e não o slug, porque o slug pode mudar e partiria a série; o runbook mostra como achar a loja.
- **Sem PII por construção:** todo rótulo vem de algo que a API decidiu: template da rota do Express (`/v1/customer/stores/:slug/me/orders`, nunca o caminho), método normalizado (fora da lista vira `OTHER`), status numérico, enums fixos e o UUID do tenant (qualquer outro valor vira `none`). Um template fora do padrão vira `<unmatched>`. `observability.test.ts` faz requisições com e-mail e telefone no caminho e na query e confere que nem as métricas nem os logs os contêm.
- **Memória limitada sem apagar série viva:** no máximo 5 mil séries por métrica. Passado o teto, combinações novas somam numa série única com todos os rótulos `_overflow` e `whiteoven_metrics_series_dropped_total` conta quantas observações foram parar lá. Série viva nunca é removida (um contador que some e volta pareceria reinício). No piloto o volume real é da ordem de algumas centenas de séries.
- **Por instância e em memória:** reiniciar zera os contadores; `process_start_time_seconds` deixa isso visível e o monitor recomeça a janela. Com mais de uma instância, cada uma é lida separadamente (mesma limitação dos rate limits, ADR 0031).
- A rota `/metrics` não entra nas próprias métricas (o monitor não infla o tráfego que mede).

### `/metrics` fechado por padrão

- `API_METRICS_TOKEN` (32 a 512 caracteres, segredo) liga a rota. Sem ele, `/metrics` é um 404 comum. Com ele, exige `Authorization: Bearer <token>`; a comparação é por SHA-256 com `timingSafeEqual`. Resposta `Cache-Control: no-store` e os cabeçalhos de segurança de sempre.
- Mesmo com token, o proxy público deve responder 404 em `/metrics` (como o Caddy da landing já faz com `/health/*`): o monitor lê pela rede interna.

### Alertas: `ops/api-monitor.mjs` e um webhook

- Um script Node 22 sem dependências, fora do processo da API (a API não consegue avisar que caiu). Roda a cada minuto por timer do systemd ou cron (`check`), ou em laço (`watch`). Lê `/health/ready` e, com `MONITOR_METRICS_TOKEN`, `/metrics`.
- Alertas:

  | Chave                 | Severidade | Dispara quando                                                                              |
  | --------------------- | ---------- | ------------------------------------------------------------------------------------------- |
  | `api_down`            | crítico    | `/health/ready` falha (status, corpo, timeout de 5 s ou conexão) em 2 verificações seguidas |
  | `metrics_unavailable` | atenção    | `/metrics` falha em 2 verificações seguidas (sem ele os outros alertas param)               |
  | `error_rate:<grupo>`  | crítico    | 5xx ≥ 5% de pelo menos 20 requisições na janela de 10 min                                   |
  | `latency:<grupo>`     | atenção    | balde do p95 acima de 2,5 s com pelo menos 20 requisições na janela                         |
  | `job_failures:<job>`  | atenção    | o contador de falhas do job subiu na janela                                                 |

  Grupo é `all` (todas as lojas) ou o UUID de uma loja; uma loja quebrada não fica escondida na média. Todos os limites são variáveis `MONITOR_*`.

- **Janela deslizante:** cada verificação guarda um resumo (totais por grupo, não as séries) no arquivo de estado e compara com o resumo mais novo que tenha pelo menos a idade da janela. No volume do piloto, comparar só com o minuto anterior nunca juntaria 20 requisições. Se `process_start_time_seconds` mudou, a janela recomeça em vez de ler contadores zerados como tráfego.
- **Primeira coleta (revisado na PR #48):** os contadores da API valem zero no instante `process_start_time_seconds`. Se o processo começou dentro da janela, esse instante serve de linha de base com tudo zerado: o que ele contou desde então aconteceu, comprovadamente, dentro da janela. Por isso uma falha de job logo antes da primeira coleta (ou logo depois de a API reiniciar) alerta já na primeira verificação, e o mesmo vale para erros e latência. Se o processo é mais antigo que a janela e o monitor ainda não tem resumo dele (monitor novo, ou estado apagado), não há como saber quando os contadores subiram: a primeira coleta só vira linha de base, nada é alertado e o monitor registra `job failures counted before this window: not alerted` com os totais. Não há detecção retroativa sem prova de quando a falha ocorreu. Monitor reiniciado com o arquivo de estado preservado continua a mesma janela.
- **Sem dados não é recuperação nem continuidade (revisado na PR #48):** alertas de erro, latência e jobs só se confirmam ou se resolvem numa verificação que leu `/metrics` e tem linha de base. Quando a API está fora, `/metrics` falha ou a API acabou de reiniciar sem linha de base, os alertas ativos ficam **em suspenso** (`staleSince` no estado): não são resolvidos e não recebem lembrete. Quem avisa nesse período são `api_down` e `metrics_unavailable`. Um alerta que disparou mas não chegou a ser enviado (webhook falhou) ainda é enviado, dizendo quando foi visto e desde quando não há métricas. Quando as métricas voltam, a mesma verificação confirma (lembrete "ainda ativo" se o intervalo de repetição já passou) ou resolve cada alerta, numa única mensagem. Estados gravados antes desta revisão continuam válidos: os campos novos são opcionais.
- **Notificação:** uma mensagem por verificação com todas as mudanças: novo alerta, alerta ainda ativo a cada 60 min, resolvido. Se o webhook falha, nada é marcado como enviado, a verificação sai com 1 e a próxima reenvia. Um lock por arquivo de estado impede duas verificações ao mesmo tempo. O estado é gravado por arquivo temporário, `fsync` e `rename`.
- **Destino genérico:** `MONITOR_WEBHOOK_URL` (https, ou http só em loopback) com `MONITOR_WEBHOOK_FORMAT` `text` (`{"text": ...}`: Slack, Mattermost, Google Chat, Rocket.Chat), `discord` (`{"content": ...}`) ou `json` (estruturado, para um receptor próprio). Qual canal usar é decisão do PO; nenhum fornecedor fica embutido.
- **Teste do canal:** `node ops/api-monitor.mjs test-alert` manda uma mensagem de teste. O critério "alertas testados" fica coberto em duas partes: `tests/deployment/api-monitor.test.mjs` exercita queda, recuperação, repetição, taxa de erro e latência por loja, falha de job, reinício, webhook com falha e a linha de comando contra uma API e um webhook falsos; e o runbook pede um ensaio real (derrubar a API do piloto e ver o alerta chegar e resolver) registrado em [docs/operations/observability.md](../operations/observability.md).
- **Sem PII no monitor:** as mensagens e as linhas de log do monitor só têm chaves, contagens, templates de rota e UUIDs de loja. URL da API, URL do webhook e token nunca são registrados nem gravados no estado. Erros de configuração nomeiam a variável, nunca o valor.

## Consequências

- Enquanto `/metrics` está fora, um problema de erro ou latência que começar nesse período só é visto quando as métricas voltam; o aviso `metrics_unavailable` deixa claro que a vigilância está parada.
- O operador recebe aviso de queda em até cerca de 2 minutos, e de erro/latência por loja em até um minuto depois de a janela acumular o volume mínimo.
- Não há painel de gráficos nem histórico longo. Se o PO quiser, um Prometheus (ou serviço compatível) pode ler o mesmo `/metrics` sem mudança na API; isso é escolha de fornecedor/infraestrutura e fica fora desta etapa.
- O monitor roda no mesmo host da API, então não percebe a queda do host inteiro nem da rede até ele. Um verificador externo da URL pública (`/health` liberado só para ele, ou uma rota da landing) é a próxima camada e depende de aprovação de fornecedor.
- Métricas são por processo e zeram ao reiniciar; o contador de pedidos não substitui os relatórios do banco (M4.6, M6.3), que continuam a fonte de verdade.
- Nova rota `/metrics` entra no checklist de segurança: 404 sem token, 401 com token errado, fora do proxy público.
