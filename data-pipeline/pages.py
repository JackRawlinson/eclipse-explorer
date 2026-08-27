"""A page per eclipse that IS the map, carrying that eclipse's facts as text.

Arriving from a search lands straight on the interactive map with the right
eclipse selected -- no interstitial, no second click. What a crawler reads and
what the script renders are the same facts in the same panel.

Each page is stamped from the site's own index.html AT GENERATION TIME, by the
deploy script and by the container's pages stage, never ahead of time. That is
the lesson of the first attempt: pages generated once and stored drift out of
step with app.js; pages stamped from the markup being shipped cannot.

The year and list pages stay plain documents -- the app has no year view for
them to be. And if a deployment ships short, a missing page answers 404 and the
404 page bounces /eclipse/<date>/ into /?e=, so the map stays reachable even
then.
"""

import html
import json
import os

MONTHS = ["January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December"]

TYPE_NAMES = {"total": "Total", "annular": "Annular",
              "hybrid": "Hybrid", "partial": "Partial"}

# One small stylesheet, inlined into every page so each is self-contained.
STYLE = """
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1.25rem 4rem;
  background: #f8fafc; color: #0f172a;
  font: 400 1rem/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 44rem; margin: 0 auto; }
h1 { font-size: 1.35rem; letter-spacing: -.01em; margin: 0 0 .35rem; }
.lead { margin: 0 0 1.1rem; color: #475569; font-size: .92rem; }
.map-link { display: block; margin: 0 0 1.1rem; border-radius: 12px; overflow: hidden;
  border: 1px solid #e2e8f0; }
.map-link img { display: block; width: 100%; height: auto; }
.cta { display: inline-block; margin: 0 0 1.6rem; padding: .55rem 1.1rem;
  border-radius: 8px; background: #4c1d95; color: #fff; text-decoration: none;
  font-weight: 600; font-size: .92rem; }
.cta:hover { filter: brightness(1.1); }
dl { display: grid; grid-template-columns: auto 1fr; gap: .3rem 1rem;
  margin: 0 0 1.6rem; font-size: .9rem; }
dt { color: #475569; }
dd { margin: 0; font-variant-numeric: tabular-nums; }
nav { display: flex; flex-wrap: wrap; gap: .4rem 1.2rem; font-size: .88rem;
  margin: 0 0 1.6rem; }
a { color: #4c1d95; }
.credit { font-size: .74rem; color: #64748b; line-height: 1.5; }
.credit a { color: inherit; }
h2 { font-size: 1rem; margin: 1.4rem 0 .4rem; padding-bottom: .2rem;
  border-bottom: 1px solid #e2e8f0; }
ul.years, ul.list { list-style: none; margin: 0 0 1rem; padding: 0;
  display: grid; gap: .3rem; font-size: .9rem; }
.note { color: #64748b; font-size: .8rem; }
.yearnav { display: flex; align-items: center; gap: .8rem; margin: 0 0 .35rem; }
.yearnav h1 { margin: 0; min-width: 0; }
.yearnav__step { flex: none; display: grid; place-items: center;
  width: 2rem; height: 2rem; border-radius: 50%; border: 1px solid #e2e8f0;
  color: #4c1d95; font-size: 1.15rem; line-height: 1; text-decoration: none; }
.yearnav__step:hover { border-color: #4c1d95; }
.yearnav__step--off { visibility: hidden; }
.yearnav__year { font: inherit; color: inherit; background: none; border: none;
  padding: 0; cursor: pointer; border-bottom: 2px dotted #94a3b8; }
.yearnav__year:hover { border-bottom-color: #4c1d95; }
.yearnav__input { font: inherit; width: 4.5ch; background: none; color: inherit;
  border: none; border-bottom: 2px solid #4c1d95; padding: 0; }
.yearnav__input:focus { outline: none; }
@media (prefers-color-scheme: dark) {
  body { background: #0b1120; color: #f8fafc; }
  .lead, dt { color: #94a3b8; }
  .map-link { border-color: #1e293b; }
  .cta { background: #a78bfa; color: #0b1120; }
  a { color: #a78bfa; }
  .credit, .note { color: #64748b; }
  h2 { border-color: #1e293b; }
  .yearnav__step { border-color: #1e293b; color: #a78bfa; }
  .yearnav__step:hover { border-color: #a78bfa; }
  .yearnav__input { border-bottom-color: #a78bfa; }
}
"""

