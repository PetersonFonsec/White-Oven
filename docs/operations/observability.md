# Runbook: métricas, alertas e logs da API

Decisão e motivos: [ADR 0032](../adr/0032-observability.md). Vale para a API (`apps/api`). Não há ambiente de produção provisionado; nunca execute o monitor contra um ambiente real sem autorização da tarefa.

## 1. O que existe

- **Logs:** uma linha JSON por requisição no stdout da API (`docker compose logs api`): `requestId`, `method`, `route` (template, nunca o caminho), `tenantId` quando a rota é de uma loja, `statusCode`, `durationMs`. Falhas dos jobs aparecem como `order acceptance timeout batch failed` e `push delivery batch failed`, com `tenantId` e lote. Nenhum dado pessoal (seção 6).
- **Métricas:** `GET /metrics` na API, formato Prometheus, só com `API_METRICS_TOKEN`. Pedidos criados, transições de status, requisições por status, latência, erros 500 e falhas de jobs, por loja (UUID do tenant).
- **Alertas:** `ops/api-monitor.mjs`, rodando a cada minuto no host da API, avisa por webhook quando a API cai, quando as métricas param, quando uma loja (ou o total) passa de 5% de erros 5xx, quando o p95 passa de 2,5 s e quando um job falha.

## 2. Configurar a API

1. Gere o token: `openssl rand -hex 32`.
2. Defina `API_METRICS_TOKEN` no ambiente da API (segredo, como as chaves de autenticação). Sem ele `/metrics` responde 404.
3. No proxy público da API, mantenha `/metrics` fora do ar, como o Caddy da landing faz com `/health/*`:

   ```caddy
   @internal path /metrics /metrics/*
   respond @internal 404
   ```

4. Confira: `curl -s -o /dev/null -w '%{http_code}\n' https://<api>/metrics` deve dar `404` pela URL pública; pela rede interna, `curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/metrics | head` mostra as séries e sem o cabeçalho dá `401`.

## 3. Configurar o monitor

O monitor precisa de Node 22 no host (ou de um container com a imagem da API rodando `node ops/api-monitor.mjs watch`). Não tem dependência.

1. Copie `ops/monitor/monitor.env.example` para `/etc/whiteoven/monitor.env` (dono root, `chmod 600`) e preencha:
   - `MONITOR_API_URL`: endereço interno da API (por exemplo `http://127.0.0.1:3000`).
   - `MONITOR_METRICS_TOKEN`: o mesmo valor de `API_METRICS_TOKEN`.
   - `MONITOR_WEBHOOK_URL` e `MONITOR_WEBHOOK_FORMAT`: o canal escolhido pelo PO. `text` serve para Slack, Mattermost, Google Chat e Rocket.Chat; `discord` para Discord; `json` para um receptor próprio. https obrigatório.
   - `MONITOR_ENVIRONMENT`: nome curto que aparece nas mensagens (`piloto`).
2. Teste o canal: `set -a; . /etc/whiteoven/monitor.env; set +a; node ops/api-monitor.mjs test-alert`. A mensagem "🧪 Teste do canal de alertas da API" deve chegar. Saída 1 significa que o webhook recusou (a linha de log diz o status HTTP).
3. Instale o timer (exemplos em `ops/monitor/`): crie o usuário `whiteoven-monitor` sem shell, copie `whiteoven-api-monitor.service` e `.timer` para `/etc/systemd/system/`, ajuste `WorkingDirectory`/`ExecStart` para onde o repositório está e rode `systemctl enable --now whiteoven-api-monitor.timer`. Sem systemd, uma linha de cron serve: `* * * * * cd /opt/whiteoven && set -a && . /etc/whiteoven/monitor.env && node ops/api-monitor.mjs check >> /var/log/whiteoven-monitor.log 2>&1`.
4. O estado fica em `MONITOR_STATE_FILE` (padrão `.ops-state/api-monitor/state.json`; no exemplo do systemd, `/var/lib/whiteoven-monitor/state.json`). Ele guarda os alertas ativos e os resumos da janela. Apagar o estado só faz o monitor esquecer alertas já avisados (pode repetir um aviso) e recomeçar a janela.

## 4. Alertas e o que fazer

