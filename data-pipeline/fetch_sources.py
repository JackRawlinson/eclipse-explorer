"""Fetch the source data the pipeline needs into cache/.

Run once; everything after that works offline.

Two kinds of file come down:

* the bulk extract of the canon's Besselian elements, which is the actual input
  to the pipeline;
* a handful of NASA pages used *only* to check our arithmetic -- their published
  path tables, their own elements array for one eclipse, and the catalogue we
  check saros numbers against.  No coordinates from these are ever shipped.

Requests are spaced out and identified; be a good guest on someone else's server.
"""

from __future__ import annotations

import os
import sys
import time
import urllib.request

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
UA = "eclipse-mapper/1.0 (static eclipse map build; contact: see README)"
PAUSE = 2.0

CANON = "https://raw.githubusercontent.com/gmiller123456/" \
        "FiveMillenniumCanonOfSolarEclipses-Besselian-Elements/master/"

SOURCES = [
    (CANON + "FiveMillenniumCanonOfSolarEclipsesExtra.json", "extra.json"),
    (CANON + "FiveMillenniumCanonOfSolarEclipses.csv", "bessel.csv"),
]

# Verification material.  The path tables span the Delta T range on purpose: the
# 1901 and 1905 eclipses predate the revision NASA applied to its modern pages,
# so they test the reduction with nothing fitted.
NASA = [
    ("https://eclipse.gsfc.nasa.gov/SEsearch/SEsearchmap.php?Ecl=20240408",
     "nasa/elements_20240408.html"),
    ("https://eclipse.gsfc.nasa.gov/SEpath/SEpath1901/SE1901May18Tpath.html",
     "nasa/path_19010518.html"),
    ("https://eclipse.gsfc.nasa.gov/SEpath/SEpath1901/SE1905Aug30Tpath.html",
     "nasa/path_19050830.html"),
    ("https://eclipse.gsfc.nasa.gov/SEpath/SEpath2001/SE2017Aug21Tpath.html",
     "nasa/path_20170821.html"),
    ("https://eclipse.gsfc.nasa.gov/SEpath/SEpath2001/SE2024Apr08Tpath.html",
     "nasa/path_20240408.html"),
    ("https://eclipse.gsfc.nasa.gov/SEpath/SEpath2001/SE2026Aug12Tpath.html",
     "nasa/path_20260812.html"),
    ("https://eclipse.gsfc.nasa.gov/SEcat5/SE1901-2000.html", "nasa/cat_1901-2000.html"),
    ("https://eclipse.gsfc.nasa.gov/SEcat5/SE2001-2100.html", "nasa/cat_2001-2100.html"),
]


def fetch(url, rel, force=False):
    dest = os.path.join(CACHE, rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest) and not force:
        print(f"  have  {rel}")
        return False
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as response:
        data = response.read()
    with open(dest, "wb") as fh:
        fh.write(data)
    print(f"  got   {rel}  ({len(data) / 1024:.0f} KB)")
    return True


def main(force=False):
    print("source data (input to the pipeline):")
    for url, rel in SOURCES:
        if fetch(url, rel, force):
            time.sleep(PAUSE)
    print("\nverification material (checked against, never shipped):")
    for url, rel in NASA:
        if fetch(url, rel, force):
            time.sleep(PAUSE)
    print("\ncache ready")


if __name__ == "__main__":
    main("--force" in sys.argv)
