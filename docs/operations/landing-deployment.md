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
- `/health/ready`: 200/503 com `{ready,capture,storage,writes}`; sem paths, erro SQL, nomes ou dados. Se `LEADS_ENABLED=false`, landing pode estar pronta com captação desativada. Se foi solicitada captação e a configuração/armazenamento falham, readiness retorna 503. Readiness durante drenagem retorna 503.
- SQLite é inicializado no startup, não pelo probe. Probe faz somente consultas, acesso/permissão e espaço livre; não cria lead, arquivo ou esquema.
- `writes` é um sinal **passivo**, alimentado pelos cadastros reais: `unknown` antes do primeiro cadastro do processo, `ok` após um cadastro gravado, `failing` após 3 falhas seguidas de gravação (conflito de idempotência não conta). Com captação solicitada, `failing` torna readiness 503. O probe continua sem escrever.
- Sem tráfego, `writes` fica `unknown`. Para comprovar escrita no volume de dados, use a verificação **explícita** `bash ops/whiteoven.sh probe-write`: cria, grava com `synchronous=FULL`, lê e apaga um SQLite temporário `.write-probe-*` no diretório de dados, sem tocar `leads.sqlite`. Agendar no monitoramento externo (ex.: a cada 15 minutos) e alertar em falha; não ligar ao healthcheck do Docker.
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

Update serializa por lock local, valida a configuração com o validador da própria imagem nova, sobe a imagem e aguarda saúde por até 90s. Guarda ID da imagem anterior em `.ops-state/previous-image`. Não apaga volumes nem executa restore. O código de saída diz o estado final do serviço:

| Saída | Situação                                                                                                                           | Ação do operador                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 0     | Nova imagem saudável.                                                                                                              | `verify`.                                                             |
| 1     | Nova imagem falhou; a anterior voltou e passou no healthcheck. A imagem nova fica marcada como falha.                              | Fixar `WHITEOVEN_IMAGE` na imagem indicada; investigar a nova.        |
| 2     | Serviço indisponível: falhou sem versão anterior, falhou com a mesma imagem (mudança só no `.env`) ou a recuperação também falhou. | Incidente: corrigir configuração ou imagem antes de qualquer restore. |

A imagem que falhou num update, ou da qual se fez rollback, é registrada em `.ops-state/failed-image`. `update`, `restore` e `import-backup` recusam essa imagem enquanto ela continuar em `WHITEOVEN_IMAGE`, porque o `.env` não é reescrito pelo script e um `up` posterior a traria de volta. Para reaplicá-la de propósito depois de corrigir a causa, usar `WHITEOVEN_RETRY_FAILED_IMAGE=1` uma vez; um update bem-sucedido limpa a marca. `WHITEOVEN_STATE_DIR` permite guardar estado operacional fora do checkout. Preservar esse estado e a imagem anterior local; não fazer prune antes da validação. Se processo morrer deixando lock, conferir se não há operação ativa antes de removê-lo manualmente.

Rollback conserva **o banco atual**, incluindo leads criados após atualização. Antes de trocar, roda o validador **da imagem anterior** contra o `ops/.env` atual: se uma variável nova ou removida torna a configuração incompatível, o rollback é recusado sem tocar o serviço. Se a imagem anterior não ficar saudável, o script volta à imagem que estava rodando e sai com 1; se nem essa voltar, sai com 2. Após rollback saudável, fixar `WHITEOVEN_IMAGE` no ID informado (ou no digest GHCR correspondente) antes de qualquer outro comando.

Restrições do rollback de imagem:

- Só existe a última imagem anterior registrada; não há histórico de várias versões. `docker image prune` antes de validar a atualização remove o alvo do rollback.
- Não restaura `.env`. Mudança de configuração que acompanhou a atualização precisa ser revertida à mão, e o validador da imagem anterior aponta a incompatibilidade.
- Não reverte dados. Se uma versão futura alterar schema de forma incompatível, não permitir rollback automático até revisar migração (expand/contract, ADR 0003).
- Recuperação de dados é sempre a seção 6, deliberada e offline; nunca parte de um rollback. Nunca usar `docker compose down -v`, apagar volume ou restore como rotina de atualização. Restauração abaixo é recuperação deliberada, com possível mudança do conjunto de dados e confirmação offline.

## 6. Backup consistente e recuperação

```sh
bash ops/whiteoven.sh ledger-init
bash ops/whiteoven.sh backup backup_YYYYMMDD_HHMMSS
bash ops/whiteoven.sh verify-backup backup_YYYYMMDD_HHMMSS
bash ops/whiteoven.sh prune-backups
```

O backup exige o diário de exclusões já criado e grava o identificador desse diário nos metadados da cópia. A cópia é convertida para um único arquivo, sem `-wal`/`-shm` ao lado. `prune-backups` apaga do volume as cópias vencidas ou com metadados ilegíveis (o restore já as recusava, mas os arquivos ficavam no disco); agendar diariamente junto com `purge`.

