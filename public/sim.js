// The view from the ground: a full-page WebGL sky for one eclipse, from one
// place. Loaded only when the eye disc is pressed, so ordinary visits never
// fetch it. Geometry arrives through the adapter app.js builds -- closures
// over the same functions the disc uses -- so this view cannot disagree with
// the map, the card, or the timeline.
//
// One frame of honesty about orientation: the site's geometry knows the Sun's
// altitude and the Moon's offset against the observer's vertical exactly, but
// not the compass bearing -- so the eclipsed body stands at a nominal azimuth
// of zero over an anonymous landscape. Everything you can check is real:
// altitude, the bite's side and roll, the ratio, the contacts, which limb the
// diamond ring flashes on. Where the mountains are is invented; when the sky
// goes dark is not.

const DEG = Math.PI / 180;
const SUN_ANG = 0.267 * DEG;          // mean solar semi-diameter
const MOON_ANG = 0.259 * DEG;         // mean lunar semi-diameter
const RM = 0.2725;                    // lunar shadow-frame unit (Earth radii)
const MIN_PX = 7;                     // smallest the Sun/Moon is allowed to draw

let sim = null;

export function open(adapter) {
  if (sim?.isOpen) return;
  if (!adapter.solar && !adapter.lunar) { adapter.onClose(); return; }
  if (!sim) {
    sim = buildDom();
    sim.gl = initGL(sim.canvas);
    if (!sim.gl || !buildProgram(sim)) {
      adapter.toast('This browser cannot show the sky view');
      sim.root.remove();
      sim = null;
      adapter.onClose();
      return;
    }
    wirePointer(sim);
    wireChrome(sim);
    new ResizeObserver(() => resize(sim)).observe(sim.root);
  }
  sim.adapter = adapter;
  sim.isOpen = true;
  sim.fraction = adapter.fraction;
  sim.playing = adapter.playing;
  sim.userLooked = false;
  sim.dark = 0;
  sim.quality = 1;
  sim.slow = 0;
  sim.fast = 0;
  sim.vyaw = 0;
  sim.vpitch = 0;
  sim.fov = 25 * DEG;
  sim.yaw = 0;
  sim.pitch = bodyAltitude(sim) * DEG;
  sim.root.hidden = false;
  sim.recentreBtn.hidden = true;
  sim.hint.classList.remove('is-gone');
  clearTimeout(sim.hintTimer);
  sim.hintTimer = setTimeout(() => sim.hint.classList.add('is-gone'), 4000);
  sim.scrub.style.setProperty('--tl-marks', adapter.marks() || '');
  sim.scrub.value = String(Math.round(adapter.fraction * 1000));
  sim.speedBtn.textContent = adapter.speedLabel();
  setPlayIcon(sim);
  installDebug(sim);            // seeds must exist before the first frame
  resize(sim);
  addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', onVisibility);
  sim.last = null;
  sim.raf = requestAnimationFrame(frame);
}

function close() {
  if (!sim?.isOpen) return;
  sim.isOpen = false;
  cancelAnimationFrame(sim.raf);
  removeEventListener('keydown', onKey, true);
  document.removeEventListener('visibilitychange', onVisibility);
  sim.root.hidden = true;
  sim.adapter.commit(sim.fraction, sim.playing);
  sim.adapter.onClose();
  document.getElementById('eye-open')?.focus();
}

// ------------------------------------------------------------------- DOM

