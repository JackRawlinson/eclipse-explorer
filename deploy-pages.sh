#!/usr/bin/env bash
# Publish the built site to Cloudflare Pages.
#
# The site is static, so this uploads public/ as it stands -- there is no build
# step in the cloud and nothing to time out. Pages only transfers files whose
# contents have changed, so the first deploy moves about 14 MB and later ones
# usually move almost nothing.
#
# Authenticate once, either way round:
#
#     npx wrangler login                     # browser, easiest
#     export CLOUDFLARE_API_TOKEN=...        # a token with Cloudflare Pages: Edit
#
# Run the data pipeline first if public/data is missing or stale:
#
#     python data-pipeline/build.py

set -euo pipefail

NAME="${CF_PAGES_PROJECT:-eclipse}"
BRANCH="${CF_PAGES_BRANCH:-main}"
WRANGLER=(npx --yes wrangler@latest)

for required in public/data/index.json public/sitemap.xml public/eclipse/index.html; do
  if [ ! -s "$required" ]; then
    echo "$required is missing. Run the pipeline first:" >&2
    echo "    python data-pipeline/build.py" >&2
    exit 1
  fi
done

if "${WRANGLER[@]}" whoami 2>&1 | grep -qi "not authenticated"; then
  echo "Not authenticated to Cloudflare. Run one of:" >&2
  echo "    npx wrangler login" >&2
  echo "    export CLOUDFLARE_API_TOKEN=...   # needs Cloudflare Pages: Edit" >&2
  echo >&2
  echo "(wrangler whoami exits 0 either way, so this reads what it prints.)" >&2
  exit 1
fi

# Creating it up front keeps the deploy non-interactive; without a project to
# deploy into, wrangler stops and asks for a name.
# Match the Project Name column only. Matching anywhere in the table finds the
# name inside the Project Domains column too, so a project that had been renamed
# still looked present and the deploy failed further down instead of recreating.
if ! "${WRANGLER[@]}" pages project list 2>/dev/null | grep -qE "^..? *$NAME +."; then
  echo "Creating Pages project $NAME"
  "${WRANGLER[@]}" pages project create "$NAME" --production-branch "$BRANCH"
fi

FILES="$(find public -type f | wc -l)"
echo "Deploying $FILES files from public/ to $NAME"
"${WRANGLER[@]}" pages deploy public \
  --project-name "$NAME" \
  --branch "$BRANCH" \
  --commit-dirty=true

cat <<DONE

Deployed. The project is served at https://$NAME.pages.dev

For eclipse.tsbf.uk: Cloudflare dashboard -> Workers & Pages -> $NAME ->
Custom domains -> Set up a custom domain. The DNS record is rewritten for
you, so whatever eclipse.tsbf.uk points at now is replaced.

public/_headers carries the caching and MIME rules; it is read at deploy
time and is not served.
DONE
