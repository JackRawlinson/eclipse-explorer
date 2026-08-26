"""A real HTML page per eclipse, so there is something to find.

The site is one URL with the eclipse in a query parameter, built by script.
That is fine to use and impossible to index: a crawler arriving at the root
sees a legend and no way through to any of the four hundred and fifty-four
eclipses behind it.

So each one also gets a page of its own, carrying its facts as text. The page
is the whole application with that content already in it -- not a separate
description that links to the map -- so arriving from a search result lands you
on the map itself, and stepping to the next eclipse from there is the same
instant swap it has always been rather than a page load.
"""

import html
import json
import os
import re

MONTHS = ["January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December"]

TYPE_NAMES = {"total": "Total", "annular": "Annular",
              "hybrid": "Hybrid", "partial": "Partial"}


def slug(entry):
    """The path segment for an eclipse: 2027-08-02."""
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
    return (f"{TYPE_NAMES[entry['type']]} solar eclipse, "
            f"{long_date(entry['date'])}")


def description_for(entry):
    """One sentence of prose, and the numbers that make it worth reading."""
    kind = entry["type"]
    when = long_date(entry["date"])
    greatest = entry["greatest"]
    bits = []
    if kind == "partial":
        bits.append(f"A partial solar eclipse on {when}. The Moon's shadow "
                    f"misses the Earth, so there is no path of totality; the "
                    f"eclipse is deepest near {lat_lon(greatest['lat'], greatest['lon'])}")
    else:
        noun = "totality" if kind != "annular" else "annularity"
        longest = duration(entry.get("centralDurationS"))
        line = (f"A {kind} solar eclipse on {when}, with {noun} lasting up to "
                f"{longest}" if longest else
                f"A {kind} solar eclipse on {when}")
        if entry.get("pathWidthKm"):
            line += f" in a path {round(entry['pathWidthKm'])} km wide"
        bits.append(line)
    bits.append(f"greatest eclipse at {greatest['ut']} UT")
    bits.append(f"magnitude {entry['magnitude']:.3f}")
    bits.append(f"saros {entry['saros']}")
    return ". ".join([bits[0], ", ".join(bits[1:]).capitalize()]) + "."


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


def _facts_html(entry):
    """The same shape the script renders, so the swap on boot is invisible."""
    pairs = "".join(f"<dt>{html.escape(k)}</dt><dd>{html.escape(v)}</dd>"
                    for k, v in _rows(entry))
    return f'<dl class="facts">{pairs}</dl>'


def _prerender_html(entry):
    return (f'<div class="prerender">'
            f'<p>{html.escape(description_for(entry))}</p>'
            f'</div>')


def _head(entry, base_url):
    url = f"{base_url}/eclipse/{slug(entry)}/"
    image = f"{base_url}/preview/{entry['id']}.png"
    # A partial has no path, so it is not offered one in its own title.
    suffix = "where and when" if entry["type"] == "partial" else "path and times"
    title = f"{title_for(entry)} — {suffix}"
    desc = description_for(entry)
    return url, image, title, desc


def render_page(template, entry, base_url):
    """One eclipse page, from the site's own index.html."""
    url, image, title, desc = _head(entry, base_url)
    page = template

    page = re.sub(r"<title>.*?</title>",
                  f"<title>{html.escape(title)}</title>", page, count=1, flags=re.S)
    page = re.sub(r'<meta name="description" content="[^"]*">',
                  f'<meta name="description" content="{html.escape(desc, quote=True)}">',
                  page, count=1)
    page = re.sub(r'<link rel="canonical" href="[^"]*">',
                  f'<link rel="canonical" href="{url}">', page, count=1)
    page = re.sub(r'<meta property="og:url" content="[^"]*">',
                  f'<meta property="og:url" content="{url}">', page, count=1)
    page = re.sub(r'<meta property="og:title" content="[^"]*">',
                  f'<meta property="og:title" content="{html.escape(title, quote=True)}">',
                  page, count=1)
    page = re.sub(r'<meta property="og:description" content="[^"]*">',
                  f'<meta property="og:description" content="{html.escape(desc, quote=True)}">',
                  page, count=1)
    page = re.sub(r'<meta property="og:image" content="[^"]*">',
                  f'<meta property="og:image" content="{image}">', page, count=1)
    page = re.sub(r'<meta property="og:image:alt" content="[^"]*">',
                  f'<meta property="og:image:alt" content="'
                  f'{html.escape(title_for(entry), quote=True)}, drawn on a world map.">',
                  page, count=1)

    page = re.sub(r'<h1 class="sr-only">.*?</h1>',
                  f'<h1 class="sr-only">{html.escape(title_for(entry))}</h1>',
                  page, count=1, flags=re.S)

    # Into the panel the script fills in anyway, so what a crawler reads and
    # what the script later renders are the same thing in the same place.
    page = page.replace('<div id="facts"></div>',
                        f'<div id="facts">{_facts_html(entry)}</div>', 1)
    page = page.replace('<div class="details" id="info">',
                        f'<div class="details" id="info">{_prerender_html(entry)}', 1)
    return page


