#!/usr/bin/env bash
# Backup and restore of the API data: PostgreSQL and catalog images, as one set (M7.1, ADR 0029).
# Runbook: docs/operations/api-backup-restore.md. Never run against a real environment without
# task authorization.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
compose_file="${WHITEOVEN_API_COMPOSE_FILE:-compose.dev.yaml}"
backup_root="${WHITEOVEN_API_BACKUP_DIR:-.ops-state/api-backups}"
state_dir="${WHITEOVEN_STATE_DIR:-.ops-state}"
db="${WHITEOVEN_DB_NAME:-whiteoven}"
superuser="${WHITEOVEN_PG_SUPERUSER:-postgres}"
retention_days="${WHITEOVEN_API_BACKUP_RETENTION_DAYS:-30}"
images_dir=/var/lib/whiteoven/images
reapply_sql=ops/postgres/reapply-customer-erasures.sql
compose=(docker compose -f "$compose_file")
[[ -z "${WHITEOVEN_API_ENV_FILE:-}" ]] ||
 compose=(docker compose --env-file "$WHITEOVEN_API_ENV_FILE" -f "$compose_file")
command="${1:-help}"
shift || true
usage() {
 echo 'Uso: bash ops/api-backup.sh backup ID | verify-backup ID | export-erasures DIR | prune-backups | restore ID --confirm-offline [--erasures ARQUIVO]...' >&2
 exit 1
}
fail() { echo "$*" >&2; exit 1; }
valid_id() { [[ "$1" =~ ^[a-zA-Z0-9_-]{1,80}$ ]]; }
[[ "$db" =~ ^[a-z_][a-z0-9_]{0,30}$ ]] || fail 'WHITEOVEN_DB_NAME inválido.'
[[ "$superuser" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail 'WHITEOVEN_PG_SUPERUSER inválido.'
[[ "$retention_days" =~ ^[1-9][0-9]{0,2}$ ]] || fail 'WHITEOVEN_API_BACKUP_RETENTION_DAYS inválido.'

# The superuser reads through RLS (FORCE RLS filters even whiteoven_owner), over the container's
# local socket; its password never leaves the container.
psql_on() {
 local database="$1"; shift
 "${compose[@]}" exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U "$superuser" -d "$database" "$@"
}
query() { psql_on "$1" -At -c "$2"; }
# Runs a shell in a one-off API container: same image, user (node) and image volume as the API.
in_api() { "${compose[@]}" run --rm --no-deps -T --entrypoint sh api -c "$1"; }
# Customer deletions as CSV without header: tenant, customer, deletion time in UTC.
current_erasures() {
 psql_on "$1" -At -c 'set timezone = UTC' -c \
  "copy (select tenant_id, id, deleted_at from customers where status = 'DELETED'
          order by deleted_at, id) to stdout with (format csv)"
}
# Changes only when the cluster is created again (new host, lost volume); a restore keeps it.
cluster_id() { query postgres 'select system_identifier from pg_control_system()'; }
manifest_value() { sed -n "s/^$2=//p" "$1/manifest.txt" | head -n 1; }

case "$command" in
 backup|restore|export-erasures|prune-backups)
  mkdir -p "$state_dir"
  mkdir "$state_dir/api-backup.lock" 2>/dev/null || fail 'Outra operação de backup ou restore está em andamento.'
  partial=""
  trap 'rm -rf -- ${partial:+"$partial"}; rmdir "$state_dir/api-backup.lock"' EXIT ;;
esac

take_backup() {
 local id="$1" dir="$backup_root/$1"
 [[ ! -e "$dir" ]] || fail "A cópia $id já existe; nada foi sobrescrito. Use um ID novo."
 mkdir -p "$backup_root"
 partial="$backup_root/.$id.partial-$$"
 mkdir "$partial"
 local created epoch
 created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; epoch="$(date -u +%s)"
 # Database first, then images. Images are never deleted after their metadata commits (ADR 0010),
 # so an archive taken after the dump holds every file the dump references; extra files are
 # harmless orphans.
 "${compose[@]}" exec -T postgres pg_dump -U "$superuser" -d "$db" --format=custom > "$partial/database.dump"
 [[ -s "$partial/database.dump" ]] || fail 'pg_dump não produziu nada; nenhuma cópia foi gravada.'
 in_api "cd $images_dir && if [ -d tenants ]; then exec tar -cf - tenants; else exec tar -cf - -T /dev/null; fi" > "$partial/images.tar"
 tar -tf "$partial/images.tar" > /dev/null
 "${compose[@]}" exec -T postgres pg_restore -l < "$partial/database.dump" > /dev/null
 local version migration erasures files
 version="$(query "$db" 'show server_version_num')"
 migration="$(query "$db" 'select name from mikro_orm_migrations order by id desc limit 1')"
 erasures="$(query "$db" "select count(*) from customers where status = 'DELETED'")"
 files="$(tar -tf "$partial/images.tar" | grep -c '\.webp$' || true)"
 {
  echo 'format=whiteoven-api-backup-1'
  echo "id=$id"
  echo "created_at=$created"
  echo "created_epoch=$epoch"
  echo "database=$db"
  echo "server_version_num=$version"
  echo "cluster_id=$(cluster_id)"
  echo "last_migration=$migration"
  echo "customer_erasures=$erasures"
  echo "image_files=$files"
  echo "database_sha256=$(sha256sum "$partial/database.dump" | cut -d' ' -f1)"
  echo "images_sha256=$(sha256sum "$partial/images.tar" | cut -d' ' -f1)"
 } > "$partial/manifest.txt"
 mv -T -- "$partial" "$dir"
 partial=""
 echo "Cópia $id gravada: banco ($migration), $files arquivos de imagem, $erasures exclusões de conta no banco."
}