| Mensagem                        | Severidade | Primeiro passo                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API indisponível                | crítico    | `docker compose ps` e `docker compose logs --tail 200 api`. `HTTP 503` é banco inacessível (`/health/ready` falhou na consulta): veja o `postgres`. `sem conexão` é o processo fora do ar ou a porta errada. `tempo esgotado` é a API travada ou sem pool.                                        |
| Métricas indisponíveis          | atenção    | `HTTP 401`: token do monitor diferente de `API_METRICS_TOKEN`. `HTTP 404`: a API está sem token. Enquanto durar, os alertas de erro, latência e jobs ficam em suspenso: nem resolvidos, nem repetidos. Quando as métricas voltam, uma única mensagem confirma ("ainda ativo") ou resolve cada um. |
| Erros 5xx em loja X / todas     | crítico    | A mensagem lista as rotas com mais erros. Filtre os logs: `docker compose logs api \| grep '"statusCode":5'` e, para uma loja, pelo `tenantId`. `unhandled exception` traz o tipo do erro e os frames.                                                                                            |
| Latência alta em loja X / todas | atenção    | Veja o banco (conexões, locks) e o uso de CPU/memória do container. O p95 é o limite superior do balde (`até 5 s` quer dizer entre 2,5 e 5 s).                                                                                                                                                    |
| Falhas no job `<job>`           | atenção    | `order_accept_timeout` ou `push_delivery`: as linhas `... batch failed` dos logs dizem a loja e o lote. O job tenta de novo no minuto seguinte.                                                                                                                                                   |

Um alerta ativo é repetido a cada 60 minutos ("ainda ativo") e gera "✅ Resolvido" quando volta ao normal. Se o webhook falhar, o monitor sai com código 1, registra `alert webhook failed` e reenvia na verificação seguinte.

**Primeira verificação:** se a API começou há menos que a janela (10 min), falhas contadas desde o início dela já alertam. Se é mais antiga e o monitor acabou de ser instalado (ou o estado foi apagado), os contadores existentes não alertam, porque não dá para saber quando subiram; a linha `job failures counted before this window: not alerted` do log do monitor mostra os totais, e os logs da API dizem quando foram as falhas.

Para achar a loja de um UUID: `select slug, name from tenants where id = '<uuid>';` (como `whiteoven_owner` ou pelo painel de operador). `none` são rotas sem loja (health, plataforma, login, rota inexistente).

## 5. Ler as métricas à mão

```bash
curl -s -H "Authorization: Bearer $API_METRICS_TOKEN" http://127.0.0.1:3000/metrics \
  | grep -E '^whiteoven_(orders_created|order_transitions|unhandled_errors)_total'
```

Os contadores são do processo atual (`process_start_time_seconds`) e zeram a cada reinício. Para totais oficiais de pedidos use o histórico e o relatório do painel (M4.6) e o extrato de cobrança (M6.3), que vêm do banco.

## 6. Logs sem dados pessoais

O que garante, e onde está testado:

- A linha de acesso tem só o template da rota: query string, corpo, cabeçalhos, IP e user agent nunca são registrados (`app.test.ts`, `observability.test.ts`).
- Mensagens livres passam por `sanitizeText` (e-mail, JWT, Bearer, senhas, números longos, literais SQL) e campos com nomes sensíveis são mascarados (`logging.test.ts`, `sanitize.test.ts`). Erros viram só tipo e frames.
- As métricas só têm rótulos decididos pela API (template, método, status, UUID da loja, enums); `observability.test.ts` manda e-mail e telefone no caminho e na query e confere métricas e logs.
- O monitor não registra URLs, token ou chave do webhook, e as mensagens só têm chaves, contagens, rotas e UUIDs (`tests/deployment/api-monitor.test.mjs`).

Ao adicionar um log: use `logger.write(level, msg, campos)` com ids gerados pela API (`tenantId`, `requestId`, `assetId`), nunca nome, e-mail, telefone, endereço, token ou texto digitado por cliente. Ao adicionar uma métrica: rótulos só de conjuntos fechados ou do UUID do tenant.

## 7. Ensaio dos alertas

O critério de aceite pede alertas testados. Os testes automáticos cobrem as decisões; o ensaio confirma o canal e o caminho reais. Repita no ambiente do piloto antes do primeiro pedido real e sempre que mudar o webhook, o host ou o proxy:

1. `node ops/api-monitor.mjs test-alert` e confira a mensagem no canal.
2. Pare a API (`docker compose stop api`). Em até 2 minutos deve chegar "🔴 CRÍTICO: API indisponível".
3. Suba a API (`docker compose start api`). Na verificação seguinte deve chegar "✅ Resolvido".
4. Troque temporariamente `MONITOR_METRICS_TOKEN` por um valor errado e confira "Métricas indisponíveis (HTTP 401)" em 2 minutos; restaure.
5. Registre abaixo.

### Registro

| Data (UTC)       | Ambiente     | Canal                        | Resultado                                                                                                                                                                                                                                                                                                                |
| ---------------- | ------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-01 00:12 | ensaio local | webhook de teste em loopback | API compilada desta PR com PostgreSQL 16 local e `API_METRICS_TOKEN`; `test-alert` entregue; API parada: 1ª verificação sem aviso, 2ª com "API indisponível ... (sem conexão)"; API de volta: "Resolvido" na verificação seguinte; `/metrics` sem token respondeu 401; logs de acesso só com template, status e duração. |
| _pendente_       | piloto       | _canal escolhido pelo PO_    |                                                                                                                                                                                                                                                                                                                          |
