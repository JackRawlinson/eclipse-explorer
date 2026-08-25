# Eclipse Mapper

Every solar eclipse from 1900 to 2100 on an interactive map: the path of totality
or annularity, how much of the Sun goes anywhere else, and — click anywhere — the
local contact times. Static files, no backend, no ads, no tracking.

Paths are computed from NASA's published orbital data rather than traced from
images, so they stay sharp at every zoom level.

> **Eclipse Predictions by Fred Espenak, NASA's GSFC.**
> Besselian elements from *Five Millennium Canon of Solar Eclipses: −1999 to +3000*,
> Fred Espenak and Jean Meeus, NASA/TP‑2006‑214141.

## Using it

- **Click the map** for that spot's local circumstances: how much of the Sun goes,
  when the partial phase runs, and inside the path, how long totality lasts there.
- **← / →** step through eclipses, **/** focuses the search box.
- The URL carries the selection (`?e=20260812`), so views are linkable and the
  back button works.
- Buttons top right: refit to the eclipse, cycle the basemap, flat map or globe,
  and smooth shading or stepped contour bands. The globe is worth reaching for on
  polar paths — Web Mercator cuts off above 85°.

The shading is a plain obscuration mask — one grey channel, no colour — painted in
the browser, so how it looks is a live setting rather than something baked into
four hundred images. Append any of these to the URL to try alternatives:

| parameter | does | default |
|---|---|---|
| `?tint=334155` | colour of the shading, hex | near-neutral slate |
| `?shade=0.3` | how strong it is, 0 to 1 | `0.3` |
| `?gamma=0.85` | curve; lower lifts the faint outer reaches | `0.85` |
| `?basemap=liberty` | `positron`, `liberty`, `bright`, `fiord`, `dark` | `positron` |

Settle on a combination and it becomes a one-line change to the defaults in
`app.js` — no rebuild.

## Running it

Everything under `public/` is the site. It needs serving over HTTP — MapLibre ships
as an ES module and browsers refuse module imports over `file://`.

```sh
python3 serve.py 8000            # http://localhost:8000/?e=20260812
```

That is `http.server` with caching turned off, which saves confusion after a
rebuild. Deploy by copying `public/` to any static host.

### In Docker

```sh
docker compose up -d --build     # http://localhost:8080/
```

Two-stage build: the first stage generates the data, the second keeps only the
result on top of nginx. No Python survives into the finished image and nothing
runs at request time — about 60 MB, all of it files. It needs no network once
built; map tiles are fetched by your browser, not by the container.

The build takes about ten minutes, nearly all of it generating data. Narrow the
range if that is tedious:

```sh
docker build --build-arg YEAR_MIN=2000 --build-arg YEAR_MAX=2050 -t eclipse-mapper .
```

### Publishing the image

`.github/workflows/container.yml` builds on every push to `main` and pushes to
`ghcr.io/jackrawlinson/eclipse-explorer:latest`, so a server pulls the image
rather than building it. To push by hand instead:

```sh
docker login ghcr.io -u JackRawlinson    # token needs write:packages
./push-image.sh
```

Either way the package starts **private**, and a private pull fails with a bare
403. Make it public once: *repo → Packages → eclipse-explorer → Package settings
→ Change visibility*.

Then point any Docker host at `ghcr.io/jackrawlinson/eclipse-explorer:latest` with
host port → container port 80. `unraid-template.xml` fills in the same fields for
that platform's container UI.

Every asset is referenced relatively, so it also works at a subpath behind a
reverse proxy.

## Regenerating the data

```sh
cd data-pipeline
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python fetch_sources.py    # once; skips anything already cached
.venv/bin/python build.py            # whole range, ~10 minutes
.venv/bin/python build.py 20240408   # a single eclipse
```

Output lands in `public/data/`: a GeoJSON and a shading image per eclipse, about
24 KB apiece and 11 MB in total. The browser loads one eclipse at a time plus a
155 KB index. The directory is gitignored — commit it instead if you would rather
deploy `public/` without running the pipeline.

Changing the range is `YEAR_MIN` / `YEAR_MAX` in `config.py`, or the matching
environment variables. The source data covers −1999 to +3000.

## Layout

```
data-pipeline/     computes the geometry and writes the static data
  build.py           writes public/data/
  config.py          year range, resolutions, tolerances
  fetch_sources.py   downloads the source data into cache/
  verify_*.py        comparison against NASA's published tables
  check_output.py    checks the shipped files
public/            the site — index.html, app.js, style.css, vendor/, data/
docs/METHOD.md     how the geometry is computed, and how it was checked
serve.py           static server for development
push-image.sh      build and push the image by hand
```

## Accuracy, briefly

Central lines and path limits agree with NASA's published tables to about
0.001° — roughly 80 metres, which is as precisely as those tables are printed.
Local contact times match their tabulated durations to a tenth of a second.
`docs/METHOD.md` has the detail and the numbers; the `verify_*` scripts reproduce
them, and CI fails the build if they drift.

## Licence and attribution

Eclipse predictions are NASA's and must carry the acknowledgment above; it appears
in the map attribution, in the info panel, and here. Map tiles are
[OpenFreeMap](https://openfreemap.org/) from
[OpenStreetMap](https://www.openstreetmap.org/copyright) data.
[MapLibre GL JS](https://maplibre.org/) is vendored under `public/vendor/` with its
licence.
