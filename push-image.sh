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
DONE

# Visibility is a property of the package rather than of a push, so it is worth
# reporting rather than assuming. A package first published by Actions inherits
# the repository's visibility; one pushed by hand starts out private, and then a
# pull from the NAS fails with a 403 and nothing useful in the log.
VISIBILITY="$(gh api "/user/packages/container/$NAME" --jq .visibility 2>/dev/null || true)"
case "$VISIBILITY" in
  public)  echo "The package is public. Nothing else to do." ;;
  private) cat <<PRIVATE
The package is PRIVATE. Unraid will get a 403 with nothing helpful in the log.
Make it public once, at:

    https://github.com/$OWNER/$NAME/pkgs/container/$NAME

  -> Package settings -> Change visibility -> Public
PRIVATE
    ;;
  *) echo "Could not read the package visibility (needs gh, logged in with read:packages)." ;;
esac

cat <<NEXT

On the NAS: Docker -> Check for Updates, then Update on the container. First
time round: Add Container, Repository = $IMAGE:$TAG, port 8080 -> 80.
NEXT
