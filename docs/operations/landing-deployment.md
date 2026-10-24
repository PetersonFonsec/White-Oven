# M0.2 — Runbook de deploy e operação

**Preparação, sem deploy real.** Nenhum servidor, domínio ou provedor foi escolhido. Não executar esses exemplos sobre Orbia ou outro projeto. Os passos de DNS, HTTPS público, GHCR após merge e operação externa dependem do ambiente futuro. Resultados locais/CI estão na descrição da PR; exemplos não são evidência de execução em produção.

## 1. Requisitos e topologia

Destino proposto: Linux com Docker Engine e Compose plugin **2.30+**, Bash, saída HTTPS para registry e espaço persistente. Referência inicial: 1 CPU, 1 GiB RAM no host (container limitado a 512 MiB/1 CPU/128 PIDs), disco SSD com margem para dados, imagens e backups. Build precisa de mais recursos: preferir imagem testada da CI, não compilar numa VPS pequena. Ajustar limites somente após medir. Readiness exige ao menos 8 MiB livres no filesystem de dados; isso não substitui monitoramento de disco.

`compose.yaml` sobe somente `landing`. `ops/compose.caddy.yaml` é exemplo **opcional**, separado, para um Caddy exclusivo do WhiteOven; requer portas 80/443 livres. Não instalar sobre proxy compartilhado sem planejar integração. A porta Node publicada é `127.0.0.1:WHITEOVEN_PORT`, não pública. Não expor Docker socket, SQLite, backups ou admin Caddy. Sem PostgreSQL, Redis, Keycloak ou serviços pagos.

Rede bridge dedicada com subnet configurável. No exemplo, Caddy tem peer estático `172.30.87.3`; este é o endereço que o Node recebe e que deve estar em `LEADS_TRUSTED_PROXIES`. **Não usar localhost por estar no mesmo host Docker.** Se a topologia mudar, verificar o peer novamente com um teste sintético isolado; não criar endpoint público de diagnóstico. A suíte de containers comprova a correspondência do exemplo. CIDRs/wildcards não são aceitos. Sem CDN/proxy adicional previsto.

## 2. Configuração

```sh
cp ops/.env.example ops/.env
chmod 600 ops/.env
# Editar valores reais; nunca versionar ops/.env.
```

Formato de `ops/.env`: `CHAVE=valor` sem aspas/expansão shell, inclusive nomes com espaços. Nenhum segredo de registry precisa entrar no container. Configure:

| Variável                                    | Uso                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| WHITEOVEN_IMAGE                             | Local para ensaio; produção deve usar GHCR `@sha256:DIGEST` da imagem aprovada, ou tag `sha-SHA_COMPLETO` sem alteração. |
| WHITEOVEN_PORT                              | Porta host loopback livre entre 1024 e 65535; porta interna fica 4321.                                                   |
| WHITEOVEN_SUBNET                            | Subnet privada livre, sem conflito com redes/VPN existentes.                                                             |
| CADDY_INTERNAL_IP                           | IP livre dentro da subnet, exclusivo do Caddy.                                                                           |
| WHITEOVEN_DOMAIN                            | Domínio real, sem esquema; usado pelo exemplo HTTPS.                                                                     |
| SITE_ORIGIN                                 | Origem pública HTTPS exata, sem barra final, igual ao domínio servido.                                                   |
| LEADS_ENABLED                               | Manter `false` até concluir checklist; `true` exige identidade, origem e proxy válidos.                                  |
| LEADS_CONTROLLER_NAME / LEADS_PRIVACY_EMAIL | Identidade real autorizada e contato publicado na política; sem placeholders.                                            |
| LEADS_TRUSTED_PROXIES                       | IP estático do Caddy, igual ao peer efetivamente observado.                                                              |

Compose fixa `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=4321`, banco `/var/lib/whiteoven/leads.sqlite`. Valores privados são somente runtime; build não recebe `.env`, lead ou export. `.dockerignore` exclui esses arquivos. O validador não imprime valores nem executa o arquivo como shell. `WHITEOVEN_ENV_FILE` permite apontar outro arquivo; `COMPOSE_PROJECT_NAME` separa instalações. Não mudar o project name inadvertidamente: os volumes ficam associados ao projeto.

## 3. Primeira instalação e HTTPS

Obter checkout revisado. Uma imagem nova deve ser acessível ao Docker: se o pacote GHCR for privado, o operador configura login read-only fora do repositório. A publicação inicial usa GITHUB_TOKEN, sem PAT próprio; verificar permissões e visibilidade do pacote após o primeiro merge.

```sh
# Ensaio local, com WHITEOVEN_IMAGE=whiteoven:local: construir antes de validar.
bash ops/whiteoven.sh build
# Se usar uma imagem GHCR publicada, substituir build por:
# bash ops/whiteoven.sh validate
bash ops/whiteoven.sh update
bash ops/whiteoven.sh verify
bash ops/whiteoven.sh status
```

Para instalação por imagem publicada, validate faz pull se a imagem não estiver local. Não usar tag `latest`. Fixar digest após conferir revisão OCI, CI e arquitetura. Scripts não requerem pnpm/Node no host: o validador roda dentro da imagem; Docker/Compose e Bash bastam.

