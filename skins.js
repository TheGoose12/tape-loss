'use strict';
/* Tape Loss MK IV skins: three faces for the same effect.
     Unit      the machine as built in app.js: screen on the left, sections and knobs on the right.
     Cassette  a compact tape box: a cassette in a window, long faders either side, scene keys.
     Reel      a reel-to-reel deck: two big reels, the head block, two VU meters, wooden cheeks.
   On Cassette and Reel the faders and keys on the face are the same parameters as the knobs, and
   Edit opens the full pages beside the window. This file shares app.js's top-level names. */

const SKINS = ['unit', 'cassette', 'reel'];
const SKIN_LABEL = { unit: 'Unit', cassette: 'Cassette', reel: 'Reel' };
const FADERS = { left: ['speed', 'wow', 'loss'], right: ['grains', 'space', 'mix'] };
const FADER_NAME = { speed: 'Speed', wow: 'Wow', loss: 'Loss', grains: 'Grain', space: 'Space', mix: 'Mix' };
const SCENES = [['Worn cassette', 'Worn'], ['Fresh tape', 'Fresh'], ['Left in the sun', 'Sun'], ['Dictaphone', 'Dicta'],
  ['Rental VHS', 'VHS'], ['Shimmer grains', 'Shimmer'], ['Smeared memory', 'Smear'], ['Slow bloom', 'Bloom']];

// ── the controls on the face ─────────────────────────────────────────────────────────────────────
function buildFader(id, host) {
  const d = DEF[id], el = document.createElement('div');
  el.className = 'fader' + (d.bipolar ? ' bi' : '');
  el.tabIndex = 0; el.dataset.help = HELP[id] || d.label;
  el.setAttribute('role', 'slider'); el.setAttribute('aria-orientation', 'vertical'); el.setAttribute('aria-label', d.label);
  el.setAttribute('aria-valuemin', d.min); el.setAttribute('aria-valuemax', d.max);
  el.innerHTML = `<span class="lab">${FADER_NAME[id] || d.label}</span><div class="slot"><i class="fill"></i><i class="cap"></i></div><output></output>`;
  const slot = el.querySelector('.slot');
  let y0 = 0, n0 = 0, moved = false, lastTap = 0;
  el.addEventListener('pointerdown', e => {
    y0 = e.clientY; n0 = toNorm(d, values[id]); moved = false;
    showPage(d.group); select(id);                      // so Edit, if it is open, shows the same control
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
  });
  el.addEventListener('pointermove', e => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    if (!moved && Math.abs(e.clientY - y0) < 3) return;
    moved = true;
    setValue(id, fromNorm(d, clamp01(n0 + (y0 - e.clientY) / Math.max(60, slot.clientHeight - 42))));
    const g = GROUP[d.group];                            // moving a fader wakes its section: a fader that does nothing is no use
    if (g && values[g.sw] < .5) setValue(g.sw, 1);
  });
  el.addEventListener('pointerup', e => {
    if (moved) { lastTap = 0; return; }
    if (e.timeStamp - lastTap < 350) { setValue(id, d.def); lastTap = 0; } else lastTap = e.timeStamp;
  });
  el.addEventListener('focus', () => select(id));
  faderEls[id] = el; host.appendChild(el);
  refresh(id);
}
function caption(text, host) { const p = document.createElement('p'); p.className = 'legend'; p.textContent = text; host.appendChild(p); }
function skey(label, help, host) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'skey'; b.textContent = label; b.dataset.help = help; b.setAttribute('aria-pressed', 'false');
  host.appendChild(b);
  return b;
}

const sceneEls = {};
let editBtn = null;
for (const side of ['left', 'right']) {
  const host = $('#side-' + side);
  const fd = document.createElement('div'); fd.className = 'faders';
  FADERS[side].forEach(id => buildFader(id, fd));
  host.appendChild(fd);
  const keys = document.createElement('div');
  if (side === 'left') {
    caption('Scenes', host);
    keys.className = 'keys';
    for (const [name, short] of SCENES) {
      const b = skey(short, `Scene: ${name}. One tap sets every sound knob.`, keys);
      b.addEventListener('click', () => { applyPreset(name); say('Preset: ' + name); });
      sceneEls[name] = b;
    }
  } else {
    caption('Sections', host);
    keys.className = 'keys three';
    for (const g of GROUPS) {
      if (g.sub) continue;
      const b = skey(g.label, `Switch ${g.id === 'grain' ? 'Grains and Evolve' : g.label} on or off.`, keys);
      b.addEventListener('click', () => setValue(g.sw, values[g.sw] > .5 ? 0 : 1));
      switchEls[g.sw] = b;
      refresh(g.sw);
    }
    editBtn = skey('Edit', 'Edit: opens every section and knob beside the window. Tap again to close.', keys);
    editBtn.classList.add('edit');
    editBtn.addEventListener('click', () => setEditing(!document.body.classList.contains('editing')));
  }
  host.appendChild(keys);
}
function setEditing(on) {
  document.body.classList.toggle('editing', on);
  editBtn.setAttribute('aria-pressed', on);
}

