'use strict';
/* Tape Loss MK IV: the visualizer.
   In Display there is a small round window, a tube, with a wire orb in it that moves to the music. Tap it
   and the visualizer takes the whole screen; tap again and the deck is back. Nothing happens on its own.

   What it shows is the machine itself, seen through:
     Reel      the plate turns to black glass and the two reels become two wire orbs inside their flanges,
               spokes still turning at tape speed; the tape, heads, meters and counter stay where they are
     Cassette  the shell becomes a wire drawing of itself and the two spools become orbs in toothed hubs
     Unit      one large orb with the spectrum standing round it
   Everywhere, each band of the spectrum pushes its own ring of an orb outward, the bass swells it, a beat
   kicks it and throws a ring, it leans with the tape's pitch and turns orange on a dropout.
   Drawn on the same canvas as everything else; no library. Open the page once with ?viz=off to remove the
   tube (?viz=on brings it back). */

let vizOn = true;
{
  const q = new URLSearchParams(location.search).get('viz');
  try { if (q) localStorage.setItem('tapeloss.viz', q); vizOn = localStorage.getItem('tapeloss.viz') !== 'off'; } catch (_) { vizOn = q !== 'off'; }
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) vizOn = false;
}
let vizFull = false, vizAmt = 0, vizE = 0, vizSince = 0, tubeGeom = null;       // vizE: how far the visualizer has taken over, 0..1, eased
let vizAn = null, vizBins = null, vizT = 0, vizYaw = 0;
let vBass = 0, vMid = 0, vHigh = 0, vAvg = 0, vKick = 0, vBeatGap = 0, vLvl = 0;
const vRings = [], vDust = [];

/** A sphere of near-equal triangles: an icosahedron with each face split `level` times. Points and edges. */
function vizMesh(level) {
  const t = (1 + Math.sqrt(5)) / 2, pts = [];
  const add = (x, y, z) => { const l = Math.hypot(x, y, z); pts.push([x / l, y / l, z / l]); return pts.length - 1; };
  for (const [a, b] of [[-1, t], [1, t], [-1, -t], [1, -t]]) { add(a, b, 0); }
  for (const [a, b] of [[-1, t], [1, t], [-1, -t], [1, -t]]) { add(0, a, b); }
  for (const [a, b] of [[-1, t], [1, t], [-1, -t], [1, -t]]) { add(b, 0, a); }
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const mids = new Map(), mid = (a, b) => {
    const key = a < b ? a * 65536 + b : b * 65536 + a;
    if (!mids.has(key)) mids.set(key, add(pts[a][0] + pts[b][0], pts[a][1] + pts[b][1], pts[a][2] + pts[b][2]));
    return mids.get(key);
  };
  for (let l = 0; l < level; l++) {
    const next = [];
    for (const [a, b, c] of faces) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    faces = next;
  }
  const seen = new Set(), edges = [];
  for (const f of faces) for (let k = 0; k < 3; k++) {
    const a = f[k], b = f[(k + 1) % 3], key = a < b ? a * 65536 + b : b * 65536 + a;
    if (!seen.has(key)) { seen.add(key); edges.push(a, b); }
  }
  return { n: pts.length, p: Float32Array.from(pts.flat()), e: Uint16Array.from(edges) };
}
const VM1 = vizMesh(1), VM2 = vizMesh(2), VM3 = vizMesh(3);          // 42, 162 and 642 points
const vX = new Float32Array(VM3.n), vY = new Float32Array(VM3.n), vZ = new Float32Array(VM3.n), vD = new Float32Array(VM3.n);
for (let i = 0; i < 90; i++) vDust.push({ a: Math.random() * Math.PI * 2, d: 1 + Math.random() * 2.2, s: 0.4 + Math.random(), w: Math.random() });