function buildDom() {
  const root = document.createElement('div');
  root.className = 'sim';
  root.id = 'sim';
  root.hidden = true;

  const canvas = document.createElement('canvas');
  canvas.className = 'sim__canvas';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'sim__close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close the sky view (Esc)');

  const recentreBtn = document.createElement('button');
  recentreBtn.type = 'button';
  recentreBtn.className = 'sim__recentre';
  recentreBtn.textContent = 'Face the eclipse';
  recentreBtn.hidden = true;

  const label = document.createElement('div');
  label.className = 'sim__label';

  const hint = document.createElement('div');
  hint.className = 'sim__hint';
  hint.textContent = 'drag to look around · scroll to zoom';

  const bar = document.createElement('div');
  bar.className = 'sim__bar';
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'sim__play';
  playBtn.setAttribute('aria-label', 'Play');
  const scrub = document.createElement('input');
  scrub.type = 'range';
  scrub.min = '0';
  scrub.max = '1000';
  scrub.step = '1';
  scrub.setAttribute('aria-label', 'Move through the eclipse');
  const time = document.createElement('output');
  time.className = 'sim__time';
  const speedBtn = document.createElement('button');
  speedBtn.type = 'button';
  speedBtn.className = 'sim__speed';
  speedBtn.setAttribute('aria-label', 'Playback speed');
  bar.append(playBtn, scrub, time, speedBtn);

  root.append(canvas, closeBtn, recentreBtn, label, hint, bar);
  document.body.append(root);
  return { root, canvas, closeBtn, recentreBtn, label, hint,
           bar, playBtn, scrub, time, speedBtn,
           isOpen: false, lastReadout: '', lastLabel: null };
}

const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';

function setPlayIcon(s) {
  s.playBtn.innerHTML = s.playing ? PAUSE : PLAY;
  s.playBtn.setAttribute('aria-label', s.playing ? 'Pause' : 'Play');
}

function wireChrome(s) {
  s.closeBtn.addEventListener('click', close);
  s.playBtn.addEventListener('click', () => togglePlay());
  s.recentreBtn.addEventListener('click', () => {
    s.userLooked = false;
    s.recentreBtn.hidden = true;
    s.yaw = 0;
  });
  s.scrub.addEventListener('input', () => {
    s.playing = false;
    setPlayIcon(s);
    s.fraction = Number(s.scrub.value) / 1000;
  });
  s.scrub.addEventListener('change', () => s.adapter.commit(s.fraction, false));
  s.speedBtn.addEventListener('click', () => {
    s.adapter.cyclePlayRate();
    s.speedBtn.textContent = s.adapter.speedLabel();
  });
}

function togglePlay() {
  sim.playing = !sim.playing;
  setPlayIcon(sim);
  if (!sim.playing) sim.adapter.commit(sim.fraction, false);
}

function onKey(ev) {
  if (!sim?.isOpen) return;
  if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); close(); return; }
  if (ev.key === ' ') { ev.stopPropagation(); ev.preventDefault(); togglePlay(); return; }
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    ev.stopPropagation();
    ev.preventDefault();
    sim.playing = false;
    setPlayIcon(sim);
    sim.fraction = Math.min(1, Math.max(0, sim.fraction + (ev.key === 'ArrowRight' ? 0.005 : -0.005)));
    sim.adapter.commit(sim.fraction, false);
  }
}

function onVisibility() {
  if (document.hidden) sim.last = null;   // the clock holds while the tab is away
}

// ---------------------------------------------------------------- pointer

function wirePointer(s) {
  const pointers = new Map();
  let pinchDist = 0;
  s.canvas.addEventListener('pointerdown', (ev) => {
    s.canvas.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, [ev.clientX, ev.clientY]);
    s.root.classList.add('sim--dragging');
    s.userLooked = true;
    s.recentreBtn.hidden = false;
    s.vyaw = 0;
    s.vpitch = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
  });
  s.canvas.addEventListener('pointermove', (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    const prev = pointers.get(ev.pointerId);
    pointers.set(ev.pointerId, [ev.clientX, ev.clientY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinchDist > 0) setFov(s, s.fov * pinchDist / d);
      pinchDist = d;
      return;
    }
    const scale = s.fov / s.canvas.clientHeight;
    const dYaw = -(ev.clientX - prev[0]) * scale;
    const dPitch = (ev.clientY - prev[1]) * scale;
    s.yaw += dYaw;
    s.pitch = clampPitch(s.pitch + dPitch);
    s.vyaw = dYaw;
    s.vpitch = dPitch;
  });
  const lift = (ev) => {
    pointers.delete(ev.pointerId);
    if (!pointers.size) s.root.classList.remove('sim--dragging');
    pinchDist = 0;
  };
  s.canvas.addEventListener('pointerup', lift);
  s.canvas.addEventListener('pointercancel', lift);
  s.canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    setFov(s, s.fov * Math.exp(ev.deltaY * 0.0012));
  }, { passive: false });
}