const skinBtn = $('#skin');
function setSkin(s, quiet) {
  if (!SKINS.includes(s)) s = 'reel';
  skin = s;
  document.body.dataset.skin = s;
  document.body.classList.toggle('plate', s !== 'unit');
  if (s === 'unit') setEditing(false);
  skinBtn.textContent = SKIN_LABEL[s];
  try { localStorage.setItem('tapeloss.skin', s); } catch (_) {}
  if (!quiet) say('Skin: ' + SKIN_LABEL[s]);
}
skinBtn.addEventListener('click', () => setSkin(SKINS[(SKINS.indexOf(skin) + 1) % SKINS.length]));
window.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.target.tagName === 'SELECT') return;
  if (e.key.toLowerCase() === 'e' && skin !== 'unit') setEditing(!document.body.classList.contains('editing'));
});
{
  let s = new URLSearchParams(location.search).get('skin');
  try { s = s || localStorage.getItem('tapeloss.skin'); } catch (_) {}
  setSkin(s || 'reel', true);
}
window.tapeloss.setSkin = setSkin;
window.tapeloss.setEditing = setEditing;

// ── drawing: shared pieces ───────────────────────────────────────────────────────────────────────
const HAND = '"Bradley Hand", "Marker Felt", "Segoe Print", "Chalkboard SE", cursive';
const PAPER = '#efe8d6', INK_D = '#1c1c1a', TAPE = '#4a3826';
let vuIn = 0, vuOut = 0, lastScene = null, platePat = null;

const clock = () => { const s = Math.floor(played); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const statusNow = () => notice() || statusText;
function fitText(g, s, w) {
  if (g.measureText(s).width <= w) return s;
  while (s.length > 3 && g.measureText(s + '…').width > w) s = s.slice(0, -1);
  return s + '…';
}
const LAMP_NAMES = ['PLAY', 'REC', 'DROP', 'FREEZE', 'LIMIT', 'BYPASS'];
function skinLamps(g, x, y, bypassed, right) {
  const on = [playing, !!rec, dropVis > 0.15, frozen, gr < 0.985, bypassed], hot = [0, 1, 1, 0, 1, 0];
  g.font = '600 9px ' + FONT; g.textAlign = 'left';
  let w = -8; for (const n of LAMP_NAMES) w += g.measureText(n).width + 8;
  let lx = right ? x - w : x;
  LAMP_NAMES.forEach((name, i) => { g.fillStyle = on[i] ? (hot[i] ? HOT : INK) : FAINT; g.fillText(name, lx, y); lx += g.measureText(name).width + 8; });
  return w;
}
function backHint(g, W, y) {
  const age = performance.now() - showSince;
  if (age > 3500) return;
  g.globalAlpha = clamp01((3500 - age) / 800); g.textAlign = 'center'; g.font = '600 11px ' + FONT; g.fillStyle = DIM;
  g.fillText(notice() ? 'tap for sound · tap again to go back' : 'tap anywhere to go back', W / 2, y);
  g.globalAlpha = 1;
}
function levelBar(g, x, top, bot, v, name) {
  const n = Math.max(6, Math.floor((bot - top - 12) / 7)), sh = (bot - top - 12) / n;
  const lit = Math.round(n * clamp01((20 * Math.log10(Math.max(v, 1e-4)) + 42) / 42));
  for (let k = 0; k < n; k++) { g.fillStyle = k < lit ? (k >= n - 2 ? HOT : INK) : FAINT; g.fillRect(x, bot - 12 - (k + 1) * sh + 1, 7, sh - 2); }
  g.font = '8px ' + FONT; g.textAlign = 'center'; g.fillStyle = DIM; g.fillText(name, x + 3.5, bot);
}
const circle = (g, x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, TWO_PI); };

// The sticker: a strip of masking tape with the project's name in marker, stuck on each face. Just the name, no drawing.
// Empty the text, or open the page once with ?sticker=off, and it is gone (?sticker=on brings it back).
const STICKER_TEXT = 'Good Summers';
let stickerOn = true;
{
  const q = new URLSearchParams(location.search).get('sticker');
  try { if (q) localStorage.setItem('tapeloss.sticker', q); stickerOn = localStorage.getItem('tapeloss.sticker') !== 'off'; } catch (_) { stickerOn = q !== 'off'; }
}
/** Draws the sticker `h` tall, centred on (x, y), or with its left end at x when `left` is set.
 *  It shrinks to fit `maxW` and is left off when that would make it too small to read. Returns its width. */
function drawSticker(g, x, y, h, angle, maxW, left) {
  if (!stickerOn || !STICKER_TEXT) return 0;
  g.save();
  g.font = `700 ${(h * 0.68).toFixed(1)}px ${HAND}`;
  let w = g.measureText(STICKER_TEXT).width + h * 1.3;
  if (maxW && w > maxW) { h *= maxW / w; w = maxW; }
  if (h < 12) { g.restore(); return 0; }
  g.font = `700 ${(h * 0.68).toFixed(1)}px ${HAND}`;
  g.translate(left ? x + w / 2 : x, y); g.rotate(angle);
  const jag = h * 0.1, teeth = 5, strip = () => {                 // torn ends
    g.beginPath(); g.moveTo(-w / 2 + jag, -h / 2);
    g.lineTo(w / 2 - jag, -h / 2);
    for (let i = 1; i <= teeth; i++) g.lineTo(w / 2 - (i % 2 ? 0 : jag), -h / 2 + i / teeth * h);
    g.lineTo(-w / 2, h / 2);
    for (let i = 1; i <= teeth; i++) g.lineTo(-w / 2 + (i % 2 ? jag : 0), h / 2 - i / teeth * h);
    g.closePath();
  };
  g.save(); g.translate(1, 2); strip(); g.fillStyle = 'rgba(0,0,0,.35)'; g.fill(); g.restore();
  strip(); g.fillStyle = '#eadfb4'; g.fill();
  g.save(); g.clip();
  g.fillStyle = 'rgba(120,96,40,.07)'; for (let lx = -w / 2; lx < w / 2; lx += 3) g.fillRect(lx, -h / 2, 1, h);      // the crepe of the tape
  g.fillStyle = 'rgba(255,255,255,.22)'; g.fillRect(-w / 2, -h / 2, w, h * 0.18);
  g.restore();
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#1c1c1a';
  g.fillText(STICKER_TEXT, 0, h * 0.04);
  g.restore();
  return w;
}