Antes de ativar o exemplo Caddy, apontar DNS A/AAAA somente aos IPs reais do destino, conferir firewall, portas 80/443 e evitar registro AAAA sem IPv6 funcional. Sem esses requisitos, não prometer emissão de certificados. Caddy fará ACME/renovação no ambiente futuro; `/data` e `/config` são volumes próprios. Não há domínio real neste repositório.

```sh
# Validar sintaxe em um ambiente de ensaio; não solicita certificados:
docker run --rm --env-file ops/.env -v "$PWD/ops/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2.11.7-alpine caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile --validate
# Exemplo de ativação FUTURA, com portas livres e domínio já validado:
docker compose --env-file ops/.env -f compose.yaml -f ops/compose.caddy.yaml up -d
```

Caddy substitui `X-Forwarded-For` pelo peer recebido, preserva Origin e aplica limites de corpo/tempo e headers de segurança. Não confia no header do visitante. `/health/*` não é publicado pelo exemplo; HTTPS tem HSTS sem preload/includeSubDomains. TLS público e renovação não foram exercitados em domínio real. Não reutilizar a subnet/IP de exemplo se conflitarem.

## 4. Saúde e pós-deploy

- `/health/live`: 200, somente processo HTTP disponível.
- `/health/ready`: 200/503 com `{ready,capture,storage}`; sem paths, erro SQL, nomes ou dados. Se `LEADS_ENABLED=false`, landing pode estar pronta com captação desativada. Se foi solicitada captação e a configuração/armazenamento falham, readiness retorna 503. Readiness durante drenagem retorna 503.
- SQLite é inicializado no startup, não pelo probe. Probe faz somente consultas, acesso/permissão e espaço livre; não comprova capacidade futura de escrita nem substitui backup/restauração. Não cria lead, arquivo ou esquema.
- `bash ops/whiteoven.sh verify` exige correspondência entre modo solicitado e estado observado. Docker usa readiness no healthcheck; Docker restart policy não reinicia automaticamente container apenas por ficar unhealthy. Monitorar unhealthy externamente.

Testar página, política, disponibilidade do formulário, headers HTTPS e tentativa de spoof de header no proxy real. Fazer um cadastro sintético controlado, confirmar via inspeção restrita e excluí-lo, registrando o procedimento. Só então ativar captação real (`LEADS_ENABLED=true`, update, verify). Não registrar PII em access logs/query strings; Caddy exemplo não habilita access log.

## 5. Atualização e rollback

```sh
# Registrar imagem atual; editar WHITEOVEN_IMAGE para o novo digest aprovado.
bash ops/whiteoven.sh update
bash ops/whiteoven.sh verify
# Se necessário, recuperar somente a imagem anterior:
bash ops/whiteoven.sh rollback
```

Update serializa por lock local, sobe a imagem e aguarda saúde por até 90s. Guarda ID da imagem anterior em `.ops-state/previous-image`. Falha tenta recuperar a imagem anterior e retorna erro para exigir investigação. Não apaga volumes nem executa restore. `WHITEOVEN_STATE_DIR` permite guardar estado operacional fora do checkout. Preservar esse estado e a imagem anterior local; não fazer prune antes da validação. Se processo morrer deixando lock, conferir se não há operação ativa antes de removê-lo manualmente.

Rollback conserva **o banco atual**, incluindo leads criados após atualização. Não restaura `.env` automaticamente; configuração incompatível precisa correção explícita. Se uma versão futura alterar schema de forma incompatível, não permitir rollback automático até revisar migração. Nunca usar `docker compose down -v`, apagar volume ou restore como rotina de atualização. Restauração abaixo é recuperação deliberada, com possível mudança do conjunto de dados e confirmação offline.

## 6. Backup consistente e recuperação

```sh
bash ops/whiteoven.sh ledger-init
bash ops/whiteoven.sh backup backup_YYYYMMDD_HHMMSS
bash ops/whiteoven.sh verify-backup backup_YYYYMMDD_HHMMSS
```

Backup usa API online SQLite, incluindo WAL; não copiar apenas `leads.sqlite` com serviço ativo. Mesmo ID verifica a cópia existente, sem sobrescrever nem fingir que contém commits posteriores. Usar novo ID para novo ponto de recuperação. Cópia e JSON de integridade/expiração ficam no volume separado `/var/backups/whiteoven`, 0700/0600. Sem nomes/WhatsApp em IDs. Hash detecta corrupção, não prova autenticidade contra atacante com acesso ao volume. Guardar inventário e prova de hash também em controle restrito separado.

Volume no mesmo host **não é backup externo** e arquivo não é cifrado pela ferramenta. Antes de captar dados reais: definir cópia externa cifrada, acesso mínimo, chave fora do host, retenção e monitoramento de execução. Nenhum fornecedor foi escolhido. Operador deve agendar backup/purge e expiração; não há cron de produção instalado nesta PR. Backups expiram em até 30 dias ou antes pela expiração mais próxima dos leads; verify recusa vencidos. Remover arquivos vencidos e todas as cópias externas conforme inventário. O app não remove automaticamente cópias externas.