/** The music, three ways: how much bass, middle and top there is right now, and whether a beat just landed. */
function vizListen(dt) {
  if (!vizAn && ctx && node) {
    vizAn = ctx.createAnalyser(); vizAn.fftSize = 2048; vizAn.smoothingTimeConstant = 0.5;
    node.connect(vizAn); vizBins = new Uint8Array(vizAn.frequencyBinCount);
  }
  let b = 0, m = 0, h = 0;
  if (vizAn && playing) {
    vizAn.getByteFrequencyData(vizBins);
    const hz = ctx.sampleRate / vizAn.fftSize, band = (f0, f1) => {
      const i0 = Math.max(1, Math.round(f0 / hz)), i1 = Math.min(vizBins.length - 1, Math.round(f1 / hz));
      let s = 0; for (let i = i0; i <= i1; i++) s += vizBins[i]; return s / ((i1 - i0 + 1) * 255);
    };
    b = band(40, 150); m = band(150, 2000); h = band(2000, 12000);
  }
  const fall = Math.exp(-dt * 5);
  vBass = Math.max(b, vBass * fall); vMid = Math.max(m, vMid * fall); vHigh = Math.max(h, vHigh * fall);
  vLvl += ((b + m + h) / 3 - vLvl) * Math.min(1, dt * 4);
  // a beat: the bass jumps well above where it has been lately
  vBeatGap += dt;
  let beat = false;
  if (b > vAvg * 1.3 + 0.05 && vBeatGap > 0.22) { beat = true; vBeatGap = 0; vKick = 1; }
  vAvg += (b - vAvg) * Math.min(1, dt * 1.4);
  vKick *= Math.exp(-dt * 6);
  return beat;
}

/** Once a frame, before anything is drawn: listen, and move towards or away from full screen. */
function vizStep(dt, show) {
  if (!show || !vizOn) { vizFull = false; vizAmt = 0; vizE = 0; vRings.length = 0; tubeGeom = null; return; }
  const beat = vizListen(dt);
  vizAmt += ((vizFull ? 1 : 0) - vizAmt) * Math.min(1, dt * 3.4);
  if (vizFull ? vizAmt > 0.99 : vizAmt < 0.01) vizAmt = vizFull ? 1 : 0;
  vizE = vizAmt * vizAmt * (3 - 2 * vizAmt);
  vizT += dt; vizYaw += dt * (0.22 + 0.9 * vLvl + 1.2 * vKick);
  if (beat && vizAmt > 0.2) vRings.push({ r: 1, a: 1 });
  for (let i = vRings.length - 1; i >= 0; i--) { const q = vRings[i]; q.r += dt * 0.75; q.a -= dt * 1.15; if (q.a <= 0) vRings.splice(i, 1); }
  tubeGeom = null;                                    // the face that draws the tube this frame sets it again
}
/** A tap on the Display at (x, y). True when the visualizer took it: on the tube it opens, anywhere it closes. */
function vizTap(x, y) {
  if (!vizOn) return false;
  if (vizFull) { vizFull = false; return true; }
  if (tubeGeom && Math.hypot(x - tubeGeom.x, y - tubeGeom.y) <= tubeGeom.r) { vizFull = true; vizSince = performance.now(); return true; }
  return false;
}
function vizHint(g, W, y) {
  const age = performance.now() - vizSince;
  if (!vizFull || age > 3200) return;
  g.save(); g.globalAlpha = clamp01((3200 - age) / 800) * vizE; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.font = '600 11px ' + FONT; g.fillStyle = DIM;
  g.fillText('tap anywhere for the deck', W / 2, y); g.restore();
}

// ── the pieces ───────────────────────────────────────────────────────────────────────────────────
/** A wire orb of radius R at (cx, cy), `e` visible (0..1). Every point is pushed out by its own band of the
 *  spectrum (lows at the bottom, highs at the top), by the bass and by the beat. `lw` scales the line weight. */