function drawSkin(g, W, H, dt, bypassed, full) {
  if (presetSel.value !== lastScene) {                  // the scene keys light with the preset in use
    lastScene = presetSel.value;
    for (const n in sceneEls) sceneEls[n].setAttribute('aria-pressed', n === lastScene);
  }
  if (full) srcGeom = null;
  if (skin === 'reel') drawReelDeck(g, W, H, dt, bypassed, full); else drawCassetteDeck(g, W, H, dt, bypassed, full);
}

// ── Cassette ─────────────────────────────────────────────────────────────────────────────────────
/** A toothed hub, as seen through a cassette's spindle hole. */
function drawHub(g, x, y, r, angle) {
  g.save(); g.translate(x, y);
  circle(g, 0, 0, r * 1.22); g.fillStyle = '#0d0d0e'; g.fill();
  g.rotate(angle);
  circle(g, 0, 0, r); g.fillStyle = INK; g.fill();
  circle(g, 0, 0, r * 0.6); g.fillStyle = '#0d0d0e'; g.fill();
  g.fillStyle = INK;
  for (let i = 0; i < 6; i++) { g.save(); g.rotate(i * TWO_PI / 6); g.fillRect(r * 0.36, -r * 0.09, r * 0.3, r * 0.18); g.restore(); }
  g.restore();
}
/** The cassette: shell in the loaded tape's colour, a paper label written with the preset's name and
 *  printed with the sound's spectrum, two hubs turning at tape speed. It leans with the pitch, and a
 *  dropout lifts the tape off the head. One unit `u` is a hundredth of the shell's width. */
