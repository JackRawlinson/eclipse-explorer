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

# A deployment can come back "complete", report every file already uploaded,
# and then serve almost nothing: the assets are in the store but the manifest
# that goes live is short. From here that is indistinguishable from a good
# deploy. It has happened twice, and both times it was found by someone opening
# the site rather than by anything here.
#
# So the live site is sampled properly. An earlier version of this checked nine
# fixed paths and passed while 453 of 454 eclipses were missing, because one of
# the nine happened to be the file that survived. Sampling at random across each
# kind of file is the difference between a check and the appearance of one.
SITE="${CF_PAGES_SITE:-https://eclipse.tsbf.uk}"

sample_paths() {
  printf '%s\n' / /app.js /style.css /circumstances.js /data/index.json \
                 /data/elements.json /sitemap.xml /robots.txt /eclipse/
  ls public/data/*.geojson | xargs -n1 basename | sed 's/\.geojson//' \
    | shuf -n 25 | sed 's|^|/data/|; s|$|.geojson|'
  ls public/preview/*.png | xargs -n1 basename | sed 's/\.png//' \
    | shuf -n 10 | sed 's|^|/preview/|; s|$|.png|'
  ls -d public/eclipse/*-*/ | xargs -n1 basename | shuf -n 10 \
    | sed 's|^|/eclipse/|; s|$|/|'
  ls -d public/eclipse/[0-9][0-9][0-9][0-9]/ | xargs -n1 basename | shuf -n 5 \
    | sed 's|^|/eclipse/|; s|$|/|'
}

check_site() {
  sample_paths | xargs -P 4 -I@ sh -c \
    "printf '%s %s\\n' '@' \"\$(curl -sS -o /dev/null -w '%{http_code}' '$SITE@')\"" \
    > "$REPORT" 2>&1
  awk '$2 != 200' "$REPORT" | wc -l
}

REPORT="$(mktemp)"
trap 'rm -f "$REPORT"' EXIT

echo
echo "Checking $SITE"
sleep 4
BAD="$(check_site)"

if [ "$BAD" != "0" ]; then
  echo "  $BAD of $(wc -l < "$REPORT") sampled paths are not being served. Redeploying once." >&2
  "${WRANGLER[@]}" pages deploy public --project-name "$NAME" \
    --branch "$BRANCH" --commit-dirty=true >/dev/null 2>&1
  sleep 5
  BAD="$(check_site)"
fi

if [ "$BAD" != "0" ]; then
  awk '$2 != 200 {printf "  %-34s %s\n", $1, $2}' "$REPORT" | head -12 >&2
  cat >&2 <<BROKEN

$BAD of $(wc -l < "$REPORT") sampled paths are still not being served, after a
second attempt. The upload succeeds while the deployment that goes live is
short, so roll back to a known good one:

    Workers & Pages -> $NAME -> Deployments -> (a working one) -> Rollback
BROKEN
  exit 1
fi

echo "  all $(wc -l < "$REPORT") sampled paths served"

cat <<DONE

Deployed and answering. The project is served at https://$NAME.pages.dev

For eclipse.tsbf.uk: Cloudflare dashboard -> Workers & Pages -> $NAME ->
Custom domains -> Set up a custom domain. The DNS record is rewritten for
you, so whatever eclipse.tsbf.uk points at now is replaced.

public/_headers carries the caching and MIME rules; it is read at deploy
time and is not served.
DONE
