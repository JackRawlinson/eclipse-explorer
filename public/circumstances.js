// What one place on the ground sees: contact times, magnitude, obscuration.
//
// A port of data-pipeline/circumstances.py, which is checked against NASA's
// published central-line durations; verify_circumstances.py --js checks this
// file against that one. Keep the two in step.

const E2 = 0.00669437999014;
const SQRT1ME2 = Math.sqrt(1 - E2);
const SIDEREAL = 1.00273791;
const DEG = Math.PI / 180;
// Matches HORIZON_TOL in the Python: the deepest moment is often sunrise itself,
// and a bare zeta >= 0 test would turn on how the solve happened to round.
// Web Mercator runs to infinity at the poles, so anything meant to reach one
// stops at the edge of the projection instead. The gap left behind is the last
// five degrees of latitude, which that projection cannot show in any case.
const POLE_LAT = 85.051129;
const HORIZON_TOL = 1e-9;

const poly = (c, t) => {
  let v = 0;
  for (let i = c.length - 1; i >= 0; i--) v = v * t + c[i];
  return v;
};

/** d/dt of a polynomial given by ascending coefficients. */
const deriv = (c, t) => {
  let v = 0;
  for (let i = c.length - 1; i >= 1; i--) v = v * t + i * c[i];
  return v;
};

function stateAt(el, t) {
  return {
    x: poly(el.x, t),
    y: poly(el.y, t),
    d: poly(el.d, t) * DEG,
    mu: poly(el.mu, t) * DEG,
    l1: poly(el.l1, t),
    l2: poly(el.l2, t),
  };
}

// Observer in the fundamental plane. theta = lambda + mu, less the rotation
// standing between the ephemeris meridian and Greenwich.
function observer(el, st, lat, lon) {
  const phi = lat * DEG;
  const u = Math.atan2(SQRT1ME2 * Math.sin(phi), Math.cos(phi));
  const S = SQRT1ME2 * Math.sin(u);
  const C = Math.cos(u);
  const theta = lon * DEG + st.mu - SIDEREAL * el.deltaT * 15 / 3600 * DEG;
  return {
    xi: C * Math.sin(theta),
    eta: S * Math.cos(st.d) - C * Math.cos(theta) * Math.sin(st.d),
    zeta: S * Math.sin(st.d) + C * Math.cos(theta) * Math.cos(st.d),
  };
}

function sample(el, lat, lon, t) {
  const st = stateAt(el, t);
  const o = observer(el, st, lat, lon);
  const sep = Math.hypot(o.xi - st.x, o.eta - st.y);
  return {
    sep,
    zeta: o.zeta,
    l1p: st.l1 - o.zeta * el.tanf1,
    l2p: st.l2 - o.zeta * el.tanf2,
  };
}

const reachAt = (el, lat, lon, t) => {
  const s = sample(el, lat, lon, t);
  return s.zeta >= -HORIZON_TOL ? s.l1p - s.sep : -1e6;
};

// Distance from the axis less the shadow radius: zero at a contact.
const gapAt = (el, lat, lon, t, umbral) => {
  const s = sample(el, lat, lon, t);
  return s.sep - (umbral ? Math.abs(s.l2p) : s.l1p);
};

// Sunrise or sunset between two bracketing instants, by Newton on zeta. The
// visibility cut puts a step in the reach curve, and no search finds a maximum
// sitting on a step; solving for the step keeps the obscuration right for
// somewhere watching the eclipse come up over the horizon.
function horizonCrossing(el, lat, lon, tLo, tHi, steps = 4) {
  const zLo = sample(el, lat, lon, tLo).zeta;
  const zHi = sample(el, lat, lon, tHi).zeta;
  const span = zHi - zLo || 1;
  const clamp = (t) => Math.min(tHi, Math.max(tLo, t));
  let t = clamp(tLo - zLo * (tHi - tLo) / span);
  for (let i = 0; i < steps; i++) {
    const st = stateAt(el, t);
    const o = observer(el, st, lat, lon);
    const dd = deriv(el.d, t) * DEG;
    const dmu = deriv(el.mu, t) * DEG;
    const rate = (dd * o.eta - dmu * o.xi * Math.cos(st.d)) || 1e-9;
    t = clamp(t - o.zeta / rate);
  }
  return t;
}

