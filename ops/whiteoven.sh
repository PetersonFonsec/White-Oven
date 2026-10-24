#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
env_file="${WHITEOVEN_ENV_FILE:-ops/.env}"
state_dir="${WHITEOVEN_STATE_DIR:-.ops-state}"
wait_seconds="${WHITEOVEN_WAIT_SECONDS:-90}"
command="${1:-help}"
shift || true
compose=(docker compose --env-file "$env_file" -f compose.yaml)
usage() {
 echo 'Uso: bash ops/whiteoven.sh validate|build|update|verify|status|backup ID|verify-backup ID|export-backup ID DIR|import-backup ID DIR|prune-backups|ledger-init|exclude UUID|delete UUID|purge|probe-write|restore ID --confirm-offline|rollback' >&2
 exit 1
}
# Resolve without printing private environment values.
image() { "${compose[@]}" config --images | head -n 1; }
image_id() { docker image inspect --format '{{.Id}}' "$1"; }
ensure_image() { docker image inspect "$1" >/dev/null 2>&1 || docker pull "$1"; }
# Each image validates with its own rules, so a rollback target is checked against today's configuration.
validate() {
 "${compose[@]}" config --quiet
 local selected="${1:-}"
 [[ -n "$selected" ]] || selected="$(image)"
 ensure_image "$selected"
 docker run --rm --env-file "$env_file" --entrypoint node "$selected" --experimental-strip-types scripts/validate-deployment.mjs
}
start() { WHITEOVEN_IMAGE="$1" "${compose[@]}" up -d --no-build --wait --wait-timeout "$wait_seconds" landing; }
healthy() { "${compose[@]}" exec -T landing node scripts/healthcheck.mjs; }
running_image() {
 local id
 id="$("${compose[@]}" ps -q landing)"
 [[ -z "$id" ]] || docker inspect --format '{{.Image}}' "$id"
}
record() { printf '%s\n' "$2" > "$state_dir/$1.tmp"; mv "$state_dir/$1.tmp" "$state_dir/$1"; }
# An image that failed or was rolled back is never redeployed by accident from an unchanged ops/.env.
refuse_failed() {
 [[ -f "$state_dir/failed-image" && "$(cat "$state_dir/failed-image")" == "$1" && "${WHITEOVEN_RETRY_FAILED_IMAGE:-}" != 1 ]] || return 0
 echo "A imagem configurada em WHITEOVEN_IMAGE falhou ou foi revertida. Configure a imagem em execução ou uma nova imagem aprovada; consulte o runbook." >&2
 exit 1
}
# Brings back a known image and reports whether the service really ended healthy.
recover() {
 local target="$1" reason="$2"
 if start "$target" && healthy; then
  echo "$reason Imagem $target recuperada e saudável, sem restaurar banco. Fixe WHITEOVEN_IMAGE=$target em $env_file antes de outro update ou restore." >&2
  exit 1
 fi
 echo "$reason A recuperação para $target também falhou: serviço indisponível. Investigue antes de qualquer restore." >&2
 exit 2
}
case "$command" in
 update|rollback|restore|backup|purge|exclude|delete|ledger-init|import-backup|prune-backups)
  mkdir -p "$state_dir"
  if ! mkdir "$state_dir/update.lock" 2>/dev/null; then echo 'Outra operação está em andamento.' >&2; exit 1; fi
  trap 'rmdir "$state_dir/update.lock"' EXIT ;;
