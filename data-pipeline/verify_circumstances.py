"""Check local circumstances against NASA's tabulated central-line durations.

For each instant NASA tabulates, take its central-line coordinates, ask what an
observer standing there would see, and compare the totality/annularity we get
with the duration NASA prints alongside.
"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import besselian as B
import circumstances as C
import config
import geometry as G
from nasa_tables import parse_path_table

CASES = [("19010518", "path_19010518.html", None),
         ("19050830", "path_19050830.html", None),
         ("20170821", "path_20170821.html", 68.35),
         ("20240408", "path_20240408.html", 71.15),
         ("20260812", "path_20260812.html", 72.03)]


def main():
    cat = {e.key: e for e, _ in B.load_catalog()}
    print(f"{'eclipse':>10} {'n':>4} {'median |d|':>11} {'p95':>8} {'max':>8}   "
          f"{'max |d| in UT of maximum':>25}")
    print("-" * 74)
    for key, fname, dT in CASES:
        el = cat[key]
        if dT:
            el.dt = dT
        rows = [r for r in parse_path_table(os.path.join(B.CACHE, "nasa", fname))
                if r["central"] and r["duration_s"]]
        window = G.contact_times(el, True)
        errs, terrs = [], []
        for r in rows:
            lat, lon = r["central"]
            res = C.local_circumstances(el, lat, lon, window=window)
            if not res or "duration_s" not in res:
                continue
            errs.append(res["duration_s"] - r["duration_s"])
            # the tabulated instant should also be the moment of maximum there
            terrs.append(abs((C.to_ut(el, res["t_max"]) - r["ut"] + 12) % 24 - 12) * 3600)
        errs = np.abs(errs)
        print(f"{key:>10} {len(errs):>4} {np.median(errs):>10.2f}s {np.percentile(errs,95):>7.2f}s "
              f"{errs.max():>7.2f}s   {max(terrs):>24.1f}s")


def compare_js(per_eclipse=70, seed=7):
    """Check the browser's port against this implementation, point for point.

    The site cannot import the Python, so the same calculation exists twice.  The
    only way that stays true is to run both over the same places and diff them.
    """
    import json
    import random
    import subprocess

    here = os.path.dirname(os.path.abspath(__file__))
    helper = os.path.join(here, "_js_circ.mjs")
    module = os.path.join(here, os.pardir, "public", "circumstances.js")

    cat = {e.key: e for e, _ in B.load_catalog()}
    rng = random.Random(seed)
    print(f"\n{'eclipse':>10} {'n':>4} {'max dt':>10} {'max dmag':>11} "
          f"{'max dobsc':>11} {'max ddur':>11} {'max dC1':>11}")
    print("-" * 74)
    for key, _, _ in CASES:
        geojson = os.path.join(config.OUTPUT_DIR, f"{key}.geojson")
        if not os.path.exists(geojson):
            print(f"{key:>10}  no built data -- run build.py first")
            continue
        el = cat[key]
        window = G.contact_times(el, True)

        points = []
        while len(points) < per_eclipse:
            lat, lon = rng.uniform(-85, 85), rng.uniform(-180, 180)
            if C.local_circumstances(el, lat, lon, window=window):
                points.append([round(lat, 4), round(lon, 4)])

        got = json.loads(subprocess.run(
            ["node", helper, module, geojson, json.dumps(points)],
            capture_output=True, text=True, check=True).stdout)

        worst = [0.0] * 5
        for (lat, lon), js in zip(points, got):
            ours = C.local_circumstances(el, lat, lon, window=window)
            if ours is None or js is None:
                continue
            worst[0] = max(worst[0], abs(C.to_ut(el, ours["t_max"]) - js["ut"]) * 3600)
            worst[1] = max(worst[1], abs(ours["magnitude"] - js["magnitude"]))
            worst[2] = max(worst[2], abs(ours["obscuration"] - js["obscuration"]))
            if ours.get("duration_s") and js["duration"]:
                worst[3] = max(worst[3], abs(ours["duration_s"] - js["duration"]))
            if ours.get("c1") and js["c1"]:
                worst[4] = max(worst[4], abs(C.to_ut(el, ours["c1"]) - js["c1"]) * 3600)
        print(f"{key:>10} {len(points):>4} {worst[0]:>9.2e}s {worst[1]:>11.2e} "
              f"{worst[2]:>11.2e} {worst[3]:>10.2e}s {worst[4]:>10.2e}s")


if __name__ == "__main__":
    main()
    if "--js" in sys.argv:
        compare_js()