const clampPitch = (p) => Math.min(89 * DEG, Math.max(-80 * DEG, p));
const setFov = (s, f) => { s.fov = Math.min(95 * DEG, Math.max(1.5 * DEG, f)); };

// ------------------------------------------------------------------ WebGL

function initGL(canvas) {
  const opts = { alpha: false, depth: false, stencil: false,
                 antialias: false, powerPreference: 'high-performance' };
  const gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
  if (!gl) return null;
  canvas.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault();
    cancelAnimationFrame(sim.raf);
  });
  canvas.addEventListener('webglcontextrestored', () => {
    buildProgram(sim);
    resize(sim);
    if (sim.isOpen) { sim.last = null; sim.raf = requestAnimationFrame(frame); }
  });
  return gl;
}

const VS = `
attribute vec2 a_pos;
varying vec2 v_ndc;
void main() { v_ndc = a_pos; gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

// GLSL ES 1.00 throughout, so the same source runs on WebGL1 and WebGL2.
const FS = `
precision highp float;
varying vec2 v_ndc;
uniform vec2  u_res;
uniform float u_px;                   // radians per pixel at screen centre
uniform float u_time;
uniform float u_mode;                 // 0 solar, 1 lunar
uniform vec3  u_camFwd, u_camRight, u_camUp;
uniform vec2  u_tanHalf;
uniform vec3  u_sunDir, u_moonDir;
uniform float u_sunAngR, u_moonAngR;  // radians, after the magnifier
uniform float u_sunAlt;               // radians; drives the sky
uniform float u_obsc, u_dark, u_twilight;
uniform float u_totality, u_ring, u_diamond, u_chromo;
uniform vec3  u_flashDir;
uniform float u_coronaSeed, u_groundSeed;
uniform mat3  u_starMat;
uniform float u_starVis;
uniform vec2  u_umbraOff;             // radians, view plane (x right, y up)
uniform float u_umbraAngR, u_penAngR, u_umbralMag;