# The year in the heading turns into a field when clicked; Enter goes to that
# year's page. Without JavaScript the button simply does nothing, and the +/-
# links either side still work, being ordinary links.
YEAR_SCRIPT = """<script>
(function () {
  var label = document.getElementById('year');
  if (!label) return;
  label.title = 'Click to type a year';
  label.addEventListener('click', function () {
    var field = document.createElement('input');
    field.type = 'text';
    field.inputMode = 'numeric';
    field.className = 'yearnav__input';
    field.value = label.textContent;
    field.setAttribute('aria-label', 'Year, 1900 to 2100');
    label.replaceWith(field);
    field.focus();
    field.select();
    field.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        var year = parseInt(field.value, 10);
        if (!year) return;
        year = Math.min(2100, Math.max(1900, year));
        location.href = '/eclipse/' + year + '/';
      } else if (event.key === 'Escape') {
        field.replaceWith(label);
      }
    });
    field.addEventListener('blur', function () {
      if (field.parentNode) field.replaceWith(label);
    });
  });
})();
</script>"""

CREDIT = ('Eclipse Predictions by Fred Espenak, NASA’s GSFC, from the '
          'Besselian elements of the '
          '<a href="https://eclipse.gsfc.nasa.gov/SEpubs/5MCSE.html" '
          'rel="noopener">Five Millennium Canon of Solar Eclipses</a>. '
          'Map data &copy; OpenStreetMap contributors.')


def slug(entry):
    return entry["date"]


def long_date(iso):
    year, month, day = (int(p) for p in iso.split("-"))
    return f"{day} {MONTHS[month - 1]} {year}"


def duration(seconds):
    if not seconds:
        return None
    minutes, rest = divmod(int(round(seconds)), 60)
    return f"{minutes}m {rest:02d}s" if minutes else f"{rest}s"


def lat_lon(lat, lon):
    return (f"{abs(lat):.1f}°{'N' if lat >= 0 else 'S'} "
            f"{abs(lon):.1f}°{'E' if lon >= 0 else 'W'}")


def title_for(entry):
    return f"{TYPE_NAMES[entry['type']]} solar eclipse, {long_date(entry['date'])}"


def description_for(entry):
    kind = entry["type"]
    when = long_date(entry["date"])
    greatest = entry["greatest"]
    if kind == "partial":
        head = (f"A partial solar eclipse on {when}. The Moon's shadow misses "
                f"the Earth, so there is no path of totality; the eclipse is "
                f"deepest near {lat_lon(greatest['lat'], greatest['lon'])}")
    else:
        noun = "annularity" if kind == "annular" else "totality"
        longest = duration(entry.get("centralDurationS"))
        head = (f"A {kind} solar eclipse on {when}, with {noun} lasting up to "
                f"{longest}" if longest else f"A {kind} solar eclipse on {when}")
        if entry.get("pathWidthKm"):
            head += f" in a path {round(entry['pathWidthKm'])} km wide"
    tail = (f"greatest eclipse at {greatest['ut']} UT, "
            f"magnitude {entry['magnitude']:.3f}, saros {entry['saros']}")
    return f"{head}. {tail[0].upper()}{tail[1:]}."


def _rows(entry):
    greatest = entry["greatest"]
    rows = [("Type", TYPE_NAMES[entry["type"]]),
            ("Date", long_date(entry["date"]))]
    longest = duration(entry.get("centralDurationS"))
    if longest:
        noun = "annularity" if entry["type"] == "annular" else "totality"
        rows.append((f"Longest {noun}", longest))
    rows.append(("Greatest eclipse", f"{greatest['ut']} UT"))
    rows.append(("Greatest eclipse at", lat_lon(greatest["lat"], greatest["lon"])))
    if entry.get("pathWidthKm"):
        rows.append(("Path width", f"{round(entry['pathWidthKm'])} km"))
    if entry.get("pathBegins"):
        rows.append(("Path on Earth", f"{entry['pathBegins']}–{entry['pathEnds']} UT"))
    if entry.get("partialBegins"):
        rows.append(("Partial eclipse", f"{entry['partialBegins']}–{entry['partialEnds']} UT"))
    rows.append(("Magnitude", f"{entry['magnitude']:.3f}"))
    rows.append(("Saros series", str(entry["saros"])))
    return rows


