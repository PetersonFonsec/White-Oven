#!/usr/bin/env bash
# Publishes the exact image tested in CI under an immutable commit tag. Never overwrites an existing tag.
set -euo pipefail
: "${COMMIT_SHA:?}" "${OWNER:?}" "${REPOSITORY:?}" "${GH_TOKEN:?}"
local_image="${LOCAL_IMAGE:-whiteoven:ci}"
package="${PACKAGE_NAME:-white-oven-landing}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
revision="$(docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$local_image")"
if [[ "$revision" != "$COMMIT_SHA" ]]; then
 echo 'A imagem testada não corresponde ao commit; publicação recusada.' >&2
 exit 1
fi
owner="${OWNER,,}"
image="ghcr.io/$owner/$package:sha-$COMMIT_SHA"
if docker manifest inspect "$image" >/dev/null 2>"$work/manifest-error"; then
 echo 'Tag do commit já publicada; digest existente preservado.'
 exit 0
fi
# Only the registry's own "manifest unknown" proves the tag is absent; any other text fails closed.
if grep -Eqi 'manifest unknown|no such manifest' "$work/manifest-error"; then
 echo 'Pacote existente sem esta tag; publicando.'
elif grep -Eqi 'denied|unauthorized' "$work/manifest-error"; then
 # A package that does not exist yet answers DENIED; only GitHub's 404 confirms that case.
 kind="$(gh api "repos/$REPOSITORY" --jq '.owner.type')" || { echo 'Falha ao consultar o GitHub; publicação recusada.' >&2; exit 1; }
 prefix=users
 if [[ "$kind" == Organization ]]; then prefix=orgs; fi
 status="$(curl --silent --show-error --output "$work/package.json" --write-out '%{http_code}' \
  --header "Authorization: Bearer $GH_TOKEN" \
  "https://api.github.com/$prefix/$owner/packages/container/$package")" || status=000
 case "$status" in
  404) echo 'Pacote ainda não existe; primeira publicação.' ;;
  200) echo 'O pacote existe, mas o registry negou a leitura da tag: erro de autorização. Publicação recusada para não sobrescrever.' >&2; exit 1 ;;
  *) echo "Verificação do pacote no GitHub falhou (HTTP $status); publicação recusada." >&2; exit 1 ;;
 esac
else
 echo 'Registry inacessível ou resposta inesperada; publicação recusada.' >&2
 exit 1
fi
docker tag "$local_image" "$image"
docker push "$image"
if ! docker manifest inspect "$image" >/dev/null 2>&1; then
 echo 'Push concluído, mas o registry não confirmou a tag.' >&2
 exit 1
fi
echo "Publicado: $image"