function vizOrb(g, cx, cy, R, e, mesh, yaw, seed, lw) {
  const t = vizT + seed * 7.3, cyaw = Math.cos(yaw), syaw = Math.sin(yaw), lean = 0.38 + tilt * 0.3, cl = Math.cos(lean), sl = Math.sin(lean), F = 3.4;
  const P = mesh.p, drop = dropVis;
  R *= (1 + 0.08 * vKick + 0.07 * vBass) * (1 - 0.12 * drop);
  for (let i = 0, k = 0; i < mesh.n; i++, k += 3) {
    const x = P[k], y = P[k + 1], z = P[k + 2];
    const n1 = Math.sin(x * 2.3 + t * 0.9) * Math.sin(y * 2.7 - t * 0.7) * Math.sin(z * 2.1 + t * 1.1);
    const n2 = Math.sin(x * 7.1 + t * 2.3) * Math.sin(y * 6.3 + t * 1.9) * Math.sin(z * 6.7 - t * 2.9);
    const bi = (y * 0.5 + 0.5) * (BARS - 1), b0 = bi | 0, sv = spec[b0] + (bi - b0) * (spec[Math.min(BARS - 1, b0 + 1)] - spec[b0]);
    const d = 0.05 * vBass + 0.1 * vKick + sv * sv * (0.2 + 0.3 * (0.5 + 0.5 * n1)) + 0.22 * vMid * n1 + 0.14 * vHigh * n2;
    vD[i] = d;
    const r = 1 + d, X = (x * cyaw + z * syaw) * r, Z0 = (z * cyaw - x * syaw) * r, Yr = y * r * cl - Z0 * sl, Z = y * r * sl + Z0 * cl, pk = F / (F - Z);
    vX[i] = cx + X * R * pk; vY[i] = cy - Yr * R * pk; vZ[i] = Z;
  }
  const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()], E = mesh.e;
  for (let k = 0; k < E.length; k += 2) {
    const a = E[k], b = E[k + 1], z = (vZ[a] + vZ[b]) * 0.5;
    const p = paths[z > 0.1 && vD[a] + vD[b] > 0.62 ? 4 : z < -0.45 ? 0 : z < 0 ? 1 : z < 0.5 ? 2 : 3];
    p.moveTo(vX[a], vY[a]); p.lineTo(vX[b], vY[b]);
  }
  const wire = drop > 0.1 ? '240,78,35' : '241,239,232';
  g.lineCap = 'butt'; g.lineJoin = 'round';
  g.lineWidth = lw;
  g.strokeStyle = `rgba(${wire},${0.1 * e})`; g.stroke(paths[0]);
  g.strokeStyle = `rgba(${wire},${0.2 * e})`; g.stroke(paths[1]);
  const core = g.createRadialGradient(cx, cy, 0, cx, cy, R * 1.02);                 // the ember inside: lit by the level, flares on the beat
  core.addColorStop(0, `rgba(240,78,35,${(0.2 + 0.5 * vLvl + 0.3 * vKick) * e})`); core.addColorStop(0.7, `rgba(120,34,14,${0.3 * e})`); core.addColorStop(1, 'rgba(9,9,10,0)');
  g.fillStyle = core; g.beginPath(); g.arc(cx, cy, R * 1.02, 0, 2 * Math.PI); g.fill();
  if (lw >= 1) { g.lineWidth = 4 * lw; g.strokeStyle = `rgba(240,78,35,${0.16 * e})`; g.stroke(paths[2]); g.stroke(paths[3]); g.stroke(paths[4]); }   // bloom under the near side
  g.lineWidth = lw; g.strokeStyle = `rgba(${wire},${0.5 * e})`; g.stroke(paths[2]);
  g.lineWidth = 1.2 * lw; g.strokeStyle = `rgba(${wire},${0.92 * e})`; g.stroke(paths[3]);
  g.lineWidth = 1.8 * lw; g.strokeStyle = `rgba(240,78,35,${e})`; g.stroke(paths[4]);                                             // where it is pushed furthest
}
/** The spectrum standing round a centre: bass at the sides, top end up and down, the same in all four quarters. */
function vizCrown(g, cx, cy, r0, maxLen, e) {
  g.save(); g.lineCap = 'round'; g.lineWidth = Math.max(1.2, 2 * Math.PI * r0 / (BARS * 4) * 0.5);
  for (let i = 0; i < BARS; i++) {
    const v = spec[i], len = (1.5 + v * v * maxLen) * e, u = (i + 0.5) / BARS * Math.PI / 2;
    g.strokeStyle = v > 0.8 ? HOT : `rgba(241,239,232,${(0.3 + 0.7 * v) * e})`;
    g.beginPath();
    for (const a of [u, Math.PI - u, Math.PI + u, -u]) { const c = Math.cos(a), s = Math.sin(a); g.moveTo(cx + c * r0, cy + s * r0); g.lineTo(cx + c * (r0 + len), cy + s * (r0 + len)); }
    g.stroke();
  }
  g.restore();
}
/** The rings thrown by the beats, about a centre; `R` is where a ring starts. */
function vizRings(g, cx, cy, R, e) {
  for (const q of vRings) {
    g.beginPath(); g.arc(cx, cy, q.r * R, 0, 2 * Math.PI);
    g.strokeStyle = `rgba(241,239,232,${q.a * 0.5 * e})`; g.lineWidth = 1 + 2 * q.a; g.stroke();
  }
}
function vizGlow(g, cx, cy, R, e) {
  const glow = g.createRadialGradient(cx, cy, R * 0.06, cx, cy, R);
  glow.addColorStop(0, `rgba(240,78,35,${(0.16 + 0.5 * vLvl + 0.3 * vKick) * e})`); glow.addColorStop(0.45, `rgba(240,78,35,${(0.05 + 0.16 * vLvl) * e})`); glow.addColorStop(1, 'rgba(240,78,35,0)');
  g.fillStyle = glow; g.beginPath(); g.arc(cx, cy, R, 0, 2 * Math.PI); g.fill();
}