Backup usa API online SQLite, incluindo WAL; não copiar apenas `leads.sqlite` com serviço ativo. Mesmo ID verifica a cópia existente, sem sobrescrever nem fingir que contém commits posteriores. Usar novo ID para novo ponto de recuperação. Cópia e JSON de integridade/expiração ficam no volume separado `/var/backups/whiteoven`, 0700/0600. Sem nomes/WhatsApp em IDs. Hash detecta corrupção, não prova autenticidade contra atacante com acesso ao volume. Guardar inventário e prova de hash também em controle restrito separado.

Volume no mesmo host **não é backup externo** e arquivo não é cifrado pela ferramenta. Antes de captar dados reais: definir cópia externa cifrada, acesso mínimo, chave fora do host, retenção e monitoramento de execução. Nenhum fornecedor foi escolhido. Operador deve agendar backup/purge e expiração; não há cron de produção instalado nesta PR. Backups expiram em até 30 dias ou antes pela expiração mais próxima dos leads; verify recusa vencidos. Remover arquivos vencidos e todas as cópias externas conforme inventário. O app não remove automaticamente cópias externas.

Restauração exige o **mesmo** diário de exclusões com o qual a cópia foi criada. Cada diário tem identidade própria; um diário recriado com `ledger-init` depois de perdido tem outra identidade, e `verify-backup`, `restore` e `import-backup` recusam toda cópia anterior a ele (`LEDGER_MISMATCH`). Isso impede que uma cópia antiga traga de volta leads excluídos só porque o diário se perdeu. Para recuperar, trazer de volta a cópia externa mais recente do diário (abaixo); se ela também se perdeu, as cópias antigas não são restauráveis e devem ser eliminadas.

```sh
# Exclusão por titular: registra no diário e só depois remove do banco ativo.
bash ops/whiteoven.sh delete UUID
# Recuperação explícita; para aplicação e a mantém parada:
bash ops/whiteoven.sh restore backup_YYYYMMDD_HHMMSS --confirm-offline
```

`delete` executa as duas etapas na ordem segura; se for interrompido entre elas, o lead continua no banco mas já está no diário, e repetir o comando conclui a exclusão. `exclude` sozinho continua disponível para cópias fora do banco ativo.

Restore valida hash/prazo/esquema, guarda backup de segurança do banco atual (inclui leads posteriores ao backup selecionado), monta candidato, reaplica exclusões do diário e purge e só então substitui o banco offline. Se o banco atual estiver corrompido a ponto de não permitir backup de segurança, o script recusa: preservar volume e investigar em cópia isolada; não adicionar `--force` improvisado. O serviço permanece parado até revisar resultado.

Inspecionar o candidato restaurado offline com container one-off e diário, conferir inventário e só depois iniciar via update/verify. Não pode haver outros containers, comandos de escrita ou instâncias montando o volume durante restore; o script para apenas seu serviço Compose. Ensaio de recuperação com dados sintéticos é obrigatório antes de publicação.

### Cópia externa e recuperação de perda do host

Processo com ferramentas já disponíveis no host e na estação do operador (Bash, Docker, GnuPG, `sha256sum`, `rsync`/`scp`); nenhum fornecedor é contratado ou integrado. O destino é um local que o controlador **já controla** fora do host da landing (outra máquina, mídia removível guardada em local restrito, armazenamento já contratado e aprovado para isso). Escolher esse destino é decisão do controlador e fica registrada no inventário.

1. **Exportar** uma cópia verificada para um diretório temporário restrito do host:
   ```sh
   bash ops/whiteoven.sh backup backup_YYYYMMDD_HHMMSS
   bash ops/whiteoven.sh export-backup backup_YYYYMMDD_HHMMSS /root/whiteoven-export
   ```
   Saem três arquivos 0600 num diretório 0700: a cópia, seus metadados (hash, expiração, identidade do diário) e o diário de exclusões daquele momento. Nada é sobrescrito. A exportação **não é cifrada**.
2. **Cifrar no host**, para uma chave pública cuja chave privada **não** fica no host (ex.: guardada pelo controlador): `gpg --encrypt --recipient CHAVE_DO_CONTROLADOR --output ARQUIVO.gpg ARQUIVO` para cada um dos três. Registrar `sha256sum` dos `.gpg` no inventário.
3. **Transferir** os `.gpg` ao destino externo com `rsync`/`scp` e acesso mínimo; conferir o `sha256sum` no destino.
4. **Apagar a exportação em claro** do host (`shred -u` ou `rm` em filesystem cifrado) e registrar no inventário: ID, destino, responsável, data, expiração (a dos metadados) e identidade do diário.
5. **Manter o diário externo atualizado.** Após cada `delete`/`exclude`, exportar de novo e substituir a cópia externa do diário. Uma cópia externa só é restaurável com o diário de mesma identidade e conteúdo atual.
6. **Eliminar cópias externas vencidas** na data de expiração registrada; o app não alcança o destino externo. Pedido de exclusão de titular segue o [runbook de exclusão](../architecture/lead-deletion-runbook.md) também para essas cópias.