verify_backup() {
 local id="$1" dir="$backup_root/$1"
 [[ -f "$dir/manifest.txt" && "$(manifest_value "$dir" format)" == whiteoven-api-backup-1 ]] ||
  fail "Cópia $id ausente ou sem manifesto válido."
 [[ "$(sha256sum "$dir/database.dump" | cut -d' ' -f1)" == "$(manifest_value "$dir" database_sha256)" ]] ||
  fail "Hash do banco não confere na cópia $id: não restaurar."
 [[ "$(sha256sum "$dir/images.tar" | cut -d' ' -f1)" == "$(manifest_value "$dir" images_sha256)" ]] ||
  fail "Hash das imagens não confere na cópia $id: não restaurar."
 tar -tf "$dir/images.tar" > /dev/null
 "${compose[@]}" exec -T postgres pg_restore -l < "$dir/database.dump" > /dev/null
 echo "Cópia $id conferida: hashes, arquivo de imagens e lista do pg_restore."
}

case "$command" in
 backup)
  valid_id "${1:-}" || usage
  take_backup "$1" ;;
 verify-backup)
  valid_id "${1:-}" || usage
  verify_backup "$1" ;;
 export-erasures)
  [[ -n "${1:-}" ]] || usage
  mkdir -p "$1"
  target="$1/customer-erasures-$(date -u +%Y%m%dT%H%M%SZ).csv"
  [[ ! -e "$target" ]] || fail 'Destino já existe; nada foi sobrescrito.'
  partial="$1/.$(basename "$target").partial-$$"
  { echo 'tenant_id,customer_id,deleted_at'; current_erasures "$db"; } > "$partial"
  mv -n -T -- "$partial" "$target"
  [[ ! -e "$partial" ]] || fail 'Destino criado por outro processo; nada foi sobrescrito.'
  partial=""
  echo "Diário de exclusões exportado: $target ($(($(wc -l < "$target") - 1)) contas). Cifre e substitua a cópia externa conforme o runbook." ;;
 prune-backups)
  [[ -d "$backup_root" ]] || exit 0
  now="$(date -u +%s)"
  for dir in "$backup_root"/*/; do
   [[ -d "$dir" ]] || continue
   dir="${dir%/}"; name="$(basename "$dir")"
   valid_id "$name" || continue
   epoch="$(manifest_value "$dir" created_epoch 2>/dev/null || true)"
   if [[ ! "$epoch" =~ ^[0-9]+$ ]] || (( now - epoch > retention_days * 86400 )); then
    rm -rf -- "$dir"
    echo "Removida: $name"
   fi
  done ;;
 restore)
  id="${1:-}"
  valid_id "$id" || usage
  [[ "${2:-}" == --confirm-offline ]] || fail 'Exige o ID da cópia e --confirm-offline; leia o runbook.'
  shift 2
  files=()
  while (($#)); do
   [[ "$1" == --erasures && -f "${2:-}" ]] || usage
   files+=("$2"); shift 2
  done
  # Every file is checked before anything stops: a malformed ledger must not cost downtime.
  for file in ${files[@]+"${files[@]}"}; do
   [[ "$(head -n 1 "$file")" == tenant_id,customer_id,deleted_at ]] || fail "Diário $file sem o cabeçalho esperado."
   if tail -n +2 "$file" | grep -qvE '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12},[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12},[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?\+00$'; then
    fail "Diário $file tem linha fora do formato; nada foi alterado."
   fi
  done
  verify_backup "$id"
  missing="$(query postgres "select coalesce(string_agg(r, ', '), '') from unnest(array['whiteoven_owner', 'whiteoven_app', 'whiteoven_platform']) r where not exists (select 1 from pg_roles where rolname = r)")"
  [[ -z "$missing" ]] || fail "Papéis ausentes no PostgreSQL: $missing. Num host novo, rode o serviço migrate uma vez antes do restore (runbook)."
  stamp="$(date -u +%Y%m%d%H%M%S)"
  work="$state_dir/api-restore-$stamp"
  mkdir -p "$work"
  erasures="$work/erasures.csv"
  : > "$erasures"
  # Deletions come from the live database when it can still be read, and from every exported
  # ledger given. The live database alone is enough only in the cluster the backup came from: a
  # new cluster (new host, lost volume) does not know the deletions made after the backup.
  live=0
  if [[ "$(query postgres "select count(*) from pg_database where datname = '$db'")" == 1 ]] &&
     current_erasures "$db" >> "$erasures" 2> "$work/live-erasures.err"; then
   live=1
  else
   : > "$erasures"
   echo 'Aviso: o banco atual não pôde ser lido; só os diários informados serão reaplicados.' >&2
  fi
  same_cluster=0
  [[ "$(cluster_id)" != "$(manifest_value "$backup_root/$id" cluster_id)" ]] || same_cluster=1
  if (( ${#files[@]} == 0 )) && ! (( live && same_cluster )); then
   fail 'ERASURES_MISSING: o banco atual não é a continuação desta cópia (outro cluster ou ilegível) e nenhum --erasures foi informado. Traga a cópia externa mais recente do diário de exclusões (runbook); nada foi alterado.'
  fi
  for file in ${files[@]+"${files[@]}"}; do tail -n +2 "$file" >> "$erasures"; done
  sort -u -o "$erasures" "$erasures"
  known="$(wc -l < "$erasures" | tr -d ' ')"

  "${compose[@]}" stop api
  candidate="${db}_restore"
  open="$(query postgres "select count(*) from pg_stat_activity where datname in ('$db', '$candidate') and pid <> pg_backend_pid()")"
  [[ "$open" == 0 ]] || fail "Há $open conexões abertas no banco. Pare todo processo que o usa (API, migrate, ferramentas) e repita; nada foi alterado."
  # Safety copy of what is about to be replaced, data written after the selected backup included.
  if (( live )); then take_backup "pre-restore-$stamp"; fi

  query postgres "drop database if exists \"$candidate\"" > /dev/null
  query postgres "create database \"$candidate\" owner whiteoven_owner" > /dev/null
  "${compose[@]}" exec -T postgres pg_restore -U "$superuser" -d "$candidate" --exit-on-error --single-transaction < "$backup_root/$id/database.dump"
  # Database-level grants are not part of a dump; same grants as the first migration.
  query "$candidate" "revoke all on database \"$candidate\" from public; grant connect on database \"$candidate\" to whiteoven_app, whiteoven_platform" > /dev/null
  {
   echo 'begin;'
   echo 'create temp table restore_erasures (tenant_id uuid not null, customer_id uuid not null, deleted_at timestamptz not null) on commit drop;'
   echo 'copy restore_erasures from stdin with (format csv);'
   cat "$erasures"
   echo '\.'
   cat "$reapply_sql"
   echo "do \$\$ begin if exists (select 1 from restore_erasures e join customers c on c.tenant_id = e.tenant_id and c.id = e.customer_id where c.status <> 'DELETED') then raise exception 'customer erasure not applied'; end if; end \$\$;"
   echo 'commit;'
  } | psql_on "$candidate" 2> "$work/reapply.log"
  result="$(sed -n 's/.*whiteoven_erasures //p' "$work/reapply.log")"
  [[ -n "$result" ]] || fail "Reaplicação das exclusões sem resultado; banco atual intacto, candidato em $candidate. Veja $work/reapply.log."

  # Images go to a staging directory inside the same volume, so the swap below is two renames.
  in_api "set -eu; cd $images_dir; rm -rf .restore-$stamp; mkdir .restore-$stamp; tar -xf - -C .restore-$stamp" < "$backup_root/$id/images.tar"

  previous="${db}_pre_restore_$stamp"
  if (( live )) || [[ "$(query postgres "select count(*) from pg_database where datname = '$db'")" == 1 ]]; then
   query postgres "alter database \"$db\" rename to \"$previous\"" > /dev/null
  fi
  if ! query postgres "alter database \"$candidate\" rename to \"$db\"" > /dev/null; then
   query postgres "alter database \"$previous\" rename to \"$db\"" > /dev/null || true
   fail "Troca do banco falhou; o banco anterior foi devolvido ao nome $db. Imagens não foram trocadas."
  fi
  in_api "set -eu; cd $images_dir; mkdir .pre-restore-$stamp; if [ -d tenants ]; then mv tenants .pre-restore-$stamp/; fi; if [ -d .restore-$stamp/tenants ]; then mv .restore-$stamp/tenants tenants; fi; rmdir .restore-$stamp" ||
   fail "Banco restaurado, mas a troca das imagens falhou: NÃO inicie a API. Imagens da cópia em $images_dir/.restore-$stamp; siga o runbook."

  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) restore id=$id previous_db=$previous previous_images=.pre-restore-$stamp known_erasures=$known $result"
  echo "$line" >> "$state_dir/api-restore.log"
  echo "Restauração offline concluída: $line"
  echo 'A API continua parada. Rode o serviço migrate, depois suba a API e confira conforme o runbook antes de liberar.' ;;
 *) usage ;;
esac
