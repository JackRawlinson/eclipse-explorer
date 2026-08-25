"""Parser for NASA's published solar-eclipse path tables (SEpath/*.html).

Used only to verify our own computations; no path coordinates from these
tables are shipped with the site.
"""

from __future__ import annotations

import html
import re

_ROW = re.compile(r"^\s*(\d{2}):(\d{2})\s+(.*)$")
_TOK = re.compile(r"(\d{1,3})\s+(\d{1,2}\.\d)([NSEW])|(-)")


def _strip_html(text: str) -> str:
    text = re.sub(r"<script.*?</script>", "", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text)


def _tokens(rest: str, want: int = 6):
    """Return ``want`` values (float degrees or None) from the coordinate columns."""
    vals = []
    for m in _TOK.finditer(rest):
        if len(vals) == want:
            break
        if m.group(4) == "-":
            vals.append(None)
            continue
        deg, minutes, hemi = int(m.group(1)), float(m.group(2)), m.group(3)
        v = deg + minutes / 60.0
        if hemi in ("S", "W"):
            v = -v
        vals.append(v)
    if len(vals) != want:
        return None
    return vals


def parse_path_table(path: str):
    """Yield dicts of NASA's tabulated path, one per time step.

    Keys: ``ut`` (hours), ``north``/``south``/``central`` as (lat, lon) or None,
    ``width_km``, ``duration_s``.
    """
    text = _strip_html(open(path, encoding="utf-8", errors="replace").read())
    rows = []
    for line in text.splitlines():
        m = _ROW.match(line)
        if not m:
            continue
        hh, mm, rest = int(m.group(1)), int(m.group(2)), m.group(3)
        if hh > 23:
            continue
        vals = _tokens(rest)
        if vals is None:
            continue
        nlat, nlon, slat, slon, clat, clon = vals

        tail = rest[_nth_end(rest, 6):]
        width = _first_int(re.findall(r"\s(\d{1,4})\s+\d{2}m", tail))
        dur = re.search(r"(\d{2})m(\d{2}(?:\.\d)?)s", tail)
        rows.append({
            "ut": hh + mm / 60.0,
            "north": (nlat, nlon) if nlat is not None and nlon is not None else None,
            "south": (slat, slon) if slat is not None and slon is not None else None,
            "central": (clat, clon) if clat is not None and clon is not None else None,
            "width_km": width,
            "duration_s": (int(dur.group(1)) * 60 + float(dur.group(2))) if dur else None,
        })
    return rows


def _nth_end(rest: str, n: int) -> int:
    for i, m in enumerate(_TOK.finditer(rest), start=1):
        if i == n:
            return m.end()
    return len(rest)


def _first_int(matches):
    return int(matches[0]) if matches else None
