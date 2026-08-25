// What one place on the ground sees: contact times, magnitude, obscuration.
//
// A port of data-pipeline/circumstances.py, which is checked against NASA's
// published central-line durations; verify_circumstances.py --js checks this
// file against that one. Keep the two in step.

const E2 = 0.00669437999014;
const SQRT1ME2 = Math.sqrt(1 - E2);
const SIDEREAL = 1.00273791;
const DEG = Math.PI / 180;

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
  return s.zeta >= 0 ? s.l1p - s.sep : -1e6;
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
