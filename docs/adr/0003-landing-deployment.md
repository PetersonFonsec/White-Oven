# ADR 0003 — Empacotamento e operação da landing M0.2

Status: adotado para preparação; sem ambiente de produção provisionado.

## Decisão

Imagem OCI multi-stage com Node 22.23.2 Debian slim, base fixada por digest multiarch, pnpm 11.25.0 e lockfile congelado. Build e compilação de addons nativos ficam nos estágios de ferramentas; runtime usa dependências de produção, usuário 1000, diretório restrito e entrypoint Node existente. TypeScript strip do Node executa os módulos operacionais já usados no projeto; não há framework de servidor novo. `@astrojs/check` e TypeScript passam a devDependencies. A imagem inclui os módulos do inicializador, não somente `dist`.

Compose mantém somente a aplicação no arquivo principal. SQLite e backups têm volumes separados, sem portas públicas de dados. A porta publicada é sempre loopback; memória, CPU, processos, tmpfs, filesystem read-only e remoção de capabilities reduzem a superfície. Inicialização do SQLite ocorre no startup, fora dos probes. Readiness consulta armazenamento sem criar leads ou modificar o banco; liveness só verifica processo HTTP. SIGTERM drena requests por até 10s, com stop_grace_period de 15s.

O exemplo opcional `ops/compose.caddy.yaml` coloca Caddy na mesma rede dedicada, com IP estático correspondente a `LEADS_TRUSTED_PROXIES`. O Node observa esse peer, não `127.0.0.1` do host Docker. O Caddy substitui headers de encaminhamento; não aceita cadeia fornecida pelo visitante. Nenhum proxy ou domínio existente é reaproveitado implicitamente. A rede/subnet deve ser escolhida sem conflito no destino.

Atualizações substituem somente a imagem e mantêm volumes. Falha de saúde tenta a imagem anterior, sem copiar banco antigo. Rollback de imagem também não restaura dados. Como ainda não há migrações incompatíveis, essa estratégia é suficiente; futuras mudanças de schema exigirão expand/contract e nova revisão antes de permitir rollback.

Backup usa a API online de SQLite para incluir commits em WAL de forma consistente. JSON com hash e expiração acompanha a cópia; a verificação recusa cópias vencidas/corrompidas. Retenção máxima de 30 dias, limitada também pela expiração mais próxima dos leads. Restauração é offline, explícita, prepara candidato separado, reaplica diário de exclusões e purge, e guarda backup de segurança do estado atual antes de substituí-lo. Esse procedimento não é usado pelo rollback de imagem.

GHCR publica apenas após push em main e sucesso dos checks existentes e testes Docker. O artefato carregado no publisher é a própria imagem testada, sem rebuild. Tag usa SHA completo; tag já existente não é sobrescrita pelo workflow. Somente o job publisher recebe packages:write, usando GITHUB_TOKEN. Não há SSH, credenciais de VPS ou deploy automático.

## Alternativas e limites

Kubernetes, banco remoto, Redis, systemd gerenciado pelo projeto e plataformas pagas adicionariam operação sem demanda. Não são necessários. Compose de uma instância não oferece HA, proteção DDoS nem backup externo automático. Backups no mesmo host não protegem contra perda do host: cópia externa cifrada, controle de inventário, DNS, HTTPS público e monitoramento são tarefas obrigatórias do futuro operador, não recursos criados nesta PR.

Os testes Docker cobrem a plataforma do executor (local ARM64 e CI AMD64). Publicação inicial será Linux AMD64; suportar manifest multiarch no GHCR exige testar cada arquitetura antes. Não afirmar compatibilidade de arquitetura somente por existir base multiarch.

## Referências

- [Compose services](https://docs.docker.com/reference/compose-file/services/): healthcheck, read_only e stop_grace_period.
- [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy): headers de encaminhamento.
- [Caddy request_body](https://caddyserver.com/docs/caddyfile/directives/request_body): limite de corpo.
