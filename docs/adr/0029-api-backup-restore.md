# ADR 0029: backup e restauração do PostgreSQL e das imagens

- **Status:** implementado em M7.1
- **Data:** 2026-10-31
- **Milestone:** M7.1

## Contexto

O piloto (M7) exige recuperar a API depois de perda de dados, migração ruim ou perda do host. Os dados da API ficam em dois lugares: o PostgreSQL 17 (ADR 0005) e o volume de imagens do catálogo, `tenants/{tenantId}/{assetId}/{variante}.webp` (ADR 0010). A ADR 0010 já avisava que o volume não é backup externo e que banco e bytes precisam ser copiados e restaurados como um conjunto. O runbook da landing cobre só o SQLite de leads.

O critério de aceite do roadmap pede restauração executada e registrada, com exclusões reaplicadas antes de restaurar. A exclusão de conta do cliente (ADR 0017) anonimiza o cliente, apaga endereços e aparelhos de push, tira os dados pessoais dos pedidos e revoga as sessões. Uma cópia feita antes dessa exclusão ainda tem os dados; restaurá-la sem reaplicar a exclusão traria de volta dados que o cliente mandou apagar.

Ainda não há ambiente de produção nem fornecedor de armazenamento externo aprovado (Q-13). O ambiente de referência é o Compose com os serviços `postgres` e `api` e o volume de imagens.

## Decisão

- **Ferramenta:** `ops/api-backup.sh`, em Bash sobre `docker compose`, como o `ops/whiteoven.sh` da landing. Comandos `backup`, `verify-backup`, `export-erasures`, `prune-backups` e `restore ID --confirm-offline [--erasures ARQUIVO]...`. Um lock em `.ops-state` impede duas operações ao mesmo tempo. Nenhum fornecedor novo.
- **Cópia do banco:** `pg_dump --format=custom` como superusuário do cluster, pelo socket local do container. O `whiteoven_owner` não serve, porque FORCE RLS filtra também o dono das tabelas (ADR 0006) e o dump sairia vazio ou falharia. A API continua sem credencial de dono ou superusuário.
- **Cópia das imagens:** `tar` do diretório `tenants` num container avulso da própria imagem da API (mesmo usuário e volume), sem montar o volume em outra imagem.
- **Consistência sem parar a API:** o banco é copiado primeiro e as imagens depois. Imagens só são gravadas antes do metadado e nunca apagadas depois do commit (a remoção só existe para compensar uma gravação que não chegou ao banco), então o arquivo de imagens tirado depois do dump contém toda imagem que o dump referencia; arquivos a mais são órfãos inofensivos. Se um dia a API passar a apagar imagens, esta regra precisa ser revista na mesma PR.
- **Manifesto:** cada cópia tem `manifest.txt` com ID, data, versão do PostgreSQL, identificador do cluster (`pg_control_system().system_identifier`), última migration, número de exclusões e de imagens, e o SHA-256 dos dois arquivos. `verify-backup` confere os hashes, lista o dump com `pg_restore -l` e lê o `tar`. O hash detecta corrupção, não prova autenticidade contra quem tem acesso ao diretório.
- **Diário de exclusões:** a fonte das exclusões é o próprio banco: o cliente nunca é apagado, só fica `DELETED` com `deleted_at` (ADR 0017). Não foi criada tabela nova. `export-erasures` grava um CSV com loja, cliente e horário (só UUIDs e data) para guardar fora do host.
- **Restauração:** sempre offline e deliberada.
  1. Confere a cópia e os papéis `whiteoven_owner`, `whiteoven_app` e `whiteoven_platform` (num host novo, o serviço `migrate` os cria antes).
  2. Junta as exclusões do banco atual, se legível, e de cada `--erasures`. O banco atual só basta sozinho quando está no mesmo cluster da cópia. Em outro cluster (host novo, volume perdido) ele não conhece as exclusões feitas depois da cópia, e o restore recusa com `ERASURES_MISSING` até receber o diário externo.
  3. Para a API, recusa se ainda houver conexões e faz uma cópia de segurança `pre-restore-*` do estado atual.
  4. Restaura o dump num banco candidato `whiteoven_restore`, refaz as permissões de conexão e, na mesma transação, carrega as exclusões e roda `ops/postgres/reapply-customer-erasures.sql`. Se alguma exclusão conhecida não ficar aplicada, a transação falha e o banco atual não muda.
  5. Extrai as imagens para um diretório de preparo no mesmo volume, troca o banco por renomeação (`whiteoven` vira `whiteoven_pre_restore_*`) e troca as imagens por renomeação (`tenants` antigo vai para `.pre-restore-*`).
  6. Registra a operação em `.ops-state/api-restore.log` e deixa a API parada. A subida passa pelo `migrate`, que aplica migrations mais novas que a cópia.
- **Reaplicação:** o arquivo SQL faz o mesmo que `deleteAccount`, guarda o horário original da exclusão e pode rodar duas vezes. O teste `backup-erasures.test.ts` compara o resultado com um `DELETE me` real e falha quando surge tabela nova que referencia `customers` sem entrar no arquivo.
- **Ensaio:** `tests/deployment/api-restore-drill.mjs` roda os dois cenários (mesmo host e perda do host) num Compose isolado com dados sintéticos e imprime o registro. Ele roda na CI, no job `api-container`.

## Consequências

- Exclusões feitas depois do último `export-erasures` se perdem se o host inteiro for perdido. O diário precisa ser exportado com frequência maior que a do backup (o runbook pede a cada hora) e a cópia externa substituída a cada exportação.
- As cópias e o diário saem sem cifra. Cifrar, levar para fora do host, controlar acesso e eliminar cópias vencidas é tarefa do operador até a Q-13 escolher um fornecedor. Nenhum agendamento de produção foi instalado.
- O restore deixa o banco anterior, as imagens anteriores e a cópia `pre-restore-*` para inspeção. Eles têm dados pessoais e precisam ser eliminados depois da validação, conforme o runbook.
- Um banco apagado e recriado à mão no mesmo cluster passaria pela regra do mesmo cluster sem conhecer exclusões antigas. O runbook manda sempre usar o diário externo quando o banco atual não for a continuação da cópia.
- O ensaio usa o Compose de desenvolvimento. O Compose de produção da API, quando existir, precisa manter os nomes `postgres` e `api`, o caminho `/var/lib/whiteoven/images` e rodar o ensaio de novo antes do piloto.