def _shell(title, desc, canonical, body, image=None):
    og_image = (f'\n<meta property="og:image" content="{image}">'
                '\n<meta name="twitter:card" content="summary_large_image">'
                if image else "")
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<meta name="description" content="{html.escape(desc, quote=True)}">
<link rel="canonical" href="{canonical}">
<meta property="og:title" content="{html.escape(title, quote=True)}">
<meta property="og:description" content="{html.escape(desc, quote=True)}">
<meta property="og:url" content="{canonical}">{og_image}
<style>{STYLE}</style>
</head>
<body>
<main>
{body}
<p class="credit">{CREDIT}</p>
</main>
</body>
</html>
"""


def _city_table(entry, rows):
    if not rows:
        return ""
    noun = {"total": "Totality", "annular": "Annularity"}.get(
        entry["type"], "Central phase")
    body = "".join(
        f'<tr><td>{html.escape(r["name"])}, {html.escape(r["country"])}</td>'
        f'<td>{r["from"]}\u2013{r["to"]} UT</td>'
        f'<td>{duration(r["durationS"])}</td></tr>'
        for r in rows)
    return (f'<h2 class="facts__cities-title">In the path</h2>'
            f'<table class="facts__cities">'
            f'<thead><tr><th>City</th><th>{noun}</th><th>Lasts</th></tr></thead>'
            f'<tbody>{body}</tbody></table>')


def render_eclipse(template, entry, base_url, cities=None):
    """The app, with this eclipse's identity and facts written into it."""
    import re
    title = title_for(entry)
    suffix = "where and when" if entry["type"] == "partial" else "path and times"
    full = f"{title} — {suffix}"
    desc = description_for(entry)
    url = f"{base_url}/eclipse/{slug(entry)}/"
    image = f"{base_url}/preview/{entry['id']}.png"
    page = template

    page = re.sub(r"<title>.*?</title>", f"<title>{html.escape(full)}</title>",
                  page, count=1, flags=re.S)
    for pattern, value in [
        (r'<meta name="description" content="[^"]*">',
         f'<meta name="description" content="{html.escape(desc, quote=True)}">'),
        (r'<link rel="canonical" href="[^"]*">',
         f'<link rel="canonical" href="{url}">'),
        (r'<meta property="og:url" content="[^"]*">',
         f'<meta property="og:url" content="{url}">'),
        (r'<meta property="og:title" content="[^"]*">',
         f'<meta property="og:title" content="{html.escape(full, quote=True)}">'),
        (r'<meta property="og:description" content="[^"]*">',
         f'<meta property="og:description" content="{html.escape(desc, quote=True)}">'),
        (r'<meta property="og:image" content="[^"]*">',
         f'<meta property="og:image" content="{image}">'),
        (r'<meta property="og:image:alt" content="[^"]*">',
         f'<meta property="og:image:alt" content="'
         f'{html.escape(title, quote=True)}, drawn on a world map.">'),
    ]:
        page = re.sub(pattern, value, page, count=1)
    page = re.sub(r'<h1 class="sr-only">.*?</h1>',
                  f'<h1 class="sr-only">{html.escape(title)}</h1>',
                  page, count=1, flags=re.S)

    # The facts, in the panel the script fills in anyway: the script replaces
    # this wholesale the moment it selects, so nothing needs removing later.
    facts = "".join(f"<dt>{html.escape(k)}</dt><dd>{html.escape(v)}</dd>"
                    for k, v in _rows(entry))
    page = page.replace(
        '<div id="facts"></div>',
        f'<div id="facts"><p class="facts__note">{html.escape(desc)}</p>'
        f'<dl class="facts">{facts}</dl>{_city_table(entry, cities)}</div>', 1)
    return page


RM_MOON = 0.2725


def _lunar_contacts(entry):
    g = entry["greatestUT"]
    half = lambda m: (m or 0) / 60 / 2
    c = {"p1": g - half(entry.get("penM")), "p4": g + half(entry.get("penM")),
         "u1": g - half(entry.get("parM")), "u4": g + half(entry.get("parM"))}
    if entry.get("totM"):
        c["u2"] = g - half(entry["totM"])
        c["u3"] = g + half(entry["totM"])
    return c


def _ut(hours):
    s = int(round(((hours % 24) + 24) % 24 * 60))
    return f"{s // 60:02d}:{s % 60:02d}"


def lunar_title(entry):
    return f"{TYPE_NAMES[entry['type']]} lunar eclipse, {long_date(entry['date'])}"


