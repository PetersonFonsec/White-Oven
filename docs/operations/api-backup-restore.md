# Runbook: backup e restauração da API (PostgreSQL e imagens)

Decisão e motivos: [ADR 0029](../adr/0029-api-backup-restore.md). Este runbook vale para a API (`apps/api`). Os leads da landing têm o próprio procedimento no [runbook da landing](landing-deployment.md#6-backup-consistente-e-recuperação).

Nunca execute estes comandos contra um ambiente real sem autorização da tarefa. Não há ambiente de produção provisionado; o ambiente de referência é o Compose com os serviços `postgres` e `api` e o volume de imagens montado em `/var/lib/whiteoven/images`.

## 1. Configuração

| Variável                              | Padrão                   | Uso                                                                            |
| ------------------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `WHITEOVEN_API_COMPOSE_FILE`          | `compose.dev.yaml`       | Arquivo Compose com os serviços `postgres` e `api`.                            |
| `WHITEOVEN_API_ENV_FILE`              | (nenhum)                 | `--env-file` do Compose, quando houver.                                        |
| `WHITEOVEN_API_BACKUP_DIR`            | `.ops-state/api-backups` | Onde ficam as cópias (diretório 0700, arquivos 0600).                          |
| `WHITEOVEN_STATE_DIR`                 | `.ops-state`             | Lock, operações de restore, último estado do diário visto e `api-restore.log`. |
| `WHITEOVEN_DB_NAME`                   | `whiteoven`              | Banco da API.                                                                  |
| `WHITEOVEN_PG_SUPERUSER`              | `postgres`               | Superusuário do cluster, usado só pelo socket local do container.              |
| `WHITEOVEN_API_BACKUP_RETENTION_DAYS` | `30`                     | Prazo do `prune-backups`.                                                      |

O backup usa o superusuário porque FORCE RLS filtra até o `whiteoven_owner`. A senha dele não sai do container; a API nunca recebe essa credencial.

O `.ops-state` faz parte da proteção: guarda as operações de restore e o último estado do diário de exclusões visto neste host. Não o apague entre operações.

## 2. Backup

```bash
bash ops/api-backup.sh backup api_AAAAMMDD_HHMMSS
bash ops/api-backup.sh verify-backup api_AAAAMMDD_HHMMSS
```

A cópia pode ser feita com a API no ar e com uploads acontecendo. O banco é copiado primeiro e as imagens depois. Antes de gravar a cópia, o script lê do dump a lista de imagens referenciadas e confere no arquivo de imagens que as duas variantes de cada uma existem e estão completas. Se faltar alguma, o backup falha com `Backup recusado` e nada é gravado; investigue o volume (ADR 0010) antes de repetir.

Cada cópia é um diretório com `database.dump`, `images.tar` e `manifest.txt` (formato `whiteoven-api-backup-2`, linhagem do banco, última migration, número de imagens conferidas e hashes). Um ID existente nunca é sobrescrito. Não use nomes, e-mails ou telefones no ID. Cópias do formato antigo não são restauráveis por esta versão.

## 3. Diário de exclusões

```bash
bash ops/api-backup.sh export-erasures /root/whiteoven-export
```

Gera `customer-erasures-AAAAMMDDTHHMMSSZ.csv`, formato `whiteoven-customer-erasures-2`:

```text
# whiteoven-customer-erasures-2 lineage=<uuid> head=<n> head_hash=<sha256> exported_at=<data>
seq,tenant_id,customer_id,deleted_at,hash
1,<uuid>,<uuid>,2026-10-31T12:00:00.000000Z,<sha256>
```

Só tem UUIDs, horários e hashes. As linhas vêm do registro `customer_erasures` do banco, numeradas sem lacuna e encadeadas por SHA-256. É o que leva a um host novo, ou a um banco recriado, as exclusões feitas depois do backup escolhido. Exporte **a cada hora** e substitua a cópia externa a cada exportação. Uma exclusão feita depois da última exportação se perde se o host inteiro for perdido.

Não edite o arquivo. Qualquer alteração, linha a menos ou fora de ordem faz o restore recusá-lo.

## 4. Cópia externa

O script não cifra nem envia nada, e nenhum fornecedor foi escolhido (Q-13). Antes de dados reais:

1. Defina destino externo, chave de cifra fora do host, acesso mínimo e responsável.
2. Depois de cada `backup` e `verify-backup`, cifre o diretório da cópia, envie ao destino, confira o hash no destino e registre no inventário: ID, data, destino, responsável, expiração (`created_at` + retenção) e hashes do manifesto.
3. Depois de cada `export-erasures`, cifre o CSV, substitua a cópia externa do diário e apague o arquivo local.
4. Elimine cópias externas vencidas na data do inventário. `prune-backups` só alcança o diretório local.

Agende `backup` e `prune-backups` diariamente e `export-erasures` de hora em hora. Não há agendamento instalado por este repositório.

## 5. Restauração no mesmo host

Use quando o banco atual ainda existe e é a continuação da cópia (dado corrompido, migration errada, exclusão acidental).

```bash
bash ops/api-backup.sh verify-backup api_AAAAMMDD_HHMMSS
bash ops/api-backup.sh restore api_AAAAMMDD_HHMMSS --confirm-offline
```

Pré-condições: nenhuma operação de restore pendente (`restore-status`), papéis criados pelo `migrate`, e nada além da API conectado ao banco.

O script cria a operação `AAAAMMDDHHMMSS_xxxxxx` e mostra seu identificador. Ele:

1. Confere a cópia e o diário informado. Diário fora do formato ou incompleto é recusado antes de qualquer alteração.
2. Com a API no ar, cria o candidato `whiteoven_rc_<operação>` (recusa se o nome já existir), restaura o dump nele, confere o diário da cópia e as imagens e as prepara em `.restore-<operação>` no volume.
3. Para a API, recusa se ainda houver conexão, e aceita o banco atual como fonte de exclusões só se ele provar que continua a cópia (mesma linhagem, diário íntegro e contendo o último estado da cópia). Sem fonte válida, recusa com `ERASURES_MISSING`.
4. Grava a cópia de segurança `pre-restore-<operação>` do estado atual e reaplica as exclusões no candidato.
5. Troca banco e imagens. Durante a troca a API não consegue conectar (o `CONNECT` dos papéis da API fica revogado até o fim). O banco atual vira `whiteoven_prev_<operação>` e as imagens atuais vão para `.pre-restore-<operação>`.
6. Grava `COMPLETE`, acrescenta uma linha em `.ops-state/api-restore.log` e deixa a API parada.

Depois:

```bash
docker compose -f compose.dev.yaml up -d --wait api   # roda o migrate antes
curl -fsS http://127.0.0.1:3000/health/ready
```

Confira cardápio público, login da equipe e de um cliente de teste e uma imagem do cardápio. Só então libere o tráfego.

Se o banco atual foi recriado à mão, restaurado fora desta ferramenta ou não é a continuação da cópia, ele não serve de fonte e o restore pede o diário externo (seção 6, passos 3 e 4).

## 6. Restauração depois de perder o host

1. Suba PostgreSQL e API vazios no host novo (`up -d --wait api`); o `migrate` cria os papéis e o schema.
2. Traga a cópia do destino externo, decifre num diretório 0700 dentro de `WHITEOVEN_API_BACKUP_DIR` e rode `verify-backup`.
3. Traga e decifre a cópia externa **mais recente** do diário.
4. Restaure informando o diário:

   ```bash
   bash ops/api-backup.sh restore api_AAAAMMDD_HHMMSS --confirm-offline --erasures /root/whiteoven-import/customer-erasures-AAAAMMDDTHHMMSSZ.csv
   ```

5. Siga a subida e as conferências da seção 5.

O diário é aceito só se for da mesma linhagem da cópia, tiver o encadeamento íntegro, a contagem igual ao cabeçalho e contiver o último estado do diário da cópia. Num host que já viu um estado mais novo do diário dessa linhagem, ele também precisa chegar a esse estado.

| Recusa                                         | Significado                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `ERASURES_MISSING`                             | Nenhuma fonte prova as exclusões feitas depois da cópia. Traga o diário externo.  |
| `ERASURES_LEDGER_INVALID: ... linhagem`        | Diário de outro banco. Use o diário exportado do banco de onde veio a cópia.      |
| `ERASURES_LEDGER_INVALID: o encadeamento ...`  | Diário alterado, truncado ou fora de ordem. Use outra cópia externa e investigue. |
| `ERASURES_LEDGER_INVALID: ... estado da cópia` | Diário anterior à cópia. Use um diário exportado depois dela.                     |
| `ERASURES_STALE`                               | Diário mais antigo que o último estado visto neste host. Use um diário mais novo. |
| `Diário ... incompleto` ou `fora do formato`   | Arquivo cortado ou editado; recusado antes de qualquer alteração.                 |

Nenhuma dessas recusas pode ser contornada. Se não houver diário válido, a cópia não deve ser restaurada: trazer de volta dados de quem pediu a exclusão é pior do que perder dados posteriores.

## 7. Operações interrompidas e recuperação

```bash
bash ops/api-backup.sh restore-status
```

Lista cada operação com fase, cópia, fase da falha e horário. Uma operação marcada `[PENDENTE]` (em andamento, interrompida ou `FAILED`) bloqueia outro restore até ser encerrada. O estado fica em `.ops-state/api-restores/<operação>/` (`state` e `journal`), e sobrevive à morte do processo e ao reinício do host.

**Como reconhecer um restore interrompido:** `restore-status` mostra `[PENDENTE]`; a API não fica pronta e o log dela mostra `permission denied for database`; o banco `whiteoven` tem comentário `whiteoven-restore ...` (`select shobj_description(oid, 'pg_database') from pg_database where datname = 'whiteoven'`), ou o banco nem existe.

**Para encerrar:**

```bash
bash ops/api-backup.sh restore-rollback <operação>
```

Devolve o banco e as imagens originais, remove o candidato e o preparo da operação, devolve o `CONNECT` da API e grava `ROLLED_BACK`. Pode ser repetido. Um lock deixado por um processo morto é retomado automaticamente. Depois, suba a API e confira.

| Fase registrada                                                 | Situação                             | O que fazer                                                       |
| --------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| `FAILED` com falha antes de `SWAP_STARTED`                      | Nada em uso mudou; candidato mantido | Leia o erro e o `reapply.log`; depois `restore-rollback`.         |
| `ROLLED_BACK`                                                   | Rollback automático feito            | Suba a API e confira.                                             |
| `FAILED` com falha a partir de `SWAP_STARTED` (rollback falhou) | API bloqueada                        | `restore-rollback`; se falhar de novo, recuperação manual abaixo. |
| `SWAP_STARTED` a `IMAGES_SWAPPED` (processo morto)              | API bloqueada                        | `restore-rollback`.                                               |
| `COMPLETE`                                                      | Restauração concluída                | Para voltar, restaure a cópia `pre-restore-<operação>`.           |

**Recuperação manual** (só se `restore-rollback` falhar repetidamente; `OP` é o identificador da operação):

1. Banco: o original é o que tem comentário `whiteoven-restore previous op=OP` (normalmente `whiteoven_prev_OP`). Se `whiteoven` tiver comentário `whiteoven-restore candidate op=OP`, renomeie-o para `whiteoven_rc_OP`; depois renomeie o original para `whiteoven`:
   ```bash
   docker compose -f compose.dev.yaml exec -T postgres psql -U postgres -d postgres -c 'alter database "whiteoven" rename to "whiteoven_rc_OP"'
   docker compose -f compose.dev.yaml exec -T postgres psql -U postgres -d postgres -c 'alter database "whiteoven_prev_OP" rename to "whiteoven"'
   ```
2. Imagens: se `.pre-restore-OP/tenants` existir, mova o `tenants` atual (se houver) para `.restore-OP/tenants` e `.pre-restore-OP/tenants` para `tenants`, num container avulso da API (`run --rm --no-deps --entrypoint sh api`).
3. Permissões: `grant connect on database "whiteoven" to whiteoven_app, whiteoven_platform` e `comment on database "whiteoven" is null`.
4. Rode `restore-rollback OP` de novo para remover o que sobrou e registrar `ROLLED_BACK`.

Nunca apague um banco ou diretório sem conferir o comentário ou o nome com o identificador da operação.

## 8. Limpeza depois da validação

O banco anterior, as imagens anteriores e a cópia `pre-restore-*` têm dados pessoais, inclusive de clientes que excluíram a conta depois da cópia escolhida (as exclusões foram reaplicadas só no banco restaurado). Depois de validar:

```bash
bash ops/api-backup.sh restore-cleanup <operação>
```

Remove só o banco `whiteoven_prev_<operação>` com a marca da operação e o diretório `.pre-restore-<operação>`, e grava `CLEANED`. Recusa se houver conexão no banco anterior. A cópia `pre-restore-<operação>` em `WHITEOVEN_API_BACKUP_DIR` fica até o `prune-backups`; remova-a antes se não for mais necessária.

## 9. Outras falhas

| Sintoma                                   | Ação                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `Hash ... não confere`                    | Cópia corrompida ou alterada. Não restaure; use outra cópia e investigue o destino.        |
| `Backup recusado` ou imagem incompleta    | Imagem referenciada ausente ou truncada. Investigue o volume (ADR 0010); nada foi gravado. |
| `Papéis ausentes`                         | Host novo sem migrate: suba o serviço `migrate` uma vez e repita.                          |
| `Há N conexões abertas`                   | Pare todo processo que usa o banco; depois `restore-rollback` da operação.                 |
| `O banco ... já existe e não pertence`    | Nome de candidato ocupado; o banco não foi tocado. `restore-rollback` e repita.            |
| `Há restauração incompleta`               | Seção 7.                                                                                   |
| `Outra operação ... em andamento`         | Há outro backup ou restore vivo. Espere; um lock de processo morto é retomado sozinho.     |
| `AVISO: o diário ... não contém o último` | O banco atual não continua o que este host viu. Investigue antes de qualquer restore.      |

## 10. Garantias e limites

Garantias, verificadas pelo ensaio:

- Toda imagem referenciada pelo banco de uma cópia está nela, completa.
- Nenhuma exclusão conhecida por uma fonte válida volta a ter dados pessoais; sem fonte válida o restore não acontece.
- Falha antes da troca não altera banco nem imagens em uso.
- Do início da troca até o fim, a API não consegue conectar, mesmo depois de morte do processo ou reinício do host.
- Falha durante a troca volta ao conjunto original, automaticamente ou com `restore-rollback`.
- Nenhum banco ou diretório sem a marca da operação é removido.

Limites:

- A troca não é atômica; é segura por causa do bloqueio e do rollback.
- Num host novo, sem `.ops-state`, um diário antigo mas posterior à cópia é aceito; exclusões depois dele se perdem.
- O encadeamento prova integridade e continuidade, não autenticidade contra quem controla o arquivo inteiro.
- A API fica fora do ar desde a parada até ser subida pelo operador.

## 11. Ensaio

```bash
node tests/deployment/api-restore-drill.mjs
```

Sobe um Compose isolado (projeto `whiteoven-drill-*`, portas 55432 e 53000), cria só dados sintéticos e executa:

- **Backup durante uploads concorrentes** pela API real; confere que toda imagem referenciada está na cópia, completa, e que temporários não entram.
- **Falhas antes da troca** (`candidate_prepare`, `pg_restore`, `images_extract`, `reapply`): conjunto em uso intacto, candidato mantido, lock liberado, bloqueio de novo restore até `restore-rollback`.
- **Colisão de candidato:** banco preexistente com o nome do candidato preservado.
- **Falhas durante a troca** (`swap_prepare`, `after_db_swap`, `images_swap`): rollback automático, API saudável depois.
- **Processo morto** (`db_rename`, `after_db_swap` com reinício do PostgreSQL, `before_complete`): API não fica pronta, operação pendente, lock retomado, `restore-rollback`.
- **Duas restaurações completas:** exclusões mantidas, imagens dos uploads concorrentes idênticas, candidatos distintos, `restore-cleanup`.
- **Banco recriado no mesmo cluster:** recusas sem diário e com diário de outra linhagem, adulterado, incompleto, anterior à cópia ou antigo; aprovação com o diário atual.
- **Perda do host:** recusa sem diário, aprovação com o diário.
- **Imagem truncada:** backup recusado.

A CI roda o ensaio no job `api-container`. Repita o ensaio com o Compose de produção da API antes do piloto e registre abaixo.

## 12. Registro de restaurações

| Data (UTC)       | Ambiente                                                                     | Commit    | Cenário       | Backup        | Restore                                  | Resultado                                                              |
| ---------------- | ---------------------------------------------------------------------------- | --------- | ------------- | ------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| 2026-10-31 17:59 | Ensaio local, Compose de desenvolvimento, PostgreSQL 17.11, dados sintéticos | `d6f4933` | Mesmo host    | 1,8 s         | 5,8 s (+7,1 s para a API ficar saudável) | Aprovado (versão anterior do script, substituída na revisão da PR #45) |
| 2026-10-31 17:59 | Ensaio local, cluster novo depois de apagar os volumes                       | `d6f4933` | Perda do host | (mesma cópia) | 5,7 s                                    | Aprovado (versão anterior do script, substituída na revisão da PR #45) |

Nos ensaios locais a imagem da API foi montada a partir dos artefatos compilados no host, com a mesma base e o mesmo layout do `apps/api/Dockerfile`, porque o ambiente do ensaio não alcançava o registro npm de dentro do build. A CI repete o ensaio com a imagem construída pelo `Dockerfile`.