float hash12(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float n1(float x) {
  float i = floor(x), f = fract(x);
  float a = hash12(vec2(i, 3.7)), b = hash12(vec2(i + 1.0, 3.7));
  return mix(a, b, f * f * (3.0 - 2.0 * f));
}
float n2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm2(vec2 p) {
  return 0.55 * n2(p) + 0.3 * n2(p * 2.13 + 5.0) + 0.15 * n2(p * 4.31 + 11.0);
}

void main() {
  vec3 d = normalize(u_camFwd
    + v_ndc.x * u_tanHalf.x * u_camRight
    + v_ndc.y * u_tanHalf.y * u_camUp);
  float e = asin(clamp(d.y, -1.0, 1.0));       // elevation of this ray
  float az = atan(d.x, d.z);                   // relative azimuth

  // ---- sky
  vec3 zen = vec3(0.16, 0.40, 0.80);
  vec3 hor = vec3(0.62, 0.78, 0.94);
  vec3 nite = vec3(0.012, 0.02, 0.045);
  float day = smoothstep(-0.12, 0.10, u_sunAlt);
  vec3 col = mix(hor, zen, pow(clamp(e / 1.4, 0.0, 1.0), 0.55)) * day;
  float sunProx = pow(max(dot(d, u_sunDir), 0.0), 3.0);
  col += vec3(1.0, 0.55, 0.28) * sunProx
       * smoothstep(0.25, -0.05, u_sunAlt) * (1.0 - u_dark) * 0.6;
  col = mix(col, nite, u_dark);

  // the 360-degree sunset ring totality paints on the whole horizon
  float band = exp(-max(e, 0.0) / 0.07) * step(0.0, e);
  float tone = 0.75 + 0.25 * sin(az * 3.0 + u_coronaSeed * 7.0);
  col += mix(vec3(1.0, 0.42, 0.18), vec3(1.0, 0.75, 0.4), band)
       * band * tone * u_ring * 0.85;

  // ---- stars: a hash lattice in rotated direction space
  vec3 sd = u_starMat * d;
  vec3 dn = normalize(sd);
  vec3 cell = floor(dn * 40.0);
  vec3 h = hash33(cell);
  vec3 sp = normalize(cell + 0.5 + (h - 0.5) * 0.8);
  float an = length(dn - sp * dot(dn, sp));    // small-angle distance to the star
  float px = u_px * 1.4 + 1e-5;
  float bright = pow(h.z, 14.0);
  float tw = 0.8 + 0.2 * sin(u_time * (2.0 + 4.0 * h.x) + h.y * 6.28);
  col += vec3(0.9, 0.95, 1.0) * bright * tw
       * smoothstep(px * 1.8, px * 0.4, an)
       * u_starVis * smoothstep(0.02, 0.12, e);

  float aS = acos(clamp(dot(d, u_sunDir), -1.0, 1.0));
  float aM = acos(clamp(dot(d, u_moonDir), -1.0, 1.0));
  float w = u_px * 1.5 + 1e-6;

  if (u_mode < 0.5) {
    // ---- solar: corona behind, then photosphere, chromosphere, moon, diamond
    vec3 tU = normalize(vec3(0.0, 1.0, 0.0) - u_sunDir * u_sunDir.y);
    vec3 tR = normalize(cross(tU, u_sunDir));
    vec3 tang = d - u_sunDir * dot(d, u_sunDir);
    float th = atan(dot(tang, tU), dot(tang, tR));
    float r = aS / max(u_sunAngR, 1e-6);
    float streak = 0.55 + 0.45 * (0.6 * n1(th * 3.0 + u_coronaSeed)
                                + 0.3 * n1(th * 7.0 + u_coronaSeed * 2.7)
                                + 0.1 * sin(th * 2.0 + u_coronaSeed));
    float fall = pow(clamp(1.0 / max(r, 1.0), 0.0, 1.0), 2.2 + 1.6 * streak);
    col += vec3(0.92, 0.95, 1.05) * fall * 1.4 * u_totality * step(1.0, r);

    // glare that collapses as the Sun is eaten
    col += vec3(1.0, 0.95, 0.85)
         * pow(max(dot(d, u_sunDir), 0.0), 700.0)
         * (pow(1.0 - u_obsc, 1.5) + 0.02) * 2.0;

    // the photosphere, limb-darkened
    float disc = smoothstep(u_sunAngR + w, u_sunAngR - w, aS);
    float mu = sqrt(max(0.0, 1.0 - r * r));
    col = mix(col, vec3(1.0, 0.96, 0.86) * (4.0 * (0.35 + 0.65 * mu)), disc);

    // chromosphere: a red rim hugging the moon's limb near 2nd/3rd contact
    vec3 ft = normalize(u_flashDir - u_sunDir * dot(u_flashDir, u_sunDir) + 1e-6);
    float side = max(dot(normalize(tang + 1e-9), ft), 0.0);
    float rim = exp(-pow((aM - u_moonAngR) / (w * 3.0), 2.0));
    col += vec3(1.0, 0.25, 0.2) * rim * side * u_chromo * 1.2;

    // the Moon, in silhouette
    float mdisc = smoothstep(u_moonAngR + w, u_moonAngR - w * 0.5, aM);
    col = mix(col, vec3(0.004, 0.005, 0.008), mdisc);

    // the diamond ring: a hard bright core a fraction of the Sun wide, with a
    // modest halo -- bounded, so the flash dazzles without whiting the sky out
    float aF = acos(clamp(dot(d, u_flashDir), -1.0, 1.0));
    float fr = aF / max(u_sunAngR, 1e-6);
    col += vec3(1.0, 0.98, 0.92) * u_diamond
         * (10.0 * exp(-fr * fr * 8.0) + 0.5 * exp(-fr * 0.8));
  } else {
    // ---- lunar: the Moon with the umbra crossing it
    vec3 tU = normalize(vec3(0.0, 1.0, 0.0) - u_moonDir * u_moonDir.y);
    vec3 tR = normalize(cross(tU, u_moonDir));
    vec3 tang = d - u_moonDir * dot(d, u_moonDir);
    vec2 q = vec2(dot(tang, tR), dot(tang, tU));    // radians; x right, y up
    float rm = length(q);
    if (rm < u_moonAngR + w * 2.0) {
      vec2 qn = q / u_moonAngR;
      float maria = 1.0 - 0.35 * smoothstep(0.45, 0.6, fbm2(qn * 3.0 + 7.0));
      vec3 moon = vec3(0.72, 0.71, 0.67) * maria;
      float du = length(q - u_umbraOff);
      float pen = smoothstep(u_umbraAngR, u_penAngR, du);
      moon *= 0.55 + 0.45 * pen;                    // penumbral dimming
      float inU = smoothstep(u_umbraAngR * 1.03, u_umbraAngR * 0.94, du);
      float depth = clamp((u_umbralMag - 1.0) * 2.0 + 0.3, 0.0, 1.0);
      vec3 red = mix(vec3(0.55, 0.12, 0.05), vec3(0.16, 0.02, 0.015), depth);
      float rimGlow = smoothstep(u_umbraAngR * 0.55, u_umbraAngR * 0.98, du);
      red += vec3(0.9, 0.35, 0.12) * 0.25 * rimGlow;
      moon = mix(moon, red * maria * 2.2, inU);
      moon = max(moon, vec3(0.015, 0.017, 0.025));  // earthshine floor
      float mdisc = smoothstep(u_moonAngR + w, u_moonAngR - w * 0.5, rm);
      col = mix(col, moon, mdisc);
      // halo from whatever part is still uneclipsed
      col += vec3(0.7, 0.75, 0.85)
           * exp(-max(rm - u_moonAngR, 0.0) / (u_moonAngR * 0.6))
           * (1.0 - clamp(u_umbralMag, 0.0, 1.0)) * 0.12 * step(u_moonAngR, rm);
    }
  }

  // ---- the ground, over everything
  vec2 azv = vec2(cos(az), sin(az));
  float ridge = -0.008 + 0.028 * fbm2(azv * 2.5 + u_groundSeed);
  if (e < ridge) {
    float depth = clamp((ridge - e) / 0.25, 0.0, 1.0);
    vec3 g = mix(vec3(0.05, 0.06, 0.05), vec3(0.008, 0.010, 0.008), depth)
           * (0.15 + 0.85 * (1.0 - u_dark));
    g += vec3(1.0, 0.5, 0.25) * exp(-(ridge - e) / 0.02) * u_ring * 0.25;
    col = g;
  }

  // tonemap, gamma, dither
  col = col / (1.0 + col);
  col = pow(col, vec3(0.4545));
  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

function buildProgram(s) {
  const gl = s.gl;
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('sim shader:', gl.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, VS);
  const fs = compile(gl.FRAGMENT_SHADER, FS);
  if (!vs || !fs) return false;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, 'a_pos');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('sim link:', gl.getProgramInfoLog(prog));
    return false;
  }
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  s.prog = prog;
  s.loc = {};
  for (const name of ['u_res', 'u_px', 'u_time', 'u_mode', 'u_camFwd', 'u_camRight', 'u_camUp',
    'u_tanHalf', 'u_sunDir', 'u_moonDir', 'u_sunAngR', 'u_moonAngR', 'u_sunAlt',
    'u_obsc', 'u_dark', 'u_twilight', 'u_totality', 'u_ring', 'u_diamond', 'u_chromo',
    'u_flashDir', 'u_coronaSeed', 'u_groundSeed', 'u_starMat', 'u_starVis',
    'u_umbraOff', 'u_umbraAngR', 'u_penAngR', 'u_umbralMag']) {
    s.loc[name] = gl.getUniformLocation(prog, name);
  }
  return true;
}