def lunar_description(entry):
    c = _lunar_contacts(entry)
    when = long_date(entry["date"])
    if entry.get("totM"):
        head = (f"A total lunar eclipse on {when}, with totality lasting "
                f"{duration(entry['totM'] * 60)}, {_ut(c['u2'])}\u2013{_ut(c['u3'])} UT")
    else:
        head = (f"A partial lunar eclipse on {when}, "
                f"{_ut(c['u1'])}\u2013{_ut(c['u4'])} UT")
    return (f"{head}. Visible from the entire night side of the Earth; "
            f"the Moon stands overhead near "
            f"{lat_lon(entry['zenith']['lat'], entry['zenith']['lon'])}. "
            f"Umbral magnitude {entry['umbralMag']:.3f}, saros {entry['saros']}.")


def _lunar_rows(entry):
    c = _lunar_contacts(entry)
    rows = [("Type", f"{TYPE_NAMES[entry['type']]} lunar"),
            ("Date", long_date(entry["date"]))]
    if entry.get("totM"):
        rows.append(("Totality", f"{_ut(c['u2'])}\u2013{_ut(c['u3'])} UT"
                     f" \u00b7 {duration(entry['totM'] * 60)}"))
    rows.append(("Partial phase", f"{_ut(c['u1'])}\u2013{_ut(c['u4'])} UT"))
    rows.append(("Penumbral", f"{_ut(c['p1'])}\u2013{_ut(c['p4'])} UT"))
    rows.append(("Umbral magnitude", f"{entry['umbralMag']:.3f}"))
    rows.append(("Moon overhead near",
                 lat_lon(entry["zenith"]["lat"], entry["zenith"]["lon"])))
    rows.append(("Saros series", str(entry["saros"])))
    return rows


def render_lunar(template, entry, base_url):
    """The app again, stamped with a lunar eclipse's identity."""
    import re
    title = lunar_title(entry)
    full = f"{title} \u2014 who sees it and when"
    desc = lunar_description(entry)
    url = f"{base_url}/lunar/{entry['date']}/"
    image = f"{base_url}/preview/lunar-{entry['id']}.png"
    page = template
    for pattern, value in [
        (r"<title>.*?</title>", f"<title>{html.escape(full)}</title>"),
        (r'<meta name="description" content="[^"]*"',
         f'<meta name="description" content="{html.escape(desc, quote=True)}"'),
        (r'<link rel="canonical" href="[^"]*">',
         f'<link rel="canonical" href="{url}">'),
        (r'<meta property="og:url" content="[^"]*">',
         f'<meta property="og:url" content="{url}">'),
        (r'<meta property="og:title" content="[^"]*">',
         f'<meta property="og:title" content="{html.escape(full, quote=True)}">'),
        (r'<meta property="og:description" content="[^"]*">',
         f'<meta property="og:description" content="{html.escape(desc, quote=True)}"'
         '>'),
        (r'<meta property="og:image" content="[^"]*">',
         f'<meta property="og:image" content="{image}">'),
        (r'<meta property="og:image:alt" content="[^"]*">',
         f'<meta property="og:image:alt" content="'
         f'{html.escape(title, quote=True)}: the Moon in the Earth\u2019s shadow.">'),
    ]:
        page = re.sub(pattern, value, page, count=1)
    page = re.sub(r'<h1 class="sr-only">.*?</h1>',
                  f'<h1 class="sr-only">{html.escape(title)}</h1>',
                  page, count=1, flags=re.S)
    facts = "".join(f"<dt>{html.escape(k)}</dt><dd>{html.escape(v)}</dd>"
                    for k, v in _lunar_rows(entry))
    page = page.replace(
        '<div id="facts"></div>',
        f'<div id="facts"><p class="facts__note">{html.escape(desc)}</p>'
        f'<dl class="facts">{facts}</dl></div>', 1)
    return page


