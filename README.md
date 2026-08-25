# Eclipse Mapper

Every solar eclipse from 1900 to 2100 on an interactive map: the path of totality or
annularity, the central line, how much of the Sun goes anywhere else, and — click
anywhere — the local contact times. Static files, no backend, no ads, no tracking.

Paths are **computed from NASA's Besselian elements**, not traced from images, so they
stay sharp at every zoom level.

> **Eclipse Predictions by Fred Espenak, NASA's GSFC.**
> Besselian elements from *Five Millennium Canon of Solar Eclipses: −1999 to +3000*,
> Fred Espenak and Jean Meeus, NASA/TP‑2006‑214141.

## Running it

Everything under `public/` is the site. It needs to be served over HTTP — MapLibre
ships as an ES module and browsers refuse module imports over `file://`.

```sh
python3 serve.py 8000
# http://localhost:8000/?e=20260812
```

`serve.py` is `http.server` plus `Cache-Control: no-store`. The stock module sends
no cache headers at all, so browsers fall back to their own heuristics and go on
serving yesterday's eclipse data after a rebuild. Data URLs also carry the build
stamp from `index.json`, so a caching host cannot hold a stale eclipse either.

To reach it from elsewhere on a Tailscale tailnet without exposing it to the local
network, bind to the tailnet address: `python3 serve.py 8000 --bind 100.x.y.z`.

Deploy by copying `public/` to any static host.

### Using it

- **Click anywhere on the map** for that spot's local circumstances: how much of the
  Sun goes, when the partial phase runs, and — inside the path — how long totality
  or annularity lasts there.