// ── the tube: the small window on the Display that opens the visualizer ──────────────────────────
/** Draws it at (x, y), glass radius r, with its legend in `ink`, and remembers where it is for vizTap(). */
function vizTube(g, x, y, r, ink) {
  if (!vizOn) return;
  const a = 1 - vizE;
  if (a < 0.02) return;
  tubeGeom = { x, y, r: r + 14 };
  g.save(); g.globalAlpha = a;
  g.beginPath(); g.arc(x + 1, y + 2.5, r + 6, 0, 2 * Math.PI); g.fillStyle = 'rgba(0,0,0,.35)'; g.fill();
  const rim = g.createLinearGradient(x - r, y - r, x + r, y + r); rim.addColorStop(0, '#fafaf7'); rim.addColorStop(1, '#8f908c');
  g.beginPath(); g.arc(x, y, r + 5.5, 0, 2 * Math.PI); g.fillStyle = rim; g.fill(); g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 1; g.stroke();
  g.beginPath(); g.arc(x, y, r + 1.5, 0, 2 * Math.PI); g.fillStyle = '#19191b'; g.fill();
  g.save();
  g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI); g.fillStyle = '#060607'; g.fill(); g.clip();
  vizGlow(g, x, y, r * 1.5, 1);
  vizOrb(g, x, y, r * 0.5, 1, VM1, vizYaw, 0.3, 0.7);
  const shine = g.createLinearGradient(x - r, y - r, x + r * 0.3, y + r * 0.3);                // the glass
  shine.addColorStop(0, 'rgba(255,255,255,.22)'); shine.addColorStop(0.5, 'rgba(255,255,255,0)');
  g.fillStyle = shine; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  g.restore();
  g.font = '700 6.5px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillStyle = ink;
  g.fillText('V I S U A L', x, y + r + 18);
  g.restore();
}

// ── Reel: one reel, seen through. Rim, three spokes turning at tape speed, the orange hub ring, the spectrum, an orb ──
function vizReel(g, cx, cy, R, angle, e, seed) {
  if (e < 0.01) return;
  g.save();
  vizGlow(g, cx, cy, R * 1.25, e);
  g.strokeStyle = `rgba(241,239,232,${0.4 * e})`; g.lineWidth = Math.max(1.2, R * 0.008);
  g.beginPath(); g.arc(cx, cy, R, 0, 2 * Math.PI); g.stroke();
  g.strokeStyle = `rgba(241,239,232,${0.26 * e})`; g.lineWidth = 1;
  for (let k = 0; k < 3; k++) {
    const a = angle + k * 2 * Math.PI / 3, c = Math.cos(a), s = Math.sin(a), o = R * 0.055;
    g.beginPath();
    for (const sd of [-1, 1]) { g.moveTo(cx + c * R * 0.72 - s * o * sd, cy + s * R * 0.72 + c * o * sd); g.lineTo(cx + c * R * 0.985 - s * o * sd, cy + s * R * 0.985 + c * o * sd); }
    g.stroke();
  }
  g.beginPath(); g.arc(cx, cy, R * 0.7, 0, 2 * Math.PI); g.strokeStyle = `rgba(240,78,35,${0.85 * e})`; g.lineWidth = Math.max(1, R * 0.012); g.stroke();
  vizCrown(g, cx, cy, R * 0.745, R * 0.22, e);
  vizRings(g, cx, cy, R, e);
  const Ro = R * 0.44;
  vizOrb(g, cx, cy, Ro, e, Ro > 85 ? VM3 : VM2, vizYaw * (seed ? -1 : 1) + seed * 2, seed, 1);
  g.restore();
}