function drawCassette(g, cx, cy, cw, bypassed) {
  const u = cw / 100, hh = 31.5 * u, col = REELS[reelName] || REELS.silver;
  g.save();
  g.translate(cx + tilt * u * 0.5, cy); g.rotate(tilt * 0.012);
  g.globalAlpha = bypassed ? 0.5 : 1;
  rr(g, -50 * u + u, -hh + 2.4 * u, 100 * u, 63 * u, 3.2 * u); g.fillStyle = 'rgba(0,0,0,.5)'; g.fill();
  const shell = g.createLinearGradient(0, -hh, 0, hh); shell.addColorStop(0, col[0]); shell.addColorStop(1, col[1]);
  rr(g, -50 * u, -hh, 100 * u, 63 * u, 3.2 * u); g.fillStyle = shell; g.fill();
  g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = Math.max(1, u * 0.3); g.stroke();
  rr(g, -48.8 * u, -hh + 1.2 * u, 97.6 * u, 60.6 * u, 2.4 * u); g.strokeStyle = 'rgba(255,255,255,.28)'; g.stroke();

  // the label
  const lt = -28 * u, lb = 13 * u;
  rr(g, -43 * u, lt, 86 * u, lb - lt, 2 * u); g.fillStyle = PAPER; g.fill();
  const v = presetSel.value, name = v.startsWith('user:') ? 'User ' + v.slice(5) : v || 'Custom', t = curTape();
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  g.font = `600 ${(6.2 * u).toFixed(1)}px ${HAND}`; g.fillStyle = '#1d2a5c';
  g.fillText(fitText(g, name, 66 * u), -39.5 * u, -20.2 * u);
  g.font = `${(3.9 * u).toFixed(1)}px ${HAND}`; g.fillStyle = 'rgba(29,42,92,.75)';
  g.fillText(fitText(g, source === 'live' ? 'live input' : t.buf || source === 'file' ? t.title : 'nothing recorded yet', 66 * u), -39.5 * u, -13.6 * u);
  g.fillStyle = 'rgba(28,28,26,.22)'; g.fillRect(-39.5 * u, -18.6 * u, 68 * u, Math.max(1, u * 0.18)); g.fillRect(-39.5 * u, -12 * u, 68 * u, Math.max(1, u * 0.18));
  circle(g, 36.5 * u, -20 * u, 3.7 * u); g.strokeStyle = INK_D; g.lineWidth = Math.max(1, u * 0.35); g.stroke();
  g.font = `800 ${(4.4 * u).toFixed(1)}px ${FONT}`; g.textAlign = 'center'; g.fillStyle = INK_D;
  g.fillText(source === 'file' ? 'A' : source === 'loop' ? 'B' : 'L', 36.5 * u, -18.4 * u);
  // the spectrum, printed along the bottom of the label
  const sx0 = -39.5 * u, sw = 79 * u / BARS, sy = 11.4 * u;
  for (let i = 0; i < BARS; i++) {
    const s = spec[i];
    g.fillStyle = s > 0.8 ? HOT : INK_D; g.globalAlpha = (bypassed ? 0.5 : 1) * (0.3 + 0.7 * s);
    g.fillRect(sx0 + i * sw + sw * 0.2, sy - Math.max(0.35 * u, s * 5.6 * u), sw * 0.6, Math.max(0.35 * u, s * 5.6 * u));
  }
  g.globalAlpha = bypassed ? 0.5 : 1;

  // the window: tape packs behind it, the hubs through their holes
  const hy = -3 * u, hx = 21.25 * u;
  g.save();
  rr(g, -29 * u, hy - 7 * u, 58 * u, 14 * u, 1.6 * u); g.fillStyle = '#101012'; g.fill(); g.clip();
  for (const s of [-1, 1]) {
    circle(g, s * hx, hy, 17.5 * u); g.fillStyle = TAPE; g.fill();
    g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
    for (const k of [10, 13, 16]) { circle(g, s * hx, hy, k * u); g.stroke(); }
  }
  g.fillStyle = 'rgba(241,239,232,.3)';
  for (let i = -5; i <= 5; i++) g.fillRect(i * 2.2 * u - 0.5, hy + 5 * u, 1, (i % 5 ? 1.1 : 2) * u);
  g.restore();
  rr(g, -29 * u, hy - 7 * u, 58 * u, 14 * u, 1.6 * u); g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = Math.max(1, u * 0.3); g.stroke();
  drawHub(g, -hx, hy, 4.6 * u, reelAngle);
  drawHub(g, hx, hy, 4.6 * u, reelAngle * 1.03 + 1);

  // the foot: holes for the capstan and the guides, and the tape running across the opening
  g.beginPath(); g.moveTo(-37 * u, hh); g.lineTo(-33 * u, 16 * u); g.lineTo(33 * u, 16 * u); g.lineTo(37 * u, hh); g.closePath();
  g.fillStyle = 'rgba(0,0,0,.16)'; g.fill(); g.strokeStyle = 'rgba(0,0,0,.35)'; g.stroke();
  g.fillStyle = '#0d0d0e';
  for (const [x, r] of [[-28, 2.5], [28, 2.5], [-11.5, 1.8], [11.5, 1.8]]) { circle(g, x * u, 23 * u, r * u); g.fill(); }
  rr(g, -3 * u, 21.3 * u, 6 * u, 3.4 * u, 0.6 * u); g.fill();
  const yT = hh - 2.1 * u, lift = dropVis * 3.2 * u;
  g.strokeStyle = dropVis > 0.05 ? HOT : TAPE; g.lineWidth = 1.5 * u; g.lineJoin = 'round'; g.lineCap = 'butt';
  g.beginPath(); g.moveTo(-31 * u, yT); g.lineTo(-7 * u, yT); g.lineTo(0, yT - lift); g.lineTo(7 * u, yT); g.lineTo(31 * u, yT); g.stroke();
  g.fillStyle = 'rgba(0,0,0,.4)';
  for (const [x, y] of [[-46.3, -27.8], [46.3, -27.8], [-46.3, 27.8], [46.3, 27.8]]) { circle(g, x * u, y * u, 1.5 * u); g.fill(); }
  const gloss = g.createLinearGradient(0, -hh, 0, 0); gloss.addColorStop(0, 'rgba(255,255,255,.16)'); gloss.addColorStop(1, 'rgba(255,255,255,0)');
  rr(g, -50 * u, -hh, 100 * u, 31.5 * u, 3.2 * u); g.fillStyle = gloss; g.fill();
  // the deck's head, under the tape
  rr(g, -4.5 * u, hh + 0.4 * u, 9 * u, 3.6 * u, 0.8 * u); g.fillStyle = dropVis > 0.1 ? HOT : INK; g.fill();
  g.restore();
}

function drawCassetteDeck(g, W, H, dt, bypassed, full) {
  const pad = 16, x0 = pad, x1 = W - pad;
  g.textBaseline = 'alphabetic';
  if (full) {
    loud += (peakOut - loud) * Math.min(1, dt * 8);
    const glow = g.createRadialGradient(W / 2, H * 0.4, 0, W / 2, H * 0.4, Math.max(W, H) * 0.7);
    glow.addColorStop(0, `rgba(240,78,35,${0.05 + 0.22 * clamp01(loud * 1.4)})`); glow.addColorStop(1, 'rgba(240,78,35,0)');
    g.fillStyle = glow; g.fillRect(0, 0, W, H);
    g.font = '700 10px ' + FONT; g.fillStyle = DIM; g.textAlign = 'left'; g.fillText('T A P E   L O S S', 20, 26);
  } else {
    g.font = '600 12px ' + FONT; g.textAlign = 'left'; g.fillStyle = notice() || statusWarn ? HOT : INK;
    g.fillText(fitText(g, statusNow(), W >= 600 ? W / 2 - 100 - x0 : W - 2 * pad - 70), x0, 24);
    skinLamps(g, x0, 40, bypassed);
  }
  if (full || W >= 600) drawSticker(g, W / 2 + (full ? 0 : 30), 27, full ? 30 : 24, -0.035);
  const tm = clock(), tx = full ? W - 20 : x1;
  g.textAlign = 'right'; g.font = '600 13px ' + MONO; g.fillStyle = INK; g.fillText(tm, tx, full ? 26 : 24);
  if (!full) clockGeom = { x: tx - 84, y: 0, w: 100, h: 44 };
  if (playing && !full) { circle(g, tx - g.measureText(tm).width - 9, 20, 3.5); g.fillStyle = HOT; g.fill(); }

  const low = full ? clamp(H * 0.27, 110, 300) : clamp(H * 0.37, 150, 232);
  const top = full ? 46 : 54, bot = H - low - 16, side = full ? 0 : 60;
  const ch = Math.max(50, Math.min(bot - top, (W - 2 * pad - side) * 0.63));
  drawCassette(g, W / 2, (top + bot) / 2 - 2, ch / 0.63, bypassed);
  if (full) {
    if (typeof vizTube === 'function') {                 // the tube, top right; opened, the cassette is seen through
      const tr = clamp(Math.min(W, H) * 0.045, 22, 36);
      vizTube(g, W - 26 - tr, 46 + tr, tr, DIM);
      if (vizE > 0.004) {
        g.fillStyle = `rgba(9,9,10,${vizE})`; g.fillRect(0, 40, W, bot + 14 - 40);
        vizCassette(g, W / 2, (top + bot) / 2 - 2, ch / 0.63, vizE);
      }
    }
    drawAudio(g, W * 0.06, W * 0.94, H - low + 6, H - 30, bypassed, true);       // the same waveform as the working screen
    backHint(g, W, H - 10);
    if (typeof vizHint === 'function') vizHint(g, W, H - 10);
    return;
  }
  levelBar(g, x0, top + 4, bot, peakIn, 'IN');
  levelBar(g, x1 - 7, top + 4, bot, peakOut, 'OUT');
  const red = Math.min(1, -20 * Math.log10(Math.max(gr, 1e-3)) / 12);
  g.fillStyle = HOT; g.fillRect(x1 - 12, top + 4, 2.5, (bot - 12 - top - 4) * red);
  const sTop = H - low;
  drawSource(g, x0, x1, sTop, sTop + 48);
  const aTop = sTop + 48 + 14, rest = H - aTop - 10;
  if (rest > 112) { drawAudio(g, x0, x1, aTop, aTop + rest * 0.62, bypassed); drawMotion(g, x0, x1, aTop + rest * 0.62 + 10, H - 10, dt, bypassed); }
  else drawAudio(g, x0, x1, aTop, H - 10, bypassed);
}

