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
restores_dir="$state_dir/api-restores"
heads_dir="$state_dir/erasure-heads"
compose=(docker compose -f "$compose_file")
[[ -z "${WHITEOVEN_API_ENV_FILE:-}" ]] ||
 compose=(docker compose --env-file "$WHITEOVEN_API_ENV_FILE" -f "$compose_file")
command="${1:-help}"
shift || true

UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
HEX64='[0-9a-f]{64}'
NO_HASH=0000000000000000000000000000000000000000000000000000000000000000
ROW="^[1-9][0-9]{0,17},$UUID,$UUID,[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z,$HEX64\$"
LEDGER_FORMAT=whiteoven-customer-erasures-2
BACKUP_FORMAT=whiteoven-api-backup-2
# Restore phases, in order. Rollback and status read them from the operation's state file.
PHASES=(PREPARING CANDIDATE_CREATED CANDIDATE_RESTORED IMAGES_STAGED API_STOPPED
 ERASURES_REAPPLIED SWAP_STARTED DB_SWAPPING DB_SWAPPED IMAGES_SWAPPING IMAGES_SWAPPED COMPLETE)

usage() {
 cat >&2 <<'EOF'
Uso: bash ops/api-backup.sh COMANDO
  backup ID | verify-backup ID | export-erasures DIR | prune-backups
  restore ID --confirm-offline [--erasures DIARIO.csv]
  restore-status | restore-rollback OPERACAO | restore-cleanup OPERACAO
EOF
 exit 1
}
fail() { echo "$*" >&2; exit 1; }
valid_id() { [[ "$1" =~ ^[a-zA-Z0-9_-]{1,80}$ ]]; }
valid_op() { [[ "$1" =~ ^[0-9]{14}_[0-9a-f]{6}$ ]]; }
[[ "$db" =~ ^[a-z_][a-z0-9_]{0,30}$ ]] || fail 'WHITEOVEN_DB_NAME inválido.'
[[ "$superuser" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail 'WHITEOVEN_PG_SUPERUSER inválido.'
[[ "$retention_days" =~ ^[1-9][0-9]{0,2}$ ]] || fail 'WHITEOVEN_API_BACKUP_RETENTION_DAYS inválido.'

# Deterministic failure injection for tests/deployment/api-restore-drill.mjs only. Inert unless
# the variable names this point; KILL simulates an abrupt death (no cleanup runs).
test_hook() {
 [[ "${WHITEOVEN_TEST_KILL_AT:-}" != "$1" ]] || kill -KILL $$
 [[ "${WHITEOVEN_TEST_FAIL_AT:-}" != "$1" ]] || fail "Falha injetada em $1 (teste)."
}

# The superuser reads through RLS (FORCE RLS filters even whiteoven_owner), over the container's
# local socket; its password never leaves the container.
psql_on() {
 local database="$1"; shift
 "${compose[@]}" exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U "$superuser" -d "$database" "$@"
}
query() { psql_on "$1" -At -c "$2"; }
# Runs a shell in a one-off API container: same image, user (node) and image volume as the API.
in_api() { "${compose[@]}" run --rm --no-deps -T --entrypoint sh api -c "$1"; }
db_exists() { [[ "$(query postgres "select count(*) from pg_database where datname = '$1'")" == 1 ]]; }
db_comment() { query postgres "select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = '$1'"; }
manifest_value() { sed -n "s/^$2=//p" "$1/manifest.txt" | head -n 1; }

locked=0
partial=""
scratch=""
restoring=0
op=""
declare -A S=()
acquire_lock() {
 local lock="$state_dir/api-backup.lock" pid
 mkdir -p "$state_dir"
 if ! mkdir "$lock" 2>/dev/null; then
  pid="$(cat "$lock/pid" 2>/dev/null || true)"
  # A process killed abruptly leaves its lock; one whose process is gone is removed.
  if [[ "$pid" =~ ^[0-9]+$ ]] && ! kill -0 "$pid" 2>/dev/null; then
   echo "Lock deixado pelo processo $pid, que não existe mais, foi removido." >&2
   rm -f "$lock/pid"
   rmdir "$lock"
   mkdir "$lock"
  else
   fail 'Outra operação de backup ou restore está em andamento.'
  fi
 fi
 locked=1
 echo $$ > "$lock/pid"
}
on_exit() {
 local status=$?
 set +e
 [[ -z "$partial" ]] || rm -rf -- "$partial"
 [[ -z "$scratch" ]] || rm -rf -- "$scratch"
 if (( restoring && status != 0 )); then restore_failed; fi
 if (( locked )); then rm -f "$state_dir/api-backup.lock/pid"; rmdir "$state_dir/api-backup.lock"; fi
 exit "$status"
}
trap on_exit EXIT
# Names the command that stopped the script when it fails without its own message.
set -E
last_error=""
trap 'last_error="linha $LINENO: $BASH_COMMAND"' ERR
new_scratch() { mkdir -p "$state_dir"; scratch="$(mktemp -d "$state_dir/tmp.XXXXXX")"; }

# --- Restore operation state: one directory per operation, written atomically and synced, so a
# crash or a reboot leaves the last phase on disk.
rank() {
 local i
 for i in "${!PHASES[@]}"; do [[ "${PHASES[$i]}" != "$1" ]] || { echo "$i"; return; }; done
 echo -1
}
terminal() { [[ "$1" == COMPLETE || "$1" == ROLLED_BACK || "$1" == CLEANED ]]; }
save_state() {
 local dir="$restores_dir/$op" key
 { for key in $(printf '%s\n' "${!S[@]}" | sort); do printf '%s=%s\n' "$key" "${S[$key]}"; done; } > "$dir/state.tmp"
 sync "$dir/state.tmp" 2>/dev/null || sync
 mv -f "$dir/state.tmp" "$dir/state"
 sync "$dir" 2>/dev/null || sync
}
set_phase() {
 S[phase]="$1"
 S[updated_at]="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
 save_state
 echo "${S[updated_at]} $1" >> "$restores_dir/$op/journal"
}
load_state() {
 local file="$restores_dir/$1/state" key value
 valid_op "$1" && [[ -f "$file" ]] || fail "Operação de restore $1 não encontrada em $restores_dir."
 S=()
 while IFS='=' read -r key value; do
  [[ "$key" =~ ^[a-z_]+$ ]] || fail "Estado da operação $1 ilegível; investigue $file."
  S[$key]="$value"
 done < "$file"
 op="$1"
}
active_ops() {
 local file phase
 for file in "$restores_dir"/*/state; do
  [[ -f "$file" ]] || continue
  phase="$(sed -n 's/^phase=//p' "$file")"
  terminal "$phase" || basename "$(dirname "$file")"
 done
}
candidate_tag() { echo "whiteoven-restore candidate op=$1"; }
previous_tag() { echo "whiteoven-restore previous op=$1"; }
restored_tag() { echo "whiteoven-restore restored op=$1"; }

# --- Customer erasure registry (ADR 0029): lineage plus a gap-free SHA-256 chain in the database.
has_registry() {
 [[ "$(query "$1" "select to_regclass('public.customer_erasures') is not null and to_regclass('public.database_lineage') is not null")" == t ]]
}
lineage_of() {
 local value
 value="$(query "$1" 'select id from database_lineage')"
 [[ "$value" =~ ^$UUID$ ]] || return 1
 echo "$value"
}
# "seq hash" of the last row, "0 NO_HASH" when empty.
head_of() {
 local value
 value="$(query "$1" "select seq || ' ' || encode(hash, 'hex') from customer_erasures order by seq desc limit 1")"
 echo "${value:-0 $NO_HASH}"
}
export_chain() {
 psql_on "$1" -At -c "copy (select seq, tenant_id, customer_id,
   to_char(deleted_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), encode(hash, 'hex')
   from customer_erasures order by seq) to stdout with (format csv)"
}
# Checks a chain (CSV rows already matched against ROW) with the database's own function, inside
# the candidate. Prints: rows head head_hash broken contains_backup_head contains_known_head.
chain_check() {
 local database="$1" csv="$2" backup_seq="$3" backup_hash="$4" known_seq="$5" known_hash="$6"
 {
  echo 'create temp table ledger_in (seq bigint, tenant_id uuid, customer_id uuid, deleted_at timestamptz, hash_hex text);'
  echo 'copy ledger_in from stdin with (format csv);'
  cat "$csv"
  echo '\.'
  echo "create temp table ledger as select seq, tenant_id, customer_id, deleted_at, decode(hash_hex, 'hex') as hash from ledger_in;"
  echo "select v.row_count, v.head_seq, coalesce(encode(v.head_hash, 'hex'), '$NO_HASH'), v.broken,
          ($backup_seq = 0 or exists (select 1 from ledger where seq = $backup_seq and hash = decode('$backup_hash', 'hex'))),
          ($known_seq = 0 or exists (select 1 from ledger where seq = $known_seq and hash = decode('$known_hash', 'hex')))
          from whiteoven_verify_erasure_chain('pg_temp.ledger') v;"
 } | psql_on "$database" -At -F ' '
}
rows_valid() { ! grep -qvE "$ROW" "$1"; }
# Last state of a lineage's chain seen by this host, to catch a live database or a ledger that went
# back in time. Advanced only forward, except after a restore (set_known_head).
known_head() {
 local file="$heads_dir/$1"
 if [[ -f "$file" ]]; then cat "$file"; else echo "0 $NO_HASH"; fi
}
set_known_head() {
 mkdir -p "$heads_dir"
 printf '%s %s\n' "$2" "$3" > "$heads_dir/$1.tmp"
 mv -f "$heads_dir/$1.tmp" "$heads_dir/$1"
}
observe_live_head() {
 local lineage seq hash known_seq known_hash at
 lineage="$(lineage_of "$db")" || return 0
 read -r seq hash <<< "$(head_of "$db")"
 read -r known_seq known_hash <<< "$(known_head "$lineage")"
 if (( known_seq > 0 )); then
  at="$(query "$db" "select encode(hash, 'hex') from customer_erasures where seq = $known_seq")"
  if [[ "$at" != "$known_hash" ]]; then
   echo "AVISO: o diário de exclusões do banco atual não contém o último estado visto neste host (seq $known_seq). O banco pode ter sido substituído fora desta ferramenta; investigue antes de qualquer restore." >&2
   return 0
  fi
 fi
 (( seq < known_seq )) || set_known_head "$lineage" "$seq" "$hash"
}
# Reads an exported ledger: header line, CSV header, rows. Sets L_LINEAGE L_HEAD L_HASH and
# writes the rows to $1.rows.
parse_ledger() {
 local file="$1" first rows last
 first="$(head -n 1 "$file")"
 [[ "$first" =~ ^\#\ $LEDGER_FORMAT\ lineage=($UUID)\ head=([0-9]+)\ head_hash=($HEX64)\ exported_at=[0-9T:Z-]+$ ]] ||
  fail "Diário $file sem o cabeçalho $LEDGER_FORMAT; exporte de novo com export-erasures. Nada foi alterado."
 L_LINEAGE="${BASH_REMATCH[1]}"; L_HEAD="${BASH_REMATCH[2]}"; L_HASH="${BASH_REMATCH[3]}"
 [[ "$(sed -n 2p "$file")" == seq,tenant_id,customer_id,deleted_at,hash ]] || fail "Diário $file sem a linha de colunas esperada."
 rows="$file.rows"
 tail -n +3 "$file" > "$rows"
 rows_valid "$rows" || fail "Diário $file tem linha fora do formato; nada foi alterado."
 [[ "$(wc -l < "$rows" | tr -d ' ')" == "$L_HEAD" ]] || fail "Diário $file incompleto: o cabeçalho diz $L_HEAD linhas."
 last="$(tail -n 1 "$rows")"
 if (( L_HEAD > 0 )); then
  [[ "${last%%,*}" == "$L_HEAD" && "${last##*,}" == "$L_HASH" ]] || fail "Diário $file: a última linha não confere com o cabeçalho."
 else
  [[ "$L_HASH" == "$NO_HASH" ]] || fail "Diário $file: cabeçalho inconsistente."
 fi
}

# --- Images: every image the database references must be in the archive, complete.
# A WebP file is complete when it starts with RIFF....WEBP and the RIFF size covers the file.
webp_complete() {
 local file="$1" size riff
 [[ -f "$file" ]] || return 1
 size="$(stat -c %s "$file")"
 (( size >= 12 )) || return 1
 [[ "$(dd if="$file" bs=1 count=4 2>/dev/null)" == RIFF && "$(dd if="$file" bs=1 skip=8 count=4 2>/dev/null)" == WEBP ]] || return 1
 riff="$(od -An -tu4 --endian=little -j4 -N4 "$file" | tr -d ' ')"
 (( riff + 8 == size ))
}
# "tenant asset" per line, from the image_assets rows inside a dump.
dump_assets() {
 "${compose[@]}" exec -T postgres pg_restore --data-only --table=image_assets -f - < "$1" | awk '
  /^COPY public\.image_assets \(/ {
   n = split(substr($0, index($0, "(") + 1), cols, /, |\) FROM/)
   for (i = 1; i <= n; i++) { if (cols[i] == "id") ci = i; if (cols[i] == "tenant_id") ti = i }
   copying = 1; next }
  copying && $0 == "\\." { copying = 0; next }
  copying { split($0, f, "\t"); print f[ti] " " f[ci] }'
}
# Prints how many referenced images were checked; fails listing the ones missing or truncated.
check_images() {
 local list="$1" archive="$2" dir bad=0 total=0 tenant asset variant
 dir="$scratch/images-check"
 rm -rf -- "$dir"
 mkdir "$dir"
 tar -xf "$archive" -C "$dir"
 while read -r tenant asset; do
  [[ -n "$tenant" ]] || continue
  if [[ ! "$tenant" =~ ^$UUID$ || ! "$asset" =~ ^$UUID$ ]]; then bad=$((bad + 1)); continue; fi
  total=$((total + 1))
  for variant in thumbnail menu; do
   if ! webp_complete "$dir/tenants/$tenant/$asset/$variant.webp"; then
    bad=$((bad + 1))
    echo "Imagem referenciada ausente ou incompleta: tenants/$tenant/$asset/$variant.webp" >&2
   fi
  done
 done < "$list"
 rm -rf -- "$dir"
 (( bad == 0 )) || return 1
 echo "$total"
}

take_backup() {
 local id="$1" dir="$backup_root/$1" created epoch version migration lineage referenced
 [[ ! -e "$dir" ]] || fail "A cópia $id já existe; nada foi sobrescrito. Use um ID novo."
 has_registry "$db" || fail 'O banco não tem o diário de exclusões (Migration20261105000000_customer_erasures). Rode o serviço migrate antes do backup.'
 mkdir -p "$backup_root"
 partial="$backup_root/.$id.partial-$$"
 mkdir "$partial"
 created="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; epoch="$(date -u +%s)"
 # Database first, then images. Variants are published complete under their final name before
 # the metadata commits, and committed images are never removed (ADR 0010), so the archive taken
 # after the dump holds every image the dump references; check_images proves it for this copy.
 "${compose[@]}" exec -T postgres pg_dump -U "$superuser" -d "$db" --format=custom > "$partial/database.dump"
 [[ -s "$partial/database.dump" ]] || fail 'pg_dump não produziu nada; nenhuma cópia foi gravada.'
 in_api "cd $images_dir && if [ -d tenants ]; then exec tar --exclude='*.tmp' -cf - tenants; else exec tar -cf - -T /dev/null; fi" > "$partial/images.tar"
 "${compose[@]}" exec -T postgres pg_restore -l < "$partial/database.dump" > /dev/null
 dump_assets "$partial/database.dump" > "$scratch/assets.txt"
 referenced="$(check_images "$scratch/assets.txt" "$partial/images.tar")" ||
  fail 'Backup recusado: há imagens referenciadas pelo banco ausentes ou incompletas; nada foi gravado. Investigue o volume (ADR 0010) antes de repetir.'
 version="$(query "$db" 'show server_version_num')"
 migration="$(query "$db" 'select name from mikro_orm_migrations order by id desc limit 1')"
 lineage="$(lineage_of "$db")"
 {
  echo "format=$BACKUP_FORMAT"
  echo "id=$id"
  echo "created_at=$created"
  echo "created_epoch=$epoch"
  echo "database=$db"
  echo "server_version_num=$version"
  echo "lineage=$lineage"
  echo "last_migration=$migration"
  echo "referenced_images=$referenced"
  echo "images_verified=yes"
  echo "database_sha256=$(sha256sum "$partial/database.dump" | cut -d' ' -f1)"
  echo "images_sha256=$(sha256sum "$partial/images.tar" | cut -d' ' -f1)"
 } > "$partial/manifest.txt"
 mv -T -- "$partial" "$dir"
 partial=""
 observe_live_head
 echo "Cópia $id gravada: banco ($migration), $referenced imagens referenciadas conferidas."
}

verify_backup() {
 local id="$1" dir="$backup_root/$1" checked
 [[ -f "$dir/manifest.txt" ]] || fail "Cópia $id ausente ou sem manifesto."
 [[ "$(manifest_value "$dir" format)" == "$BACKUP_FORMAT" && "$(manifest_value "$dir" images_verified)" == yes ]] ||
  fail "Cópia $id em formato antigo ou sem imagens conferidas; não é restaurável por esta versão."
 [[ "$(sha256sum "$dir/database.dump" | cut -d' ' -f1)" == "$(manifest_value "$dir" database_sha256)" ]] ||
  fail "Hash do banco não confere na cópia $id: não restaurar."
 [[ "$(sha256sum "$dir/images.tar" | cut -d' ' -f1)" == "$(manifest_value "$dir" images_sha256)" ]] ||
  fail "Hash das imagens não confere na cópia $id: não restaurar."
 "${compose[@]}" exec -T postgres pg_restore -l < "$dir/database.dump" > /dev/null
 dump_assets "$dir/database.dump" > "$scratch/assets.txt"
 checked="$(check_images "$scratch/assets.txt" "$dir/images.tar")" || fail "Cópia $id com imagem referenciada ausente ou incompleta: não restaurar."
 echo "Cópia $id conferida: hashes, lista do pg_restore e $checked imagens referenciadas completas."
}

# Puts the original set back, whatever phase the operation reached. Every step looks at what is
# really there and is safe to repeat. It never drops a database without this operation's mark.
# Returns non-zero (without exiting) when a step fails, so a failed trap can report it.
rollback_resources() {
 local cand="${S[candidate]}" prev="${S[previous]}" current
 in_api "set -eu
  cd $images_dir
  P='${S[aside]}'; R='${S[staging]}'; ORIG='${S[original_images]:-unknown}'
  if [ -d \"\$P\" ]; then
   if [ -d \"\$P/tenants\" ]; then
    if [ -d tenants ]; then [ ! -e \"\$R/tenants\" ] || exit 3; mkdir -p \"\$R\"; mv tenants \"\$R/tenants\"; fi
    mv \"\$P/tenants\" tenants
   elif [ \"\$ORIG\" = 0 ]; then
    if [ -d tenants ]; then [ ! -e \"\$R/tenants\" ] || exit 3; mkdir -p \"\$R\"; mv tenants \"\$R/tenants\"; fi
   elif [ \"\$ORIG\" != 1 ]; then
    exit 4
   fi
   rmdir \"\$P\"
  fi
  if [ -d \"\$R\" ]; then rm -rf -- \"\$R\"; fi" || { echo 'Rollback das imagens falhou; veja o runbook (seção de recuperação manual).' >&2; return 1; }
 if db_exists "$db" && [[ "$(db_comment "$db")" == "$(candidate_tag "$op")" ]]; then
  query postgres "alter database \"$db\" rename to \"$cand\"" > /dev/null || return 1
 fi
 if ! db_exists "$db" && db_exists "$prev" && [[ "$(db_comment "$prev")" == "$(previous_tag "$op")" ]]; then
  query postgres "alter database \"$prev\" rename to \"$db\"" > /dev/null || return 1
 fi
 if [[ "${S[live_existed]:-yes}" == yes ]]; then
  db_exists "$db" || { echo "Banco original não encontrado: nem $db nem $prev." >&2; return 1; }
  current="$(db_comment "$db")"
  [[ -z "$current" || "$current" == "$(previous_tag "$op")" ]] ||
   { echo "O banco $db não é o original desta operação (marca: $current)." >&2; return 1; }
 fi
 if db_exists "$cand"; then
  if [[ "$(db_comment "$cand")" == "$(candidate_tag "$op")" ]]; then
   query postgres "drop database \"$cand\"" > /dev/null || return 1
  else
   echo "O banco $cand existe sem a marca desta operação e não foi removido." >&2
  fi
 fi
 if [[ "${S[live_revoked]:-no}" == yes ]] && db_exists "$db"; then
  query postgres "grant connect on database \"$db\" to whiteoven_app, whiteoven_platform" > /dev/null || return 1
  query postgres "comment on database \"$db\" is null" > /dev/null || return 1
 fi
}

restore_failed() {
 local failed="${S[phase]:-PREPARING}"
 [[ -z "$last_error" ]] || echo "Comando que falhou: $last_error" >&2
 S[failed_phase]="$failed"
 set_phase FAILED
 if (( $(rank "$failed") < $(rank SWAP_STARTED) )); then
  echo "Restauração $op falhou na fase $failed, antes de qualquer troca: banco e imagens em uso não foram alterados." >&2
  echo "Candidato e arquivos preparados ficam para investigação em $restores_dir/$op. Para limpar: bash ops/api-backup.sh restore-rollback $op" >&2
  if (( $(rank "$failed") >= $(rank API_STOPPED) )); then
   echo 'A API foi parada nesta operação; suba-a de novo depois de conferir.' >&2
  fi
 else
  echo "Restauração $op falhou na fase $failed, durante a troca. Voltando ao conjunto original..." >&2
  if rollback_resources; then
   set_phase ROLLED_BACK
   echo 'Rollback concluído: banco e imagens originais de volta e CONNECT da API devolvido. A API continua parada; suba-a e confira.' >&2
  else
   echo "Rollback automático falhou. A API não consegue conectar ao banco $db até a recuperação. Rode bash ops/api-backup.sh restore-status e restore-rollback $op (runbook, seção 8)." >&2
  fi
 fi
}

case "$command" in
 backup|restore|export-erasures|prune-backups|restore-rollback|restore-cleanup) acquire_lock ;;
esac
new_scratch

case "$command" in
 backup)
  valid_id "${1:-}" || usage
  take_backup "$1" ;;
 verify-backup)
  valid_id "${1:-}" || usage
  verify_backup "$1" ;;
 export-erasures)
  [[ -n "${1:-}" ]] || usage
  has_registry "$db" || fail 'O banco não tem o diário de exclusões; rode o serviço migrate.'
  mkdir -p "$1"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="$1/customer-erasures-$stamp.csv"
  [[ ! -e "$target" ]] || fail 'Destino já existe; nada foi sobrescrito.'
  lineage="$(lineage_of "$db")"
  export_chain "$db" > "$scratch/rows.csv"
  rows_valid "$scratch/rows.csv" || fail 'Exportação com linha fora do formato; nada foi gravado.'
  count="$(wc -l < "$scratch/rows.csv" | tr -d ' ')"
  last="$(tail -n 1 "$scratch/rows.csv")"
  head_hash="$NO_HASH"; (( count == 0 )) || head_hash="${last##*,}"
  (( count == 0 )) || [[ "${last%%,*}" == "$count" ]] || fail 'O diário do banco tem lacunas; nada foi gravado. Investigue.'
  partial="$1/.$(basename "$target").partial-$$"
  {
   echo "# $LEDGER_FORMAT lineage=$lineage head=$count head_hash=$head_hash exported_at=$stamp"
   echo 'seq,tenant_id,customer_id,deleted_at,hash'
   cat "$scratch/rows.csv"
  } > "$partial"
  mv -n -T -- "$partial" "$target"
  [[ ! -e "$partial" ]] || fail 'Destino criado por outro processo; nada foi sobrescrito.'
  partial=""
  observe_live_head
  echo "Diário de exclusões exportado: $target ($count contas, linhagem $lineage). Cifre e substitua a cópia externa conforme o runbook." ;;
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
 restore-status)
  found=0
  for file in "$restores_dir"/*/state; do
   [[ -f "$file" ]] || continue
   found=1
   name="$(basename "$(dirname "$file")")"
   phase="$(sed -n 's/^phase=//p' "$file")"
   printf '%s fase=%s cópia=%s falhou_em=%s atualizada=%s%s\n' "$name" "$phase" \
    "$(sed -n 's/^backup=//p' "$file")" "$(sed -n 's/^failed_phase=//p' "$file")" \
    "$(sed -n 's/^updated_at=//p' "$file")" "$(terminal "$phase" || echo ' [PENDENTE]')"
  done
  (( found )) || echo 'Nenhuma operação de restore registrada.' ;;
 restore-rollback)
  load_state "${1:-}"
  case "${S[phase]}" in
   COMPLETE) fail "A operação $op foi concluída. Para voltar, restaure a cópia pre-restore-$op (runbook)." ;;
   ROLLED_BACK|CLEANED) echo "A operação $op já está encerrada (${S[phase]})."; exit 0 ;;
  esac
  rollback_resources || fail "Rollback de $op incompleto; nada além do relatado foi alterado. Siga a recuperação manual do runbook (seção 8)."
  set_phase ROLLED_BACK
  echo "Rollback de $op concluído: banco e imagens originais em uso e recursos da operação removidos. Suba a API e confira." ;;
 restore-cleanup)
  load_state "${1:-}"
  [[ "${S[phase]}" == COMPLETE ]] || fail "Só uma restauração concluída tem o que limpar; a $op está em ${S[phase]} (use restore-rollback)."
  prev="${S[previous]}"
  if db_exists "$prev"; then
   [[ "$(db_comment "$prev")" == "$(previous_tag "$op")" ]] || fail "O banco $prev não tem a marca desta operação; não foi removido."
   (( $(query postgres "select count(*) from pg_stat_activity where datname = '$prev'") == 0 )) || fail "Há conexões em $prev."
   query postgres "drop database \"$prev\"" > /dev/null
  fi
  in_api "set -eu; cd $images_dir; if [ -d '${S[aside]}' ]; then rm -rf -- '${S[aside]}'; fi"
  set_phase CLEANED
  echo "Limpeza de $op concluída: banco anterior $prev e imagens anteriores removidos. A cópia pre-restore-$op continua até o prune." ;;
 restore)
  id="${1:-}"
  valid_id "$id" || usage
  [[ "${2:-}" == --confirm-offline ]] || fail 'Exige o ID da cópia e --confirm-offline; leia o runbook.'
  shift 2
  ledger=""
  while (($#)); do
   [[ "$1" == --erasures && -z "$ledger" && -f "${2:-}" ]] || usage
   ledger="$scratch/ledger.csv"
   cp -- "$2" "$ledger"
   shift 2
  done
  # Every check that needs no database runs first: a malformed ledger costs no downtime.
  [[ -z "$ledger" ]] || parse_ledger "$ledger"
  pending="$(active_ops | tr '\n' ' ')"
  [[ -z "$pending" ]] || fail "Há restauração incompleta: $pending. Veja restore-status e encerre com restore-rollback antes de outra."
  verify_backup "$id"
  missing="$(query postgres "select coalesce(string_agg(r, ', '), '') from unnest(array['whiteoven_owner', 'whiteoven_app', 'whiteoven_platform']) r where not exists (select 1 from pg_roles where rolname = r)")"
  [[ -z "$missing" ]] || fail "Papéis ausentes no PostgreSQL: $missing. Num host novo, rode o serviço migrate uma vez antes do restore (runbook)."

  op="${WHITEOVEN_TEST_OPERATION_ID:-$(date -u +%Y%m%d%H%M%S)_$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')}"
  valid_op "$op" || fail 'Identificador de operação inválido.'
  mkdir -p "$restores_dir"
  mkdir "$restores_dir/$op" 2> /dev/null || fail "A operação $op já existe; nada foi alterado."
  candidate="${db}_rc_$op"; previous="${db}_prev_$op"
  S=([backup]="$id" [database]="$db" [candidate]="$candidate" [previous]="$previous"
   [staging]=".restore-$op" [aside]=".pre-restore-$op" [live_revoked]=no
   [started_at]="$(date -u +%Y-%m-%dT%H:%M:%SZ)")
  restoring=1
  set_phase PREPARING

  # Phase A, with the API still running: the candidate is a new database of this operation.
  ! db_exists "$candidate" || fail "O banco $candidate já existe e não pertence a esta operação; nada foi tocado."
  query postgres "create database \"$candidate\" owner whiteoven_owner" > /dev/null
  query postgres "revoke all on database \"$candidate\" from public" > /dev/null
  query postgres "comment on database \"$candidate\" is '$(candidate_tag "$op")'" > /dev/null
  set_phase CANDIDATE_CREATED
  test_hook candidate_prepare
  dump="$backup_root/$id/database.dump"
  if [[ "${WHITEOVEN_TEST_FAIL_AT:-}" == pg_restore ]]; then
   head -c 4096 "$dump" > "$scratch/truncated.dump"; dump="$scratch/truncated.dump"
  fi
  "${compose[@]}" exec -T postgres pg_restore -U "$superuser" -d "$candidate" --exit-on-error --single-transaction < "$dump"
  set_phase CANDIDATE_RESTORED
  has_registry "$candidate" || fail 'A cópia não tem o diário de exclusões; não é restaurável por esta versão.'
  cand_lineage="$(lineage_of "$candidate")" || fail 'A cópia não tem linhagem válida.'
  read -r known_seq known_hash <<< "$(known_head "$cand_lineage")"
  export_chain "$candidate" > "$scratch/backup-chain.csv"
  rows_valid "$scratch/backup-chain.csv" || fail 'Diário da cópia fora do formato.'
  read -r rows backup_seq backup_hash broken _ _ <<< "$(chain_check "$candidate" "$scratch/backup-chain.csv" 0 "$NO_HASH" 0 "$NO_HASH")"
  [[ "$broken" == 0 && "$rows" == "$backup_seq" ]] || fail 'O diário de exclusões da cópia está quebrado; não restaurar.'
  S[lineage]="$cand_lineage"; S[backup_head]="$backup_seq"
  save_state

  sources=()
  if [[ -n "$ledger" ]]; then
   [[ "$L_LINEAGE" == "$cand_lineage" ]] || fail "ERASURES_LEDGER_INVALID: o diário é da linhagem $L_LINEAGE e a cópia, da $cand_lineage."
   read -r rows head head_hash broken has_backup has_known <<< "$(chain_check "$candidate" "$ledger.rows" "$backup_seq" "$backup_hash" "$known_seq" "$known_hash")"
   [[ "$broken" == 0 && "$rows" == "$head" && "$head" == "$L_HEAD" ]] ||
    fail 'ERASURES_LEDGER_INVALID: o encadeamento do diário não confere (linha alterada, faltando ou fora de ordem).'
   [[ "$has_backup" == t ]] ||
    fail "ERASURES_LEDGER_INVALID: o diário (até $head) não contém o estado da cópia (seq $backup_seq); exporte um diário posterior à cópia."
   ledger_known="$has_known"
   cp -- "$ledger" "$restores_dir/$op/ledger.csv"
   sources+=("$ledger.rows")
  fi

  # Images of the copy, checked against the candidate's own metadata, then staged in the volume.
  query "$candidate" "select tenant_id || ' ' || id from image_assets" > "$scratch/assets.txt"
  check_images "$scratch/assets.txt" "$backup_root/$id/images.tar" > /dev/null || fail 'Imagens da cópia incompletas; não restaurar.'
  archive="$backup_root/$id/images.tar"
  if [[ "${WHITEOVEN_TEST_FAIL_AT:-}" == images_extract ]]; then
   head -c 2048 "$archive" > "$scratch/truncated.tar"; archive="$scratch/truncated.tar"
  fi
  in_api "set -eu; cd $images_dir; mkdir '${S[staging]}'; tar -xf - -C '${S[staging]}'" < "$archive"
  set_phase IMAGES_STAGED

  # Phase B: the API stops, so no deletion can happen after the live chain is read.
  "${compose[@]}" stop api
  set_phase API_STOPPED
  open="$(query postgres "select count(*) from pg_stat_activity where datname in ('$db', '$candidate') and pid <> pg_backend_pid()")"
  [[ "$open" == 0 ]] || fail "Há $open conexões abertas no banco. Pare todo processo que o usa (migrate, ferramentas, outras instâncias)."
  live_ok=no
  live_known=f
  live_readable=no
  if db_exists "$db" && has_registry "$db" 2> /dev/null; then
   live_readable=yes
   live_lineage="$(lineage_of "$db" 2> /dev/null || echo none)"
   if [[ "$live_lineage" != "$cand_lineage" ]]; then
    echo "O banco atual é de outra linhagem ($live_lineage): não é a continuação desta cópia e não serve de fonte de exclusões." >&2
   elif export_chain "$db" > "$scratch/live-chain.csv" 2> /dev/null && rows_valid "$scratch/live-chain.csv"; then
    read -r rows head head_hash broken has_backup live_known <<< "$(chain_check "$candidate" "$scratch/live-chain.csv" "$backup_seq" "$backup_hash" "$known_seq" "$known_hash")"
    if [[ "$broken" == 0 && "$rows" == "$head" && "$has_backup" == t ]]; then
     live_ok=yes
     cp -- "$scratch/live-chain.csv" "$restores_dir/$op/live-chain.csv"
     sources+=("$scratch/live-chain.csv")
    else
     echo 'O diário do banco atual não continua o da cópia (quebrado ou anterior a ela): não serve de fonte de exclusões.' >&2
    fi
   fi
  fi
  [[ "$live_ok" == yes ]] || live_known=f
  (( ${#sources[@]} )) || fail 'ERASURES_MISSING: não há prova de que as exclusões feitas depois da cópia são conhecidas (o banco atual não é a continuação dela). Traga a cópia externa mais recente do diário (--erasures); nada foi trocado.'
  if (( known_seq > 0 )) && [[ "$live_known" != t && "${ledger_known:-f}" != t ]]; then
   fail "ERASURES_STALE: este host já viu o diário da linhagem até seq $known_seq e nenhuma fonte chega lá. Use um diário exportado depois disso; nada foi trocado."
  fi
  S[erasure_sources]=""
  [[ "$live_ok" != yes ]] || S[erasure_sources]=live
  [[ -z "$ledger" ]] || S[erasure_sources]="${S[erasure_sources]:+${S[erasure_sources]},}ledger"
  save_state
  # Safety copy of what is about to be replaced, data written after the selected backup included.
  if [[ "$live_readable" == yes ]]; then take_backup "pre-restore-$op"; fi

  for source in "${sources[@]}"; do cut -d, -f2-4 "$source"; done | sort -u > "$scratch/erasures.csv"
  known="$(wc -l < "$scratch/erasures.csv" | tr -d ' ')"
  {
   echo 'begin;'
   echo 'create temp table restore_erasures (tenant_id uuid not null, customer_id uuid not null, deleted_at timestamptz not null) on commit drop;'
   echo 'copy restore_erasures from stdin with (format csv);'
   cat "$scratch/erasures.csv"
   echo '\.'
   cat "$reapply_sql"
   echo "do \$\$ begin if exists (select 1 from restore_erasures e join customers c on c.tenant_id = e.tenant_id and c.id = e.customer_id where c.status <> 'DELETED') then raise exception 'customer erasure not applied'; end if; end \$\$;"
   [[ "${WHITEOVEN_TEST_FAIL_AT:-}" != reapply ]] || echo 'select 1 / 0;'
   echo 'commit;'
  } | psql_on "$candidate" 2> "$restores_dir/$op/reapply.log"
  result="$(sed -n 's/.*whiteoven_erasures //p' "$restores_dir/$op/reapply.log")"
  [[ -n "$result" ]] || fail 'Reaplicação das exclusões sem resultado.'
  export_chain "$candidate" > "$scratch/restored-chain.csv"
  read -r rows new_seq new_hash broken _ _ <<< "$(chain_check "$candidate" "$scratch/restored-chain.csv" 0 "$NO_HASH" 0 "$NO_HASH")"
  [[ "$broken" == 0 && "$rows" == "$new_seq" ]] || fail 'Diário do banco restaurado quebrado após a reaplicação.'
  set_phase ERASURES_REAPPLIED

  # Swap. From SWAP_STARTED until COMPLETE the API role cannot connect to the database name: the
  # original loses CONNECT before it is renamed and the restored one gets CONNECT only at the end.
  # That block lives in PostgreSQL, so it survives a crash or a reboot of this host.
  S[original_images]="$(in_api "[ -d $images_dir/tenants ] && echo 1 || echo 0")"
  S[live_existed]=no
  ! db_exists "$db" || S[live_existed]=yes
  S[live_revoked]=yes
  set_phase SWAP_STARTED
  if [[ "${S[live_existed]}" == yes ]]; then
   query postgres "revoke connect on database \"$db\" from whiteoven_app, whiteoven_platform" > /dev/null
   query postgres "comment on database \"$db\" is '$(previous_tag "$op")'" > /dev/null
  fi
  test_hook swap_prepare
  set_phase DB_SWAPPING
  if [[ "${S[live_existed]}" == yes ]]; then query postgres "alter database \"$db\" rename to \"$previous\"" > /dev/null; fi
  test_hook db_rename
  query postgres "alter database \"$candidate\" rename to \"$db\"" > /dev/null
  set_phase DB_SWAPPED
  test_hook after_db_swap
  set_phase IMAGES_SWAPPING
  inject=""
  [[ "${WHITEOVEN_TEST_FAIL_AT:-}" != images_swap ]] || inject='echo "Falha injetada em images_swap (teste)." >&2; exit 9'
  in_api "set -eu; cd $images_dir; mkdir '${S[aside]}'
   if [ -d tenants ]; then mv tenants '${S[aside]}/'; fi
   $inject
   if [ -d '${S[staging]}/tenants' ]; then mv '${S[staging]}/tenants' tenants; fi
   rmdir '${S[staging]}'"
  set_phase IMAGES_SWAPPED
  test_hook before_complete
  query postgres "grant connect on database \"$db\" to whiteoven_app, whiteoven_platform" > /dev/null
  query postgres "comment on database \"$db\" is '$(restored_tag "$op")'" > /dev/null
  set_phase COMPLETE
  restoring=0
  set_known_head "$cand_lineage" "$new_seq" "$new_hash"
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) restore op=$op id=$id previous_db=$previous previous_images=${S[aside]} sources=${S[erasure_sources]} known_erasures=$known $result"
  echo "$line" >> "$state_dir/api-restore.log"
  echo "Restauração offline concluída: $line"
  echo "A API continua parada. Suba-a (o migrate roda antes), confira conforme o runbook e depois limpe com restore-cleanup $op." ;;
 *) usage ;;
esac