// ── Cassette: the shell as a wire drawing, the two spools as orbs in toothed hubs. `cw` is the shell's width ──
function vizCassette(g, cx, cy, cw, e) {
  if (e < 0.01) return;
  const u = cw / 100, hh = 31.5 * u, ink = a => `rgba(241,239,232,${a * e})`;
  g.save();
  g.translate(cx + tilt * u * 0.5, cy); g.rotate(tilt * 0.012);
  g.lineJoin = 'round';
  rr(g, -50 * u, -hh, 100 * u, 63 * u, 3.2 * u); g.fillStyle = `rgba(9,9,10,${0.55 * e})`; g.fill();
  g.strokeStyle = ink(0.75); g.lineWidth = 1.5; g.stroke();
  rr(g, -48.8 * u, -hh + 1.2 * u, 97.6 * u, 60.6 * u, 2.4 * u); g.strokeStyle = ink(0.18); g.lineWidth = 1; g.stroke();
  rr(g, -43 * u, -28 * u, 86 * u, 41 * u, 2 * u); g.strokeStyle = ink(0.3); g.stroke();
  // the label: the preset's name, by hand, as on the shell
  const v = presetSel.value, name = v.startsWith('user:') ? 'User ' + v.slice(5) : v || 'Custom';
  g.textBaseline = 'alphabetic'; g.textAlign = 'left'; g.font = `600 ${(6.2 * u).toFixed(1)}px ${HAND}`; g.fillStyle = ink(0.92);
  g.fillText(fitText(g, name, 66 * u), -39.5 * u, -20.6 * u);
  g.fillStyle = ink(0.22); g.fillRect(-39.5 * u, -19 * u, 68 * u, 1);
  g.beginPath(); g.arc(36.5 * u, -20.4 * u, 3.7 * u, 0, 2 * Math.PI); g.strokeStyle = ink(0.7); g.lineWidth = 1.2; g.stroke();
  g.font = `800 ${(4.4 * u).toFixed(1)}px ${FONT}`; g.textAlign = 'center'; g.fillStyle = ink(0.8);
  g.fillText(source === 'file' ? 'A' : source === 'loop' ? 'B' : 'L', 36.5 * u, -18.8 * u);
  // the two spools
  const hy = -1 * u, hx = 21.25 * u;
  [-1, 1].forEach((sd, i) => {
    const x = sd * hx, ang = i ? reelAngle * 1.03 + 1 : reelAngle, rt = 10.4 * u;
    vizGlow(g, x, hy, 20 * u, e);
    g.strokeStyle = ink(0.55); g.lineWidth = 1.2; g.beginPath(); g.arc(x, hy, rt, 0, 2 * Math.PI); g.stroke();
    g.beginPath();
    for (let k = 0; k < 6; k++) { const a = ang + k * Math.PI / 3, c = Math.cos(a), s = Math.sin(a); g.moveTo(x + c * rt, hy + s * rt); g.lineTo(x + c * (rt - 1.5 * u), hy + s * (rt - 1.5 * u)); }
    g.lineWidth = Math.max(2, 0.9 * u); g.strokeStyle = ink(0.75); g.stroke();
    vizCrown(g, x, hy, 11.6 * u, 3.6 * u, e);
    vizRings(g, x, hy, 16 * u, e * 0.7);
    vizOrb(g, x, hy, 7 * u, e, 7 * u > 70 ? VM3 : VM2, vizYaw * sd + i * 2, i, 1);
  });
  // the foot: guide holes, and the tape across the opening, lifting off the head on a dropout
  g.beginPath(); g.moveTo(-37 * u, hh); g.lineTo(-33 * u, 18.5 * u); g.lineTo(33 * u, 18.5 * u); g.lineTo(37 * u, hh);
  g.strokeStyle = ink(0.35); g.lineWidth = 1; g.stroke();
  for (const [x, r] of [[-28, 2.5], [28, 2.5], [-11.5, 1.8], [11.5, 1.8]]) { g.beginPath(); g.arc(x * u, 24.5 * u, r * u, 0, 2 * Math.PI); g.stroke(); }
  const yT = hh - 2.1 * u, lift = dropVis * 3.2 * u;
  g.strokeStyle = dropVis > 0.05 ? HOT : ink(0.8); g.lineWidth = Math.max(1.5, 0.5 * u);
  g.beginPath(); g.moveTo(-31 * u, yT); g.lineTo(-7 * u, yT); g.lineTo(0, yT - lift); g.lineTo(7 * u, yT); g.lineTo(31 * u, yT); g.stroke();
  g.strokeStyle = ink(0.4); g.lineWidth = 1;
  for (const [x, y] of [[-46.3, -27.8], [46.3, -27.8], [-46.3, 27.8], [46.3, 27.8]]) { g.beginPath(); g.arc(x * u, y * u, 1.5 * u, 0, 2 * Math.PI); g.stroke(); }
  g.restore();
}