function resize(s) {
  const dpr = Math.min(devicePixelRatio || 1, 1.75) * s.quality;
  const w = Math.max(1, Math.round(s.root.clientWidth * dpr));
  const h = Math.max(1, Math.round(s.root.clientHeight * dpr));
  if (s.canvas.width !== w || s.canvas.height !== h) {
    s.canvas.width = w;
    s.canvas.height = h;
  }
  s.gl.viewport(0, 0, w, h);
}

// --------------------------------------------------------------- geometry

const dirFromAltAz = (alt, az) =>
  [Math.sin(az) * Math.cos(alt), Math.sin(alt), Math.cos(az) * Math.cos(alt)];

function timeAt(s) {
  const [w0, w1] = s.adapter.window;
  return w0 + (w1 - w0) * s.fraction;
}

function bodyAltitude(s) {
  const t = timeAt(s);
  return s.adapter.kind === 'lunar'
    ? s.adapter.lunar.alt(t)
    : s.adapter.solar.instant(t).altitude;
}

/** The per-instant uniforms and label for the solar sky. */
function solarUniforms(s, t, dt) {
  const a = s.adapter;
  const v = a.solar.instant(t);
  const c = Math.max(v.ratio, 1e-3);
  const o = a.solar.obscuration(v.magnitude, c);
  const total = v.separation <= c - 1;
  const annular = c < 1 && v.separation <= 1 - c;
  const twilight = Math.min(1, Math.max(0, (2 - v.altitude) / 10));
  const kTarget = total ? 1 : Math.max(Math.min(1, o ** 4), twilight);
  s.dark += (kTarget - s.dark) * Math.min(1, dt * 4);

  // the parallactic roll, exactly as the eye disc computes it
  const zl = Math.hypot(v.zenithEast, v.zenithNorth);
  const zx = zl > 1e-6 ? -v.zenithEast / zl : 0;
  const zy = zl > 1e-6 ? -v.zenithNorth / zl : -1;
  const phi = Math.atan2(zx, -zy);
  const dn = Math.hypot(v.east, v.north) || 1;
  const ox = -(v.east / dn) * v.separation;
  const oy = -(v.north / dn) * v.separation;
  const rx = ox * Math.cos(phi) + oy * Math.sin(phi);
  const ry = oy * Math.cos(phi) - ox * Math.sin(phi);
  const off = [rx, -ry];                       // view plane: x right, y up

  // the magnifier: one factor for every angular size, unity when zoomed in
  const pxPerRad = s.canvas.height / (2 * Math.tan(s.fov / 2));
  const mag = Math.max(1, MIN_PX / (SUN_ANG * pxPerRad));
  const sunAng = SUN_ANG * mag;

  const alt = v.altitude * DEG;
  const S = dirFromAltAz(alt, 0);
  const tR = norm3(cross([0, 1, 0], S));
  const tU = cross(S, tR);
  const sep = v.separation * sunAng;
  const T = norm3(add3(scale3(tR, off[0]), scale3(tU, off[1])));
  const M = norm3(add3(scale3(S, Math.cos(sep)), scale3(T, Math.sin(sep))));
  const F = norm3(add3(scale3(S, Math.cos(sunAng)),
                       scale3(T, -Math.sin(sunAng))));   // limb opposite the moon

  const totality = total
    ? Math.min(1, ((c - 1 - v.separation) / Math.max(c - 1, 1e-4)) * 3 + 0.3)
    : 0;
  const label = !v.up ? 'Sun below the horizon'
    : total ? 'Totality'
    : annular ? 'Annular'
    : o >= 0.005 ? `${Math.min(99, Math.round(o * 100))}% covered`
    : '';

  return {
    mode: 0, sunDir: S, moonDir: M, flashDir: F,
    sunAngR: sunAng, moonAngR: sunAng * c,
    sunAlt: alt, obsc: o, twilight,
    totality,
    ring: total ? 1 : smootherstep(0.985, 1.0, v.magnitude),
    diamond: (total || annular) ? 0 : smootherstep(0.99, 0.9985, v.magnitude),
    chromo: total ? Math.max(0, 1 - totality) : 0,
    umbraOff: [0, 0], umbraAngR: 0, penAngR: 0, umbralMag: 0,
    bodyAlt: v.altitude, label,
  };
}