- **← / →** step to the previous or next eclipse, **/** focuses the search box.
- The URL carries the selection (`?e=20260812`), so views are linkable and the
  browser's back and forward buttons work.
- Map controls, top right: refit to the selected eclipse, switch the basemap between
  light and dark, switch between the flat map and a globe, and switch the shading
  between a smooth gradient and stepped contour bands. The globe is worth reaching
  for on polar paths — Web Mercator cuts off above 85°.

## Repository layout

```
data-pipeline/     computes the geometry and writes the static data
  besselian.py       elements, polynomial state, ellipsoid projection
  geometry.py        central line, shadow limits, path polygons, sphere wrapping
  raster.py          shadow-reach field, obscuration, contour tracing
  shading.py         the smooth obscuration image, and a small PNG writer
  circumstances.py   what one place on the ground sees (reference implementation)
  build.py           writes public/data/*.geojson and index.json
  config.py          year range, resolutions, tolerances
  fetch_sources.py   downloads the canon extract and the NASA pages into cache/
  nasa_tables.py     parser for NASA's published path tables (verification only)
  verify_*.py        comparison against those tables
  validate_regions.py  region boundaries vs a brute-force rasterisation
  check_output.py    the shipped files, structurally and physically
  cache/             the canon extract and the NASA pages, fetched once
public/            the site
  index.html app.js style.css
  circumstances.js   port of circumstances.py, so a click answers instantly
  vendor/            MapLibre GL JS, vendored so there is no CDN dependency
  data/              one GeoJSON and one PNG per eclipse, plus index.json
serve.py           static server for development, with caching turned off
```

## Regenerating the data

```sh
cd data-pipeline
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python fetch_sources.py      # once; skips anything already cached
.venv/bin/python build.py              # whole range, ~10 minutes
.venv/bin/python build.py 20240408     # a single eclipse
```

Then check what came out:

```sh
.venv/bin/python verify_central.py --fit        # against NASA's published tables
.venv/bin/python verify_limits.py --fitted
.venv/bin/python verify_circumstances.py --js   # local times, and Python vs browser
.venv/bin/python check_output.py 120            # the shipped files themselves
```

Output lands in `public/data/`: a GeoJSON and a shading PNG for each of 454
eclipses, together about 24 KB apiece and 11 MB in total. The browser loads one
eclipse at a time — roughly 24 KB of geometry and 14 KB of shading — plus a 155 KB
index at startup. `public/data/` is gitignored; commit it instead if you would
rather deploy without running the pipeline.

Widening the range is a change to `YEAR_MIN` / `YEAR_MAX` in `config.py`. The canon
covers −1999 to +3000, so the pipeline will take any range inside that.

### Source data

`data-pipeline/cache/` holds a bulk extract of the canon's Besselian elements
([gmiller123456/FiveMillenniumCanonOfSolarEclipses-Besselian-Elements](https://github.com/gmiller123456/FiveMillenniumCanonOfSolarEclipses-Besselian-Elements)),
checked coefficient by coefficient against the array NASA's own page for 2024‑04‑08
publishes. It agrees exactly, to the extract's 7 significant figures — worst-case
effect on a computed position, about 3 metres. The extract also carries the canon's
summary row per eclipse (type, magnitude, gamma, ΔT, greatest-eclipse position,
path width, central duration), and those are the numbers the info panel shows.

The `cache/nasa/` pages are used only to check our arithmetic. No path coordinates
from NASA are shipped.

## Method

Standard reduction of Besselian elements, following Meeus, *Elements of Solar
Eclipses 1951–2200*, and the *Explanatory Supplement to the Astronomical Almanac*,
ch. 8. Elements give the shadow axis in the fundamental plane as polynomials in time;
the ρ₁/ρ₂/d₁/d₂ auxiliaries flatten the WGS 84 ellipsoid onto a unit sphere so the
axis can be intersected with the surface.

Geographic longitude is `θ − μ + 1.002738·ΔT`. `μ` is an *ephemeris* hour angle,
reckoned from the ephemeris meridian rather than from Greenwich; the opposite sign
puts the 2024 path 0.6° out of place.

**Path limits** are the envelope of the shadow circle — the locus where its edge is
momentarily stationary along the normal to the shadow's motion *relative to the
ground*. The ground point's own velocity in the fundamental plane
(`ξ′ = μ′(ζ cos d − η sin d)`, `η′ = μ′ξ sin d − d′ζ`) was re-derived rather than
recalled, and checked against the physical case of a point on the equator.

**Path ends** come from the same construction: where the envelope point leaves the
Earth, the boundary is the shadow circle's crossing of the limb instead, and at first
and last contact the two sides meet at a point, so the polygon closes on itself
rather than spiking.

**The penumbral region** cannot be built that way. Its footprint boundary is mostly
arc rather than envelope, and the two families swap places along the region's edge.
It is traced instead as the zero contour of *shadow reach* — how close the shadow
ever comes to each point, negative where it never arrives, and pushed far negative
where the Sun stays below the horizon, which is what puts the sunrise and sunset
edges of the region in the right place. Reach is *maximised* over time, not sampled:
the region's edge is exactly where the eclipse lasts no time at all, so any fixed
time step would place it short by however far the shadow travels in half a step.
Grid resolution decides only the topology; every contour vertex is then solved onto
the true boundary, and lands within about 25 m of it.

**Grazing eclipses** (|γ| near 1) have a broad umbra against a short path, so their
umbral footprint behaves like the penumbra's and the envelope sweep fails. Rather
than guess from γ, the pipeline measures what actually matters — the share of the
eclipse during which the shadow straddles the limb — and traces a contour instead
when that share exceeds 0.15. The measure separates cleanly: ordinary eclipses come
in at 0.005–0.08, grazing ones at 0.20–1.00. About 7% of eclipses take this route,
flagged as `"pathMethod": "raster"` in `index.json`.

**Hybrid eclipses** are split where the central-line umbral radius changes sign, so
the annular and total legs are drawn in their own colours.

**How much of the Sun goes** is shown two ways, from the same field. *Magnitude* is
the covered fraction of the solar diameter, `(L1' − m) / (L1' + L2')` at the moment
of deepest eclipse; *obscuration* is the covered fraction of the disc, which is what
people mean by "a 90% eclipse" and is not the same number — two equal discs half
overlapping in diameter hide only 39% of the area. Obscuration comes from the
circular-lens area with the Sun's radius as the unit and the Moon's as the diameter
ratio `(L1' − L2') / (L1' + L2')`. Contours at 20/40/60/80/90% are traced the same
way the region boundary is, and labelled along the line.

The smooth shading is a separate image, because MapLibre has no way to colour a
greyscale raster through a ramp — `raster-color` is a Mapbox property, not one of
theirs. So the colour is baked in at build time and only the alpha varies, which
also makes the file small: with the three colour channels constant there is almost
nothing left for zlib to store, and a 768×384 image comes to about 14 KB. Rows are
spaced evenly in Web Mercator y rather than in latitude, so it drapes onto
MapLibre's image source with no reprojection. The map toggles between it and the
stepped bands.

**One sampling feeds everything.** Finding the deepest moment at a point is the
expensive step — with contact times, path limits and the central line together
costing under 2% of the build, essentially all of it is that one search. So it
happens once per eclipse on a single grid, and the region outline, the obscuration
contours and the shading image are all read off that. The search itself is
golden-section rather than ternary, keeping one of its two interior points each
round and so costing one evaluation per step instead of two.

**The horizon is solved for, not searched across.** Reach is masked where the Sun is
down, which puts a step in the curve, and no search finds a maximum that sits
exactly on a step — so for anywhere whose deepest moment *is* the moment the Sun
comes up, the answer was only ever as good as the scan was fine. Sunrise and sunset
are now found directly, by Newton on ζ using the rate `d'η − μ'ξ cos d` that the
observer transform already yields, and used as hard ends of the bracket. That took
obscuration near the terminator from as much as **11 percentage points** out to
**0.0003**, and made the result independent of scan density altogether.

**Local circumstances** — what a single place sees — are computed in the browser
from the Besselian elements, which ride along in each eclipse's GeoJSON. The
deepest moment is found by the same bracket-and-ternary search the fields use;
contacts are then bisected on `distance − radius`, with the umbral radius for
second and third contact. Each contact carries the Sun's altitude, so an eclipse
already under way at sunrise says so rather than quietly reporting a time nobody
could have watched.

**Antimeridian and poles.** Ring longitudes are unwrapped along the curve, then cut
into ±180° tiles. A ring whose longitude winds a full turn encircles a pole; it is
closed over whichever pole the shadow actually reaches, by fanning strips from the
pole down to the boundary and accumulating them *by parity* — a point is inside when
a meridian crosses the boundary an odd number of times below it. Plain union is not
enough, because a boundary that doubles back crosses the same meridian more than
once. The strips are folded into ±180° before the parity is taken, or those crossings
land on separate copies of the world and never cancel.

## Verification

Everything below is reproducible: `verify_central.py`, `verify_limits.py`,
`validate_regions.py`.

### Central line against NASA's published path tables

`verify_central.py` — great-circle separation from the coordinates NASA tabulates in
`SEpath`, using the ΔT that ships with the elements. The first and last tabulated
instants sit where the shadow axis meets the limb, and there a fraction of a second
of timing slides the point a long way along the ground, so they are reported
separately rather than quietly dropped.

| Eclipse | ΔT | n | median | rms | max | max interior |
|---|---|---|---|---|---|---|
| 1901‑05‑18 | −0.9 s | 193 | **0.00068°** | 0.00069° | 0.00117° | 0.00117° |
| 1905‑08‑30 | +4.6 s | 172 | **0.00076°** | 0.00090° | 0.00305° | 0.00218° |
| 2017‑08‑21 | 70.3 s | 97 | 0.0197° | 0.0483° | 0.379° | 0.0836° |
| 2024‑04‑08 | 74.0 s | 98 | 0.0315° | 0.0960° | 0.795° | 0.1274° |
| 2026‑08‑12 | 75.4 s | 46 | 0.0363° | 0.0742° | 0.394° | 0.0994° |

**0.0007° is about 80 metres** — the rounding floor of NASA's tables, which are
printed to a tenth of an arcminute. The two eclipses from the 1900s sit on that floor
with no fitting of any kind.

The three modern eclipses do not, and the difference is not in the geometry.
`verify_central.py --fit` searches for the ΔT that best reproduces each table:

| Eclipse | canon ΔT | best-fit ΔT | difference | rms at canon | rms at best |
|---|---|---|---|---|---|
| 1901‑05‑18 | −0.9 s | −0.90 s | **0.00 s** | 0.00069° | 0.00069° |
| 1905‑08‑30 | +4.6 s | +4.67 s | **+0.07 s** | 0.00090° | 0.00084° |
| 2017‑08‑21 | 70.3 s | 68.35 s | −1.95 s | 0.0483° | **0.00085°** |
| 2024‑04‑08 | 74.0 s | 71.15 s | −2.85 s | 0.0960° | **0.00493°** |
| 2026‑08‑12 | 75.4 s | 72.03 s | −3.38 s | 0.0742° | **0.00276°** |

The historical eclipses want no adjustment at all; the modern ones want two to three
and a half seconds, and every residual then collapses onto the tables' rounding
floor. NASA has regenerated its recent pages with a revised ΔT. The reduction
underneath is the same one.

### Path limits and central duration

`verify_limits.py --fitted`, against the same tables with ΔT matched:

| Eclipse | N limit (median) | S limit (median) | worst | central duration |
|---|---|---|---|---|
| 1901‑05‑18 | 0.0017° | 0.0018° | 0.024° | 0.04 s |
| 1905‑08‑30 | 0.0010° | 0.0010° | 0.009° | 0.04 s |
| 2017‑08‑21 | 0.0008° | 0.0009° | 0.007° | 0.03 s |
| 2024‑04‑08 | 0.0038° | 0.0039° | 0.010° | 0.12 s |
| 2026‑08‑12 | 0.0021° | 0.0018° | 0.058° | 0.03 s |

### Regions against brute force

`validate_regions.py` asks, for every point of a lat/lon grid, whether the shadow
ever actually reaches it, and compares that with the polygon. Cells the boundary
passes through will always disagree, so every disagreement is then re-judged with a
scan far denser than the sweep can afford.

Run over a random sample spanning 1900–2100 plus deliberately awkward cases — a path
over the North Pole, a path across the antimeridian, a hybrid, a partial-only
eclipse, several grazing eclipses — mis-classified cells run at 0–7 out of regions of
several hundred to several thousand.

`check_output.py 120` repeats the comparison against the **shipped** polygons, and
over 120 randomly chosen eclipses came to **646 mis-classified cells out of about
1.56 million reached — 0.04%**, with the worst single eclipse at 18. What is left is
the straight-line error between contour vertices, and cell centres that fall within
metres of a boundary.

### Local circumstances

`verify_circumstances.py` takes every instant NASA tabulates, stands an observer on
the central-line coordinates printed for it, and compares.

| Eclipse | n | median | p95 | worst | error in the moment of maximum |
|---|---|---|---|---|---|
| 1901‑05‑18 | 193 | 0.05 s | 0.11 s | 0.12 s | 0.2 s |
| 1905‑08‑30 | 172 | 0.04 s | 0.09 s | 0.10 s | 0.2 s |
| 2017‑08‑21 | 97 | 0.03 s | 0.08 s | 0.10 s | 0.1 s |
| 2024‑04‑08 | 98 | 0.11 s | 0.19 s | 0.20 s | 0.4 s |
| 2026‑08‑12 | 46 | 0.03 s | 0.06 s | 0.07 s | 0.2 s |

Against published city figures for 2024‑04‑08, the partial phase at Dallas begins
17:23:12 UT and ends 20:02:35 UT — both to the second — and New York's maximum lands
on 19:25:30 UT. Totality durations: Little Rock 2m31s (published ~2m32s), Dallas
3m50s (~3m52s), Cleveland 3m49s (~3m50s), Buffalo 3m45s (~3m45s), Mazatlán 4m16s
(~4m20s). The residual is the canon's ΔT against the revised one, plus whichever
point in the city each source picked.

`verify_circumstances.py --js` runs the browser's port over the same points through
node and compares it with the Python: magnitude agrees to 3 × 10⁻¹¹, duration to
2 × 10⁻¹² s. The two are the same calculation.

### The shipped files

`check_output.py` reads what the browser reads, so it also catches anything lost in
simplification, rounding or serialisation. It checks every one of the 454 files for
coordinates out of range and for an edge drawn the wrong way round the world — the
bug that makes a path streak across the map — and then re-runs the region comparison
above against the shipped polygons for a random sample.

A part of a path may legitimately span 200° of longitude without going anywhere near
the antimeridian, so the test is on the *jump between neighbouring vertices*, not on
the span. The one edge allowed to jump is the one closing a polar cap along the top
or bottom of the map.

### Saros

`saros = ((38·LN + 111) mod 223) + 1`, checked against all 452 eclipses NASA's
SEcat5 catalogue lists for 1900–2100. No mismatches.

## Assumptions, stated rather than buried

- **ΔT comes from the canon.** It is the value published alongside the elements and
  the one that makes the output reproducible from a single cited source. NASA's
  current web pages use a slightly different value for 21st-century eclipses, which
  moves those paths by about 3–4 km on the ground. Set `DELTA_T_OVERRIDES` in
  `config.py` to match another source. ΔT, not the geometry, is the limiting
  uncertainty in where an eclipse path falls — especially for future eclipses.
- **Displayed facts are the canon's own**, not our reductions. Our computed path
  width matches the canon's to 0.1% mid-path but diverges near the sunrise and
  sunset ends, where "width" is definitionally soft — great-circle distance between
  the two limits at one instant is not the same thing as width measured perpendicular
  to the central line. Publishing a number that disagrees with NASA's for a reason
  that is really about definitions would be worse than useless.
- **The contours and the shading are obscuration, not magnitude** — the fraction of
  the Sun's *area* hidden, which is what "a 90% eclipse" is usually taken to mean.
  Magnitude, the fraction of its *diameter*, is the larger number: 90% obscuration
  is about 91% magnitude, and 50% magnitude is only 39% obscuration. The click
  readout gives both so there is no guessing which one is on screen.
- **WGS 84** (e² = 0.00669438), which is what the canon's coordinates use.
- Predictions are for the Moon's centre of mass. Real contact times shift by a few
  seconds from lunar limb profile; Baily's beads and the grazing-limit detail that
  implies are out of scope. A clicked point near the very edge of the path is
  therefore the place to trust least — that is exactly where the limb profile
  decides whether you see totality at all.
- Clicked circumstances ignore elevation, which shifts contact times by well under a
  second for any ordinary altitude. For a point with the Sun within a few arcminutes
  of the horizon the answer is formally right and practically meaningless —
  refraction and the local skyline decide what is actually seen, and neither is
  modelled.

## Licence and attribution

Eclipse predictions are NASA's and must carry the acknowledgment above; it appears in
the map attribution, in the info panel, and here. Map tiles are
[OpenFreeMap](https://openfreemap.org/) from
[OpenStreetMap](https://www.openstreetmap.org/copyright) data.
[MapLibre GL JS](https://maplibre.org/) is vendored under `public/vendor/` with its
licence.