function bisectContact(el, lat, lon, tIn, tOut, umbral) {
  for (let i = 0; i < 60; i++) {
    const mid = (tIn + tOut) / 2;
    if (gapAt(el, lat, lon, mid, umbral) < 0) tIn = mid;
    else tOut = mid;
  }
  return (tIn + tOut) / 2;
}

/**
 * The inverse of `observer`: a point on the fundamental plane, dropped onto the
 * near face of the ellipsoid. Returns null where it falls outside the disc.
 */
export function surfacePoint(el, t, xi, eta) {
  const st = stateAt(el, t);
  const sinD = Math.sin(st.d);
  const cosD = Math.cos(st.d);
  const rho1 = Math.sqrt(1 - E2 * cosD * cosD);
  const rho2 = Math.sqrt(1 - E2 * sinD * sinD);
  const sd1 = sinD / rho1;
  const cd1 = SQRT1ME2 * cosD / rho1;

  const eta1 = eta / rho1;
  const z1sq = 1 - xi * xi - eta1 * eta1;
  if (z1sq < -1e-12) return null;               // off the edge of the Earth
  const zeta1 = Math.sqrt(Math.max(0, z1sq));   // the tolerance admits the limb itself

  const sinU = eta1 * cd1 + zeta1 * sd1;
  const cosUcosTheta = zeta1 * cd1 - eta1 * sd1;
  const cosU = Math.sqrt(Math.max(0, 1 - sinU * sinU));

  const theta = Math.atan2(xi, cosUcosTheta) / DEG;
  let lon = theta - st.mu / DEG + SIDEREAL * el.deltaT * 15 / 3600;
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  const lat = Math.atan2(sinU, SQRT1ME2 * cosU) / DEG;

  const s12 = E2 * sinD * cosD / (rho1 * rho2);
  const c12 = SQRT1ME2 / (rho1 * rho2);
  const zeta = rho2 * (zeta1 * c12 - eta1 * s12);
  return { lat, lon, zeta };
}

/**
 * A ring on the ground at one instant: a circle about the shadow axis on the
 * fundamental plane, dropped onto the ellipsoid. `radiusFor` gives the circle's
 * radius as a function of the height of the ground point, because both the
 * shadow cones narrow with height -- so radius and landing point are solved
 * together rather than one before the other.
 *
 * Most of the time part of the ring runs off the edge of the Earth, and what
 * lands is closed along the limb, exactly as the static bands are. Returns null
 * only when none of the ring reaches the ground at all, and otherwise
 * `{ ring, limb }`, where `limb` flags the vertices that came from the Earth's
 * edge rather than from the contour -- those sit wherever the edge is, not at
 * the level the ring stands for.
 */