esac
case "$command" in
 validate) validate ;;
 build) "${compose[@]}" config --quiet; "${compose[@]}" build --pull landing; validate ;;
 status) "${compose[@]}" ps ;;
 verify) "${compose[@]}" exec -T landing node scripts/healthcheck.mjs; "${compose[@]}" exec -T landing node --input-type=module -e 'const r=await fetch("http://127.0.0.1:4321/health/ready");const s=await r.json();if(!r.ok||(process.env.LEADS_ENABLED==="true"&&(s.capture!=="enabled"||s.storage!=="ready"||s.writes==="failing")))process.exit(1);for(const path of ["/","/privacidade"]){if(!(await fetch("http://127.0.0.1:4321"+path)).ok)process.exit(1);}const a=await(await fetch("http://127.0.0.1:4321/api/leads")).json();if(a.available!==(process.env.LEADS_ENABLED==="true"))process.exit(1);console.log("Readiness, páginas e modo de captação conferidos.");' ;;
 update)
  next="$(image)"
  validate "$next"
  next_id="$(image_id "$next")"
  refuse_failed "$next_id"
  old_image="$(running_image)"
  if start "$next"; then
   if [[ -n "$old_image" && "$old_image" != "$next_id" ]]; then record previous-image "$old_image"; fi
   rm -f "$state_dir/failed-image"
   echo 'Atualização saudável; banco preservado.'
  elif [[ -z "$old_image" ]]; then
   record failed-image "$next_id"
   "${compose[@]}" stop landing || true
   echo 'Atualização falhou e não havia versão anterior em execução; serviço parado.' >&2
   exit 2
  elif [[ "$old_image" == "$next_id" ]]; then
   # Same image: the change was in ops/.env, which this script never rewrites.
   echo 'A imagem em execução não ficou saudável com a configuração atual: serviço indisponível. Corrija ops/.env e repita update.' >&2
   exit 2
  else
   record failed-image "$next_id"
   "${compose[@]}" stop landing || true
   recover "$old_image" 'Atualização falhou.'
  fi ;;
 rollback)
  [[ -f "$state_dir/previous-image" ]] || { echo 'Imagem anterior não registrada.' >&2; exit 1; }
  previous="$(cat "$state_dir/previous-image")"
  current="$(running_image)"
  validate "$previous"
  if start "$previous" && healthy; then
   if [[ -n "$current" && "$current" != "$previous" ]]; then record failed-image "$current"; fi
   echo "Rollback saudável; banco atual preservado. Fixe WHITEOVEN_IMAGE=$previous em $env_file ou aplique nova imagem aprovada antes de outro update ou restore."
  elif [[ -n "$current" && "$current" != "$previous" ]]; then
   recover "$current" 'Rollback não ficou saudável.'
  else
   echo 'Rollback não ficou saudável e não há outra imagem para recuperar: serviço indisponível.' >&2
   exit 2
  fi ;;
 backup|verify-backup|ledger-init|exclude)
  validate
  storage_command="$command"; [[ "$command" != verify-backup ]] || storage_command=verify
  "${compose[@]}" exec -T landing node scripts/storage.mjs "$storage_command" "$@" ;;
 delete)
  [[ "${1:-}" =~ ^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$ ]] || usage
  # The ledger entry comes first: if deletion is interrupted, a restore still removes the lead.
  "${compose[@]}" exec -T landing node scripts/storage.mjs exclude "$1"
  "${compose[@]}" exec -T landing node --experimental-strip-types scripts/leads.mjs delete "$1" ;;
 prune-backups) "${compose[@]}" exec -T landing node scripts/storage.mjs prune ;;
 probe-write) "${compose[@]}" exec -T landing node scripts/storage.mjs probe-write ;;
 export-backup)
  id="${1:-}"; destination="${2:-}"
  [[ "$id" =~ ^[a-zA-Z0-9_-]{1,80}$ && -n "$destination" ]] || usage
  for suffix in .sqlite .sqlite.json .deletions.json; do
   [[ ! -e "$destination/$id$suffix" ]] || { echo 'Destino já contém essa cópia; nada foi sobrescrito.' >&2; exit 1; }
  done
  "${compose[@]}" exec -T landing node scripts/storage.mjs verify "$id"
  mkdir -p "$destination"; chmod 700 "$destination"
  for pair in "$id.sqlite:$id.sqlite" "$id.sqlite.json:$id.sqlite.json" "deletions.json:$id.deletions.json"; do
   "${compose[@]}" exec -T landing cat "/var/backups/whiteoven/${pair%%:*}" > "$destination/${pair##*:}"
  done
  echo 'Cópia exportada SEM cifra. Cifre, envie ao destino externo e apague esta cópia local conforme o runbook.' ;;
 import-backup)
  id="${1:-}"; source_dir="${2:-}"
  [[ "$id" =~ ^[a-zA-Z0-9_-]{1,80}$ && -f "$source_dir/$id.sqlite" && -f "$source_dir/$id.sqlite.json" ]] || usage
  refuse_failed "$(image_id "$(image)")"
  "${compose[@]}" run --rm --no-deps -T -e "STORAGE_IMPORT_META=$(cat "$source_dir/$id.sqlite.json")" --entrypoint node landing scripts/storage.mjs import "$id" < "$source_dir/$id.sqlite" ;;
 purge) "${compose[@]}" exec -T landing node --experimental-strip-types scripts/leads.mjs purge ;;
 restore)
  validate
  [[ "${2:-}" == --confirm-offline ]] || { echo 'Exige ID da cópia e --confirm-offline; leia o runbook.' >&2; exit 1; }
  refuse_failed "$(image_id "$(image)")"
  "${compose[@]}" stop landing
  [[ -z "$("${compose[@]}" ps --status running -q landing)" ]] || exit 1
  "${compose[@]}" run --rm --no-deps -T --entrypoint node landing scripts/storage.mjs restore "$1" --confirm-offline
  echo 'Restauração offline concluída. Serviço continua parado; confira exclusões e readiness antes de liberar.' ;;
 *) usage ;;
esac