Recuperação após perda do host ou do volume de backups:

1. Preparar host novo pela seção 3, sem ativar captação. Recriar o volume de backups trazendo **primeiro** o diário: decifrar a cópia externa mais recente do diário e colocá-la como `/var/backups/whiteoven/deletions.json` com um container one-off do mesmo projeto Compose (usuário 1000, modo 0600). Não usar `ledger-init` nesse caso.
2. Decifrar a cópia escolhida e seus metadados num diretório 0700 e importar: `bash ops/whiteoven.sh import-backup backup_YYYYMMDD_HHMMSS /root/whiteoven-import`. O conteúdo é enviado por stdin ao container; hash, prazo, integridade e identidade do diário são verificados, e uma cópia inválida é removida.
3. Seguir o restore offline acima: ele reaplica o diário e o purge. Depois `update`, `verify` e um cadastro sintético controlado.
4. Apagar os arquivos decifrados e registrar o ensaio ou a recuperação (tempo total = RTO medido).

O ensaio completo (exportar, cifrar, transferir, apagar o host de teste, importar, restaurar) com dados sintéticos é pré-requisito da captação real; a suíte de containers cobre exportação e importação, não a cifra nem a transferência.

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
| `LEDGER_MISMATCH`            | Diário atual não é o da cópia; trazer a cópia externa do diário correto. Sem ela, a cópia não é restaurável.         |
| `writes=failing`             | Cadastros reais falhando ao gravar: rodar `probe-write`, conferir espaço, permissões e integridade em cópia.         |
| Update/rollback sai com 2    | Serviço indisponível; não restaurar banco. Conferir `.env`, imagem e logs; usar imagem saudável conhecida.           |
| Imagem recusada como falha   | `WHITEOVEN_IMAGE` aponta para imagem marcada em `.ops-state/failed-image`; fixar a imagem em execução ou nova.       |
| GHCR inacessível             | Visibilidade/permissões do pacote; login de leitura do operador, sem colocar token no repo ou app.                   |
| Publicação GHCR recusada     | Ver seção 10; o job falha fechado e nunca sobrescreve tag existente.                                                 |

Logs da aplicação são genéricos; `docker compose ... logs --tail 100 landing` para investigação autorizada. Não anexar dumps de env, banco ou exports a issues. Compose limita logs locais a três arquivos de 10 MiB por serviço; monitoramento e envio externo seguro ainda dependem do operador.

## 9. Checklist de liberação

- [ ] Destino, responsável, domínio e subnet sem conflitos definidos; nenhuma Orbia afetada.
- [ ] Imagem/digest/arquitetura aprovados e CI verde; pull testado; pacote GHCR com visibilidade correta.
- [ ] UID/volumes/permissões/espaço e recuperação de imagem validados no destino.
- [ ] DNS, HTTPS/renovação, firewall e headers conferidos.
- [ ] Caddy peer real igual à lista confiável; spoof rejeitado; Origin e limites preservados.
- [ ] Controlador/contato/política reais revisados; nenhuma credencial no build/Git/logs.
- [ ] Backup externo cifrado (seção 6), inventário, agendamentos de backup/purge/prune, expiração, cópia externa do diário e ensaio de restore definidos e testados.
- [ ] Monitoramento de liveness/readiness (`writes`), `probe-write`, disco e unhealthy, com alertas atribuídos a operador.
- [ ] Cadastro sintético completo, persistência após recriação, exclusão e recuperação conferidos.
- [ ] Ativação explícita da captação e verify confirmando ready/enabled/ready.

Todos os itens dependentes do ambiente real permanecem pendentes nesta PR. Nenhum deploy automático na VPS foi adicionado.

## 10. Publicação no GHCR

`ops/ghcr-publish.sh` roda no job `publish` da CI, só em push na `main`, com a imagem exata testada no job `containers`. Decisões, todas cobertas por `tests/deployment/ops.test.mjs`:

| Cenário                                                                         | Comportamento                                                          |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Revisão OCI da imagem diferente do commit                                       | Recusa.                                                                |
| Tag `sha-COMMIT` já existe                                                      | Sai com sucesso sem push; digest existente preservado.                 |
| Pacote existe, tag ausente (`manifest unknown`)                                 | Publica e confirma a tag no registry.                                  |
| Pacote inexistente (registry responde `denied`, API 404)                        | Primeira publicação.                                                   |
| `denied`/`unauthorized` com pacote existente (API 200)                          | Recusa: erro de autorização; nunca tenta publicar por cima.            |
| API do GitHub recusa ou falha (403, 000, `gh` com erro)                         | Recusa.                                                                |
| Registry inacessível ou texto inesperado (inclui "404 page not found" genérico) | Recusa, sem consultar a API.                                           |
| Push interrompido ou tag não confirmada depois do push                          | Falha; re-executar o job é seguro porque a tag existente é preservada. |

Nenhum desses cenários foi exercitado contra o GHCR real nesta milestone; o primeiro merge na `main` é o primeiro teste real, e a visibilidade do pacote precisa ser conferida depois dele.