Restauração exige diário de exclusões atual no volume de backups. `ledger-init` só cria diário vazio se ausente; não recriá-lo como substituto de um diário perdido. Se já houve exclusões, reconstruir evidências antes de qualquer restore.

```sh
# Registrar cada UUID de exclusão ANTES de excluir do banco ativo:
bash ops/whiteoven.sh exclude UUID
# Excluir no banco, seguindo também o runbook de titulares:
docker compose --env-file ops/.env -f compose.yaml exec -T landing \
  node --experimental-strip-types scripts/leads.mjs delete UUID
# Recuperação explícita; para aplicação e a mantém parada:
bash ops/whiteoven.sh restore backup_YYYYMMDD_HHMMSS --confirm-offline
```

Restore valida hash/prazo/esquema, guarda backup de segurança do banco atual (inclui leads posteriores ao backup selecionado), monta candidato, reaplica exclusões do diário e purge e só então substitui o banco offline. Se o banco atual estiver corrompido a ponto de não permitir backup de segurança, o script recusa: preservar volume e investigar em cópia isolada; não adicionar `--force` improvisado. O serviço permanece parado até revisar resultado.

Inspecionar o candidato restaurado offline com container one-off e diário, conferir inventário e só depois iniciar via update/verify. Não pode haver outros containers, comandos de escrita ou instâncias montando o volume durante restore; o script para apenas seu serviço Compose. Guardar cópia do diário atualizada separadamente dos backups históricos. Ensaio de recuperação com dados sintéticos é obrigatório antes de publicação.

## 7. Retenção e direitos

```sh
bash ops/whiteoven.sh purge
```

Agendar purge diariamente e backup na frequência compatível com perda aceitável de leads (RPO a definir). Medir tempo de recuperação (RTO) no ensaio. Os 180 dias do cadastro, expiração das cópias e pedidos de exclusão abrangem exportações e backups; seguir [runbook de exclusão](../architecture/lead-deletion-runbook.md). O diário técnico não substitui inventário, confirmação de destinatários ou resposta ao titular. Só contém UUIDs restritos e deve ser eliminado quando não existirem cópias restauráveis abrangidas/casos pendentes, conforme procedimento. Nenhum dado real é manipulado pelos testes desta milestone.

## 8. Troubleshooting

| Sintoma                      | Ação                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Unhealthy, live=200          | Conferir readiness dentro do container e configuração sem imprimir `.env`; requested capture incompleta retorna 503. |
| storage=unavailable          | Conferir volume, UID 1000, diretório 0700, arquivo 0600, espaço livre e integridade em cópia. Não aplicar chmod 777. |
| POST 403                     | Origin deve coincidir com SITE_ORIGIN; conferir peer estático e substituição de um único XFF.                        |
| POST 429                     | Cota NAT compartilhada, abuso ou concorrência; não aumentar global sem medir.                                        |
| POST 408 / conexão fechada   | Cliente lento ou timeout de transporte; retry preserva chave e campos.                                               |
| Caddy não emite TLS          | DNS, firewall, 80/443, domínio e relógio; não desabilitar TLS em produção para contornar.                            |
| Falha de imagem/native addon | Conferir arquitetura/Node e imagem CI correta; não copiar node_modules do macOS.                                     |
| Restore recusado             | Diário ausente, cópia vencida/corrompida ou impossibilidade de backup atual; não sobrescrever à força.               |
| GHCR inacessível             | Visibilidade/permissões do pacote; login de leitura do operador, sem colocar token no repo ou app.                   |

Logs da aplicação são genéricos; `docker compose ... logs --tail 100 landing` para investigação autorizada. Não anexar dumps de env, banco ou exports a issues. Compose limita logs locais a três arquivos de 10 MiB por serviço; monitoramento e envio externo seguro ainda dependem do operador.

## 9. Checklist de liberação

- [ ] Destino, responsável, domínio e subnet sem conflitos definidos; nenhuma Orbia afetada.
- [ ] Imagem/digest/arquitetura aprovados e CI verde; pull testado; pacote GHCR com visibilidade correta.
- [ ] UID/volumes/permissões/espaço e recuperação de imagem validados no destino.
- [ ] DNS, HTTPS/renovação, firewall e headers conferidos.
- [ ] Caddy peer real igual à lista confiável; spoof rejeitado; Origin e limites preservados.
- [ ] Controlador/contato/política reais revisados; nenhuma credencial no build/Git/logs.
- [ ] Backup externo cifrado, inventário, agendamentos, expiração, diário e ensaio de restore definidos e testados.
- [ ] Monitoramento de liveness/readiness/disco/unhealthy e alertas atribuídos a operador.
- [ ] Cadastro sintético completo, persistência após recriação, exclusão e recuperação conferidos.
- [ ] Ativação explícita da captação e verify confirmando ready/enabled/ready.

Todos os itens dependentes do ambiente real permanecem pendentes nesta PR. Nenhum deploy automático na VPS foi adicionado.
