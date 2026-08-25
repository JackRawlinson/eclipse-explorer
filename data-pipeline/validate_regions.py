"""Cross-check the analytic region boundaries against a brute-force rasterisation.

The analytic boundary is traced from envelope and limb-crossing curves.  This
script instead asks, for every point on a lat/lon grid, whether the shadow ever
actually reaches it -- and compares the two answers.  Disagreements should occur
only in cells the boundary passes through.
"""

import sys

import numpy as np
import shapely

import besselian as B
import geometry as G

SAMPLES = [
    ("20170821", "total, mid-latitude"),
    ("20240408", "total, crosses N America"),
    ("20260812", "total, high latitude"),
    ("20210610", "annular, over the North Pole"),
    ("20230420", "hybrid"),
    ("20241002", "annular, southern ocean"),
    ("20250329", "partial only"),
    ("19620205", "total, antimeridian"),
]


def truth_mask(el, lat, lon, penumbral, n_t=1500, chunk=4000):
    window = G.contact_times(el, penumbral)
    if window is None:
        return np.zeros(lat.shape, bool)
    t = np.linspace(window[0], window[1], n_t)
    st = el.state(t)
    l0 = st.l1 if penumbral else st.l2
    tanf = st.tanf1 if penumbral else st.tanf2
    out = np.zeros(lat.size, bool)
    for i in range(0, lat.size, chunk):
        sl = slice(i, i + chunk)
        xi, eta, zeta = st.observer(lat.ravel()[sl, None], lon.ravel()[sl, None])
        radius = np.abs(l0 - zeta * tanf)
        hit = (zeta >= 0.0) & ((xi - st.x) ** 2 + (eta - st.y) ** 2 <= radius ** 2)
        out[sl] = hit.any(axis=1)
    return out.reshape(lat.shape)


def analytic_region(el, extra, penumbral, n_steps=900, step=1.0):
    import raster
    north_in, south_in = raster.poles_inside(el, penumbral)
    if penumbral:
        parts = []
        for lat, lon in raster.region_rings(el, True, step=step):
            mp = G.ring_to_multipolygon(lat, lon, north_in, south_in)
            if mp is not None and not mp.is_empty:
                parts.append(mp)
        if not parts:
            return None
        from shapely.ops import unary_union
        return unary_union(parts)
    ring = G.swept_ring(el, penumbral, n_steps)
    if ring is None:
        return None
    return G.ring_to_multipolygon(ring[0], ring[1], north_in, south_in)


def sweep(n, seed=11, step=1.0):
    """Same check over a random spread of eclipses across the shipped range."""
    import random
    cat = [(e, x) for e, x in B.load_catalog() if 1900 <= e.year <= 2100]
    random.Random(seed).shuffle(cat)
    picked = cat[:n]
    globals()["SAMPLES"] = [(e.key, f"{x['eclipse_type']} g={x['gamma']:+.3f}")
                            for e, x in picked]
    main(step)


def main(step=0.5):
    cat = {e.key: (e, x) for e, x in B.load_catalog()}
    lats = np.arange(-90 + step / 2, 90, step)
    lons = np.arange(-180 + step / 2, 180, step)
    LON, LAT = np.meshgrid(lons, lats)
    cell_km = step * 111.195

    print(f"grid {step} deg ({LAT.size} points), agreement of analytic vs rasterised region\n")
    hdr = (f"{'eclipse':>10} {'kind':<28} {'region':<9} {'grid pts':>9} "
           f"{'disagree':>9} {'of edge cells':>14} {'wrong':>10}")
    print(hdr); print("-" * len(hdr))
    for key, label in SAMPLES:
        if key not in cat:
            print(f"{key:>10} MISSING"); continue
        el, extra = cat[key]
        for penumbral in (True, False):
            name = "penumbra" if penumbral else "umbra"
            poly = analytic_region(el, extra, penumbral)
            truth = truth_mask(el, LAT, LON, penumbral)
            if poly is None:
                status = "n/a (no umbral path)" if not truth.any() else "MISSED A REAL PATH"
                print(f"{key:>10} {label:<28} {name:<9} {truth.sum():>9} {status}")
                continue
            got = shapely.contains_xy(poly, LON.ravel(), LAT.ravel()).reshape(LAT.shape)
            bad = got != truth
            # Neither side is authoritative at this resolution, so re-judge every
            # disagreement with a scan far denser than the sweep can afford.
            wrong = 0
            if bad.any():
                bi, bj = np.nonzero(bad)
                verdict = truth_mask(el, LAT[bi, bj], LON[bi, bj], penumbral,
                                     n_t=40000, chunk=40)
                wrong = int((verdict != got[bi, bj]).sum())
            edge_cells = max(1.0, poly.length / step)
            print(f"{key:>10} {label:<28} {name:<9} {truth.sum():>9} {bad.sum():>9} "
                  f"{100 * bad.sum() / edge_cells:>13.1f}% {wrong:>10}")


if __name__ == "__main__":
    if "--sweep" in sys.argv:
        sweep(int(sys.argv[sys.argv.index("--sweep") + 1]))
    else:
        main(float(sys.argv[1]) if len(sys.argv) > 1 else 0.5)
