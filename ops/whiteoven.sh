#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
env_file="${WHITEOVEN_ENV_FILE:-ops/.env}"
state_dir="${WHITEOVEN_STATE_DIR:-.ops-state}"
command="${1:-help}"
shift || true
compose=(docker compose --env-file "$env_file" -f compose.yaml)
# Resolve without printing private environment values.
image() { "${compose[@]}" config --images | head -n 1; }
validate() {
 "${compose[@]}" config --quiet
 local selected; selected="$(image)"
 docker image inspect "$selected" >/dev/null 2>&1 || docker pull "$selected"
 docker run --rm --env-file "$env_file" --entrypoint node "$selected" --experimental-strip-types scripts/validate-deployment.mjs
}
case "$command" in
 update|rollback|restore|backup|purge|exclude|ledger-init)
  mkdir -p "$state_dir"
  if ! mkdir "$state_dir/update.lock" 2>/dev/null; then echo 'Outra operação está em andamento.' >&2; exit 1; fi
  trap 'rmdir "$state_dir/update.lock"' EXIT ;;
esac
case "$command" in
 validate) validate ;;
 build) "${compose[@]}" config --quiet; "${compose[@]}" build --pull landing; validate ;;
 status) "${compose[@]}" ps ;;
 verify) "${compose[@]}" exec -T landing node scripts/healthcheck.mjs; "${compose[@]}" exec -T landing node --input-type=module -e 'const r=await fetch("http://127.0.0.1:4321/health/ready");const s=await r.json();if(!r.ok||(process.env.LEADS_ENABLED==="true"&&(s.capture!=="enabled"||s.storage!=="ready")))process.exit(1);for(const path of ["/","/privacidade"]){if(!(await fetch("http://127.0.0.1:4321"+path)).ok)process.exit(1);}const a=await(await fetch("http://127.0.0.1:4321/api/leads")).json();if(a.available!==(process.env.LEADS_ENABLED==="true"))process.exit(1);console.log("Readiness, páginas e modo de captação conferidos.");' ;;
 update)
  validate
  old_id="$("${compose[@]}" ps -q landing)"
  old_image=""
  if [[ -n "$old_id" ]]; then old_image="$(docker inspect --format '{{.Image}}' "$old_id")"; fi
  next="$(image)"
  # Existing local builds are accepted; immutable GHCR digests/tags can be pulled explicitly.
  docker image inspect "$next" >/dev/null 2>&1 || docker pull "$next"
  next_id="$(docker image inspect --format '{{.Id}}' "$next")"
  if "${compose[@]}" up -d --no-build --wait --wait-timeout "${WHITEOVEN_WAIT_SECONDS:-90}" landing; then
   if [[ -n "$old_image" && "$old_image" != "$next_id" ]]; then printf '%s\n' "$old_image" > "$state_dir/previous-image.tmp"; mv "$state_dir/previous-image.tmp" "$state_dir/previous-image"; fi
   echo 'Atualização saudável; banco preservado.'
  else
   "${compose[@]}" stop landing
   if [[ -n "$old_image" ]]; then WHITEOVEN_IMAGE="$old_image" "${compose[@]}" up -d --no-build --wait --wait-timeout "${WHITEOVEN_WAIT_SECONDS:-90}" landing; fi
   echo 'Atualização falhou; recuperação da imagem anterior foi tentada sem restaurar banco.' >&2; exit 1
  fi ;;
 rollback)
  validate
  [[ -f "$state_dir/previous-image" ]] || { echo 'Imagem anterior não registrada.' >&2; exit 1; }
  previous="$(cat "$state_dir/previous-image")"
  WHITEOVEN_IMAGE="$previous" "${compose[@]}" up -d --no-build --wait --wait-timeout "${WHITEOVEN_WAIT_SECONDS:-90}" landing ;;
 backup|verify-backup|ledger-init|exclude)
  validate
  storage_command="$command"; [[ "$command" != verify-backup ]] || storage_command=verify
  "${compose[@]}" exec -T landing node scripts/storage.mjs "$storage_command" "$@" ;;
 purge) "${compose[@]}" exec -T landing node --experimental-strip-types scripts/leads.mjs purge ;;
 restore)
  validate
  [[ "${2:-}" == --confirm-offline ]] || { echo 'Exige ID da cópia e --confirm-offline; leia o runbook.' >&2; exit 1; }
  "${compose[@]}" stop landing
  [[ -z "$("${compose[@]}" ps --status running -q landing)" ]] || exit 1
  "${compose[@]}" run --rm --no-deps -T --entrypoint node landing scripts/storage.mjs restore "$1" --confirm-offline
  echo 'Restauração offline concluída. Serviço continua parado; confira exclusões e readiness antes de liberar.' ;;
 *) echo 'Uso: bash ops/whiteoven.sh validate|build|update|verify|status|backup ID|verify-backup ID|ledger-init|exclude UUID|purge|restore ID --confirm-offline|rollback'; exit 1 ;;
esac
