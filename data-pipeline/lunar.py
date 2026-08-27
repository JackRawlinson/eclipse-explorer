"""The lunar eclipse catalogue: fetched from NASA, parsed, and shipped small.

A lunar eclipse has no path -- the whole night side of the Earth watches the
same event at the same instants -- so unlike the solar side there is no
geometry pipeline here at all. Everything the site needs fits in one JSON:
the contact times, the magnitudes, and the sub-lunar point at greatest
eclipse, which NASA publishes directly ("Greatest in Zenith"). The app draws
visibility from those alone.

Approximations, stated plainly:

* Contacts are taken as symmetric about greatest eclipse (half the published
  duration each side). The true asymmetry is under a minute or two, smaller
  than the softness of a visibility edge (refraction and parallax are of the
  same order).
* Between contacts the sub-lunar point is drifted west at the mean rate of
  14.49 degrees per hour (Earth's rotation less the Moon's eastward motion),
  holding latitude. Over the +/-3 h of a long eclipse that errs by well under
  a degree.

Penumbral eclipses (types N and Nx) are dropped: to the eye they are nearly
nothing, and listing them would promise a sight that does not come.

Source: Espenak and Meeus, *Five Millennium Canon of Lunar Eclipses*, via the
century catalogue pages. Fetched once into cache/nasa/ and parsed offline.
"""

import json
import os
import re
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache", "nasa")
PUBLIC_DATA = os.path.join(os.path.dirname(HERE), "public", "data")
UA = "eclipse-mapper/1.0 (static eclipse map build; contact: see README)"

PAGES = [  # every catalogue year that can fall in 1900-2100
    ("https://eclipse.gsfc.nasa.gov/LEcat5/LE1801-1900.html", "LE1801-1900.html"),
    ("https://eclipse.gsfc.nasa.gov/LEcat5/LE1901-2000.html", "LE1901-2000.html"),
    ("https://eclipse.gsfc.nasa.gov/LEcat5/LE2001-2100.html", "LE2001-2100.html"),
]

MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}

# 05421  1901 May 03  18:30:38   -1  -1221  110  Nx  -t  -1.0101 ... with the
# catalogue number and saros wrapped in links. Stripped of tags first, the
# columns split cleanly on whitespace.
ROW = re.compile(
    r"^(?P<cat>\d{5})\s+(?P<year>\d{4})\s+(?P<mon>[A-Z][a-z]{2})\s+(?P<day>\d{2})\s+"
    r"(?P<td>\d{2}:\d{2}:\d{2})\s+(?P<dt>-?\d+)\s+(?P<luna>-?\d+)\s+(?P<saros>\d+)\s+"
    r"(?P<type>[NPT][a-z+\-]?)\s+(?P<qse>\S+)\s+(?P<gamma>-?\d+\.\d+)\s+"
    r"(?P<pmag>-?\d+\.\d+)\s+(?P<umag>-?\d+\.\d+)\s+"
    r"(?P<dpen>[\d.]+|-)\s+(?P<dpar>[\d.]+|-)\s+(?P<dtot>[\d.]+|-)\s+"
    r"(?P<zlat>\d+[NS])\s+(?P<zlon>\d+[EW])\s*$")


def _fetch(url, name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if os.path.exists(path):
        return path
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req) as resp, open(path, "wb") as fh:
        fh.write(resp.read())
    time.sleep(2.0)
    return path


def _hours(hms):
    h, m, s = (int(p) for p in hms.split(":"))
    return h + m / 60 + s / 3600


def _signed(text):
    value = float(text[:-1])
    return -value if text[-1] in "SW" else value


def parse():
    rows = []
    for url, name in PAGES:
        with open(_fetch(url, name)) as fh:
            raw = fh.read()
        text = re.sub(r"<[^>]+>", "", raw)
        for line in text.splitlines():
            m = ROW.match(line.strip())
            if not m:
                continue
            year = int(m["year"])
            if not 1900 <= year <= 2100:
                continue
            kind = m["type"]
            if kind.startswith("N"):
                continue                     # penumbral: nothing to see
            date = f"{year:04d}-{MONTHS[m['mon']]:02d}-{int(m['day']):02d}"
            greatest_ut = _hours(m["td"]) - float(m["dt"]) / 3600
            entry = {
                "id": date.replace("-", ""),
                "date": date,
                "type": "total" if kind.startswith("T") else "partial",
                "saros": int(m["saros"]),
                "gamma": float(m["gamma"]),
                "penMag": float(m["pmag"]),
                "umbralMag": float(m["umag"]),
                # UT hours of greatest eclipse; may sit outside 0-24, meaning
                # the previous or next civil day -- the date stays the TD date.
                "greatestUT": round(greatest_ut, 4),
                "zenith": {"lat": _signed(m["zlat"]), "lon": _signed(m["zlon"])},
            }
            for key, col in (("penM", "dpen"), ("parM", "dpar"), ("totM", "dtot")):
                if m[col] != "-":
                    entry[key] = float(m[col])
            rows.append(entry)
    rows.sort(key=lambda r: r["date"])
    return rows


def write(rows):
    os.makedirs(PUBLIC_DATA, exist_ok=True)
    out = os.path.join(PUBLIC_DATA, "lunar.json")
    with open(out, "w") as fh:
        json.dump({"count": len(rows), "eclipses": rows}, fh,
                  separators=(",", ":"))
    return out


if __name__ == "__main__":
    rows = parse()
    out = write(rows)
    total = sum(1 for r in rows if r["type"] == "total")
    print(f"{len(rows)} lunar eclipses 1900-2100 "
          f"({total} total, {len(rows) - total} partial) -> {out}")