function groundRing(el, t, radiusFor, steps) {
  const st = stateAt(el, t);
  const cosD = Math.cos(st.d);
  const rho1 = Math.sqrt(1 - E2 * cosD * cosD);
  const step = (2 * Math.PI) / steps;

  // One sample of the ring, radius and landing point solved together.
  const at = (angle) => {
    let radius = radiusFor(0);
    let xi = 0;
    let eta = 0;
    let point = null;
    for (let pass = 0; pass < 4; pass++) {
      xi = st.x + radius * Math.cos(angle);
      eta = st.y + radius * Math.sin(angle);
      point = surfacePoint(el, t, xi, eta);
      if (!point) break;
      radius = radiusFor(point.zeta);
    }
    return { xi, eta, point };
  };

  // The Earth's limb is the unit circle on the flattened fundamental plane, so
  // a point on it is just an angle. There zeta is zero, which fixes the radius.
  const limb = (phi) => surfacePoint(el, t, Math.cos(phi), rho1 * Math.sin(phi));
  const limbInside = (phi) => {
    const r = radiusFor(0);
    const dx = Math.cos(phi) - st.x;
    const dy = rho1 * Math.sin(phi) - st.y;
    return dx * dx + dy * dy < r * r;
  };

  /** The angle on the limb where the ring leaves the disc, by bisection. */
  const crossing = (angleIn, angleOut) => {
    let a = angleIn;
    let b = angleOut;
    for (let i = 0; i < 24; i++) {
      const mid = (a + b) / 2;
      if (at(mid).point) a = mid;
      else b = mid;
    }
    const p = at(a);
    return Math.atan2(p.eta / rho1, p.xi);
  };

  /** The stretch of limb joining an exit back to an entry, inside the ring. */
  const arc = (from, to) => {
    let sweep = to - from;
    while (sweep <= 0) sweep += 2 * Math.PI;
    if (!limbInside(from + sweep / 2)) sweep -= 2 * Math.PI;
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 90)));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const p = limb(from + (sweep * i) / n);
      if (p) out.push([p.lon, p.lat]);
    }
    return out;
  };

  // How far apart in longitude neighbouring points may sit before the curve
  // between them is resolved further. Sampling is even in angle about the
  // shadow axis, which near a pole can carry the ground point most of the way
  // round the world in a single step; joined directly that draws a chord across
  // the top of the map instead of the path round it.
  const LON_STEP = 20;
  const REFINE = 6;
  const dlon = (a, b) => {
    let d = b - a;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
  };
  const refine = (angA, pA, angB, pB, depth, ring, limb) => {
    if (depth === 0 || Math.abs(dlon(pA.lon, pB.lon)) < LON_STEP) return;
    const mid = (angA + angB) / 2;
    const pM = at(mid).point;
    if (!pM) return;
    refine(angA, pA, mid, pM, depth - 1, ring, limb);
    ring.push([pM.lon, pM.lat]);
    limb.push(false);
    refine(mid, pM, angB, pB, depth - 1, ring, limb);
  };

  const samples = [];
  for (let i = 0; i < steps; i++) samples.push(at(i * step));
  const inside = samples.map((s) => s.point !== null);

  /**
   * Close the ring, in a longitude frame that runs continuously rather than
   * jumping at the antimeridian -- drawn raw, a ring straddling the date line
   * doubles back and stripes the whole world.
   */
  const close = (ring, limb) => {
    if (ring.length < 4) return null;
    for (let i = 1; i < ring.length; i++) {
      const step = ring[i][0] - ring[i - 1][0];
      if (step > 180) ring[i][0] -= 360;
      else if (step < -180) ring[i][0] += 360;
    }
    ring.push([ring[0][0], ring[0][1]]);
    limb.push(limb[0]);
    return { ring, limb };
  };

  if (inside.every(Boolean)) {
    const ring = [];
    const limb = [];
    for (let i = 0; i < steps; i++) {
      ring.push([samples[i].point.lon, samples[i].point.lat]);
      limb.push(false);
      const j = (i + 1) % steps;
      refine(i * step, samples[i].point, i * step + step, samples[j].point,
             REFINE, ring, limb);
    }
    return close(ring, limb);
  }

  if (!inside.some(Boolean)) {
    // Either the ring misses the Earth, or it swallows the whole visible face.
    const middle = surfacePoint(el, t, 0, 0);
    if (!middle) return null;
    const r = radiusFor(middle.zeta);
    if (st.x * st.x + st.y * st.y >= r * r) return null;
    const whole = arc(0, 2 * Math.PI).slice(0, -1);
    return close(whole, whole.map(() => true));
  }

  // Walk from an entry, so the ring is built in one pass and closes on itself.
  let start = 0;
  for (let i = 0; i < steps; i++) {
    if (inside[i] && !inside[(i + steps - 1) % steps]) { start = i; break; }
  }
  const ring = [];
  const limbFlag = [];
  let exit = null;
  for (let k = 0; k < steps; k++) {
    const i = (start + k) % steps;
    const j = (start + k + 1) % steps;
    if (inside[i]) {
      ring.push([samples[i].point.lon, samples[i].point.lat]);
      limbFlag.push(false);
      if (inside[j]) {
        refine(i * step, samples[i].point, i * step + step, samples[j].point,
               REFINE, ring, limbFlag);
      } else exit = crossing(i * step, i * step + step);
    } else if (inside[j] && exit !== null) {
      const along = arc(exit, crossing(j * step, j * step - step));
      ring.push(...along);
      for (const _ of along) limbFlag.push(true);
      exit = null;
    }
  }
  return close(ring, limbFlag);
}

/** Where the umbra is standing at one instant, and its centre. */
export function shadowOutline(el, t, steps = 72) {
  const st = stateAt(el, t);
  const centre = surfacePoint(el, t, st.x, st.y);
  const shape = groundRing(el, t, (zeta) => Math.abs(st.l2 - zeta * el.tanf2), steps);
  return { centre, ring: shape ? shape.ring : null };
}