/** The per-instant uniforms and label for the lunar sky. */
function lunarUniforms(s, t, dt) {
  const a = s.adapter;
  const p = a.lunar.phase(t);
  const geo = a.lunar.geometry();
  const alt = a.lunar.alt(t);

  // The Moon stands at the anti-solar point, so the Sun's altitude is -alt to
  // first order -- a moonrise eclipse gets its opposite twilight for free.
  const sunAlt = -alt * DEG;
  const night = 1 - smootherstep(-18, -4, -alt);   // 1 deep night .. 0 moon low
  s.dark += (Math.max(0.75, night) - s.dark) * Math.min(1, dt * 4);

  const pxPerRad = s.canvas.height / (2 * Math.tan(s.fov / 2));
  const mag = Math.max(1, MIN_PX / (MOON_ANG * pxPerRad));
  const moonAng = MOON_ANG * mag;
  const sAng = (MOON_ANG / RM) * mag;          // radians per shadow-frame unit

  const M = dirFromAltAz(alt * DEG, 0);
  const label = alt < -0.3 ? 'Moon below the horizon'
    : p.phase === 'total' ? 'Totality'
    : p.phase === 'partial' ? `${Math.min(99, Math.round(p.umbralMag * 100))}% in umbra`
    : p.phase === 'penumbral' ? 'Penumbral shading'
    : '';

  return {
    mode: 1, sunDir: dirFromAltAz(sunAlt, Math.PI), moonDir: M, flashDir: M,
    sunAngR: SUN_ANG, moonAngR: moonAng,
    sunAlt, obsc: 1, twilight: 0,
    totality: 0, ring: 0, diamond: 0, chromo: 0,
    umbraOff: [geo.vx * (t - geo.g) * sAng,
               (a.lunar.gamma > 0 ? -geo.m0 : geo.m0) * sAng],
    umbraAngR: geo.ru * sAng,
    penAngR: geo.rp * sAng,
    umbralMag: p.umbralMag,
    bodyAlt: alt, label,
  };
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1],
                         a[2] * b[0] - a[0] * b[2],
                         a[0] * b[1] - a[1] * b[0]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const norm3 = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const smootherstep = (a, b, x) => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

