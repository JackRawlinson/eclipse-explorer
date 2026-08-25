#!/usr/bin/env bash
# Build and push the image to GitHub's container registry by hand.
#
# CI does this on every push to main; this is for when you want the image now,
# without a commit. Log in first — the token is never handled by this script:
#
#     docker login ghcr.io -u <your-github-username>
#
# and paste a personal access token (classic) carrying write:packages as the
# password. Settings → Developer settings → Personal access tokens → Tokens
# (classic). A fine-grained token needs the "Packages: write" permission.

set -euo pipefail

OWNER="${GHCR_OWNER:-JackRawlinson}"
NAME="${GHCR_NAME:-eclipse-explorer}"
IMAGE="ghcr.io/$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')/$(echo "$NAME" | tr '[:upper:]' '[:lower:]')"
TAG="${1:-latest}"
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"

if ! docker system info 2>/dev/null | grep -qi 'ghcr.io'; then
  # `docker login` records the host in ~/.docker/config.json rather than in
  # `docker info`, so check there instead of guessing.
  if ! grep -q 'ghcr.io' "${DOCKER_CONFIG:-$HOME/.docker}/config.json" 2>/dev/null; then
    echo "Not logged in to ghcr.io. Run:" >&2
    echo "    docker login ghcr.io -u $OWNER" >&2
    exit 1
  fi
fi

echo "Building $IMAGE:$TAG (and :sha-$SHA)"
echo "This regenerates all the eclipse data — about ten minutes."
docker build -t "$IMAGE:$TAG" -t "$IMAGE:sha-$SHA" .

docker push "$IMAGE:$TAG"
docker push "$IMAGE:sha-$SHA"

cat <<DONE

Pushed:
    $IMAGE:$TAG
    $IMAGE:sha-$SHA

The package is PRIVATE until you say otherwise. Unraid will get a 403 with
nothing helpful in the log. Make it public once, at:

    https://github.com/$OWNER/$NAME/pkgs/container/$NAME

  → Package settings → Change visibility → Public

Then on the NAS: Docker → Add Container, Repository = $IMAGE:$TAG,
port 8080 → 80.
DONE