/**
 * The night side at one instant, as a polygon rather than a shaded raster, so
 * that its edge is an edge. Read one latitude per longitude off zeta = 0, then
 * close along whichever pole is in darkness: with the Sun north of the equator
 * the south pole is the one in night, and the other way round.
 *
 * Returns null within a whisker of an equinox, where the terminator runs
 * through both poles and there is no cap to close against.
 */
export function nightPolygon(el, t, steps = 360, cap = POLE_LAT) {
  const st = stateAt(el, t);
  const sinD = Math.sin(st.d);
  const cosD = Math.cos(st.d);
  if (Math.abs(sinD) < 1e-3) return null;
  const rot = SIDEREAL * el.deltaT * 15 / 3600 * DEG;
  const edge = sinD > 0 ? -cap : cap;
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const lon = -180 + (360 * i) / steps;
    const theta = lon * DEG + st.mu - rot;
    // zeta = 0 solved for the parametric latitude, then flattened to geodetic
    const lat = Math.atan(-Math.cos(theta) * cosD / ((1 - E2) * sinD)) / DEG;
    ring.push([lon, Math.max(-cap, Math.min(cap, lat))]);
  }
  ring.push([180, edge], [-180, edge], ring[0]);
  return [ring];
}

/**
 * The day/night line at one instant. The Sun sits on the horizon exactly where
 * zeta is zero, which on the flattened fundamental plane is the unit circle --
 * the same curve the rings are clipped against, read as a curve in its own
 * right. Split at the antimeridian, since a line drawn straight across it wraps
 * the wrong way round the world.
 */
export function terminator(el, t, steps = 240) {
  const st = stateAt(el, t);
  const rho1 = Math.sqrt(1 - E2 * Math.cos(st.d) * Math.cos(st.d));
  const parts = [];
  let run = [];
  let last = null;
  for (let i = 0; i <= steps; i++) {
    const phi = (i / steps) * 2 * Math.PI;
    const p = surfacePoint(el, t, Math.cos(phi), rho1 * Math.sin(phi));
    if (!p) continue;
    if (last !== null && Math.abs(p.lon - last) > 180) {
      if (run.length > 1) parts.push(run);
      run = [];
    }
    run.push([p.lon, p.lat]);
    last = p.lon;
  }
  if (run.length > 1) parts.push(run);
  return parts.length ? parts : null;
}


/**
 * The outer edge of the shadow where it falls on the Earth at one instant, as
 * lines rather than a closed shape: the shading behind it is drawn per pixel,
 * and this is only here to give it an edge to stop at. Split at the
 * antimeridian, since a line drawn straight across it wraps the wrong way.
 */
export function penumbraEdge(el, t, steps = 192) {
  const st = stateAt(el, t);
  const shape = groundRing(el, t, (zeta) => st.l1 - zeta * el.tanf1, steps);
  if (!shape) return null;
  const parts = [];
  let run = [];
  for (const [lon, lat] of shape.ring) {
    const wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
    if (run.length && Math.abs(wrapped - run.at(-1)[0]) > 180) {
      if (run.length > 1) parts.push(run);
      run = [];
    }
    run.push([wrapped, lat]);
  }
  if (run.length > 1) parts.push(run);
  return parts.length ? parts : null;
}

/**
 * Instantaneous obscuration over a lat/lon grid, for the shadow as it stands at
 * one moment -- not the same quantity as the static shading, which is the
 * deepest each place gets at any point in the eclipse.
 *
 * Fills `out` row-major, one row per latitude, with the fraction of the Sun's
 * area covered, and zero where the penumbra has not reached. `margin` carries
 * the field a little way past the horizon: cutting it off exactly there leaves
 * the day/night edge stepping along the pixel grid, so the caller runs it over
 * and trims it back with an edge of its own. Drawn per pixel rather than as bands because a field has no
 * topology to get wrong: rings round a pole, or across the antimeridian, are
 * exactly where a filled outline stops being able to describe the shape.
 *
 * The trigonometry that depends only on the row or only on the column is
 * hoisted, which is most of it.
 */