// ── Unit: one large orb, the spectrum round it, dust thrown outward ──────────────────────────────
function vizUnit(g, W, H, dt, bypassed) {
  const e = vizE;
  if (e < 0.004) return;
  g.save();
  g.fillStyle = `rgba(9,9,10,${e})`; g.fillRect(0, 0, W, H);                       // the deck steps back
  const cx = W / 2, cy = H * 0.42, R0 = Math.min(W * 0.16, H * 0.2);
  vizGlow(g, cx, cy, R0 * 3.4, e);
  g.fillStyle = INK;
  for (const d of vDust) {
    d.d += dt * d.s * (0.12 + 1.6 * vHigh + 1.2 * vKick);
    if (d.d > 3.3) { d.d = 1.05; d.a = Math.random() * Math.PI * 2; }
    g.globalAlpha = e * (0.15 + 0.5 * d.w) * Math.min(1, (3.3 - d.d) * 1.2) * Math.min(1, (d.d - 1) * 4);
    const s = 1 + d.w * 1.4;
    g.fillRect(cx + Math.cos(d.a) * d.d * R0 - s / 2, cy + Math.sin(d.a) * d.d * R0 * 0.82 - s / 2, s, s);
  }
  g.globalAlpha = 1;
  vizRings(g, cx, cy, R0 * 1.05, e);
  const r0 = R0 * 1.52;
  g.beginPath(); g.arc(cx, cy, r0 - 5, 0, 2 * Math.PI); g.strokeStyle = `rgba(241,239,232,${0.1 * e})`; g.lineWidth = 1; g.stroke();
  vizCrown(g, cx, cy, r0, R0 * 0.62, e);
  vizOrb(g, cx, cy, R0 * (0.8 + 0.2 * e), e, VM3, vizYaw, 0, 1);
  // what stays from the deck: the name, the counter, and the real waveform along the bottom
  g.globalAlpha = e;
  g.textBaseline = 'alphabetic'; g.font = '700 10px ' + FONT; g.fillStyle = DIM; g.textAlign = 'left';
  g.fillText('T A P E   L O S S', 20, 26);
  const secs = Math.floor(played);
  g.textAlign = 'right'; g.font = '600 13px ' + MONO; g.fillStyle = INK;
  g.fillText(String(Math.floor(secs / 60)).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0'), W - 20, 26);
  drawAudio(g, W * 0.06, W * 0.94, H * 0.79, H * 0.95, bypassed, true);
  g.restore();
  vizHint(g, W, H - 14);
}