/** A slow, plausibly-poled diurnal turn for the procedural star field. */
function starMatrix(s, t) {
  const lat = s.adapter.pin.lat;
  const pole = dirFromAltAz(Math.abs(lat) * DEG, lat >= 0 ? Math.PI : 0);
  const ang = ((t * 15) % 360) * DEG;
  const [x, y, z] = pole;
  const c = Math.cos(ang), si = Math.sin(ang), ic = 1 - c;
  return new Float32Array([
    c + x * x * ic, x * y * ic + z * si, x * z * ic - y * si,
    x * y * ic - z * si, c + y * y * ic, y * z * ic + x * si,
    x * z * ic + y * si, y * z * ic - x * si, c + z * z * ic,
  ]);
}

// ------------------------------------------------------------------ frame

function frame(now) {
  const s = sim;
  if (!s?.isOpen) return;
  const dt = s.last === null ? 0 : Math.min(0.1, (now - s.last) / 1000);
  s.last = now;

  // the same playback law as the timeline: the crossing takes 24 s at 1x
  if (s.playing && dt > 0) {
    s.fraction += (dt * 1000 / 24000) * s.adapter.playRate();
    if (s.fraction > 1) s.fraction = 0;
    s.scrub.value = String(Math.round(s.fraction * 1000));
  }

  const t = timeAt(s);
  const u = s.adapter.kind === 'lunar'
    ? lunarUniforms(s, t, dt)
    : solarUniforms(s, t, dt);

  // follow the body until the person takes the view for themselves
  if (!s.userLooked) {
    s.yaw = 0;
    s.pitch = clampPitch(Math.max(u.bodyAlt * DEG, 2 * DEG));
  } else if (s.vyaw || s.vpitch) {
    const k = Math.exp(-dt * 6);
    s.vyaw *= k;
    s.vpitch *= k;
    if (Math.hypot(s.vyaw, s.vpitch) < 0.0003) { s.vyaw = 0; s.vpitch = 0; }
    s.yaw += s.vyaw;
    s.pitch = clampPitch(s.pitch + s.vpitch);
  }

  // right = up x fwd, so +azimuth is the viewer's right and the sky is not
  // mirrored -- proven against the eye disc, which the ground truth validated
  const fwd = dirFromAltAz(s.pitch, s.yaw);
  const right = norm3(cross([0, 1, 0], fwd));
  const up = cross(fwd, right);
  const aspect = s.canvas.width / Math.max(1, s.canvas.height);
  const tanH = Math.tan(s.fov / 2);

  const gl = s.gl;
  const L = s.loc;
  gl.useProgram(s.prog);
  gl.uniform2f(L.u_res, s.canvas.width, s.canvas.height);
  gl.uniform1f(L.u_px, s.fov / Math.max(1, s.canvas.height));
  gl.uniform1f(L.u_time, now / 1000);
  gl.uniform1f(L.u_mode, u.mode);
  gl.uniform3fv(L.u_camFwd, fwd);
  gl.uniform3fv(L.u_camRight, right);
  gl.uniform3fv(L.u_camUp, up);
  gl.uniform2f(L.u_tanHalf, tanH * aspect, tanH);
  gl.uniform3fv(L.u_sunDir, u.sunDir);
  gl.uniform3fv(L.u_moonDir, u.moonDir);
  gl.uniform1f(L.u_sunAngR, u.sunAngR);
  gl.uniform1f(L.u_moonAngR, u.moonAngR);
  gl.uniform1f(L.u_sunAlt, u.sunAlt);
  gl.uniform1f(L.u_obsc, u.obsc);
  gl.uniform1f(L.u_dark, s.dark);
  gl.uniform1f(L.u_twilight, u.twilight);
  gl.uniform1f(L.u_totality, u.totality);
  gl.uniform1f(L.u_ring, u.ring);
  gl.uniform1f(L.u_diamond, u.diamond);
  gl.uniform1f(L.u_chromo, u.chromo);
  gl.uniform3fv(L.u_flashDir, u.flashDir);
  gl.uniform1f(L.u_coronaSeed, s.seeds[0]);
  gl.uniform1f(L.u_groundSeed, s.seeds[1]);
  gl.uniformMatrix3fv(L.u_starMat, false, starMatrix(s, t));
  gl.uniform1f(L.u_starVis, u.mode === 1
    ? Math.min(1, s.dark)
    : smootherstep(0.6, 0.95, s.dark));
  gl.uniform2fv(L.u_umbraOff, u.umbraOff);
  gl.uniform1f(L.u_umbraAngR, u.umbraAngR);
  gl.uniform1f(L.u_penAngR, u.penAngR);
  gl.uniform1f(L.u_umbralMag, u.umbralMag);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // chrome: only touch the DOM when the words change
  const readout = s.adapter.readout(t);
  if (readout !== s.lastReadout) { s.time.value = readout; s.lastReadout = readout; }
  if (u.label !== s.lastLabel) { s.label.textContent = u.label; s.lastLabel = u.label; }

  // adaptive quality: step down under sustained slowness, creep back up
  if (dt > 0.02) { s.slow++; s.fast = 0; } else if (dt > 0 && dt < 0.01) { s.fast++; s.slow = 0; }
  if (s.slow > 30 && s.quality > 0.6) {
    s.quality = s.quality > 0.75 ? 0.75 : 0.6;
    s.slow = 0;
    resize(s);
  } else if (s.fast > 120 && s.quality < 1) {
    s.quality = 1;
    s.fast = 0;
    resize(s);
  }

  s.raf = requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ debug

function installDebug(s) {
  const h = (str) => {
    let x = 2166136261;
    for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); }
    return ((x >>> 0) % 1000) / 1000;
  };
  s.seeds = [h(s.adapter.seed) * 20, h(s.adapter.seed + 'g') * 20];
  window.__sim = {
    state: s,
    setView(yawDeg, pitchDeg, fovDeg) {
      s.userLooked = true;
      s.recentreBtn.hidden = false;
      s.yaw = yawDeg * DEG;
      s.pitch = clampPitch(pitchDeg * DEG);
      if (fovDeg) setFov(s, fovDeg * DEG);
    },
    setFraction(f) {
      s.playing = false;
      setPlayIcon(s);
      s.fraction = Math.min(1, Math.max(0, f));
      s.scrub.value = String(Math.round(s.fraction * 1000));
    },
    sample(fx, fy) {
      // one synchronous frame, then read the pixel while it is still fresh
      cancelAnimationFrame(s.raf);
      frame(performance.now());
      cancelAnimationFrame(s.raf);
      const gl = s.gl;
      const px = new Uint8Array(4);
      gl.readPixels(Math.round(fx * (s.canvas.width - 1)),
                    Math.round((1 - fy) * (s.canvas.height - 1)),
                    1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      s.raf = requestAnimationFrame(frame);
      return [px[0], px[1], px[2]];
    },
    loseContext() {
      s.gl.getExtension('WEBGL_lose_context')?.loseContext();
      setTimeout(() => s.gl.getExtension('WEBGL_lose_context')?.restoreContext(), 300);
    },
    close,
  };
}