export function instantField(el, t, lats, lons, out, margin = 0) {
  const st = stateAt(el, t);
  const sinD = Math.sin(st.d);
  const cosD = Math.cos(st.d);
  const rot = SIDEREAL * el.deltaT * 15 / 3600 * DEG;

  const sinTheta = new Float64Array(lons.length);
  const cosTheta = new Float64Array(lons.length);
  for (let i = 0; i < lons.length; i++) {
    const theta = lons[i] * DEG + st.mu - rot;
    sinTheta[i] = Math.sin(theta);
    cosTheta[i] = Math.cos(theta);
  }

  for (let j = 0; j < lats.length; j++) {
    const phi = lats[j] * DEG;
    const u = Math.atan2(SQRT1ME2 * Math.sin(phi), Math.cos(phi));
    const S = SQRT1ME2 * Math.sin(u);
    const C = Math.cos(u);
    const row = j * lons.length;
    for (let i = 0; i < lons.length; i++) {
      const zeta = S * sinD + C * cosTheta[i] * cosD;
      if (zeta < -margin - HORIZON_TOL) { out[row + i] = 0; continue; }
      const l1 = st.l1 - zeta * el.tanf1;
      const dx = C * sinTheta[i] - st.x;
      const dy = S * cosD - C * cosTheta[i] * sinD - st.y;
      const sep = Math.hypot(dx, dy);
      if (sep >= l1) { out[row + i] = 0; continue; }
      const l2 = st.l2 - zeta * el.tanf2;
      out[row + i] = obscurationFrom((l1 - sep) / (l1 + l2), (l1 - l2) / (l1 + l2));
    }
  }
  return out;
}

/** Fraction of the Sun's area hidden, from the fraction of its diameter. */
export function obscurationFrom(magnitude, ratio) {
  if (magnitude <= 0) return 0;
  const c = Math.max(ratio, 1e-6);
  const sep = 1 + c - 2 * magnitude;
  if (sep <= Math.abs(c - 1)) return Math.min(1, c * c);
  if (sep >= 1 + c) return 0;
  const clamp = (v) => Math.min(1, Math.max(-1, v));
  const lens =
    Math.acos(clamp((sep * sep + 1 - c * c) / (2 * sep))) +
    c * c * Math.acos(clamp((sep * sep + c * c - 1) / (2 * sep * c))) -
    0.5 * Math.sqrt(Math.max(0,
      (-sep + 1 + c) * (sep + 1 - c) * (sep - 1 + c) * (sep + 1 + c)));
  return lens / Math.PI;
}

/**
 * How the two discs stand from lat/lon at the single instant `t`: the Moon's
 * apparent size and offset with the Sun's radius as the unit, and the direction
 * it lies in on the fundamental plane (xi east, eta north). Presentation only,
 * for drawing the view -- the verified numbers come from localCircumstances.
 */
export function localInstant(el, lat, lon, t) {
  const st = stateAt(el, t);
  const o = observer(el, st, lat, lon);
  const l1p = st.l1 - o.zeta * el.tanf1;
  const l2p = st.l2 - o.zeta * el.tanf2;
  const east = st.x - o.xi;
  const north = st.y - o.eta;
  const sep = Math.hypot(east, north);
  return {
    up: o.zeta >= -HORIZON_TOL,
    altitude: Math.asin(Math.min(1, Math.max(-1, o.zeta))) / DEG,
    // The observer's zenith, seen in the plane of the view: the transverse
    // part of their position vector. Gives the horizon its true tilt.
    zenithEast: o.xi,
    zenithNorth: o.eta,
    ratio: (l1p - l2p) / (l1p + l2p),      // Moon diameter over Sun diameter
    separation: 2 * sep / (l1p + l2p),     // centre to centre, in Sun radii
    east,
    north,
    magnitude: (l1p - sep) / (l1p + l2p),
  };
}

/**
 * Where the Sun stands in the local sky at instant `t`: altitude and true
 * compass azimuth (degrees from north, eastward). The Besselian axis points
 * at the Sun to within the lunar parallax, so its declination `d` and hour
 * angle `mu` are the Sun's for any purpose a horizon view has. Presentation
 * only, like localInstant.
 */