def render_list(entries, base_url):
    """The page that gives a crawler a route to all of them."""
    by_year = {}
    for e in entries:
        by_year.setdefault(e["date"][:4], []).append(e)
    blocks = []
    for year in sorted(by_year):
        links = "".join(
            f'<li><a href="/eclipse/{slug(e)}/">{html.escape(title_for(e))}</a></li>'
            for e in by_year[year])
        blocks.append(f'<h2><a href="/eclipse/{year}/">{year}</a></h2><ul>{links}</ul>')
    body = "".join(blocks)

    title = "Every solar eclipse, 1900 to 2100"
    desc = (f"A list of all {len(entries)} solar eclipses between "
            f"{entries[0]['date'][:4]} and {entries[-1]['date'][:4]}, each with "
            "its path, times and duration.")
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<link rel="canonical" href="{base_url}/eclipse/">
<link rel="stylesheet" href="/style.css">
</head>
<body class="listing">
<main>
<h1>{title}</h1>
<p>Every solar eclipse in the range, in date order. Each links to its path on
the map. <a href="/">Open the map</a>.</p>
{body}
</main>
</body>
</html>
"""


def render_year(year, entries, base_url):
    """A page for one year's eclipses.

    A search for "2027 eclipse" has several answers whenever a year holds more
    than one, and left to itself it is arbitrary which of them turns up. A page
    about the year is the honest answer to that question: it names them all,
    says which is which, and sends you to the one you meant.
    """
    listed = "".join(
        f'<li><a href="/eclipse/{slug(e)}/">{html.escape(title_for(e))}</a>'
        f'<span class="year__note">{html.escape(_summary(e))}</span></li>'
        for e in entries)
    kinds = ", ".join(f"{TYPE_NAMES[e['type']].lower()} on "
                      f"{long_date(e['date']).rsplit(' ', 1)[0]}" for e in entries)
    count = len(entries)
    # Only promise paths if any of them has one.
    central = any(e["type"] != "partial" for e in entries)
    offers = ("Paths, times and how much of the Sun is covered." if central
              else "Times, and how much of the Sun is covered.")
    desc = (f"{count} solar eclipse{'s' if count != 1 else ''} in {year}: "
            f"{kinds}. {offers}")
    title = f"Solar eclipses in {year}"
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{html.escape(desc, quote=True)}">
<link rel="canonical" href="{base_url}/eclipse/{year}/">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{html.escape(desc, quote=True)}">
<meta property="og:image" content="{base_url}/preview/{entries[0]['id']}.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/style.css">
</head>
<body class="listing">
<main>
<h1>{title}</h1>
<p>{html.escape(desc)}</p>
<ul class="year">{listed}</ul>
<p><a href="/eclipse/">Every eclipse, 1900 to 2100</a> &middot; <a href="/">Open the map</a></p>
</main>
</body>
</html>
"""


def _summary(entry):
    longest = duration(entry.get("centralDurationS"))
    if entry["type"] == "partial":
        return "no path of totality; deepest near " + lat_lon(
            entry["greatest"]["lat"], entry["greatest"]["lon"])
    noun = "annularity" if entry["type"] == "annular" else "totality"
    return f"up to {longest} of {noun}" if longest else "central eclipse"


def render_sitemap(entries, base_url):
    years = sorted({e["date"][:4] for e in entries})
    urls = [f"{base_url}/", f"{base_url}/eclipse/"]
    urls += [f"{base_url}/eclipse/{y}/" for y in years]
    urls += [f"{base_url}/eclipse/{slug(e)}/" for e in entries]
    body = "".join(f"<url><loc>{u}</loc></url>" for u in urls)
    return ('<?xml version="1.0" encoding="UTF-8"?>'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            f"{body}</urlset>")


def write_all(entries, public_dir, base_url):
    """Every eclipse page, the list, and the sitemap. Returns how many."""
    with open(os.path.join(public_dir, "index.html")) as fh:
        template = fh.read()

    for entry in entries:
        directory = os.path.join(public_dir, "eclipse", slug(entry))
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, "index.html"), "w") as fh:
            fh.write(render_page(template, entry, base_url))

    by_year = {}
    for entry in entries:
        by_year.setdefault(entry["date"][:4], []).append(entry)
    for year, group in by_year.items():
        directory = os.path.join(public_dir, "eclipse", year)
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, "index.html"), "w") as fh:
            fh.write(render_year(year, group, base_url))

    listing = os.path.join(public_dir, "eclipse")
    os.makedirs(listing, exist_ok=True)
    with open(os.path.join(listing, "index.html"), "w") as fh:
        fh.write(render_list(entries, base_url))
    with open(os.path.join(public_dir, "sitemap.xml"), "w") as fh:
        fh.write(render_sitemap(entries, base_url))
    return len(entries) + len(by_year) + 2


# Run on its own, the pages are rebuilt from an index that already exists. That
# is what lets the container build them in a separate stage: generating them
# costs a tenth of a second, so it can depend on the site's own markup without
# dragging the eleven minutes of eclipse geometry along behind it.
if __name__ == "__main__":
    import config

    public = os.path.dirname(config.OUTPUT_DIR)
    with open(os.path.join(config.OUTPUT_DIR, "index.json")) as fh:
        index = json.load(fh)
    written = write_all(index["eclipses"], public, config.BASE_URL)
    print(f"wrote {written} pages under {public}/eclipse/")