def render_lunar_list(entries, base_url):
    by_year = {}
    for e in entries:
        by_year.setdefault(e["date"][:4], []).append(e)
    blocks = []
    for year in sorted(by_year):
        links = "".join(
            f'<li><a href="/lunar/{e["date"]}/">{html.escape(lunar_title(e))}</a></li>'
            for e in by_year[year])
        blocks.append(f'<h2>{year}</h2><ul class="years">{links}</ul>')
    desc = (f"A list of all {len(entries)} lunar eclipses between "
            f"{entries[0]['date'][:4]} and {entries[-1]['date'][:4]} \u2014 "
            "every total and partial eclipse of the Moon, each with its "
            "times and visibility.")
    body = f"""<h1>Every lunar eclipse, 1900 to 2100</h1>
<p class="lead">{html.escape(desc)}
<a href="/">Open the interactive map</a>.
<a href="/eclipse/">Solar eclipses instead</a>.</p>
{''.join(blocks)}"""
    return _shell("Every lunar eclipse, 1900 to 2100", desc,
                  f"{base_url}/lunar/", body)


def _year_step(year, sign):
    if year is None:
        return f'<span class="yearnav__step yearnav__step--off">{sign}</span>'
    return (f'<a class="yearnav__step" href="/eclipse/{year}/" '
            f'aria-label="Solar eclipses in {year}" '
            f'title="Solar eclipses in {year}">{sign}</a>')


def render_year(year, entries, base_url, before=None, after=None, lunar=None):
    listed = "".join(
        f'<li><a href="/eclipse/{slug(e)}/">{html.escape(title_for(e))}</a> '
        f'<span class="note">{html.escape(_summary(e))}</span></li>'
        for e in entries)
    kinds = ", ".join(f"{TYPE_NAMES[e['type']].lower()} on "
                      f"{long_date(e['date']).rsplit(' ', 1)[0]}" for e in entries)
    count = len(entries)
    central = any(e["type"] != "partial" for e in entries)
    offers = ("Paths, times and how much of the Sun is covered." if central
              else "Times, and how much of the Sun is covered.")
    desc = f"{count} solar eclipse{'s' if count != 1 else ''} in {year}: {kinds}. {offers}"
    body = f"""<div class="yearnav">{_year_step(before, "−")}
<h1>Solar eclipses in <button type="button" class="yearnav__year" id="year">{year}</button></h1>
{_year_step(after, "+")}</div>
<p class="lead">{html.escape(desc)}</p>
<ul class="list">{listed}</ul>
{_lunar_year_block(lunar)}
<nav><a href="/eclipse/">Every eclipse, 1900 to 2100</a>
<a href="/lunar/">Every lunar eclipse</a>
<a href="/">Open the interactive map</a></nav>
{YEAR_SCRIPT}"""
    return _shell(f"Solar eclipses in {year}", desc,
                  f"{base_url}/eclipse/{year}/", body)


def _lunar_year_block(entries):
    if not entries:
        return ""
    listed = "".join(
        f'<li><a href="/lunar/{e["date"]}/">{html.escape(lunar_title(e))}</a> '
        f'<span class="note">{"totality " + duration(e["totM"] * 60) if e.get("totM") else "partial only"}</span></li>'
        for e in entries)
    return f'<h2>Lunar eclipses the same year</h2><ul class="list">{listed}</ul>'


def _summary(entry):
    if entry["type"] == "partial":
        return "no path of totality"
    longest = duration(entry.get("centralDurationS"))
    noun = "annularity" if entry["type"] == "annular" else "totality"
    return f"up to {longest} of {noun}" if longest else "central eclipse"


def render_list(entries, base_url):
    by_year = {}
    for e in entries:
        by_year.setdefault(e["date"][:4], []).append(e)
    blocks = []
    for year in sorted(by_year):
        links = "".join(
            f'<li><a href="/eclipse/{slug(e)}/">{html.escape(title_for(e))}</a></li>'
            for e in by_year[year])
        blocks.append(f'<h2><a href="/eclipse/{year}/">{year}</a></h2>'
                      f'<ul class="years">{links}</ul>')
    desc = (f"A list of all {len(entries)} solar eclipses between "
            f"{entries[0]['date'][:4]} and {entries[-1]['date'][:4]}, each with "
            "its path, times and duration.")
    body = f"""<h1>Every solar eclipse, 1900 to 2100</h1>
<p class="lead">{html.escape(desc)}
<a href="/">Open the interactive map</a>.</p>
{''.join(blocks)}"""
    return _shell("Every solar eclipse, 1900 to 2100", desc,
                  f"{base_url}/eclipse/", body)