export function localHorizon(el, lat, lon, t) {
  const st = stateAt(el, t);
  const phi = lat * DEG;
  const H = lon * DEG + st.mu - SIDEREAL * el.deltaT * 15 / 3600 * DEG;
  const sinAlt = Math.sin(phi) * Math.sin(st.d)
    + Math.cos(phi) * Math.cos(st.d) * Math.cos(H);
  // measured from south, westward positive; shifted to from-north, eastward
  const azS = Math.atan2(Math.sin(H),
    Math.cos(H) * Math.sin(phi) - Math.tan(st.d) * Math.cos(phi));
  return {
    altitude: Math.asin(Math.min(1, Math.max(-1, sinAlt))) / DEG,
    azimuth: ((azS / DEG + 180) % 360 + 360) % 360,
  };
}

/**
 * What is seen from lat/lon. Returns null where the eclipse misses the place.
 * Times are TDT hours from the elements' t0; use `toUT` to read them off a clock.
 */
export function localCircumstances(el, lat, lon, scan = 400) {
  if (!el.window) return null;
  const [w0, w1] = el.window;

  let peak = 0, best = -Infinity;
  for (let i = 0; i < scan; i++) {
    const t = w0 + (w1 - w0) * (i / (scan - 1));
    const r = reachAt(el, lat, lon, t);
    if (r > best) { best = r; peak = i; }
  }
  if (best <= 0) return null;

  const stepT = (w1 - w0) / (scan - 1);
  const at = (i) => w0 + stepT * i;
  let lo = at(Math.max(peak - 1, 0));
  let hi = at(Math.min(peak + 1, scan - 1));

  // pull the bracket in to sunrise / sunset if one of them falls inside it
  let before = -1, after = -1;
  for (let i = peak; i >= 0; i--) {
    if (sample(el, lat, lon, at(i)).zeta < 0) { before = i; break; }
  }
  for (let i = peak; i < scan; i++) {
    if (sample(el, lat, lon, at(i)).zeta < 0) { after = i; break; }
  }
  if (before >= 0) lo = Math.max(lo, horizonCrossing(el, lat, lon, at(before), at(before + 1)));
  if (after >= 0) hi = Math.min(hi, horizonCrossing(el, lat, lon, at(after - 1), at(after)));
  hi = Math.max(hi, lo);

  let a = lo, b = hi;
  for (let i = 0; i < 80; i++) {
    const third = (b - a) / 3;
    const m1 = a + third, m2 = b - third;
    if (reachAt(el, lat, lon, m1) < reachAt(el, lat, lon, m2)) a = m1;
    else b = m2;
  }
  // a constrained maximum can sit on either horizon instant instead
  let tMax = (a + b) / 2;
  for (const t of [at(peak), lo, hi]) {
    if (reachAt(el, lat, lon, t) > reachAt(el, lat, lon, tMax)) tMax = t;
  }

  const s = sample(el, lat, lon, tMax);
  const magnitude = (s.l1p - s.sep) / (s.l1p + s.l2p);
  const ratio = (s.l1p - s.l2p) / (s.l1p + s.l2p);
  const central = s.sep < Math.abs(s.l2p);

  const out = {
    tMax,
    magnitude,
    ratio,
    obscuration: obscurationFrom(magnitude, ratio),
    sunAlt: Math.asin(Math.min(1, Math.max(-1, s.zeta))) / DEG,
    central,
    total: central && s.l2p < 0,
  };

  const contact = (edge, umbral, key) => {
    if (gapAt(el, lat, lon, edge, umbral) <= 0) return;
    const t = bisectContact(el, lat, lon, tMax, edge, umbral);
    out[key] = t;
    // A contact can fall while the Sun is still down: the eclipse is already
    // under way when it rises, or still under way when it sets.
    out[key + 'Alt'] = Math.asin(Math.min(1, Math.max(-1, sample(el, lat, lon, t).zeta))) / DEG;
  };
  contact(w0, false, 'c1');
  contact(w1, false, 'c4');
  if (central) {
    contact(w0, true, 'c2');
    contact(w1, true, 'c3');
    if (out.c2 !== undefined && out.c3 !== undefined) {
      out.durationS = (out.c3 - out.c2) * 3600;
    }
  }
  return out;
}

/** TDT hours from t0 to hours UT (may wrap past midnight). */
export const toUT = (el, t) => ((el.t0 + t - el.deltaT / 3600) % 24 + 24) % 24;
