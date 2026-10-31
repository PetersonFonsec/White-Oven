# Runbook: backup e restauração da API (PostgreSQL e imagens)

Decisão e motivos: [ADR 0029](../adr/0029-api-backup-restore.md). Este runbook vale para a API (`apps/api`). Os leads da landing têm o próprio procedimento no [runbook da landing](landing-deployment.md#6-backup-consistente-e-recuperação).

Nunca execute estes comandos contra um ambiente real sem autorização da tarefa. Não há ambiente de produção provisionado; o ambiente de referência é o Compose com os serviços `postgres` e `api` e o volume de imagens montado em `/var/lib/whiteoven/images`.

## 1. Configuração

| Variável                              | Padrão                   | Uso                                                               |
| ------------------------------------- | ------------------------ | ----------------------------------------------------------------- |
| `WHITEOVEN_API_COMPOSE_FILE`          | `compose.dev.yaml`       | Arquivo Compose com os serviços `postgres` e `api`.               |
| `WHITEOVEN_API_ENV_FILE`              | (nenhum)                 | `--env-file` do Compose, quando houver.                           |
| `WHITEOVEN_API_BACKUP_DIR`            | `.ops-state/api-backups` | Onde ficam as cópias (diretório 0700, arquivos 0600).             |
| `WHITEOVEN_STATE_DIR`                 | `.ops-state`             | Lock, área de trabalho do restore e `api-restore.log`.            |
| `WHITEOVEN_DB_NAME`                   | `whiteoven`              | Banco da API.                                                     |
| `WHITEOVEN_PG_SUPERUSER`              | `postgres`               | Superusuário do cluster, usado só pelo socket local do container. |
| `WHITEOVEN_API_BACKUP_RETENTION_DAYS` | `30`                     | Prazo do `prune-backups`.                                         |

O backup usa o superusuário porque FORCE RLS filtra até o `whiteoven_owner`. A senha dele não sai do container; a API nunca recebe essa credencial.

## 2. Backup

```bash
bash ops/api-backup.sh backup api_AAAAMMDD_HHMMSS
bash ops/api-backup.sh verify-backup api_AAAAMMDD_HHMMSS
```

A cópia pode ser feita com a API no ar. O banco é copiado primeiro e as imagens depois; como imagens nunca são apagadas depois do commit, toda imagem citada no banco está no arquivo de imagens. Cada cópia é um diretório com `database.dump` (formato custom do `pg_dump`), `images.tar` e `manifest.txt` (hashes, identificador do cluster, última migration, contagens). Um ID existente nunca é sobrescrito. Não use nomes, e-mails ou telefones no ID.

## 3. Diário de exclusões

```bash
bash ops/api-backup.sh export-erasures /root/whiteoven-export
```

Gera `customer-erasures-AAAAMMDDTHHMMSSZ.csv` com `tenant_id,customer_id,deleted_at` de toda conta excluída. Só tem UUIDs e horários. É o que leva a um host novo as exclusões feitas depois do backup escolhido. Exporte **a cada hora** e substitua a cópia externa a cada exportação; uma exclusão feita depois da última exportação se perde se o host inteiro for perdido.

## 4. Cópia externa

O script não cifra nem envia nada, e nenhum fornecedor foi escolhido (Q-13). Antes de dados reais:

1. Defina destino externo, chave de cifra fora do host, acesso mínimo e responsável.
2. Depois de cada `backup` e `verify-backup`, cifre o diretório da cópia, envie ao destino, confira o hash no destino e registre no inventário: ID, data, destino, responsável, expiração (`created_at` + retenção) e hashes do manifesto.
3. Depois de cada `export-erasures`, cifre o CSV, substitua a cópia externa do diário e apague o arquivo local.
4. Elimine cópias externas vencidas na data do inventário. `prune-backups` só alcança o diretório local.

Agende `backup` e `prune-backups` diariamente e `export-erasures` de hora em hora. Não há agendamento instalado por este repositório.

## 5. Restauração no mesmo host

Use quando o banco atual ainda existe (dado corrompido, migration errada, exclusão acidental).

```bash
bash ops/api-backup.sh verify-backup api_AAAAMMDD_HHMMSS
bash ops/api-backup.sh restore api_AAAAMMDD_HHMMSS --confirm-offline
```

O script:

1. Confere a cópia e lê as exclusões do banco atual. Junta os arquivos `--erasures`, se informados. Arquivos fora do formato são recusados antes de parar qualquer coisa.
2. Para o serviço `api` e recusa se ainda houver conexão no banco (pare migrate, ferramentas e outras instâncias).
3. Grava a cópia de segurança `pre-restore-AAAAMMDDHHMMSS` do estado atual, com o que foi escrito depois da cópia escolhida.
4. Restaura no banco candidato `whiteoven_restore`, reaplica as exclusões e confere que nenhuma ficou de fora. Qualquer erro aqui deixa o banco atual intacto.
5. Troca o banco por renomeação (o atual vira `whiteoven_pre_restore_AAAAMMDDHHMMSS`) e as imagens por renomeação (as atuais vão para `.pre-restore-AAAAMMDDHHMMSS` no volume).
6. Acrescenta uma linha em `.ops-state/api-restore.log` e deixa a API parada.

Depois:

```bash
docker compose -f compose.dev.yaml up -d --wait api   # roda o migrate antes
curl -fsS http://127.0.0.1:3000/health/ready
```

Confira cardápio público, login da equipe e de um cliente de teste e uma imagem do cardápio. Só então libere o tráfego.

## 6. Restauração depois de perder o host

1. Suba PostgreSQL e API vazios no host novo (`up -d --wait api`); o `migrate` cria os papéis e o schema.
2. Traga a cópia do destino externo, decifre num diretório 0700 dentro de `WHITEOVEN_API_BACKUP_DIR` e rode `verify-backup`.
3. Traga e decifre a cópia externa **mais recente** do diário.
4. Restaure informando o diário:

   ```bash
   bash ops/api-backup.sh restore api_AAAAMMDD_HHMMSS --confirm-offline --erasures /root/whiteoven-import/customer-erasures-AAAAMMDDTHHMMSSZ.csv
   ```

   Sem `--erasures`, o restore recusa com `ERASURES_MISSING`: o banco do host novo não conhece as exclusões feitas depois da cópia. Pode-se passar `--erasures` mais de uma vez.

5. Siga a subida e as conferências da seção 5.

Use `--erasures` também no mesmo host sempre que o banco atual não for a continuação da cópia (por exemplo, recriado à mão).

## 7. Limpeza depois da validação

O banco anterior, as imagens anteriores e a cópia `pre-restore-*` têm dados pessoais, inclusive de clientes que excluíram a conta depois da cópia escolhida (as exclusões foram reaplicadas só no banco restaurado). Depois de validar:

```bash
docker compose -f compose.dev.yaml exec -T postgres dropdb -U postgres whiteoven_pre_restore_AAAAMMDDHHMMSS
docker compose -f compose.dev.yaml run --rm --no-deps -T --entrypoint sh api -c 'rm -rf /var/lib/whiteoven/images/.pre-restore-AAAAMMDDHHMMSS'
```

e remova `pre-restore-*` de `WHITEOVEN_API_BACKUP_DIR` quando não for mais necessária (o `prune-backups` a remove no vencimento).

## 8. Falhas

| Sintoma                                   | Ação                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Hash ... não confere`                    | Cópia corrompida ou alterada. Não restaure; use outra cópia e investigue o destino.               |
| `ERASURES_MISSING`                        | Traga a cópia externa mais recente do diário. Sem ela, a cópia não deve ser restaurada.           |
| `Papéis ausentes`                         | Host novo sem migrate: suba o serviço `migrate` uma vez e repita.                                 |
| `Há N conexões abertas`                   | Pare todo processo que usa o banco. Nada foi alterado.                                            |
| `Reaplicação das exclusões sem resultado` | Banco atual intacto; candidato em `whiteoven_restore`. Veja o `reapply.log` indicado e não force. |
| `a troca das imagens falhou`              | Banco já restaurado. Não suba a API; mova à mão `.restore-*/tenants` para `tenants` e confira.    |
| `Outra operação ... em andamento`         | Confira se não há backup ou restore rodando antes de remover `.ops-state/api-backup.lock`.        |

## 9. Ensaio

```bash
node tests/deployment/api-restore-drill.mjs
```

Sobe um Compose isolado (projeto `whiteoven-drill-*`, portas 55432 e 53000), cria dados sintéticos e executa:

- **Mesmo host:** clientes A e B e uma imagem; backup; A exclui a conta; C se cadastra; outra imagem chega; restore. Confere que A continua excluído (sem e-mail, sem endereço, login 401), B volta, C fica só no banco anterior, a imagem da cópia volta idêntica e a posterior fica em `.pre-restore-*`.
- **Perda do host:** apaga os volumes, sobe um cluster novo, confere a recusa sem diário e restaura com o diário exportado; A continua excluído e a API volta saudável.
- Uma cópia adulterada é recusada pelo `verify-backup`.

A CI roda o ensaio no job `api-container`. Repita o ensaio com o Compose de produção da API antes do piloto e registre abaixo.

## 10. Registro de restaurações

| Data (UTC)       | Ambiente                                                                     | Commit    | Cenário       | Backup        | Restore                                  | Resultado                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------- | --------- | ------------- | ------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-31 17:59 | Ensaio local, Compose de desenvolvimento, PostgreSQL 17.11, dados sintéticos | `d6f4933` | Mesmo host    | 1,8 s         | 5,8 s (+7,1 s para a API ficar saudável) | Aprovado: `reapplied=1 already=0 absent=0`; exclusão posterior à cópia mantida, cliente posterior só no banco anterior, imagem idêntica byte a byte |
| 2026-10-31 17:59 | Ensaio local, cluster novo depois de apagar os volumes                       | `d6f4933` | Perda do host | (mesma cópia) | 5,7 s                                    | Aprovado: recusa `ERASURES_MISSING` sem diário; com o diário exportado, `reapplied=1`; API saudável como `whiteoven_app`                            |

No ensaio de 2026-10-31 a imagem da API foi montada a partir dos artefatos compilados no host, com a mesma base e o mesmo layout do `apps/api/Dockerfile`, porque o ambiente do ensaio não alcançava o registro npm de dentro do build. A CI repete o ensaio com a imagem construída pelo `Dockerfile`.
