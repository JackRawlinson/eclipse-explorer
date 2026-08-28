// The lunar side: what one eclipse of the Moon looks like, from the catalogue
// numbers alone. There is no path and no Besselian machinery here -- the whole
// night side of the Earth sees the same event at the same instants, so
// everything derives from the contact times, the magnitudes, and the sub-lunar
// point at greatest eclipse (published by NASA as "greatest in zenith").
//
// The shadow-frame model: distances in Earth radii at the Moon's distance,
// with the Moon's radius rm = 0.2725. The umbra and penumbra radii are
// recovered from the published magnitudes -- magnitude is penetration in Moon
// diameters, so at greatest, mag = (r + rm - |gamma|) / 2rm, which inverts to
// r = 2 rm mag + |gamma| - rm. The Moon crosses the shadow on a straight
// chord at constant speed, fixed by the umbral contact times. Everything the
// site draws is then self-consistent with the catalogue by construction.

const DEG = Math.PI / 180;
const RM = 0.2725;             // the Moon, in Earth radii at its distance
const DRIFT = 14.492;          // sub-lunar point, degrees west per hour

/** Contacts and chord geometry, computed once per eclipse and cached on it. */
export function geometryOf(entry) {
  if (entry._geo) return entry._geo;
  const g = entry.greatestUT;
  const half = (m) => (m ?? 0) / 60 / 2;
  const m0 = Math.abs(entry.gamma);
  const ru = 2 * RM * entry.umbralMag + m0 - RM;
  const rp = 2 * RM * entry.penMag + m0 - RM;
  const contacts = {
    p1: g - half(entry.penM), p4: g + half(entry.penM),
    u1: g - half(entry.parM), u4: g + half(entry.parM),
  };
  if (entry.totM) {
    contacts.u2 = g - half(entry.totM);
    contacts.u3 = g + half(entry.totM);
  }
  // Chord speed from the umbral contacts: at u1 the Moon's centre stands
  // ru + rm from the shadow's, and |gamma| abreast of it.
  const run = Math.sqrt(Math.max(0, (ru + RM) ** 2 - m0 ** 2));
  const vx = run / Math.max(1e-6, g - contacts.u1);
  entry._geo = { g, m0, ru, rp, vx, contacts };
  return entry._geo;
}

/** Where the Moon is overhead at UT hour `t`: anchored to NASA's zenith point
    at greatest, drifted west at the mean rate. */
export function sublunar(entry, t) {
  const { g } = geometryOf(entry);
  let lon = entry.zenith.lon - DRIFT * (t - g);
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  return { lat: entry.zenith.lat, lon };
}

/** True compass azimuth of the Moon: the great-circle bearing from the
    observer to the point the Moon is overhead. Degrees from north, eastward. */
export function moonAzimuth(entry, lat, lon, t) {
  const s = sublunar(entry, t);
  const dl = (s.lon - lon) * DEG;
  const az = Math.atan2(Math.sin(dl) * Math.cos(s.lat * DEG),
    Math.cos(lat * DEG) * Math.sin(s.lat * DEG)
    - Math.sin(lat * DEG) * Math.cos(s.lat * DEG) * Math.cos(dl));
  return ((az / DEG) % 360 + 360) % 360;
}

export function moonAlt(entry, lat, lon, t) {
  const s = sublunar(entry, t);
  const sinAlt = Math.sin(lat * DEG) * Math.sin(s.lat * DEG)
    + Math.cos(lat * DEG) * Math.cos(s.lat * DEG) * Math.cos((lon - s.lon) * DEG);
  return Math.asin(Math.min(1, Math.max(-1, sinAlt))) / DEG;
}

/**
 * The Moon's standing in the shadow at UT hour `t`.
 * Returns { dist, umbralMag, penMag, phase } with magnitudes as penetration
 * in Moon diameters (>= 1 means fully inside) and phase one of
 * 'none' | 'penumbral' | 'partial' | 'total'.
 */