def render_sitemap(entries, base_url, lunar=()):
    years = sorted({e["date"][:4] for e in entries})
    urls = [f"{base_url}/", f"{base_url}/eclipse/"]
    urls += [f"{base_url}/eclipse/{y}/" for y in years]
    urls += [f"{base_url}/eclipse/{slug(e)}/" for e in entries]
    if lunar:
        urls.append(f"{base_url}/lunar/")
        urls += [f"{base_url}/lunar/{e['date']}/" for e in lunar]
    body = "".join(f"<url><loc>{u}</loc></url>" for u in urls)
    return ('<?xml version="1.0" encoding="UTF-8"?>'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            f"{body}</urlset>")


def _city_times(public_dir):
    """The per-city table data, computed by cities.py in the pipeline stage.
    Falling back to building it here keeps a fresh checkout honest, at the
    price of a couple of minutes."""
    path = os.path.join(public_dir, "data", "cities.json")
    if os.path.exists(path):
        with open(path) as fh:
            return json.load(fh)
    import cities
    return cities.build()


def _lunar_entries(public_dir):
    path = os.path.join(public_dir, "data", "lunar.json")
    if not os.path.exists(path):
        import lunar as lunar_mod
        lunar_mod.write(lunar_mod.parse())
    with open(path) as fh:
        return json.load(fh)["eclipses"]


def write_all(entries, public_dir, base_url):
    """Every leaf page, both kinds, the year and list pages, and the sitemap."""
    with open(os.path.join(public_dir, "index.html")) as fh:
        template = fh.read()
    city_times = _city_times(public_dir)
    moons = _lunar_entries(public_dir)
    ordered = sorted(entries, key=lambda e: e["date"])
    for entry in ordered:
        directory = os.path.join(public_dir, "eclipse", slug(entry))
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, "index.html"), "w") as fh:
            fh.write(render_eclipse(template, entry, base_url,
                                    city_times.get(entry["id"])))

    for entry in moons:
        directory = os.path.join(public_dir, "lunar", entry["date"])
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, "index.html"), "w") as fh:
            fh.write(render_lunar(template, entry, base_url))
    with open(os.path.join(public_dir, "lunar", "index.html"), "w") as fh:
        fh.write(render_lunar_list(moons, base_url))

    lunar_by_year = {}
    for entry in moons:
        lunar_by_year.setdefault(entry["date"][:4], []).append(entry)

    by_year = {}
    for entry in ordered:
        by_year.setdefault(entry["date"][:4], []).append(entry)
    # Neighbours come from the years that exist, not year arithmetic, so a year
    # with no eclipses (there are none, but the data decides) is stepped over.
    years = sorted(by_year)
    for position, year in enumerate(years):
        before = years[position - 1] if position else None
        after = years[position + 1] if position + 1 < len(years) else None
        directory = os.path.join(public_dir, "eclipse", year)
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, "index.html"), "w") as fh:
            fh.write(render_year(year, by_year[year], base_url, before, after,
                                 lunar_by_year.get(year)))

    with open(os.path.join(public_dir, "eclipse", "index.html"), "w") as fh:
        fh.write(render_list(ordered, base_url))
    with open(os.path.join(public_dir, "sitemap.xml"), "w") as fh:
        fh.write(render_sitemap(ordered, base_url, moons))
    return len(ordered) + len(moons) + len(by_year) + 3


# Standalone: rebuild the pages (and any missing previews) from the index that
# already exists, without running the eleven minutes of geometry.
if __name__ == "__main__":
    import config
    import preview

    public = os.path.dirname(config.OUTPUT_DIR)
    with open(os.path.join(config.OUTPUT_DIR, "index.json")) as fh:
        index = json.load(fh)

    preview_dir = os.path.join(public, "preview")
    os.makedirs(preview_dir, exist_ok=True)
    drawn = 0
    for entry in index["eclipses"]:
        target = os.path.join(preview_dir, f"{entry['id']}.png")
        if os.path.exists(target):
            continue
        with open(os.path.join(config.OUTPUT_DIR, f"{entry['id']}.geojson")) as fh:
            collection = json.load(fh)
        with open(target, "wb") as out:
            out.write(preview.render(collection, entry))
        drawn += 1

    import lunar_preview
    moons = _lunar_entries(public)
    for entry in moons:
        target = os.path.join(preview_dir, f"lunar-{entry['id']}.png")
        if os.path.exists(target):
            continue
        with open(target, "wb") as out:
            out.write(lunar_preview.render(entry))
        drawn += 1

    written = write_all(index["eclipses"], public, config.BASE_URL)
    print(f"wrote {written} pages, drew {drawn} previews")