// ── Reel ─────────────────────────────────────────────────────────────────────────────────────────
/** The deck's top plate: brushed aluminium, lit from above. */
function plate(g, W, H) {
  if (!platePat) {
    const c = document.createElement('canvas'); c.width = 64; c.height = 6;
    const p = c.getContext('2d');
    p.fillStyle = '#c4c5c1'; p.fillRect(0, 0, 64, 6);
    p.fillStyle = 'rgba(255,255,255,.22)'; p.fillRect(0, 0, 64, 1);
    p.fillStyle = 'rgba(0,0,0,.05)'; p.fillRect(0, 3, 64, 1);
    platePat = g.createPattern(c, 'repeat');
  }
  g.fillStyle = platePat; g.fillRect(0, 0, W, H);
  const sh = g.createLinearGradient(0, 0, 0, H);
  sh.addColorStop(0, 'rgba(255,255,255,.3)'); sh.addColorStop(0.5, 'rgba(255,255,255,0)'); sh.addColorStop(1, 'rgba(0,0,0,.2)');
  g.fillStyle = sh; g.fillRect(0, 0, W, H);
}
function screw(g, x, y, r) {
  circle(g, x, y, r); g.fillStyle = '#9d9e9a'; g.fill(); g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 1; g.stroke();
  g.beginPath(); g.moveTo(x - r * 0.6, y - r * 0.3); g.lineTo(x + r * 0.6, y + r * 0.3); g.stroke();
}
/** Where a line from (px,py) touches the circle: the left or the right of the two tangent points. */
function tangentPick(cx, cy, r, px, py, left) {
  const dx = px - cx, dy = py - cy, th = Math.atan2(dy, dx), a = Math.acos(Math.min(1, r / Math.hypot(dx, dy)));
  const p1 = { x: cx + Math.cos(th + a) * r, y: cy + Math.sin(th + a) * r }, p2 = { x: cx + Math.cos(th - a) * r, y: cy + Math.sin(th - a) * r };
  return (p1.x < p2.x) === left ? p1 : p2;
}
/** The centre of a roller of radius r that turns the tape from A, round the corner at C, towards B. */
function bendCentre(A, C, B, r) {
  let ux = C.x - A.x, uy = C.y - A.y, vx = B.x - C.x, vy = B.y - C.y;
  const ul = Math.hypot(ux, uy), vl = Math.hypot(vx, vy); ux /= ul; uy /= ul; vx /= vl; vy /= vl;
  const dot = clamp(ux * vx + uy * vy, -1, 1), t = r * Math.tan(Math.acos(dot) / 2);
  let nx = vx - ux * dot, ny = vy - uy * dot; const nl = Math.hypot(nx, ny) || 1;
  return { x: C.x - ux * t + nx / nl * r, y: C.y - uy * t + ny / nl * r };
}
/** Behind the tape: the reel's shadow on the plate, and the wound tape. */
function reelBack(g, cx, cy, R) {
  circle(g, cx + R * 0.02, cy + R * 0.05, R * 1.01); g.fillStyle = 'rgba(0,0,0,.3)'; g.fill();
  circle(g, cx, cy, R * 0.74); g.fillStyle = '#3a2d21'; g.fill();
  g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
  for (const k of [0.48, 0.58, 0.66, 0.71]) { circle(g, cx, cy, R * k); g.stroke(); }
}
/** In front of it: the flange with its three windows, the hub and the spindle, all turning. */
function reelFront(g, cx, cy, R, angle) {
  const col = REELS[reelName] || REELS.silver, s = R * 0.105, r1 = R * 0.4, r2 = R * 0.87;
  const o1 = Math.asin(s / r1), o2 = Math.asin(s / r2);
  g.save(); g.translate(cx, cy); g.rotate(angle);
  g.beginPath(); g.arc(0, 0, R, 0, TWO_PI);
  for (let i = 0; i < 3; i++) {
    const a = i * TWO_PI / 3, b = a + TWO_PI / 3;
    g.moveTo(Math.cos(a + o2) * r2, Math.sin(a + o2) * r2);
    g.arc(0, 0, r2, a + o2, b - o2); g.arc(0, 0, r1, b - o1, a + o1, true); g.closePath();
  }
  g.fillStyle = col[0]; g.fill('evenodd');
  g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = 1; g.stroke();
  circle(g, 0, 0, R); g.strokeStyle = col[1]; g.lineWidth = Math.max(1.5, R * 0.03); g.stroke();
  // hub: three screws and a three-pronged spindle
  circle(g, 0, 0, R * 0.3); g.fillStyle = col[1]; g.fill();
  circle(g, 0, 0, R * 0.26); g.fillStyle = col[0]; g.fill();
  circle(g, 0, 0, R * 0.335); g.strokeStyle = HOT; g.lineWidth = Math.max(1, R * 0.014); g.stroke();
  g.fillStyle = 'rgba(0,0,0,.45)';
  for (let i = 0; i < 3; i++) { const a = i * TWO_PI / 3 + 1.05; circle(g, Math.cos(a) * R * 0.19, Math.sin(a) * R * 0.19, R * 0.022); g.fill(); }
  g.fillStyle = '#17171a';
  circle(g, 0, 0, R * 0.075); g.fill();
  for (let i = 0; i < 3; i++) { g.save(); g.rotate(i * TWO_PI / 3); g.fillRect(0, -R * 0.022, R * 0.14, R * 0.044); g.restore(); }
  g.restore();
  const sheen = g.createLinearGradient(cx - R, cy - R, cx + R, cy + R);       // light across the flange; it does not turn with the reel
  sheen.addColorStop(0, 'rgba(255,255,255,.26)'); sheen.addColorStop(0.5, 'rgba(255,255,255,0)'); sheen.addColorStop(1, 'rgba(0,0,0,.2)');
  circle(g, cx, cy, R); g.fillStyle = sheen; g.fill();
}
function roller(g, x, y, r, dark) {
  circle(g, x + 1, y + 2, r); g.fillStyle = 'rgba(0,0,0,.28)'; g.fill();
  const m = g.createLinearGradient(x - r, y - r, x + r, y + r);
  m.addColorStop(0, dark ? '#4a4a4c' : '#fafaf7'); m.addColorStop(1, dark ? '#161617' : '#8f908c');
  circle(g, x, y, r); g.fillStyle = m; g.fill(); g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 1; g.stroke();
  circle(g, x, y, Math.max(1.5, r * 0.3)); g.fillStyle = dark ? '#b9bab6' : '#3a3a3c'; g.fill();
}
/** A VU meter: cream face, black scale, red above zero, a needle. `v` runs 0..1 with zero VU at 0.72. */
function drawVU(g, x, y, w, h, v, name, lit) {
  rr(g, x + 1, y + 2, w, h, 6); g.fillStyle = 'rgba(0,0,0,.3)'; g.fill();
  rr(g, x, y, w, h, 6); g.fillStyle = '#19191b'; g.fill();
  const fx = x + 4, fy = y + 4, fw = w - 8, fh = h - 8;
  const face = g.createLinearGradient(0, fy, 0, fy + fh);
  face.addColorStop(0, lit ? '#fff4d2' : '#e6dcbd'); face.addColorStop(1, lit ? '#f0dda2' : '#cbc09e');
  g.save();
  rr(g, fx, fy, fw, fh, 3); g.fillStyle = face; g.fill(); g.clip();
  const px = x + w / 2, py = fy + fh * 1.22, rad = fh * 0.98, a0 = -Math.PI / 2 - 0.76, a1 = -Math.PI / 2 + 0.76, az = a0 + (a1 - a0) * 0.72;
  const lw = Math.max(1.2, h * 0.028);
  g.lineCap = 'butt';
  g.strokeStyle = INK_D; g.lineWidth = lw; g.beginPath(); g.arc(px, py, rad, a0, az); g.stroke();
  g.strokeStyle = '#d2351a'; g.lineWidth = lw * 2.4; g.beginPath(); g.arc(px, py, rad - lw * 0.7, az, a1); g.stroke();
  g.lineWidth = lw;
  for (const t of [0, 0.16, 0.32, 0.46, 0.6, 0.72, 0.86, 1]) {
    const a = a0 + (a1 - a0) * t;
    g.strokeStyle = t > 0.72 ? '#d2351a' : INK_D;
    g.beginPath(); g.moveTo(px + Math.cos(a) * rad, py + Math.sin(a) * rad); g.lineTo(px + Math.cos(a) * (rad + h * 0.075), py + Math.sin(a) * (rad + h * 0.075)); g.stroke();
  }
  g.font = `700 ${Math.max(7, h * 0.13).toFixed(1)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillStyle = INK_D;
  g.fillText('VU', px, fy + fh * 0.66);
  const a = a0 + (a1 - a0) * clamp(v, 0, 1.04);
  g.strokeStyle = '#111'; g.lineWidth = Math.max(1.2, h * 0.022); g.lineCap = 'round';
  g.beginPath(); g.moveTo(px + Math.cos(a) * rad * 0.2, py + Math.sin(a) * rad * 0.2); g.lineTo(px + Math.cos(a) * (rad + h * 0.05), py + Math.sin(a) * (rad + h * 0.05)); g.stroke();
  g.fillStyle = '#19191b'; g.fillRect(fx, fy + fh * 0.8, fw, fh * 0.2);
  g.font = `700 ${Math.max(6.5, h * 0.1).toFixed(1)}px ${FONT}`; g.fillStyle = '#d9d4c2'; g.fillText(name, px, fy + fh * 0.95);
  g.restore();
}

function drawReelDeck(g, W, H, dt, bypassed, full) {
  g.textBaseline = 'alphabetic';
  plate(g, W, H);
  const band = full ? clamp(H * 0.24, 110, 280) : clamp(H * 0.31, 150, 196);
  const P = H - band - 4;                                        // the plate, above the glass
  const row = clamp(P * 0.27, 78, 124);                          // the head row, under the reels
  const R = Math.max(26, Math.min((P - row - 26) / 2, (W - 36) / 4.25));
  const sep = R * 1.07, xC = W / 2, xL = xC - sep, xR = xC + sep;
  const y0 = Math.max(10, (P - (2 * R + 12 + row)) / 2), cy = y0 + R, rowBot = cy + R + 12 + row, yT = cy + R + 32;
  for (const [x, y] of [[13, 13], [W - 13, 13], [13, P - 11], [W - 13, P - 11]]) screw(g, x, y, 4.5);
  // the visualizer (viz.js), opened from the Display's tube: the plate turns to black glass inside its frame
  const vz = full && typeof vizE !== 'undefined' ? vizE : 0;
  if (vz > 0.004) {
    g.save(); g.globalAlpha = vz;
    rr(g, 23, 23, W - 46, P - 38, 11); g.fillStyle = 'rgba(255,255,255,.5)'; g.fill();
    const pane = g.createLinearGradient(0, 24, 0, P); pane.addColorStop(0, '#17171a'); pane.addColorStop(1, '#0b0b0c');
    rr(g, 24, 24, W - 48, P - 40, 10); g.fillStyle = pane; g.fill();
    g.restore();
  }

  // the counter, in the gap above where the reels meet
  const chord = Math.sqrt(Math.max(0, R * R - (R - 30) * (R - 30))), cw = Math.min(104, 2 * (sep - chord) - 14);
  if (cw > 44) {
    if (!full) clockGeom = { x: xC - cw / 2 - 12, y: y0 - 8, w: cw + 24, h: 46 };
    rr(g, xC - cw / 2, y0 + 2, cw, 26, 5); g.fillStyle = '#19191b'; g.fill();
    rr(g, xC - cw / 2 + 3, y0 + 5, cw - 6, 20, 3); g.fillStyle = '#0b0b0c'; g.fill();
    g.font = `600 ${Math.min(13, cw / 6).toFixed(1)}px ${MONO}`; g.textAlign = 'center'; g.fillStyle = playing ? '#f6e7b4' : 'rgba(246,231,180,.6)';
    g.fillText(clock(), xC + (cw > 80 ? 5 : 0), y0 + 20);
    if (cw > 80) { circle(g, xC - cw / 2 + 13, y0 + 15, 3); g.fillStyle = rec ? HOT : playing ? '#f6e7b4' : 'rgba(246,231,180,.2)'; g.fill(); }
  }

  // the tape: off the left pack, round a roller, across the heads, round a roller, on to the right pack
  const pack = R * 0.74, rl = clamp(R * 0.075, 6, 11), lw = Math.max(2, R * 0.024);
  const gx = Math.min(sep + R * 0.78, W / 2 - 12 - rl), hw = clamp(W * 0.24, 92, 210);
  const CL = { x: xC - gx, y: yT }, CR = { x: xC + gx, y: yT };
  const tL = tangentPick(xL, cy, pack, CL.x, CL.y, true), tR = tangentPick(xR, cy, pack, CR.x, CR.y, false);
  g.globalAlpha = 1 - vz; reelBack(g, xL, cy, R); reelBack(g, xR, cy, R); g.globalAlpha = 1;
  const lift = dropVis * row * 0.16;
  g.strokeStyle = dropVis > 0.05 ? HOT : TAPE; g.lineWidth = lw; g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath(); g.moveTo(tL.x, tL.y); g.arcTo(CL.x, CL.y, CL.x + 40, yT, rl);
  g.lineTo(xC - hw * 0.46, yT); g.lineTo(xC, yT - lift); g.lineTo(xC + hw * 0.46, yT);
  g.arcTo(CR.x, CR.y, tR.x, tR.y, rl); g.lineTo(tR.x, tR.y); g.stroke();
  if (vz > 0.004 && dropVis <= 0.05) { g.strokeStyle = `rgba(241,239,232,${0.55 * vz})`; g.stroke(); }      // on the glass the tape is drawn light
  if (vz < 0.996) { g.globalAlpha = 1 - vz; reelFront(g, xL, cy, R, reelAngle); reelFront(g, xR, cy, R, reelAngle * 1.03 + 1); g.globalAlpha = 1; }
  if (vz > 0.004) { vizReel(g, xL, cy, R, reelAngle, vz, 0); vizReel(g, xR, cy, R, reelAngle * 1.03 + 1, vz, 1); }
  const bL = bendCentre(tL, CL, { x: CL.x + 40, y: yT }, rl), bR = bendCentre({ x: CR.x - 40, y: yT }, CR, tR, rl);
  roller(g, bL.x, bL.y, rl - lw / 2); roller(g, bR.x, bR.y, rl - lw / 2);

  drawSticker(g, 24, y0 + clamp(R * 0.17, 18, 28) * 0.5 + 6, clamp(R * 0.17, 18, 28), -0.05, xL - Math.sqrt(Math.max(0, R * R - (R - 44) * (R - 44))) - 30, true);

  // the heads under the tape, their cover, and the capstan with its pinch roller
  const hy = yT + lw / 2 + 0.5, cvY = yT + 15, cvH = rowBot - 6 - cvY;
  ['', 'HOT', ''].forEach((kind, i) => {
    const hxp = xC + (i - 1) * hw * 0.29;
    rr(g, hxp - 10, hy, 20, 16, 3); g.fillStyle = kind && dropVis > 0.1 ? HOT : '#ecebe6'; g.fill();
    g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 1; g.stroke();
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(hxp - 0.5, hy + 1, 1, 6);
  });
  rr(g, xC - hw / 2 + 1, cvY + 2, hw, cvH, 7); g.fillStyle = 'rgba(0,0,0,.3)'; g.fill();
  rr(g, xC - hw / 2, cvY, hw, cvH, 7); g.fillStyle = '#232325'; g.fill();
  g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1; g.stroke();
  g.font = '800 8px ' + FONT; g.textAlign = 'center'; g.fillStyle = '#d9d4c2';
  g.fillText('T A P E   L O S S', xC, cvY + cvH * 0.36 + 3);
  // drift: how far off pitch the tape is running right now, about a centre mark
  const sy = cvY + cvH * 0.66, swd = hw * 0.36;
  rr(g, xC - swd - 4, sy - 5, swd * 2 + 8, 10, 3); g.fillStyle = '#0b0b0c'; g.fill();
  g.fillStyle = 'rgba(241,239,232,.35)'; g.fillRect(xC - 0.5, sy - 5, 1, 10);
  g.fillStyle = bypassed ? DIM : HOT; g.fillRect(xC + clamp(cents / 60, -1, 1) * swd - 1.5, sy - 4, 3, 8);
  if (cvH > 56) { g.font = '600 6.5px ' + FONT; g.fillStyle = 'rgba(217,212,194,.6)'; g.fillText('D R I F T', xC, sy + 15); }
  const pr = rl * 1.1, pxp = xC + hw / 2 + pr + 8, away = reelSpeed > 0.05 ? 0 : pr * 0.5;
  if (pxp + pr < CR.x - rl) {
    roller(g, pxp, yT + lw / 2 + 4, 3.5);
    roller(g, pxp, yT - lw / 2 - pr - away, pr, true);
  }

  // the meters: what comes in, what goes out
  const zero = v => clamp((20 * Math.log10(Math.max(v, 1e-4)) + 26) / 29, 0, 1.04);
  const ti = playing ? zero(peakIn) : 0, to = playing ? zero(peakOut) : 0;
  vuIn += (ti - vuIn) * Math.min(1, dt * (ti > vuIn ? 14 : 5)); vuOut += (to - vuOut) * Math.min(1, dt * (to > vuOut ? 14 : 5));
  const vuTop = yT + 13, vuW = Math.min((rowBot - 6 - vuTop) * 1.75, gx - hw / 2 - 24), vuH = vuW / 1.75;
  if (vuW >= 58) {
    drawVU(g, xC - hw / 2 - 14 - vuW, vuTop, vuW, vuH, vuIn, 'I N', playing);
    drawVU(g, xC + hw / 2 + 14, vuTop, vuW, vuH, vuOut, 'O U T', playing);
  }

  // the glass under the plate: what is playing, the loop, the sound
  const bt = P, bx0 = 22, bx1 = W - 22;
  rr(g, 8, bt, W - 16, H - bt - 8, 10); g.fillStyle = 'rgba(255,255,255,.5)'; g.fill();
  const glass = g.createLinearGradient(0, bt, 0, H); glass.addColorStop(0, '#17171a'); glass.addColorStop(1, '#0b0b0c');
  rr(g, 9, bt + 1, W - 18, H - bt - 10, 9); g.fillStyle = glass; g.fill();
  if (full) {
    drawAudio(g, bx0 + 6, bx1 - 6, bt + 14, H - 24, bypassed, true);              // the same waveform as the working screen
    backHint(g, W, H - 14);
    if (typeof vizTube === 'function') {                 // the tube: top right, in the corner the right reel leaves free
      let tr = clamp(Math.min(W, H) * 0.045, 22, 36);
      while (tr > 16 && Math.hypot(W - 28 - tr - xR, 28 + tr - cy) < R + tr + 10) tr -= 2;
      vizTube(g, W - 28 - tr, 28 + tr, tr, 'rgba(28,28,26,.7)');
      vizHint(g, W, H - 14);
    }
    return;
  }
  const lampsW = W > 430 ? skinLamps(g, bx1, bt + 20, bypassed, true) : 0;
  g.font = '600 12px ' + FONT; g.textAlign = 'left'; g.fillStyle = notice() || statusWarn ? HOT : INK;
  g.fillText(fitText(g, statusNow(), bx1 - bx0 - lampsW - 16), bx0, bt + 21);
  drawSource(g, bx0, bx1, bt + 30, bt + 30 + 44);
  drawAudio(g, bx0, bx1, bt + 30 + 44 + 12, H - 16, bypassed);
}