export function phaseAt(entry, t) {
  const { g, m0, ru, rp, vx } = geometryOf(entry);
  const dist = Math.hypot(m0, vx * (t - g));
  const umbral = (ru + RM - dist) / (2 * RM);
  const pen = (rp + RM - dist) / (2 * RM);
  const phase = umbral >= 1 ? 'total'
    : umbral > 0 ? 'partial'
    : pen > 0 ? 'penumbral'
    : 'none';
  return { dist, umbralMag: umbral, penMag: pen, phase };
}

// ------------------------------------------------------------- map painting
//
// Both lunar map views paint into the same live canvas the solar shadow uses,
// handed over by the app. Darkness means the same thing it means on the solar
// side: what you do not get to see.

/** The whole-eclipse view: how much of the umbral eclipse each place misses.
    Lunar mode runs on the dark basemap, so the wash is pale -- daylight, the
    reason a place misses out -- and where the whole eclipse is seen the map
    stays dark, which is what the sky does there. */
export function paintSummary(entry, target) {
  const { lats, lons, canvas, ctx, field, image } = target;
  const { contacts } = geometryOf(entry);
  const steps = 16;
  const subs = [];
  for (let k = 0; k < steps; k++) {
    const t = contacts.u1 + ((contacts.u4 - contacts.u1) * (k + 0.5)) / steps;
    const s = sublunar(entry, t);
    subs.push([Math.sin(s.lat * DEG), Math.cos(s.lat * DEG), s.lon]);
  }
  const W = lons.length;
  for (let j = 0; j < lats.length; j++) {
    const sinLat = Math.sin(lats[j] * DEG);
    const cosLat = Math.cos(lats[j] * DEG);
    const row = j * W;
    for (let i = 0; i < W; i++) {
      let up = 0;
      for (const [sinS, cosS, lonS] of subs) {
        if (sinLat * sinS + cosLat * cosS * Math.cos((lons[i] - lonS) * DEG) > 0) up++;
      }
      field[row + i] = up / steps;
    }
  }
  const px = image.data;
  for (let k = 0, p = 0; k < field.length; k++, p += 4) {
    const missed = 1 - field[k];
    px[p] = 226; px[p + 1] = 232; px[p + 2] = 240;
    px[p + 3] = Math.round(150 * missed ** 1.2);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** One instant. The Moon-up side IS the night side, so on the dark basemap it
    stays clear -- carrying only the colour of the eclipse itself, red at
    totality. The Moon-down side is in daylight and gets a pale wash. */
export function paintInstant(entry, t, target) {
  const { lats, lons, canvas, ctx, image } = target;
  const now = phaseAt(entry, t);
  const s = sublunar(entry, t);
  const sinS = Math.sin(s.lat * DEG);
  const cosS = Math.cos(s.lat * DEG);
  const tint = now.phase === 'total' ? [227, 74, 48, 82]
    : now.phase === 'partial'
      ? [245, 158, 11, 18 + Math.round(42 * Math.min(1, now.umbralMag))]
    : now.phase === 'penumbral' ? [148, 163, 184, 16]
    : [0, 0, 0, 0];
  const DAY = [226, 232, 240, 84];
  const W = lons.length;
  const px = image.data;
  for (let j = 0; j < lats.length; j++) {
    const sinLat = Math.sin(lats[j] * DEG);
    const cosLat = Math.cos(lats[j] * DEG);
    for (let i = 0; i < W; i++) {
      const p = (j * W + i) * 4;
      const upness = sinLat * sinS + cosLat * cosS * Math.cos((lons[i] - s.lon) * DEG);
      const src = upness > 0 ? tint : DAY;
      const soft = Math.min(1, Math.abs(upness) / 0.04);   // eases only the seam
      px[p] = src[0]; px[p + 1] = src[1]; px[p + 2] = src[2];
      px[p + 3] = Math.round(src[3] * soft);
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** The moonrise/moonset line at `t`: a great circle 90 degrees from the
    sub-lunar point, split where it crosses the antimeridian, for drawing as a
    crisp line over the soft raster. */
export function horizonLine(entry, t, steps = 240) {
  const s = sublunar(entry, t);
  const sinP = Math.sin(s.lat * DEG);
  const cosP = Math.cos(s.lat * DEG);
  const parts = [];
  let run = [];
  let prev = null;
  for (let k = 0; k <= steps; k++) {
    const th = (2 * Math.PI * k) / steps;
    // destination point at 90 degrees along bearing th from the sub-lunar point
    const sinLat = cosP * Math.cos(th);
    const lat = Math.asin(Math.min(1, Math.max(-1, sinLat))) / DEG;
    const lon = s.lon
      + Math.atan2(Math.sin(th) * cosP, -sinP * sinLat) / DEG;
    const L = ((lon + 540) % 360) - 180;
    if (prev !== null && Math.abs(L - prev) > 180) {
      if (run.length > 1) parts.push(run);
      run = [];
    }
    run.push([L, lat]);
    prev = L;
  }
  if (run.length > 1) parts.push(run);
  return parts;
}

// ------------------------------------------------------------- the eye disc
//
// The Moon in the shadow, as the pinned place sees it: alt-az, horizon level.
// Orientation of the crossing is drawn diagram-style (celestial north up);
// the bite starts on the Moon's eastern limb, which is the left in a sky view.

export function drawEye(ctx, size, entry, t, pin) {
  const { m0, ru, vx, g } = geometryOf(entry);
  const cx = size / 2, cy = size / 2, edge = size / 2;
  const alt = pin ? moonAlt(entry, pin.lat, pin.lon, t) : 90;
  const now = phaseAt(entry, t);

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, edge, 0, 2 * Math.PI);
  ctx.clip();

  // night, always -- it is a lunar eclipse
  ctx.fillStyle = '#070b16';
  ctx.fillRect(0, 0, size, size);
  // a few stars, fixed by hand rather than by chance
  ctx.fillStyle = 'rgba(226,232,240,.8)';
  for (const [sx, sy, r] of [[0.16, 0.2, 1.2], [0.82, 0.14, 1], [0.3, 0.78, 1],
                             [0.72, 0.66, 1.3], [0.88, 0.42, 0.9], [0.12, 0.55, 0.9]]) {
    ctx.beginPath();
    ctx.arc(sx * size, sy * size, r, 0, 2 * Math.PI);
    ctx.fill();
  }

  const R = edge * 0.34;                 // the Moon
  const unit = R / RM;                   // canvas px per Earth radius

  // The umbra's centre, relative to the Moon at the middle of the view.
  // gamma > 0: the Moon passes north of the shadow, so the shadow sits south
  // (down, north up). The Moon moves east through the shadow and east is left
  // in a sky view, so before greatest the shadow stands to the left -- the
  // bite starts on the Moon's eastern limb, as it really does.
  const ux = cx + vx * (t - g) * unit;
  const uy = cy + (entry.gamma > 0 ? m0 : -m0) * unit;

  // the full Moon
  const moon = ctx.createRadialGradient(cx - R * 0.25, cy - R * 0.25, R * 0.2, cx, cy, R);
  moon.addColorStop(0, '#f1f0ea');
  moon.addColorStop(1, '#b9b7ae');
  ctx.fillStyle = moon;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.fill();
  // a hint of maria, so it reads as the Moon and not a plate
  ctx.fillStyle = 'rgba(120,118,110,.35)';
  for (const [mxr, myr, rr] of [[-0.25, -0.2, 0.3], [0.15, 0.12, 0.22], [-0.05, 0.3, 0.16]]) {
    ctx.beginPath();
    ctx.arc(cx + mxr * R, cy + myr * R, rr * R, 0, 2 * Math.PI);
    ctx.fill();
  }

  // the umbra over it, clipped to the Moon; red where the Moon is inside
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.clip();
  if (now.phase === 'total') {
    const depth = Math.min(1, (now.umbralMag - 1) * 2 + 0.35);
    const red = ctx.createRadialGradient(ux, uy, 0, ux, uy, ru * unit);
    red.addColorStop(0, `rgba(70,10,8,${0.96})`);
    red.addColorStop(0.8, `rgba(126,26,16,${0.9})`);
    red.addColorStop(1, `rgba(190,70,30,${0.75 - 0.3 * depth})`);
    ctx.fillStyle = red;
    ctx.fillRect(0, 0, size, size);
  } else if (now.umbralMag > 0) {
    const um = ctx.createRadialGradient(ux, uy, ru * unit * 0.85, ux, uy, ru * unit);
    um.addColorStop(0, 'rgba(10,8,10,.93)');
    um.addColorStop(1, 'rgba(30,16,14,.15)');
    ctx.fillStyle = um;
    ctx.beginPath();
    ctx.arc(ux, uy, ru * unit, 0, 2 * Math.PI);
    ctx.fill();
  } else if (now.penMag > 0.4) {
    // deep penumbra: a soft shading toward the umbral side
    ctx.fillStyle = `rgba(20,16,20,${0.25 * Math.min(1, now.penMag)})`;
    ctx.beginPath();
    ctx.arc(ux, uy, (ru + 2 * RM) * unit, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.restore();

  // The ground, exactly as the solar disc does it. The altitude is clamped
  // for drawing: far enough below the horizon the ground is simply everything,
  // rather than a band that slides out through the top of the disc.
  if (pin && alt < 10) {
    const yH = cy + (Math.max(alt, -12) / 10) * edge;
    const ground = ctx.createLinearGradient(0, yH, 0, cy + edge * 1.2);
    ground.addColorStop(0, '#131a17');
    ground.addColorStop(1, '#070a08');
    ctx.fillStyle = ground;
    ctx.fillRect(0, yH, size, size * 2);
  }
  ctx.restore();

  const label = pin && alt < -0.3 ? 'Moon below the horizon'
    : now.phase === 'total' ? 'Totality'
    : now.phase === 'partial' ? `${Math.min(99, Math.round(now.umbralMag * 100))}% in umbra`
    : now.phase === 'penumbral' ? 'Penumbral shading'
    : '';
  return { label, alt };
}

// ---------------------------------------------------------------- the words

const pad2 = (n) => String(n).padStart(2, '0');
export const utClock = (h) => {
  const s = Math.round(((h % 24) + 24) % 24 * 3600);
  return `${pad2(Math.floor(s / 3600) % 24)}:${pad2(Math.floor(s / 60) % 60)}`;
};

/** What the pinned place gets: which phases happen with the Moon up. */
export function placeSummary(entry, pin) {
  const { contacts } = geometryOf(entry);
  const at = (t) => moonAlt(entry, pin.lat, pin.lon, t);
  const phases = [];
  if (contacts.u2 !== undefined) {
    phases.push(['Totality', contacts.u2, contacts.u3]);
  }
  phases.push(['Partial phase', contacts.u1, contacts.u4]);
  const rows = phases.map(([name, a, b]) => {
    const upA = at(a) > 0;
    const upB = at(b) > 0;
    const seen = upA && upB ? 'all of it'
      : upA ? 'until the Moon sets'
      : upB ? 'from moonrise'
      : 'not visible';
    return [name, `${utClock(a)}–${utClock(b)} UT`, seen];
  });
  const altG = at(geometryOf(entry).g);
  const best = contacts.u2 !== undefined ? at((contacts.u2 + contacts.u3) / 2) : altG;
  const head = best > 0
    ? (contacts.u2 !== undefined ? 'Totality visible from here' : 'Eclipse visible from here')
    : altG > 0 ? 'Partly visible from here'
    : 'Moon below the horizon throughout';
  return { head, rows, altAtGreatest: altG };
}
