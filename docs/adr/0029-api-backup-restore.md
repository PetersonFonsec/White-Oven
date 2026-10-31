# ADR 0029: backup e restauração do PostgreSQL e das imagens

- **Status:** implementado em M7.1 (revisado na PR #45: diário encadeado, operação com fases duráveis)
- **Data:** 2026-10-31
- **Milestone:** M7.1

## Contexto

O piloto (M7) exige recuperar a API depois de perda de dados, migração ruim ou perda do host. Os dados da API ficam em dois lugares: o PostgreSQL 17 (ADR 0005) e o volume de imagens do catálogo, `tenants/{tenantId}/{assetId}/{variante}.webp` (ADR 0010). A ADR 0010 já avisava que o volume não é backup externo e que banco e bytes precisam ser copiados e restaurados como um conjunto.

O critério de aceite do roadmap pede restauração executada e registrada, com exclusões reaplicadas antes de restaurar. A exclusão de conta do cliente (ADR 0017) anonimiza o cliente, apaga endereços e aparelhos de push, tira os dados pessoais dos pedidos e revoga as sessões. Uma cópia feita antes dessa exclusão ainda tem os dados; restaurá-la sem reaplicar a exclusão traria de volta dados que o cliente mandou apagar.

A primeira versão desta decisão confiava no identificador do cluster para saber se o banco atual conhecia todas as exclusões, usava um banco candidato de nome fixo e trocava banco e imagens sem estado durável. A revisão da PR #45 mostrou cinco riscos: um banco recriado no mesmo cluster passava como continuação da cópia; o candidato podia apagar um banco alheio; falhas intermediárias deixavam recursos sem registro; uploads concorrentes podiam deixar imagem referenciada ausente ou truncada na cópia; e uma troca interrompida podia deixar a API subir sobre um conjunto misturado. Esta versão trata os cinco.

Ainda não há ambiente de produção nem fornecedor de armazenamento externo aprovado (Q-13). O ambiente de referência é o Compose com os serviços `postgres` e `api` e o volume de imagens.

## Decisão

### Ferramenta

`ops/api-backup.sh`, em Bash sobre `docker compose`, como o `ops/whiteoven.sh` da landing. Comandos: `backup`, `verify-backup`, `export-erasures`, `prune-backups`, `restore ID --confirm-offline [--erasures DIARIO [--accept-erasures-until EXPORTADO_EM]]`, `restore-status`, `restore-rollback OPERACAO`, `restore-finish OPERACAO` e `restore-cleanup OPERACAO`. Um lock em `.ops-state` impede duas operações ao mesmo tempo; um lock cujo processo não existe mais (morte abrupta) é retomado. Nenhum fornecedor ou dependência nova.

### Cópia

- **Banco:** `pg_dump --format=custom` como superusuário do cluster, pelo socket local do container. O `whiteoven_owner` não serve, porque FORCE RLS filtra também o dono das tabelas (ADR 0006). A API continua sem credencial de dono ou superusuário.
- **Imagens:** `tar` do diretório `tenants` num container avulso da própria imagem da API, sem os arquivos temporários (`*.tmp`).
- **Consistência sem parar a API:** o banco é copiado primeiro e as imagens depois. A API publica cada variante completa e sincronizada sob o nome final antes de gravar o metadado, e nunca apaga imagem cujo metadado foi gravado (ADR 0010). Por isso o arquivo de imagens tirado depois do dump contém toda imagem que o dump referencia. Isso não fica só como argumento: o backup lê do próprio dump a lista de `image_assets` e confere cada variante no arquivo de imagens com `ops/api-image-check.mjs`, que roda com o Node e o Sharp da imagem da API. Se faltar uma ou alguma for inválida, o backup falha e nada é gravado.
- **Nível da conferência das imagens:** estrutural e de decodificação. Detecta variante ausente, arquivo truncado ou com sobra (tamanho RIFF diferente do arquivo), assinatura RIFF/WEBP errada, chunks que não cobrem o arquivo exatamente, primeiro chunk que não é VP8, VP8L ou VP8X, assinatura de bitstream VP8 ou VP8L errada, e qualquer conteúdo que o libwebp se recuse a decodificar por inteiro. Não detecta pixels alterados que ainda decodificam: nenhum checksum é gravado no upload, então nada distingue esses bytes dos originais. As variantes são conferidas uma a uma: no máximo um arquivo e um bitmap decodificado ficam em memória. Medido com variantes sintéticas de 1600 px e 480 px: cerca de 60 ms por imagem e pico de memória estável em cerca de 220 MB de 50 a 500 imagens (1 000 imagens levam cerca de 1 minuto, em cada conferência). Arquivos acima de 16 MiB são recusados sem leitura e o Sharp recusa imagens acima de 30 megapixels.
- **Manifesto:** formato `whiteoven-api-backup-2`, com ID, data, versão do PostgreSQL, linhagem do banco, última migration, número de imagens referenciadas conferidas e SHA-256 dos dois arquivos. `verify-backup` repete as conferências. O hash detecta corrupção, não prova autenticidade contra quem tem acesso ao diretório.

### Registro de exclusões e prova de continuidade

A migration `Migration20261105000000_customer_erasures` cria dois registros globais, sem dado pessoal e sem privilégio para os papéis da API:

- `database_lineage`: um UUID aleatório criado com o schema. Viaja com os dados (dump e restore o preservam). Um banco recriado do zero ganha outro, mesmo no mesmo cluster.
- `customer_erasures`: uma linha por conta excluída (loja, cliente, `deleted_at`), gravada por gatilho quando o cliente passa a `DELETED`. As linhas são numeradas de 1 a n sem lacuna e encadeadas: cada `hash` é o SHA-256 do hash anterior e do texto canônico da linha (`whiteoven_erasure_hash`). Não há UPDATE nem DELETE (gatilho de bloqueio). `whiteoven_verify_erasure_chain` confere qualquer tabela com essas colunas.

Uma fonte de exclusões só é aceita quando **prova** que continua a cópia: mesma linhagem, encadeamento íntegro, número de linhas igual ao último `seq`, e contém o último par (`seq`, `hash`) do diário da cópia. As fontes são o banco atual e, opcionalmente, um diário exportado. A mera existência de um arquivo não basta.

- O banco atual serve como fonte só se passar nessas conferências. Um banco recriado (outra linhagem) ou voltado para trás (sem o último estado da cópia) não serve.
- `export-erasures` grava o diário `whiteoven-customer-erasures-2`: cabeçalho com linhagem, último `seq`, último hash e data, e as linhas com `seq` e `hash`. O restore confere formato, contagem, última linha contra o cabeçalho, linhagem e encadeamento dentro do PostgreSQL. Um diário incompleto ou fora do formato é recusado antes de qualquer alteração; um diário de outra linhagem, adulterado ou anterior à cópia é recusado com `ERASURES_LEDGER_INVALID`.
- Sem nenhuma fonte válida o restore recusa com `ERASURES_MISSING`. Não há modo de forçar.
- O host guarda em `.ops-state/erasure-heads/<linhagem>` o último estado do diário que viu. Esse registro só avança quando o host observa o banco (backup, exportação e restore), não a cada exclusão. Se nenhuma fonte chega a esse estado, o restore recusa com `ERASURES_STALE`: protege contra um diário antigo trazido por engano e contra um banco substituído, fora da ferramenta, por um estado anterior da mesma linhagem, desde que o host tenha observado o estado perdido.
- Quando só o diário externo prova as exclusões (banco atual ausente, de outra linhagem ou que não continua a cópia), o restore recusa com `ERASURES_CUTOFF_UNCONFIRMED` até o operador repetir com `--accept-erasures-until` igual à data de exportação do diário. A confirmação registra no `state` até onde as exclusões são conhecidas (`erasures_until`). Um diário válido prova as exclusões até a exportação, nunca a ausência de exclusões depois dela.
- A reaplicação (`ops/postgres/reapply-customer-erasures.sql`) faz o mesmo que `deleteAccount`, preserva o horário original e pode rodar duas vezes sem efeito. Ela usa a união das fontes válidas, roda numa transação, falha se alguma exclusão conhecida não ficar aplicada e, ao final, o diário do banco restaurado é conferido de novo.

O que cada verificação prova, e o que não prova:

- **Integridade:** o encadeamento detecta hash alterado, linha alterada, linha intermediária ausente ou fora de ordem dentro de uma cadeia.
- **Continuidade:** a fonte contém o último estado da cópia e, quando conhecido, o último estado visto pelo host. Logo ela não perdeu nada até esses pontos.
- **Completude temporal:** nenhuma cadeia, sozinha, prova que não houve exclusões depois do seu último registro. O banco atual é completo por ser o banco em uso, a menos que tenha sido trocado fora da ferramenta depois da última observação do host. O diário é completo só até a exportação, e é isso que o operador confirma. A janela de risco é o intervalo entre a última exportação (ou observação) e a perda.

### Operação de restauração

Cada restore é uma operação com identificador próprio (`AAAAMMDDHHMMSS_xxxxxx`) e um diretório `.ops-state/api-restores/<operação>/` com `state` (gravado de forma atômica e sincronizado) e `journal`. As fases, em ordem: `PREPARING`, `CANDIDATE_CREATED`, `CANDIDATE_RESTORED`, `IMAGES_STAGED`, `API_STOPPED`, `ERASURES_REAPPLIED`, `SWAP_STARTED`, `DB_SWAPPING`, `DB_SWAPPED`, `IMAGES_SWAPPING`, `IMAGES_SWAPPED`, `ACTIVATING`, `COMPLETE`. Estados finais: `FAILED` (com `failed_phase`), `ROLLED_BACK`, `COMPLETE` e `CLEANED`. Enquanto houver operação que não está em estado final (inclusive `FAILED`), outro restore é recusado.

1. **Preparo, com a API no ar:** confere a cópia, o diário informado e os papéis. Cria o candidato `<banco>_rc_<operação>` (nome validado; se já existir, recusa sem tocar nele), revoga o acesso público, marca-o com o comentário `whiteoven-restore candidate op=<operação>` e restaura o dump nele numa transação. Confere linhagem e diário da cópia, valida o diário externo, confere as imagens da cópia contra o metadado do próprio candidato e as extrai para `.restore-<operação>` no volume.
2. **Parada:** para a API e recusa se houver conexões. Valida o banco atual como fonte, exige uma fonte válida e o último estado visto no host. Faz a cópia de segurança `pre-restore-<operação>` do estado atual e reaplica as exclusões no candidato.
3. **Troca:** registra o estado das imagens e entra em `SWAP_STARTED`. Revoga `CONNECT` dos papéis da API no banco atual e o marca como `previous`. Renomeia o banco atual para `<banco>_prev_<operação>`, o candidato para `<banco>`, e troca as imagens por renomeação dentro do volume (as atuais vão para `.pre-restore-<operação>`). Confere o conjunto restaurado (`verify_live_set`).
4. **Ativação:** grava `ACTIVATING` e, numa única transação do PostgreSQL, devolve `CONNECT` aos papéis da API e marca o banco como `restored`. Esse commit é o ponto de virada, e o banco é a fonte da verdade sobre ele. Antes do commit a API não conecta e uma falha leva ao rollback. Depois do commit o conjunto em uso já foi conferido, e só falta o registro local (`COMPLETE`, último estado do diário visto e `api-restore.log`). Se o processo morrer ou falhar nesse intervalo, a operação fica em `ACTIVATING`, o rollback é recusado e `restore-finish` conclui o registro. Nenhum `COMPLETE` é gravado antes do commit.

A troca **não é atômica**: são renomeações separadas no PostgreSQL e no volume. O que a torna segura é o bloqueio. De `SWAP_STARTED` até o commit da ativação os papéis `whiteoven_app` e `whiteoven_platform` não conseguem conectar ao nome do banco. O banco original perdeu `CONNECT` antes de ser renomeado, e o candidato nunca teve `CONNECT` (o dump não leva permissões de banco). Esse bloqueio está no próprio PostgreSQL: sobrevive à morte do processo e ao reinício do host. Uma API que suba nesse intervalo falha ao conectar e não fica pronta.

### Falhas e recuperação

- **Antes da troca:** a operação vira `FAILED` e nada em uso foi alterado. O candidato, o preparo das imagens e o `reapply.log` ficam para investigação. `restore-rollback` remove só o que tem a marca da operação.
- **Durante a troca:** o script tenta o rollback automático com a fase `ROLLING_BACK` gravada em disco. Ele devolve as imagens e o banco originais, remove o candidato marcado e confere o conjunto original (`verify_live_set`: toda imagem referenciada pelo banco original está em `tenants`, completa e decodificável, e não sobrou diretório da operação). Só então devolve `CONNECT` e grava `ROLLED_BACK`. Se qualquer passo falhar, grava `ROLLBACK_FAILED`, a API continua bloqueada e as mensagens de cada tentativa ficam em `rollback.log`. `restore-rollback` pode ser repetido.
- **Processo morto (kill, queda, reinício), inclusive durante o rollback:** a fase (`ROLLING_BACK` no rollback) fica no `state`, o bloqueio fica no PostgreSQL e o lock órfão é retomado. `restore-status` lista a operação como pendente e `restore-rollback` a encerra.
- **Liberação do acesso:** o `CONNECT` dos papéis da API só volta em dois pontos, ambos depois de `verify_live_set`: no commit da ativação (conjunto restaurado conferido, junto com a marca `restored` na mesma transação) e no fim de um rollback (conjunto original conferido). Uma recuperação parcial nunca libera acesso, e o rollback recusa uma operação cuja ativação o banco já confirmou.
- **Host novo:** sem banco original (`live_existed=no`) o rollback devolve o candidato ao nome de candidato e o remove, sem nada sob o nome do banco. Sem diretório `tenants` original, o rollback não cria um. Uma nova tentativa de restore é possível depois.
- O rollback olha o que realmente existe e pode ser repetido. Ele nunca remove um banco sem a marca da operação, e as remoções no volume só alcançam os diretórios da própria operação (`.restore-<operação>`, `.pre-restore-<operação>`). Não há `rm -rf` em `tenants` nem em diretório compartilhado.
- Depois de validar, `restore-cleanup` remove o banco anterior e as imagens anteriores marcados da operação concluída.

### Ensaio

`tests/deployment/api-restore-drill.mjs` executa o fluxo real num Compose isolado, só com dados sintéticos: backup durante uploads concorrentes; falhas injetadas antes e durante a troca; morte do processo durante a troca, com reinício do PostgreSQL; colisão de candidato; duas restaurações completas; banco recriado no mesmo cluster com diários inválidos e válidos; perda do host; imagem truncada. As falhas são injetadas por `WHITEOVEN_TEST_FAIL_AT` e `WHITEOVEN_TEST_KILL_AT`, que não têm efeito quando ausentes. Ele roda na CI, no job `api-container`.

## Consequências

- Exclusões feitas depois do último `export-erasures` se perdem se o host inteiro for perdido junto com o `.ops-state`, e o operador assume isso ao confirmar o corte do diário. Num host novo não existe o último estado visto, então um diário antigo, mas íntegro e posterior à cópia, só é detectado como antigo pelo inventário da cópia externa. Também não é detectada a troca do banco por um estado anterior da mesma linhagem feita depois da última observação do host. O diário precisa ser exportado com frequência maior que a do backup (o runbook pede a cada hora), e a cópia externa precisa ser substituída a cada exportação.
- A conferência do diário prova integridade e continuidade, não autenticidade: quem pode reescrever o arquivo inteiro e recalcular os hashes pode forjar um diário coerente. A proteção contra isso é o controle de acesso à cópia externa (Q-13).
- As cópias e o diário saem sem cifra. Cifrar, levar para fora do host, controlar acesso e eliminar cópias vencidas é tarefa do operador até a Q-13 escolher um fornecedor. Nenhum agendamento de produção foi instalado.
- O restore mantém o banco anterior, as imagens anteriores e a cópia `pre-restore-*` até o `restore-cleanup` e o `prune-backups`. Eles têm dados pessoais, inclusive de clientes que excluíram a conta depois da cópia, e precisam ser eliminados depois da validação.
- A API fica parada do início da fase `API_STOPPED` até o operador subi-la. Durante a troca ela não consegue conectar, por desenho.
- `customer_erasures` guarda IDs e horários de contas excluídas indefinidamente. Não há dado pessoal nele, mas o tempo de guarda entra na revisão jurídica da retenção (ADR 0017).
- Toda tabela global nova precisa entrar em `GLOBAL_TABLES` da checagem de isolamento, como `audit_events` e `customer_erasures`.
- O ensaio usa o Compose de desenvolvimento. O Compose de produção da API, quando existir, precisa manter os nomes `postgres` e `api`, o caminho `/var/lib/whiteoven/images` e rodar o ensaio de novo antes do piloto.
