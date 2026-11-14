'use strict';
/* Tape Loss MK IV: the effect on its own, for an iPad on its side.
   Sound comes from one of three sources (Live, Loop, File), goes through the tape effect, and out.
   No tracks, no instruments. PARAM_DEFS, GROUPS and TapeCore come from dsp/tape-processor.js. */

const $ = s => document.querySelector(s);
const DEF = Object.fromEntries(PARAM_DEFS.map(d => [d.id, d]));
const KNOBS = PARAM_DEFS.filter(d => d.group !== 'switch');
const GROUP = Object.fromEntries(GROUPS.map(g => [g.id, g]));
GROUPS.forEach(g => { g.knobs = KNOBS.filter(d => d.group === g.id); });
const values = Object.fromEntries(PARAM_DEFS.map(d => [d.id, d.def]));    // where the knobs sit
const LIVE_ONLY = ['stop', 'bypass', 'drop', 'freeze'];                    // momentary: never saved, undone or bounced
const has = id => id in DEF;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = n => clamp(n, 0, 1);

// audio state, declared early because the controls talk to `node` as soon as they are built
let ctx = null, node = null, analyser = null, master = null;
let playing = false, source = 'file', thru = false;
let liveNode = null, liveStream = null, bufNode = null, bufT0 = 0, bufP0 = 0, bufRate = 1, rec = null;
// ls, le: where the loop starts and ends, in seconds. fi, fo: how long it fades in after the start and out before the end.
const tape = { file: { buf: null, title: 'Demo loop', ls: 0, le: 0, fi: 0, fo: 0, peaks: null }, loop: { buf: null, title: 'Loop', ls: 0, le: 0, fi: 0, fo: 0, peaks: null } };
const meters = [];
// Rec can wait for sound: armed, it starts the moment the input passes REC_LEVEL (about -36 dB), like auto sampling on a sampler
const REC_LEVEL = 0.016;
let recWait = true;
try { recWait = localStorage.getItem('tapeloss.recwait') !== '0'; } catch (_) {}
let statusText = 'Press Play', statusWarn = false;
// quiet when testing: 127.0.0.1 or ?mute runs the audio but sends silence to the speakers; a tap on the screen unmutes
let muted = location.hostname === '127.0.0.1' || new URLSearchParams(location.search).has('mute');

// ── what things do, in a sentence (the help line shows these) ────────────────────────────────────
const HELP = {
  speed: 'Speed: how fast the tape plays, for a Loop or a File. Half speed is an octave down and twice as long. A live input cannot be slowed.',
  wow: 'Wow: slow pitch drift, like a warped tape. Further round is deeper.',
  wowRate: 'Rate: how fast the wow goes round.',
  flutter: 'Flutter: a fast, fine shiver in the pitch.',
  wobble: 'Wobble: irregular drift, and the odd moment where the tape snags.',
  spread: 'Spread: lets the left and right sides drift apart.',
  drive: 'Saturate: pushes the sound into the tape for warmth, then grit.',
  loss: 'Loss: an older, duller tape. Treble and bass both narrow.',
  dropouts: 'Dropouts: moments where the tape loses contact and the sound dips.',
  hiss: 'Hiss: tape noise under everything.',
  grains: 'Amount: how much of the grain cloud you hear against the plain tape.',
  gPos: 'Position: how far back in the last few seconds the grains read from.',
  gSpray: 'Spray: scatters the grains in time and across the stereo field.',
  gSize: 'Size: how long each grain lasts.',
  gDensity: 'Density: how many grains start each second.',
  gShape: 'Shape: left is a hit that dies away, the middle a soft bell, right a swell.',
  gTone: 'Tone: right clears the low end out of the cloud, left darkens it.',
  gPitch: 'Pitch: moves the grains up or down in semitones.',
  gScatter: 'Scatter: some grains jump an octave or a fifth, so it stays in key.',
  gReverse: 'Reverse: the share of grains that play backwards.',
  gScan: 'Scan: slides the reading point through the tape on its own.',
  gFeedback: 'Feedback: records the cloud back onto its own tape, so it builds and keeps changing.',
  gDrift: 'Drift: slow random movement of position, size, pitch and density.',
  space: 'Space: how much reverb.',
  sDecay: 'Decay: how long the reverb rings on.',
  sTone: 'Tone: how bright the reverb tail stays.',
  sLow: 'Low: reverb level below 200 Hz. Keep it down for a clean bottom end.',
  sMid: 'Mid: reverb level from 200 to 800 Hz.',
  sMidHi: 'Mid-Hi: reverb level from 800 Hz to 3 kHz.',
  sHigh: 'High: reverb level from 3 to 8 kHz.',
  sAir: 'Hi-Fi: reverb level above 8 kHz, the air.',
  lowCut: 'Low cut: removes rumble below this frequency.',
  tone: 'Tone: tilts the whole sound darker or brighter.',
  glue: 'Glue: gentle compression that holds the sound together.',
  width: 'Width: from mono, through normal, to extra wide.',
  mix: 'Mix: the effect against the untouched sound. Keep it at 100% when this sits on a send.',
  output: 'Output: the final level.',
};
const SECTION_HELP = {
  motion: 'Motion: the tape speed wandering. The little line is the pitch right now.',
  tape: 'Tape: saturation, loss, dropouts and hiss. The bar is the level off the tape; it breaks up in a dropout.',
  grain: 'Grains: the tape cut into small overlapping pieces. The dots are grains sounding now.',
  evolve: 'Evolve: how the grain cloud moves and changes over time. It shares its switch with Grains.',
  space: 'Space: the reverb. The columns are how much is ringing in each range.',
  master: 'Master: low cut, tone, glue, width, mix and the limiter. Red is how hard the level is being held down.',
};
const HELP_IDLE = 'Touch a control to see what it does. Drag a knob up or down; double-tap it to reset.';

// Holds: while the pad is down these values replace the knob positions; letting go springs back.
const HOLDS = {
  stop:   { key: 's', label: 'Brake',  does: 'Brake: the tape winds down to a stop, and spins back up when you let go.', set: () => ({ stop: 1 }) },
  drop:   { key: 'd', label: 'Drop',   does: 'Drop: the tape lifts off the head; the sound falls away.', set: () => ({ drop: 1 }) },
  freeze: { key: 'f', label: 'Freeze', does: 'Freeze: the grains hold on to what they just heard.', set: () => ({ freeze: 1, onGrain: 1, grains: Math.max(values.grains, 0.85) }) },
  throw:  { key: 'g', label: 'Throw',  does: 'Throw: grains to full.', set: () => ({ onGrain: 1, grains: 1 }) },
  half:   { key: 'h', label: 'Half',   does: 'Half: grains an octave down.', set: () => ({ onGrain: 1, grains: 1, gPitch: -12 }) },
  melt:   { key: 'j', label: 'Melt',   does: 'Melt: wow and wobble to full.', set: () => ({ onMotion: 1, wow: 1, wobble: 1 }) },
  under:  { key: 'k', label: 'Under',  does: 'Under: loss to full, as if underwater.', set: () => ({ onTape: 1, loss: 1 }) },
  bloom:  { key: 'a', label: 'Bloom',  does: 'Bloom: feedback and space to full.', set: () => ({ onGrain: 1, onSpace: 1, grains: Math.max(values.grains, 0.7), gFeedback: 1, space: Math.max(values.space, 0.8) }) },
};
const holdOfKey = Object.fromEntries(Object.entries(HOLDS).map(([n, h]) => [h.key, n]));
const held = new Map();          // pad name → { o: the values it pushes, amt: 0..1 how far in it is, dir: +1 coming in, -1 going out }
let latchMode = 0;               // 0 off: a pad works while held. 1 latch: tap on, tap off. 2 smooth: the same, gliding in and out
const GLIDE_IN = 0.8, GLIDE_OUT = 1.2;
const isHeld = name => held.has(name) && held.get(name).dir > 0;

// presets set the sound sections; Master is left alone. `reel` picks what is loaded on the deck.
const PRESET_BASE = Object.fromEntries(KNOBS.filter(d => d.group !== 'master' && d.id !== 'speed').map(d => [d.id, d.def]));   // a preset leaves the speed where it is
const PRESETS = {
  'Worn cassette':    { reel: 'silver', wow: .35, wowRate: .6,  flutter: .25, wobble: .3,  spread: .3,  drive: .3,  loss: .35, dropouts: .15, hiss: .25 },
  'Fresh tape':       { reel: 'white',  wow: .15, wowRate: .5,  flutter: .1,  wobble: .1,  spread: .2,  drive: .2,  loss: .1,  dropouts: 0,   hiss: .1  },
  'Left in the sun':  { reel: 'orange', wow: .8,  wowRate: .35, flutter: .35, wobble: .8,  spread: .5,  drive: .5,  loss: .55, dropouts: .35, hiss: .35 },
  'Dictaphone':       { reel: 'smoke',  wow: .3,  wowRate: 1.6, flutter: .6,  wobble: .3,  spread: 0,   drive: .7,  loss: .9,  dropouts: .3,  hiss: .5  },
  'Rental VHS':       { reel: 'black',  wow: .25, wowRate: .3,  flutter: .5,  wobble: .5,  spread: .6,  drive: .25, loss: .3,  dropouts: .5,  hiss: .2  },
  'Shimmer grains':   { reel: 'gold',   wow: .3,  wowRate: .5,  flutter: .2,  wobble: .3,  spread: .5,  drive: .3,  loss: .3,  dropouts: .1,  hiss: .2,
                        grains: .5,  gPos: .2, gSpray: .5, gSize: .22, gDensity: 30, gShape: .5, gPitch: 12, gScatter: .3, gReverse: .2, gFeedback: .35, gDrift: .4, space: .45, sDecay: .75 },
  'Smeared memory':   { reel: 'ice',    wow: .5,  wowRate: .4,  flutter: .25, wobble: .5,  spread: .6,  drive: .35, loss: .5,  dropouts: .2,  hiss: .3,
                        grains: .75, gPos: 1.2, gSpray: .8, gSize: .5, gDensity: 18, gShape: .5, gReverse: .4, gScan: -.5, gFeedback: .5, gDrift: .7, space: .5, sDecay: .8 },
  'Octave-down dust': { reel: 'rust',   wow: .35, wowRate: .6,  flutter: .3,  wobble: .4,  spread: .4,  drive: .45, loss: .45, dropouts: .25, hiss: .3,
                        grains: .6,  gSpray: .4, gSize: .3, gDensity: 12, gShape: .2, gPitch: -12, gDrift: .3, space: .2 },
  'Slow bloom':       { reel: 'gold',   wow: .2,  wowRate: .3,  flutter: .1,  wobble: .3,  spread: .5,  drive: .2,  loss: .25, dropouts: 0,   hiss: .1,
                        grains: .85, gPos: 1, gSpray: .9, gSize: 1.2, gDensity: 8, gShape: .5, gScatter: .5, gReverse: .5, gScan: -.25, gFeedback: .7, gDrift: .8, space: .7, sDecay: .9, sTone: .5 },
  'Glass stutter':    { reel: 'ice',    wow: .15, wowRate: .8,  flutter: .2,  wobble: .1,  spread: .4,  drive: .25, loss: .15, dropouts: .1,  hiss: .1,
                        grains: .7,  gSpray: .05, gSize: .04, gDensity: 40, gShape: .1, gScatter: .6, gFeedback: .2, gDrift: .5, space: .25, sDecay: .5 },
  'Clean (all off)':  { reel: 'silver', wow: 0,   wowRate: .6,  flutter: 0,   wobble: 0,   spread: 0,   drive: 0,   loss: 0,   dropouts: 0,   hiss: 0   },
};
const PRESET_NAMES = Object.keys(PRESETS), USER = ['A', 'B', 'C', 'D'];
let userPresets = {}, reelName = 'silver';
try { userPresets = JSON.parse(localStorage.getItem('warble.user') || '{}') || {}; } catch (_) {}

// ── values ───────────────────────────────────────────────────────────────────────────────────────
const knobEls = {}, tiles = {}, pages = {}, powers = {}, miniCv = {};
const faderEls = {}, switchEls = {};      // the faders and section keys on the Cassette and Reel faces (skins.js)
let skin = 'unit';
const presetSel = $('#preset');
let sel = KNOBS[0].id, page = GROUPS[0].id;

const toNorm = (d, v) => Math.pow((v - d.min) / (d.max - d.min), 1 / (d.skew || 1));
const fromNorm = (d, n) => d.min + (d.max - d.min) * Math.pow(n, d.skew || 1);
function fmt(d, v) {
  if (d.unit === 'cut') return Math.abs(v) < 0.02 ? 'flat' : v > 0 ? 'low cut ' + Math.round(30 * Math.pow(40, v)) + ' Hz' : 'high cut ' + (18 * Math.pow(800 / 18000, -v)).toFixed(1) + ' k';
  if (d.unit === '%') return Math.round(v * 100) + '%';
  if (d.unit === 'spd') return v.toFixed(2) + '×';
  if (d.unit === 'Hz') return (v < 10 ? v.toFixed(2) : Math.round(v)) + ' Hz';
  if (d.unit === 'dB') return (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
  if (d.unit === 'tilt') return (v > 0 ? '+' : '') + (v * 6).toFixed(1) + ' dB';
  if (d.unit === 'ms') return v >= 1 ? v.toFixed(2) + ' s' : Math.round(v * 1000) + ' ms';
  if (d.unit === 's') return v.toFixed(1) + ' s';
  if (d.unit === 'st') return (v > 0 ? '+' : '') + Math.round(v) + ' st';
  if (d.unit === 'x') return (v > 0 ? '+' : '') + v.toFixed(2) + '×';
  if (d.unit === '/s') return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' /s';
  return String(v);
}
/** What the effect should hear right now: the knob, unless a pad is pushing it. */
function effective(id) {
  let v = values[id];
  for (const h of held.values()) if (id in h.o) {
    const d = DEF[id];
    if (h.amt >= 1 || d.group === 'switch') { v = h.o[id]; continue; }     // switches go over at once; the knobs glide
    const g = GROUP[d.group], base = g && values[g.sw] < .5 && d.off !== undefined ? d.off : v;
    v = base + (h.o[id] - base) * h.amt * h.amt * (3 - 2 * h.amt);
  }
  return v;
}
/** The same, but the neutral value when the knob's section is switched off. */
function audible(id) {
  const g = GROUP[DEF[id].group];
  return g && effective(g.sw) < .5 && DEF[id].off !== undefined ? DEF[id].off : effective(id);
}
function refresh(id) {
  const d = DEF[id], v = effective(id);
  if (node) node.parameters.get(id).value = v;
  const el = knobEls[id];
  if (el) {
    const n = toNorm(d, v), arc = el.querySelector('.val');
    if (d.bipolar) {
      arc.setAttribute('stroke-dasharray', `${(Math.abs(n - .5) * 100).toFixed(2)} 100`);
      arc.setAttribute('stroke-dashoffset', (-Math.min(n, .5) * 100).toFixed(2));
    } else arc.setAttribute('stroke-dasharray', `${(n * 100).toFixed(2)} 100`);
    el.querySelector('.cap').setAttribute('transform', `rotate(${-135 + 270 * n} 32 32)`);
    el.querySelector('output').textContent = fmt(d, v);
    el.setAttribute('aria-valuenow', v.toFixed(3));
    el.setAttribute('aria-valuetext', fmt(d, v));
    el.classList.toggle('pushed', v !== values[id]);
  }
  for (const g of GROUPS) if (g.sw === id) {
    tiles[g.id].classList.toggle('off', v < .5);
    pages[g.id].classList.toggle('off', v < .5);
    powers[g.id].setAttribute('aria-pressed', v > .5);
  }
  const fd = faderEls[id];
  if (fd) {
    fd.style.setProperty('--n', toNorm(d, v).toFixed(4));
    fd.querySelector('output').textContent = fmt(d, v);
    fd.setAttribute('aria-valuenow', v.toFixed(3)); fd.setAttribute('aria-valuetext', fmt(d, v));
    fd.classList.toggle('pushed', v !== values[id]);
  }
  if (switchEls[id]) switchEls[id].setAttribute('aria-pressed', v > .5);
  if (id === 'limit' && limiterBtn) limiterBtn.setAttribute('aria-pressed', v > .5);
  if (id === 'bypass') $('#bypass').setAttribute('aria-pressed', v > .5);
  if (id === 'speed' || id === 'onMotion' || id === 'bypass') applySpeed();
}
/** Tape speed: the loop or file plays faster or slower. Bypass, or Motion switched off, plays it straight. */
function applySpeed() {
  const r = values.bypass > .5 ? 1 : audible('speed');
  if (bufNode && ctx) {
    const t = curTape(), len = Math.max(0.02, t.le - t.ls);
    bufP0 = (bufP0 + (ctx.currentTime - bufT0) * bufRate) % len; bufT0 = ctx.currentTime;
    bufNode.playbackRate.setTargetAtTime(r, ctx.currentTime, 0.04);       // a short glide, like a motor changing speed
  }
  bufRate = r;
}
function setValue(id, v, quiet) {
  const d = DEF[id];
  if (d.step) v = Math.round(v / d.step) * d.step;
  if (id === 'speed') for (const stop of [0.5, 1, 2]) if (Math.abs(v - stop) < 0.03 * stop) v = stop;     // it clicks into half, normal and double
  values[id] = clamp(v, d.min, d.max);
  refresh(id);
  if (!quiet && d.group !== 'switch' && d.group !== 'master' && id !== 'speed') presetSel.value = '';
  if (!LIVE_ONLY.includes(id)) histMark();
}

// ── pads ─────────────────────────────────────────────────────────────────────────────────────────
function holdStart(name) {
  let h = held.get(name);
  if (h) { if (h.dir > 0) return; h.dir = 1; }                // caught on its way out: bring it back in from where it is
  else held.set(name, h = { o: HOLDS[name].set(), amt: latchMode === 2 ? 0 : 1, dir: 1 });
  Object.keys(h.o).forEach(refresh);
  padEls[name].classList.add('down');
}
function holdEnd(name) {
  const h = held.get(name);
  if (!h) return;
  padEls[name].classList.remove('down');
  if (latchMode === 2 && h.amt > 0) { h.dir = -1; return; }   // smooth: let it glide out; glideHolds finishes the job
  held.delete(name);
  Object.keys(h.o).forEach(refresh);
}
/** Smooth latch: move every pad that is on its way in or out a little further. Called once a frame. */
function glideHolds(dt) {
  for (const [name, h] of held) {
    if (h.dir > 0 && h.amt >= 1) continue;
    h.amt = h.dir > 0 ? Math.min(1, h.amt + dt / GLIDE_IN) : h.amt - dt / GLIDE_OUT;
    if (h.amt <= 0) held.delete(name);
    Object.keys(h.o).forEach(refresh);
  }
}
const padEls = {};
for (const name in HOLDS) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'pad'; b.textContent = HOLDS[name].label; b.dataset.help = HOLDS[name].does;
  b.addEventListener('pointerdown', e => {
    if (latchMode) return isHeld(name) ? holdEnd(name) : holdStart(name);
    holdStart(name);
    try { b.setPointerCapture(e.pointerId); } catch (_) {}     // capture keeps the pad held if the finger slides off it
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t => b.addEventListener(t, () => { if (!latchMode) holdEnd(name); }));
  b.addEventListener('contextmenu', e => e.preventDefault());
  padEls[name] = b; $('#pads').appendChild(b);
}
$('#latch').addEventListener('click', () => {
  latchMode = (latchMode + 1) % 3;
  $('#latch').setAttribute('aria-pressed', latchMode > 0);
  $('#latch-state').textContent = ['off', 'on', 'smooth'][latchMode];
  if (!latchMode) [...held.keys()].forEach(holdEnd);
});

// ── knobs, chain, pages ──────────────────────────────────────────────────────────────────────────
document.body.insertAdjacentHTML('beforeend',
  '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><radialGradient id="capGrad" cx=".35" cy=".3" r=".9">' +
  '<stop offset="0" stop-color="#fdfcf9"/><stop offset="1" stop-color="#b9b8b1"/></radialGradient>' +
  '<radialGradient id="capMetal" cx=".35" cy=".3" r=".9"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#c3c6c8"/><stop offset="1" stop-color="#84888b"/></radialGradient>' +
  '<radialGradient id="capCream" cx=".35" cy=".3" r=".9"><stop offset="0" stop-color="#fdf8e8"/><stop offset=".6" stop-color="#ddd5be"/><stop offset="1" stop-color="#a39b83"/></radialGradient></defs></svg>');

function buildKnob(d, host) {
  const el = document.createElement('div');
  el.className = 'knob' + (d.small ? ' small' : '');
  el.tabIndex = 0; el.dataset.help = HELP[d.id] || d.label;
  el.setAttribute('role', 'slider'); el.setAttribute('aria-label', d.label);
  el.setAttribute('aria-valuemin', d.min); el.setAttribute('aria-valuemax', d.max);
  el.innerHTML = `
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path class="track" d="M12.2 51.8 A28 28 0 1 1 51.8 51.8"/>
      <path class="val" d="M12.2 51.8 A28 28 0 1 1 51.8 51.8" pathLength="100" stroke-dasharray="0 100"/>
      <g class="cap"><circle class="cap-body" cx="32" cy="32" r="20"/><line class="tick" x1="32" y1="15" x2="32" y2="24"/></g>
    </svg><span class="lab">${d.label}</span><output></output>`;
  let y0 = 0, n0 = 0, moved = false, lastTap = 0;
  el.addEventListener('pointerdown', e => {
    y0 = e.clientY; n0 = toNorm(d, values[d.id]); moved = false;
    select(d.id);
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
  });
  el.addEventListener('pointermove', e => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    if (!moved && Math.abs(e.clientY - y0) < 3) return;
    moved = true;
    setValue(d.id, fromNorm(d, clamp01(n0 + (y0 - e.clientY) / (e.shiftKey ? 900 : 200))));
  });
  el.addEventListener('pointerup', e => {            // a second tap within a moment, without a drag, resets it
    if (moved) { lastTap = 0; return; }
    if (e.timeStamp - lastTap < 350) { setValue(d.id, d.def); lastTap = 0; } else lastTap = e.timeStamp;
  });
  el.addEventListener('focus', () => select(d.id));
  knobEls[d.id] = el;
  host.appendChild(el);
}
function select(id) {
  if (knobEls[sel]) knobEls[sel].classList.remove('sel');
  sel = id;
  knobEls[id].classList.add('sel');
}
function showPage(id) {
  page = id;
  for (const g of GROUPS) {
    tiles[g.id].classList.toggle('active', g.id === id);
    tiles[g.id].setAttribute('aria-selected', g.id === id);
    pages[g.id].classList.toggle('active', g.id === id);
  }
  if (DEF[sel].group !== id) select(GROUP[id].knobs[0].id);
}
let limiterBtn = null;
for (const g of GROUPS) {
  // the tile in the chain: lamp, name, and a small live display of what the section is doing
  const t = document.createElement('button');
  t.type = 'button'; t.className = 'tile'; t.setAttribute('role', 'tab');
  t.dataset.help = (SECTION_HELP[g.id] || g.label) + ' Tap to open it; tap its lamp to switch it on or off.';
  t.innerHTML = `<span class="led"></span><span class="nm">${g.label}</span><canvas class="mini" aria-hidden="true"></canvas>`;
  t.addEventListener('click', e => {
    if (e.target.classList.contains('led')) setValue(g.sw, values[g.sw] > .5 ? 0 : 1);
    else showPage(g.id);
  });
  miniCv[g.id] = t.querySelector('canvas');
  tiles[g.id] = t; $('#chain').appendChild(t);

  // its page of controls
  const p = document.createElement('section');
  p.className = 'page'; p.setAttribute('aria-label', g.label);
  const head = document.createElement('header');
  head.innerHTML = `<h2>${g.label}</h2>`;
  const pw = document.createElement('button');
  pw.type = 'button'; pw.className = 'power'; pw.innerHTML = '<span class="led"></span>On';
  pw.dataset.help = `Switch ${g.sub ? 'Grains and Evolve' : g.label} on or off. Off sends it to neutral without moving its knobs.`;
  pw.addEventListener('click', () => setValue(g.sw, values[g.sw] > .5 ? 0 : 1));
  powers[g.id] = pw; head.appendChild(pw);
  const body = document.createElement('div'); body.className = 'body';
  if (g.id === 'space' || g.id === 'master') {
    const cv = document.createElement('canvas'); cv.className = 'scope'; cv.id = g.id + '-scope';
    cv.dataset.help = g.id === 'space' ? 'The reverb in five ranges, with the orange line showing where the five range knobs are set.'
      : 'What is going out in five ranges, with the master EQ (low cut and tone) drawn over it. Red at the right is gain reduction.';
    body.appendChild(cv);
  }
  const k = document.createElement('div'); k.className = 'knobs';
  g.knobs.forEach(d => buildKnob(d, k));
  if (g.id === 'master') {
    limiterBtn = document.createElement('button');
    limiterBtn.type = 'button'; limiterBtn.className = 'key-btn toggle limiter'; limiterBtn.textContent = 'Limiter';
    limiterBtn.dataset.help = 'Limiter: a safety net on the very end, so the output never clips.';
    limiterBtn.addEventListener('click', () => setValue('limit', values.limit > .5 ? 0 : 1));
    k.appendChild(limiterBtn);
  }
  body.appendChild(k);
  p.append(head, body);
  pages[g.id] = p; $('#pages').appendChild(p);
}

// Under the pages, in a strip of its own because it belongs to no section: how Rec starts. The moment you
// press it, or armed and waiting for the first sound.
{
  const seg = document.createElement('div');
  seg.className = 'seg recmode'; seg.id = 'rec-mode'; seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'How Rec starts');
  seg.dataset.help = 'Rec instant: recording starts the moment you press Rec. Rec on sound: Rec arms, and recording starts by itself with the first sound that comes in.';
  seg.innerHTML = '<button type="button" role="radio" data-wait="0">Rec instant</button><button type="button" role="radio" data-wait="1">Rec on sound</button>';
  const showMode = () => seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', (b.dataset.wait === '1') === recWait));
  seg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    recWait = b.dataset.wait === '1'; showMode();
    try { localStorage.setItem('tapeloss.recwait', recWait ? '1' : '0'); } catch (_) {}
    say(recWait ? 'Rec will wait for the first sound' : 'Rec starts the moment you press it');
  });
  showMode();
  $('#recbar').appendChild(seg);
}

// ── help line: for touch, it shows what you last touched ─────────────────────────────────────────
const helpEl = $('#help');
function showHelp(target) {
  const n = target && target.closest ? target.closest('[data-help]') : null;
  helpEl.textContent = n ? n.dataset.help : HELP_IDLE;
}
document.addEventListener('pointerdown', e => showHelp(e.target), true);
document.addEventListener('pointerover', e => { if (e.pointerType === 'mouse') showHelp(e.target); });
document.addEventListener('focusin', e => showHelp(e.target));
showHelp(null);

// ── presets, A/B, undo ───────────────────────────────────────────────────────────────────────────
function snap() {
  const o = { reel: reelName, preset: presetSel.value };
  for (const d of PARAM_DEFS) if (!LIVE_ONLY.includes(d.id)) o[d.id] = values[d.id];
  return o;
}
function applySnap(o) {
  for (const id in o) if (has(id)) setValue(id, o[id], true);
  reelName = o.reel || reelName;
  presetSel.value = o.preset || '';
}
function buildPresetMenu() {
  const cur = presetSel.value;
  presetSel.innerHTML = '<option value="">Custom</option>' +
    '<optgroup label="Factory">' + PRESET_NAMES.map(n => `<option value="${n}">${n}</option>`).join('') + '</optgroup>' +
    '<optgroup label="Yours">' + USER.map(u => `<option value="user:${u}"${userPresets[u] ? '' : ' disabled'}>User ${u}${userPresets[u] ? '' : ' (empty)'}</option>`).join('') + '</optgroup>' +
    '<optgroup label="Save what you have now">' + USER.map(u => `<option value="save:${u}">Save to User ${u}${userPresets[u] ? ' (replace)' : ''}</option>`).join('') + '</optgroup>';
  presetSel.value = cur;
}
function applyPreset(name) {
  const p = PRESETS[name]; if (!p) return;
  const all = Object.assign({}, PRESET_BASE, p);
  for (const id in all) if (has(id)) setValue(id, all[id], true);
  if (all.grains > 0) setValue('onGrain', 1, true);       // a preset that uses a section switches it on
  if (all.space > 0) setValue('onSpace', 1, true);
  reelName = p.reel || 'silver';
  presetSel.value = name;
}
function saveUser(u) {
  userPresets[u] = snap();
  try { localStorage.setItem('warble.user', JSON.stringify(userPresets)); } catch (_) {}
  buildPresetMenu();
  presetSel.value = 'user:' + u;
  say(`Saved to User ${u}`);
}
function applyUser(u) {
  const p = userPresets[u]; if (!p) return;
  for (const id in p) if (has(id)) setValue(id, p[id], true);
  reelName = p.reel || 'silver';
  presetSel.value = 'user:' + u;
}
presetSel.addEventListener('change', () => {
  const v = presetSel.value;
  if (v.startsWith('save:')) saveUser(v.slice(5));
  else if (v.startsWith('user:')) applyUser(v.slice(5));
  else applyPreset(v);
  presetSel.blur();
});
function stepPreset(dir) {
  const list = [...PRESET_NAMES, ...USER.filter(u => userPresets[u]).map(u => 'user:' + u)];
  let i = list.indexOf(presetSel.value);
  i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
  const v = list[i];
  if (v.startsWith('user:')) applyUser(v.slice(5)); else applyPreset(v);
  say('Preset: ' + (v.startsWith('user:') ? 'User ' + v.slice(5) : v));
}
$('#preset-prev').addEventListener('click', () => stepPreset(-1));
$('#preset-next').addEventListener('click', () => stepPreset(1));

const ab = { cur: 'A', A: null, B: null };
function setAB(k) {
  if (k === ab.cur) return;
  ab[ab.cur] = snap();
  if (!ab[k]) ab[k] = snap();          // first visit: B starts as a copy of A
  ab.cur = k;
  applySnap(ab[k]);
  document.querySelectorAll('#ab button').forEach(b => b.setAttribute('aria-checked', b.dataset.ab === k));
  say('Comparing: now on ' + k);
}
document.querySelectorAll('#ab button').forEach(b => b.addEventListener('click', () => setAB(b.dataset.ab)));

const hist = { past: [], future: [], last: null, timer: 0, lock: false };
function histSync() { $('#undo').disabled = !hist.past.length; $('#redo').disabled = !hist.future.length; }
function histCommit() {
  clearTimeout(hist.timer); hist.timer = 0;
  const now = snap();
  if (hist.last && JSON.stringify(now) !== JSON.stringify(hist.last)) {
    hist.past.push(hist.last); if (hist.past.length > 80) hist.past.shift();
    hist.future.length = 0;
  }
  hist.last = now;
  histSync();
}
function histMark() { if (!hist.lock && hist.last) { clearTimeout(hist.timer); hist.timer = setTimeout(histCommit, 350); } }
function histGo(from, to, word) {
  histCommit();
  if (!from.length) return;
  to.push(hist.last);
  hist.last = from.pop();
  hist.lock = true; applySnap(hist.last); hist.lock = false;
  histSync();
  say(word);
}
const undo = () => histGo(hist.past, hist.future, 'Undone');
const redo = () => histGo(hist.future, hist.past, 'Redone');
$('#undo').addEventListener('click', undo);
$('#redo').addEventListener('click', redo);

// first paint
function say(msg, warn) { statusText = msg; statusWarn = !!warn; $('#status').textContent = msg; }
buildPresetMenu();
PARAM_DEFS.forEach(d => refresh(d.id));
presetSel.value = 'Worn cassette';
showPage(page); select(sel);
hist.last = snap(); histSync();

// ── audio ────────────────────────────────────────────────────────────────────────────────────────
// source → effect → analyser (for the display) → output. The source is the live input, a recorded
// loop, or a file. In Loop, the live input can stay on over the loop (Thru).
const REC_MAX = 30;

// iPad and iPhone. Two things keep a web page silent there, and both are handled from the tap itself,
// before anything is awaited:
//  1. Silent Mode mutes Web Audio unless the page says it is playing media. Newer systems let the page
//     say so (navigator.audioSession); on older ones a silent, looping <audio> element does the same job.
//  2. The audio engine starts, or comes back from an interruption, suspended until a tap resumes it.
let silentEl = null;
function audioSessionFor(live) {
  try { if (navigator.audioSession) navigator.audioSession.type = live ? 'play-and-record' : 'playback'; } catch (_) {}
}
function unlockAudio() {
  const appleTouch = navigator.maxTouchPoints > 1 && /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Android/.test(navigator.userAgent);
  if (appleTouch && !navigator.audioSession) {
    if (!silentEl) {
      const n = 2000, v = new DataView(new ArrayBuffer(44 + n * 2));           // a quarter second of silence, 8 kHz mono
      const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
      str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      str(36, 'data'); v.setUint32(40, n * 2, true);
      silentEl = new Audio(URL.createObjectURL(new Blob([v], { type: 'audio/wav' })));
      silentEl.loop = true; silentEl.setAttribute('playsinline', '');
    }
    if (silentEl.paused) silentEl.play().catch(() => {});
  }
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
}
// any tap while it should be sounding brings a suspended or interrupted engine back
document.addEventListener('pointerdown', () => { if (playing && ctx && ctx.state !== 'running') unlockAudio(); }, true);
document.addEventListener('visibilitychange', () => { if (!document.hidden && playing && ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); });

async function ensureAudio() {
  if (ctx) { if (ctx.state !== 'running') ctx.resume().catch(() => {}); return; }
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  ctx.resume().catch(() => {});                 // still inside the tap that asked for sound
  await ctx.audioWorklet.addModule('dsp/tape-processor.js');
  node = new AudioWorkletNode(ctx, 'tape-warble', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
  });
  node.port.onmessage = e => {
    const d = e.data;
    if (d.recChunk) { if (rec) { rec.L.push(d.recChunk[0]); rec.R.push(d.recChunk[1]); rec.len += d.recChunk[0].length; } }
    else if (d.recDone) recDone();
    else if (d.recStarted) { if (rec) { rec.armed = false; rec.t0 = ctx.currentTime; say('Recording the input…'); syncUI(); } }
    else { meters.push(d); if (meters.length > 400) meters.splice(0, 200); }
  };
  analyser = ctx.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.72;
  master = ctx.createGain(); master.gain.value = muted ? 0 : 1;
  node.connect(analyser); analyser.connect(master); master.connect(ctx.destination);
  for (const id in values) node.parameters.get(id).value = effective(id);
  if (!tape.file.buf) setTape('file', makeDemo(ctx), 'Demo loop');
}
function makePeaks(buf) {
  const n = 1200, d = buf.getChannelData(0), step = d.length / n, lo = new Float32Array(n), hi = new Float32Array(n);
  const stride = Math.max(1, Math.floor(step / 400));
  for (let b = 0; b < n; b++) {
    let mn = 0, mx = 0;
    for (let k = Math.floor(b * step), e = Math.floor((b + 1) * step); k < e; k += stride) { const v = d[k]; if (v < mn) mn = v; else if (v > mx) mx = v; }
    lo[b] = mn; hi[b] = mx;
  }
  return { lo, hi };
}
function setTape(which, buf, title) {
  const t = tape[which];
  t.buf = buf; t.title = title; t.ls = 0; t.le = buf.duration; t.fi = 0; t.fo = 0; t.faded = null; t.peaks = makePeaks(buf);
}
// Loop fades: the loop rises from silence after its start and falls to silence before its end, so it
// turns over without a seam. The fades never add up to more than the loop.
const ease = x => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(x));
function fades(t) {
  const len = Math.max(0.02, t.le - t.ls), fi = Math.min(t.fi || 0, len), fo = Math.min(t.fo || 0, len - fi);
  return [fi, fo];
}
/** The level at `x` seconds into a loop `len` long. */
const fadeGain = (x, len, fi, fo) => Math.min(x < fi ? ease(x / fi) : 1, len - x < fo ? ease((len - x) / fo) : 1);
/** The loop's stretch of the tape with its fades printed in, or null when there are none. */
function fadedBuf(t) {
  const [fi, fo] = fades(t);
  if (fi < 0.005 && fo < 0.005) return null;
  const key = [t.ls, t.le, fi, fo].join();
  if (t.faded && t.faded.key === key && t.faded.src === t.buf) return t.faded.buf;
  const sr = t.buf.sampleRate, a = Math.round(t.ls * sr), n = Math.max(1, Math.min(t.buf.length, Math.round(t.le * sr)) - a);
  const out = ctx.createBuffer(t.buf.numberOfChannels, n, sr), ni = Math.min(n, Math.round(fi * sr)), no = Math.min(n, Math.round(fo * sr));
  for (let c = 0; c < t.buf.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    d.set(t.buf.getChannelData(c).subarray(a, a + n));
    for (let k = 0; k < ni; k++) d[k] *= ease(k / ni);
    for (let k = 0; k < no; k++) d[n - 1 - k] *= ease(k / no);
  }
  t.faded = { key, src: t.buf, buf: out };
  return out;
}
const curTape = () => (source === 'live' ? null : tape[source]);

async function openLive() {
  if (liveNode) return;
  liveStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
  });
  liveNode = ctx.createMediaStreamSource(liveStream);
  liveNode.connect(node);
}
function closeLive() {
  if (liveNode) { liveNode.disconnect(); liveNode = null; }
  if (liveStream) { liveStream.getTracks().forEach(t => t.stop()); liveStream = null; }
}
function stopBuf() { if (bufNode) { try { bufNode.stop(); } catch (_) {} bufNode.disconnect(); bufNode = null; } }
function startBuf() {
  stopBuf();
  const t = curTape();
  if (!t || !t.buf) return;
  const n = ctx.createBufferSource();
  const fb = fadedBuf(t);
  n.buffer = fb || t.buf; n.loop = true;
  if (!fb) { n.loopStart = t.ls; n.loopEnd = t.le; }
  n.playbackRate.value = bufRate;
  n.connect(node); n.start(0, fb ? 0 : t.ls);
  bufNode = n; bufT0 = ctx.currentTime; bufP0 = 0;
}
function tapePos() {
  const t = curTape();
  return t && bufNode ? t.ls + ((bufP0 + (ctx.currentTime - bufT0) * bufRate) % Math.max(0.02, t.le - t.ls)) : 0;
}
/** Does the live input need to be open right now? Always in Live; in Loop, before there is a loop, while recording, or with Thru on. */
const wantLive = () => source === 'live' || (source === 'loop' && (!tape.loop.buf || thru || !!rec));

async function play() {
  try {
    audioSessionFor(wantLive()); unlockAudio();
    await ensureAudio();
    if (wantLive()) {
      try { await openLive(); }
      catch (err) { say('Could not open the audio input: ' + err.message, true); if (source === 'live') { playing = false; syncUI(); return; } }
    } else closeLive();
    startBuf();
    playing = true;
    say(describe());
    setTimeout(() => { if (playing && ctx.state !== 'running') say('No sound yet: tap the screen once', true); }, 700);
  } catch (err) {
    playing = false; closeLive();
    say('Audio failed to start: ' + err.message, true);
  }
  syncUI();
}
function stop() {
  if (rec) node.port.postMessage({ rec: null });
  stopBuf(); closeLive();
  playing = false;
  say('Stopped'); syncUI();
}
function describe() {
  if (source === 'live') return 'Live input';
  if (source === 'loop') return tape.loop.buf ? `Loop, ${(tape.loop.le - tape.loop.ls).toFixed(1)} s` + (thru ? ' + live input' : '') : 'Live input · press Rec to capture a loop';
  return tape.file.title;
}
async function setSource(s) {
  source = s;
  document.body.dataset.src = s;
  // Live, and Loop before anything is recorded, are about what is coming in: start listening at once, so
  // the input shows on the screen (and through the effect) without a second press
  const listen = s === 'live' || (s === 'loop' && !tape.loop.buf);
  if (playing || listen) await play(); else { say(describe()); syncUI(); }
}

// Record: the clean input, up to 30 s, into the loop. It starts looping the moment you stop.
async function toggleRec() {
  if (rec) { node.port.postMessage({ rec: null }); return; }
  audioSessionFor(true); unlockAudio();
  try { await ensureAudio(); } catch (err) { say('Audio failed to start: ' + err.message, true); return; }
  if (source !== 'loop') { source = 'loop'; document.body.dataset.src = 'loop'; }
  rec = { L: [], R: [], len: 0, t0: 0, armed: recWait };
  stopBuf();
  try { await openLive(); } catch (err) { rec = null; say('Could not open the audio input: ' + err.message, true); syncUI(); return; }
  playing = true;
  rec.t0 = ctx.currentTime;
  node.port.postMessage({ rec: 'in', max: REC_MAX, wait: recWait ? REC_LEVEL : 0 });
  say(recWait ? 'Waiting for sound: play something, or press Rec to cancel' : 'Recording the input…');
  syncUI();
}
function recDone() {
  const r = rec; rec = null;
  if (!r || r.len < ctx.sampleRate * 0.15) {          // nothing worth keeping: go back to the loop there was
    say(r && r.armed ? 'Recording cancelled' : 'That was too short to keep');
    if (!wantLive()) closeLive();
    if (playing && tape.loop.buf) startBuf();
    syncUI(); return;
  }
  const buf = ctx.createBuffer(2, r.len, ctx.sampleRate), bl = buf.getChannelData(0), br = buf.getChannelData(1);
  for (let k = 0, o = 0; k < r.L.length; o += r.L[k].length, k++) { bl.set(r.L[k], o); br.set(r.R[k], o); }
  const f = Math.min(Math.round(ctx.sampleRate * 0.006), r.len >> 1);       // 6 ms fades, so the loop seam does not click
  for (let k = 0; k < f; k++) { const g = k / f; bl[k] *= g; br[k] *= g; bl[r.len - 1 - k] *= g; br[r.len - 1 - k] *= g; }
  setTape('loop', buf, 'Loop');
  if (!wantLive()) closeLive();
  if (playing) startBuf();
  say(describe());
  syncUI();
}

async function loadFile(file) {
  if (!file) return;
  try {
    await ensureAudio();
    say('Reading ' + file.name + '…');
    setTape('file', await ctx.decodeAudioData(await file.arrayBuffer()), file.name);
    source = 'file'; document.body.dataset.src = 'file';
    await play();
  } catch (err) { say('Could not read that file as audio (' + file.name + ')', true); }
}

/** Save a WAV: the loop or file, played once through the effect as it is set now, with its tail. */
async function saveWav() {
  const t = curTape(), btn = $('#save');
  if (!t || !t.buf) { say('Nothing to save: record a loop or load a file first', true); return; }
  btn.disabled = true;
  try {
    const sr = t.buf.sampleRate, from = Math.round(t.ls * sr), rate = audible('speed'), last = t.buf.length - 1;
    const span = Math.floor((Math.min(t.buf.length, Math.round(t.le * sr)) - from) / rate);      // slower tape, longer file
    const n = span + Math.round((0.4 + 6 * audible('space')) * sr), [fi, fo] = fades(t), flen = Math.max(0.02, t.le - t.ls);
    const core = new TapeCore(sr);
    for (const d of PARAM_DEFS) if (!LIVE_ONLY.includes(d.id)) core.setParam(d.id, values[d.id]);
    const inL = t.buf.getChannelData(0), inR = t.buf.numberOfChannels > 1 ? t.buf.getChannelData(1) : inL;
    const outL = new Float32Array(n), outR = new Float32Array(n);
    const B = 4096, il = new Float32Array(B), ir = new Float32Array(B);
    for (let p = 0, c = 0; p < n; p += B, c++) {
      const m = Math.min(B, n - p);
      il.fill(0); ir.fill(0);
      for (let i = 0, e = Math.min(m, span - p); i < e; i++) {              // the source at tape speed
        const x = from + (p + i) * rate, k = Math.min(last, Math.floor(x)), k1 = Math.min(last, k + 1), f = x - k;
        const fg = fadeGain((p + i) * rate / sr, flen, fi, fo);
        il[i] = (inL[k] + (inL[k1] - inL[k]) * f) * fg; ir[i] = (inR[k] + (inR[k1] - inR[k]) * f) * fg;
      }
      core.process(il, ir, outL.subarray(p, p + m), outR.subarray(p, p + m), m);
      if (c % 40 === 39) { say(`Saving: ${Math.round(p / n * 100)}%`); await new Promise(r => setTimeout(r)); }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(encodeWav(outL, outR, sr));
    a.download = t.title.replace(/\.[^.]+$/, '').replace(/\s+/g, '-').toLowerCase() + '-tape-loss.wav';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    say('Saved ' + a.download);
  } catch (err) { say('Save failed: ' + err.message, true); }
  btn.disabled = false;
}

function syncUI() {
  $('#play-label').textContent = playing ? 'Stop' : 'Play';
  $('#play').setAttribute('aria-pressed', playing);
  $('#rec').setAttribute('aria-pressed', !!rec);
  $('#rec').classList.toggle('armed', !!(rec && rec.armed));
  $('#thru').setAttribute('aria-pressed', thru);
  document.querySelectorAll('#src button').forEach(b => b.setAttribute('aria-checked', b.dataset.src === source));
  document.body.dataset.src = source;
}

// wiring
$('#play').addEventListener('click', () => (playing ? stop() : play()));
$('#rec').addEventListener('click', toggleRec);
$('#bypass').addEventListener('click', () => setValue('bypass', values.bypass > .5 ? 0 : 1));
document.querySelectorAll('#src button').forEach(b => b.addEventListener('click', () => setSource(b.dataset.src)));
$('#load').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', e => { loadFile(e.target.files[0]); e.target.value = ''; });
$('#thru').addEventListener('click', () => { thru = !thru; if (playing) play(); else syncUI(); });
$('#save').addEventListener('click', saveWav);
const app = $('#app');
app.addEventListener('dragover', e => { e.preventDefault(); app.classList.add('dragging'); });
app.addEventListener('dragleave', () => app.classList.remove('dragging'));
app.addEventListener('drop', e => { e.preventDefault(); app.classList.remove('dragging'); loadFile(e.dataTransfer.files[0]); });

// Display: the tape, full screen. Tap it to come back.
function setShow(on) { document.body.classList.toggle('show', on); }
$('#show').addEventListener('click', () => setShow(true));

// a keyboard still works, when there is one
window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === ' ') { e.preventDefault(); if (!e.repeat) playing ? stop() : play(); return; }
  if (k === 'Escape') { setShow(false); return; }
  if (k === 'ArrowUp' || k === 'ArrowDown') {
    e.preventDefault();
    const d = DEF[sel], dir = k === 'ArrowUp' ? 1 : -1;
    if (d.step) setValue(sel, values[sel] + dir * (e.shiftKey ? d.big || d.step : d.step));
    else setValue(sel, fromNorm(d, clamp01(toNorm(d, values[sel]) + dir * (e.shiftKey ? .1 : .02))));
    return;
  }
  if (e.repeat) return;
  if (holdOfKey[k]) { if (latchMode && isHeld(holdOfKey[k])) holdEnd(holdOfKey[k]); else holdStart(holdOfKey[k]); }
  else if (k === 'b') setValue('bypass', values.bypass > .5 ? 0 : 1);
  else if (k === 'o') toggleRec();
  else if (k === 'v') setShow(!document.body.classList.contains('show'));
});
window.addEventListener('keyup', e => {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === ' ') e.preventDefault();
  if (holdOfKey[k] && !latchMode) holdEnd(holdOfKey[k]);
});
window.addEventListener('blur', () => { if (!latchMode) [...held.keys()].forEach(holdEnd); });

// ── a built-in demo loop, so File has something in it from the start ───────────────────────────
function makeDemo(ac) {
  const sr = ac.sampleRate, beat = 60 / 78, len = Math.round(16 * beat * sr);
  const L = new Float32Array(len), R = new Float32Array(len);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const put = (t0, dur, pan, fn) => {           // wraps around the end so the loop is seamless
    const start = Math.round(t0 * sr), n = Math.round(dur * sr);
    const gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
    for (let i = 0; i < n; i++) { const v = fn(i / sr), k = (start + i) % len; L[k] += v * gl; R[k] += v * gr; }
  };
  const hz = m => 440 * Math.pow(2, (m - 69) / 12);
  const keys = (m, t0, dur, vel, pan) => put(t0, dur, pan, t => {
    const f = hz(m), env = Math.exp(-t * 2.4) * (1 - Math.exp(-t * 300)) * Math.min(1, (dur - t) * 30);
    const fm = 1.4 * Math.exp(-t * 7) * Math.sin(TWO_PI * f * t);
    return vel * env * (Math.sin(TWO_PI * f * t + fm) + 0.1 * Math.exp(-t * 10) * Math.sin(TWO_PI * f * 4 * t));
  });
  const chords = [[53, 57, 60, 64, 67], [52, 55, 59, 62, 66], [50, 53, 57, 60, 64], [48, 52, 55, 59, 62]];
  chords.forEach((ch, bar) => {
    const t = bar * 4 * beat;
    ch.forEach((m, i) => {
      keys(m, t + i * 0.012, 2.6, 0.16, (i - 2) * 0.25);
      keys(m, t + 2.5 * beat + i * 0.01, 1.4, 0.11, (2 - i) * 0.25);
    });
    keys(ch[4] + 12, t + 3.5 * beat, 0.9, 0.07, 0.4);
    [0, 2.5].forEach(b => put(t + b * beat, 0.7, 0, x =>        // bass
      0.3 * Math.exp(-x * 3) * Math.min(1, x * 200) * Math.tanh(1.6 * Math.sin(TWO_PI * hz(ch[0] - 12) * x))));
    [0, 2.5].forEach(b => put(t + b * beat, 0.3, 0, x =>        // kick
      0.55 * Math.exp(-x * 14) * Math.sin(TWO_PI * (48 * x + 9 * (1 - Math.exp(-x * 30))))));
    [1, 3].forEach(b => put(t + b * beat, 0.22, 0.1, x =>       // snare
      Math.exp(-x * 22) * (0.22 * rnd() + 0.15 * Math.sin(TWO_PI * 190 * x))));
    for (let e = 0; e < 8; e++) {                               // swung hats
      let prev = 0;
      put(t + (e + (e % 2 ? 0.16 : 0)) * 0.5 * beat, 0.06, -0.3, x => {
        const n = rnd(), v = n - prev; prev = n;
        return (e % 2 ? 0.05 : 0.08) * Math.exp(-x * 70) * v;
      });
    }
  });
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = 0.7 / peak;
  const buf = ac.createBuffer(2, len, sr);
  const bl = buf.getChannelData(0), br = buf.getChannelData(1);
  for (let i = 0; i < len; i++) { bl[i] = L[i] * g; br[i] = R[i] * g; }
  return buf;
}

function encodeWav(L, R, sr) {
  const n = L.length, bytes = n * 6, v = new DataView(new ArrayBuffer(44 + bytes));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 6, true); v.setUint16(32, 6, true); v.setUint16(34, 24, true);
  str(36, 'data'); v.setUint32(40, bytes, true);
  let o = 44;
  const w = x => {
    const s = Math.max(-8388608, Math.min(8388607, Math.round(x * 8388607)));
    v.setUint8(o++, s & 255); v.setUint8(o++, (s >> 8) & 255); v.setUint8(o++, (s >> 16) & 255);
  };
  for (let i = 0; i < n; i++) { w(L[i]); w(R[i]); }
  return new Blob([v], { type: 'audio/wav' });
}

// ── the screen ───────────────────────────────────────────────────────────────────────────────────
// Working view: the machine, the loop with its start and end, the sound, and the tape's motion.
// Display: the same tape, full screen, drawn only from the sound itself: reels, a spectrum printed
// along the tape, and the waveform. No knobs, no numbers.
const INK = '#f1efe8', DIM = 'rgba(241,239,232,.4)', FAINT = 'rgba(241,239,232,.13)', HOT = '#f04e23';
const FONT = 'ui-rounded, system-ui, sans-serif', MONO = 'ui-monospace, Menlo, monospace';
const deckCv = $('#deck');
const REELS = {
  silver: ['#f4f3ee', '#a9a8a2'], white: ['#ffffff', '#d3d2cc'], gold: ['#f6e3a3', '#b08a2a'], orange: ['#ff8a55', '#e2461d'],
  ice: ['#e3f1f4', '#8fb3bd'], smoke: ['#bdbcb6', '#5e5d59'], black: ['#77766f', '#3a3a37'], rust: ['#c98a5e', '#6e3d22'],
};
const SPAN = 6, WN = 4096, HN = 1024, BARS = 56;
const wMin = new Float32Array(WN), wMax = new Float32Array(WN);              // the sound: one column per 128 samples
const hCents = new Float32Array(HN), hDrop = new Float32Array(HN).fill(1);   // the motion: one entry per report
const revLvl = new Float32Array(5), revPeak = new Float32Array(5), outLvl = new Float32Array(5), outPeak = new Float32Array(5);
const spec = new Float32Array(BARS);
let freqData = null, timeData = null;
let wPos = 0, hPos = 0, reelAngle = 0, reelSpeed = 0, quiet = 0, cents = 0, tilt = 0, dropGain = 1, dropVis = 0;
let peakIn = 0, peakOut = 0, tapeLvl = 0, gr = 1, frozen = false, grains = null, range = 25, lastT = 0, played = 0, loud = 0, showSince = 0;

function fit(cv) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, W: w, H: h };
}
function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** One reel, flat: a ring in the reel's colour, the tape as a plain disc, three windows, a white hub. */
function drawReel(g, cx, cy, R, angle, alpha) {
  const col = REELS[reelName] || REELS.silver, pack = R * 0.8;
  g.save(); g.translate(cx, cy); g.globalAlpha = alpha;
  g.beginPath(); g.arc(0, 0, pack, 0, TWO_PI); g.fillStyle = '#5c4a36'; g.fill();
  g.beginPath(); g.arc(0, 0, R, 0, TWO_PI); g.strokeStyle = col[1]; g.lineWidth = Math.max(1.2, R * 0.05); g.stroke();
  g.rotate(angle);
  g.fillStyle = col[0]; g.globalAlpha = alpha * 0.62;
  for (let i = 0; i < 3; i++) {
    const a0 = i * TWO_PI / 3 + 0.3, a1 = a0 + 0.8;
    g.beginPath(); g.arc(0, 0, R * 0.7, a0, a1); g.arc(0, 0, R * 0.4, a1 - 0.12, a0 + 0.12, true); g.closePath(); g.fill();
  }
  g.globalAlpha = alpha;
  g.beginPath(); g.arc(0, 0, R * 0.27, 0, TWO_PI); g.fillStyle = INK; g.fill();
  for (let i = 0; i < 3; i++) { g.save(); g.rotate(i * TWO_PI / 3); g.fillRect(R * 0.24, -R * 0.03, R * 0.08, R * 0.06); g.restore(); }
  g.beginPath(); g.arc(0, 0, R * 0.05, 0, TWO_PI); g.fillStyle = '#17171a'; g.fill();
  g.restore();
  return pack;
}
function tangent(cx, cy, pack, px, py) {
  const dx = px - cx, dy = py - cy, th = Math.atan2(dy, dx), a = Math.acos(Math.min(1, pack / Math.hypot(dx, dy)));
  const p1 = { x: cx + Math.cos(th + a) * pack, y: cy + Math.sin(th + a) * pack };
  const p2 = { x: cx + Math.cos(th - a) * pack, y: cy + Math.sin(th - a) * pack };
  return p1.y > p2.y ? p1 : p2;
}
/** Two reels and the tape between them, over a head. A dropout lifts the tape off the head. */
function drawMachine(g, xC, cy, R, sep, alpha, lineW) {
  const xL = xC - sep, xR = xC + sep, yT = cy + R + R * 0.34, ox = tilt * R * 0.05;
  const pack = drawReel(g, xL + ox, cy, R, reelAngle, alpha);
  drawReel(g, xR + ox, cy, R, reelAngle * 1.03 + 1, alpha);
  const post = sep * 0.9, roll = sep * 0.42, lift = dropVis * R * 0.3;
  const pL = { x: xC - post, y: yT + 3 }, pR = { x: xC + post, y: yT + 3 };
  const tL = tangent(xL + ox, cy, pack, pL.x, pL.y), tR = tangent(xR + ox, cy, pack, pR.x, pR.y);
  g.globalAlpha = alpha;
  g.strokeStyle = dropVis > 0.05 ? HOT : 'rgba(241,239,232,.55)'; g.lineWidth = lineW; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(tL.x, tL.y); g.lineTo(pL.x, pL.y); g.lineTo(xC - roll, yT - 3);
  g.lineTo(xC, yT - lift); g.lineTo(xC + roll, yT - 3); g.lineTo(pR.x, pR.y); g.lineTo(tR.x, tR.y); g.stroke();
  const dot = Math.max(2.4, R * 0.07);
  for (const p of [pL, pR]) { g.beginPath(); g.arc(p.x, p.y, dot, 0, TWO_PI); g.fillStyle = INK; g.fill(); }
  for (const x of [xC - roll, xC + roll]) {
    g.beginPath(); g.arc(x, yT - 3, dot * 1.6, 0, TWO_PI); g.fillStyle = '#0b0b0c'; g.fill();
    g.strokeStyle = INK; g.lineWidth = Math.max(1.3, lineW); g.stroke();
  }
  rr(g, xC - dot * 2.3, yT + 1, dot * 4.6, dot * 3.8, 2); g.fillStyle = dropVis > 0.1 ? HOT : INK; g.fill();
  g.globalAlpha = 1;
  return yT + dot * 3.8;
}

// the loop strip: the whole loop or file, the part that plays drawn bright, two ends you can drag
let srcGeom = null, drag = null;
function drawSource(g, x0, x1, top, bot) {
  const t = curTape(), w = x1 - x0;
  g.textBaseline = 'alphabetic'; g.font = '600 9px ' + FONT; g.fillStyle = DIM; g.textAlign = 'left';
  srcGeom = null;
  if (rec && rec.armed) {                             // armed: the input level, with the mark it has to pass
    const y = (top + 13 + bot) / 2, lvl = v => clamp01((20 * Math.log10(Math.max(v, 1e-4)) + 60) / 60);
    g.fillStyle = Math.floor(performance.now() / 450) % 2 ? HOT : 'rgba(240,78,35,.45)'; g.fillText('WAITING FOR SOUND', x0, top + 8);
    g.textAlign = 'right'; g.fillStyle = DIM; g.fillText('STARTS WHEN THE LEVEL PASSES THE MARK', x1, top + 8);
    g.fillStyle = FAINT; g.fillRect(x0, y - 4, w, 8);
    g.fillStyle = INK; g.fillRect(x0, y - 4, w * lvl(peakIn), 8);
    g.fillStyle = HOT; g.fillRect(x0 + w * lvl(REC_LEVEL) - 1, y - 9, 2, 18);
    return;
  }
  if (rec) {
    const el = ctx.currentTime - rec.t0;
    g.fillStyle = HOT; g.fillText(`RECORDING ${el.toFixed(1)} / ${REC_MAX} S`, x0, top + 8);
    g.fillStyle = FAINT; g.fillRect(x0, (top + 13 + bot) / 2 - 4, w, 8);
    g.fillStyle = HOT; g.fillRect(x0, (top + 13 + bot) / 2 - 4, w * Math.min(1, el / REC_MAX), 8);
    return;
  }
  if (!t || !t.buf) {
    g.fillText(source === 'live' ? 'LIVE INPUT' : source === 'file' ? 'FILE · ' + t.title.toUpperCase() + ' · PRESS PLAY' : 'LOOP · PRESS REC TO CAPTURE WHAT IS COMING IN', x0, top + 8);
    g.fillStyle = FAINT; g.fillRect(x0, (top + 13 + bot) / 2 - 3, w, 6);                 // the input level, as a bar
    g.fillStyle = INK; g.fillRect(x0, (top + 13 + bot) / 2 - 3, w * clamp01((20 * Math.log10(Math.max(peakIn, 1e-4)) + 48) / 48), 6);
    return;
  }
  let name = t.title; if (name.length > 36) name = name.slice(0, 34) + '…';
  g.fillText(`${source === 'loop' ? 'LOOP' : 'FILE'} · ${name.toUpperCase()}`, x0, top + 8);
  const [fi, fo] = fades(t), faded = fi > 0.005 || fo > 0.005;
  g.textAlign = 'right';
  g.fillText(`${t.ls.toFixed(2)} – ${t.le.toFixed(2)} S · ` + (faded ? `FADE ${fi.toFixed(1)} IN ${fo.toFixed(1)} OUT` : w > 420 ? 'DRAG THE ENDS · PULL THE DOTS TO FADE' : 'DRAG THE ENDS'), x1, top + 8);
  const pt = top + 14, mid = (pt + bot) / 2, half = (bot - pt) / 2, dur = t.buf.duration, len = Math.max(0.02, t.le - t.ls);
  const xs = x0 + t.ls / dur * w, xe = x0 + t.le / dur * w, pk = t.peaks, bins = pk.lo.length, n = Math.floor(w);
  const xfi = xs + fi / dur * w, xfo = xe - fo / dur * w;
  srcGeom = { x0, x1, top: pt - 10, bot: bot + 18, pb: bot, dur };
  const shape = lvl => {                                               // lvl: the loop's fades, when drawing the part that plays
    const k = q => 1.3 * (lvl ? fadeGain(q / n * dur - t.ls, len, fi, fo) : 1);
    g.beginPath();
    for (let q = 0; q <= n; q++) { const b = Math.min(bins - 1, Math.floor(q / n * bins)); const y = mid - Math.min(1, pk.hi[b] * k(q)) * half - 0.5; q ? g.lineTo(x0 + q, y) : g.moveTo(x0 + q, y); }
    for (let q = n; q >= 0; q--) { const b = Math.min(bins - 1, Math.floor(q / n * bins)); g.lineTo(x0 + q, mid - Math.max(-1, pk.lo[b] * k(q)) * half + 0.5); }
    g.closePath();
  };
  shape(false); g.fillStyle = 'rgba(241,239,232,.18)'; g.fill();
  g.save(); g.beginPath(); g.rect(xs, pt - 2, xe - xs, bot - pt + 4); g.clip(); shape(true); g.fillStyle = INK; g.fill(); g.restore();
  g.strokeStyle = 'rgba(240,78,35,.75)'; g.lineWidth = 1.2;            // the fades, as ramps
  if (xfi - xs > 2) { g.beginPath(); g.moveTo(xs, bot + 2); g.lineTo(xfi, pt - 2); g.lineTo(xfi, bot + 3); g.stroke(); }
  if (xe - xfo > 2) { g.beginPath(); g.moveTo(xe, bot + 2); g.lineTo(xfo, pt - 2); g.lineTo(xfo, bot + 3); g.stroke(); }
  g.fillStyle = HOT;
  for (const [x, dir] of [[xs, 1], [xe, -1]]) {                       // the ends: big enough for a finger
    g.fillRect(x - 1, pt - 4, 2, bot - pt + 8);
    g.beginPath(); g.moveTo(x, pt - 4); g.lineTo(x + dir * 9, pt - 4); g.lineTo(x, pt + 6); g.closePath(); g.fill();
  }
  for (const x of [xfi, xfo]) {                                       // the fade tabs: pull one inward from its end
    g.beginPath(); g.arc(x, bot + 8, 5, 0, TWO_PI); g.fillStyle = HOT; g.fill();
    g.beginPath(); g.arc(x, bot + 8, 2, 0, TWO_PI); g.fillStyle = '#0b0b0c'; g.fill();
  }
  if (bufNode) { const xp = x0 + tapePos() / dur * w; g.fillStyle = INK; g.fillRect(xp - 1, pt - 2, 2, bot - pt + 4); }
}
/** The sound: the last six seconds off the tape, newest at the left, with the grains riding on it. */
function drawAudio(g, x0, x1, top, bot, bypassed) {
  const amt = audible('grains'), on = amt > 0.005 && !bypassed;
  g.font = '600 9px ' + FONT; g.fillStyle = DIM; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillText(frozen ? 'SOUND · HELD' : 'SOUND', x0, top + 8);
  g.textAlign = 'right';
  g.fillText(on ? `${grains ? grains.length / 4 : 0} GRAINS` : `LAST ${SPAN} S`, x1, top + 8);
  const pt = top + 14, mid = (pt + bot) / 2, half = (bot - pt) / 2, w = x1 - x0;
  const colDt = 128 / (ctx ? ctx.sampleRate : 48000), perPx = SPAN / colDt / w, n = Math.floor(w);
  g.strokeStyle = FAINT; g.lineWidth = 1; g.beginPath(); g.moveTo(x0, mid); g.lineTo(x1, mid); g.stroke();
  g.beginPath();
  for (let pass = 0; pass < 2; pass++) for (let q = 0; q <= n; q++) {
    const xi = pass ? n - q : q, c0 = Math.floor(xi * perPx), c1 = Math.max(c0 + 1, Math.floor((xi + 1) * perPx));
    let v = 0;
    for (let c = c0; c < c1 && c < WN; c++) { const k = (wPos - c + WN * 2) % WN, s = pass ? wMin[k] : wMax[k]; if (pass ? s < v : s > v) v = s; }
    const y = mid - clamp(v * 1.25, -1, 1) * half;
    if (!pass && !q) g.moveTo(x0 + xi, y); else g.lineTo(x0 + xi, y);
  }
  g.closePath(); g.fillStyle = bypassed ? 'rgba(241,239,232,.3)' : 'rgba(241,239,232,.92)'; g.fill();
  g.fillStyle = HOT; g.fillRect(x0 - 1, pt, 2, bot - pt);
  g.fillStyle = DIM; for (let sec = 1; sec < SPAN; sec++) g.fillRect(x0 + sec / SPAN * w, pt - 3, 1, 4);
  if (on && grains) {
    const px = w / SPAN;
    for (let i = 0; i < grains.length; i += 4) {
      const off = grains[i], rate = grains[i + 1], prog = grains[i + 2], len = grains[i + 3];
      if (off > SPAN) continue;
      const st = 12 * Math.log2(Math.abs(rate) || 1), cx = x0 + off * px, cy = mid - clamp(st / 24, -1, 1) * (half - 5);
      const a = 0.2 + 0.8 * Math.sin(Math.PI * prog), dir = rate < 0 ? 1 : -1, bw = clamp(len * Math.abs(rate) * px, 5, 70);
      g.strokeStyle = `rgba(240,78,35,${a * 0.5})`; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(cx, mid); g.lineTo(cx, cy); g.lineTo(clamp(cx + dir * bw, x0, x1), cy); g.stroke();
      g.beginPath(); g.arc(cx, cy, 3.5, 0, TWO_PI);
      if (rate < 0) { g.fillStyle = '#0b0b0c'; g.fill(); g.strokeStyle = `rgba(255,120,80,${a})`; g.lineWidth = 1.5; g.stroke(); }
      else { g.fillStyle = `rgba(240,78,35,${a})`; g.fill(); }
    }
  }
}
/** Motion: the speed the tape is really playing at, on the same time axis; dropouts ticked in red. */
function drawMotion(g, x0, x1, top, bot, dt, bypassed) {
  const msgDt = 512 / (ctx ? ctx.sampleRate : 48000), w = x1 - x0, n = Math.min(HN, Math.floor(SPAN / msgDt));
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(hCents[(hPos - i + HN) % HN]));
  range += (clamp(peak * 1.25, 25, 100) - range) * Math.min(1, dt * 3);
  g.font = '600 9px ' + FONT; g.fillStyle = DIM; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillText('MOTION' + (effective('onMotion') < .5 ? ' (OFF)' : ''), x0, top + 8);
  g.textAlign = 'right'; g.fillText('±' + Math.round(range) + ' CENTS', x1, top + 8);
  const pt = top + 14, pb = bot - 7, mid = (pt + pb) / 2, half = (pb - pt) / 2;
  g.strokeStyle = FAINT; g.lineWidth = 1; g.beginPath(); g.moveTo(x0, mid); g.lineTo(x1, mid); g.stroke();
  g.beginPath();
  for (let i = 0; i < n; i++) {
    const x = x0 + i * msgDt / SPAN * w, y = mid - clamp(hCents[(hPos - i + HN) % HN] / range, -1, 1) * half;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.strokeStyle = bypassed ? DIM : INK; g.lineWidth = 1.8; g.lineJoin = 'round'; g.stroke();
  g.fillStyle = HOT;
  for (let i = 0; i < n; i++) {
    const d = hDrop[(hPos - i + HN) % HN];
    if (d < 0.9) g.fillRect(x0 + i * msgDt / SPAN * w, pb + 1.5, Math.max(1.5, msgDt / SPAN * w), 1.5 + (1 - d) * 4.5);
  }
  g.fillRect(x0 - 1, pt, 2, pb - pt);
}

function drawWork(g, W, H, dt, bypassed) {
  const pad = 16, x0 = pad, x1 = W - pad, xC = W / 2;
  const R = clamp(H * 0.075, 22, 42), sep = clamp(W * 0.13, 66, 124);
  const machBot = drawMachine(g, xC, 12 + R, R, sep, bypassed ? 0.4 : 1, 1.3);
  // words, left of the machine: what is playing, lamps, and the knob in hand
  const lx1 = xC - sep - R - 14;
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  g.font = '600 12px ' + FONT; g.fillStyle = muted || statusWarn ? HOT : INK;
  let st = muted ? 'MUTED · tap here for sound' : statusText; const full = st;
  while (st.length > 4 && g.measureText(st).width > lx1 - x0) st = st.slice(0, -2);
  g.fillText(st === full ? st : st + '…', x0, 24);
  const lamps = [['PLAY', playing], ['REC', !!rec, 1], ['DROP', dropVis > 0.15, 1], ['FREEZE', frozen], ['LIMIT', gr < 0.985, 1], ['BYPASS', bypassed]];
  g.font = '600 9px ' + FONT;
  let lx = x0;
  for (const [name, on, hot] of lamps) { if (!on && lx + g.measureText(name).width > lx1) break; g.fillStyle = on ? (hot ? HOT : INK) : FAINT; g.fillText(name, lx, 40); lx += g.measureText(name).width + 8; }
  const d = DEF[sel], grp = GROUP[d.group];
  g.fillStyle = DIM; g.fillText(`${grp.label} · ${d.label}`.toUpperCase() + (effective(grp.sw) < .5 ? ' (OFF)' : ''), x0, 60);
  g.font = '600 26px ' + FONT; g.fillStyle = effective(sel) !== values[sel] ? HOT : INK;
  g.fillText(fmt(d, effective(sel)), x0, 88);
  // right of the machine: the counter and the levels
  const secs = Math.floor(played);
  g.textAlign = 'right'; g.font = '600 13px ' + MONO; g.fillStyle = INK;
  const tm = String(Math.floor(secs / 60)).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0');
  g.fillText(tm, x1, 24);
  if (playing) { g.beginPath(); g.arc(x1 - g.measureText(tm).width - 9, 20, 3.5, 0, TWO_PI); g.fillStyle = HOT; g.fill(); }
  const bx = Math.max(xC + sep + R + 40, x1 - 170);
  [['IN', peakIn], ['OUT', peakOut], ['GR', gr, 1]].forEach(([name, v, reduce], i) => {
    const yy = 38 + i * 14, n = 16, w = (x1 - bx) / n;
    g.font = '8px ' + FONT; g.textAlign = 'left'; g.fillStyle = DIM; g.fillText(name, bx - 24, yy + 7);
    const lit = reduce ? Math.round(n * Math.min(1, -20 * Math.log10(Math.max(v, 1e-3)) / 12)) : Math.round(n * clamp01((20 * Math.log10(Math.max(v, 1e-4)) + 42) / 42));
    for (let k = 0; k < n; k++) {
      const on = reduce ? n - 1 - k < lit : k < lit;
      g.fillStyle = on ? (reduce || k >= n - 2 ? HOT : INK) : FAINT; g.fillRect(bx + k * w, yy, Math.max(1.5, w - 2), 7);
    }
  });
  // the loop, the sound, the motion
  const top = Math.max(machBot + 14, 100), sH = 52;
  // the sticker: on the right, under the level bars, when there is room above the loop strip
  if (typeof drawSticker === 'function' && top >= 118) drawSticker(g, (bx + x1) / 2, 98, 20, -0.04, x1 - bx);
  drawSource(g, x0, x1, top, top + sH);
  const aTop = top + sH + 16, rest = H - aTop - 10, aBot = aTop + rest * 0.64;
  drawAudio(g, x0, x1, aTop, aBot, bypassed);
  drawMotion(g, x0, x1, aBot + 10, H - 10, dt, bypassed);
}

/** Display: drawn only from the sound. The reels turn with the tape; the spectrum is printed along
 *  a line like tape running across the screen; the waveform rides under it; the room glows with level. */
function drawShow(g, W, H, dt) {
  srcGeom = null;
  loud += (peakOut - loud) * Math.min(1, dt * 8);
  const glow = g.createRadialGradient(W / 2, H * 0.42, 0, W / 2, H * 0.42, Math.max(W, H) * 0.7);
  glow.addColorStop(0, `rgba(240,78,35,${0.05 + 0.22 * clamp01(loud * 1.4)})`); glow.addColorStop(1, 'rgba(240,78,35,0)');
  g.fillStyle = glow; g.fillRect(0, 0, W, H);

  const R = Math.min(H * 0.2, W * 0.12), sep = Math.min(W * 0.27, R * 2.6);
  drawMachine(g, W / 2, H * 0.08 + R, R, sep, 1, Math.max(1.6, R * 0.035));
  if (typeof drawSticker === 'function') drawSticker(g, W / 2, H * 0.08 + R * 0.6, clamp(R * 0.24, 16, 40), -0.04, 2 * (sep - R) - 24);

  // the spectrum along the tape: low notes at the left, high at the right, mirrored about the line
  const x0 = W * 0.06, x1 = W * 0.94, yS = H * 0.66, hS = H * 0.15, bw = (x1 - x0) / BARS;
  g.fillStyle = FAINT; g.fillRect(x0, yS - 0.5, x1 - x0, 1);
  for (let i = 0; i < BARS; i++) {
    const v = spec[i], h = Math.max(1.5, v * hS), a = 0.35 + 0.65 * v;
    g.fillStyle = v > 0.8 ? HOT : `rgba(241,239,232,${a})`;
    rr(g, x0 + i * bw + bw * 0.18, yS - h, bw * 0.64, h * 2, Math.min(3, bw * 0.3)); g.fill();
  }
  // the waveform
  const yW = H * 0.88, hW = H * 0.07;
  g.beginPath();
  if (timeData) for (let i = 0, n = timeData.length; i < n; i += 4) {
    const x = x0 + i / (n - 1) * (x1 - x0), y = yW - clamp(timeData[i] * 1.6, -1, 1) * hW;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  } else { g.moveTo(x0, yW); g.lineTo(x1, yW); }
  g.strokeStyle = INK; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();

  g.textBaseline = 'alphabetic'; g.font = '700 10px ' + FONT; g.fillStyle = DIM; g.textAlign = 'left';
  g.fillText('T A P E   L O S S', 20, 26);
  const secs = Math.floor(played);
  g.textAlign = 'right'; g.font = '600 13px ' + MONO; g.fillStyle = INK;
  g.fillText(String(Math.floor(secs / 60)).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0'), W - 20, 26);
  const age = performance.now() - showSince;                     // a quiet reminder of the way back, then it goes
  if (age < 3500) { g.globalAlpha = clamp01((3500 - age) / 800); g.textAlign = 'center'; g.font = '600 11px ' + FONT; g.fillStyle = DIM; g.fillText(muted ? 'tap for sound · tap again to go back' : 'tap anywhere to go back', W / 2, H - 14); g.globalAlpha = 1; }
}

// the small displays on the chain, and the two on the Space and Master pages
function drawMinis(bypassed) {
  // on the Unit face they are drawn in dark ink straight onto the tile; on the deck faces each one is a
  // small glass window, so they are drawn in light ink and kept clear of the window's edge
  const glass = skin !== 'unit';
  const INK_D = glass ? INK : '#1c1c1a', SOFT = glass ? 'rgba(241,239,232,.14)' : 'rgba(28,28,26,.16)', inkRgb = glass ? [241, 239, 232] : [28, 28, 26];
  const db = v => clamp01((20 * Math.log10(Math.max(v, 1e-4)) + 48) / 48);
  const paint = (id, fn) => {
    const cv = miniCv[id]; if (!cv || !cv.clientWidth) return;
    const { g, W, H } = fit(cv);
    g.globalAlpha = !bypassed && effective(GROUP[id].sw) > .5 ? 1 : 0.35;
    if (glass) { g.translate(7, 5); fn(g, W - 14, H - 10); } else fn(g, W, H);
  };
  paint('motion', (g, W, H) => {
    const n = 46;
    g.strokeStyle = SOFT; g.lineWidth = 1; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
    g.beginPath();
    for (let i = 0; i < n; i++) { const y = H / 2 - clamp(hCents[(hPos - (n - 1 - i) + HN * 2) % HN] / Math.max(25, range), -1, 1) * (H / 2 - 2); i ? g.lineTo(i / (n - 1) * W, y) : g.moveTo(0, y); }
    g.strokeStyle = INK_D; g.lineWidth = 1.5; g.lineJoin = 'round'; g.stroke();
  });
  paint('tape', (g, W, H) => {
    const rgb = mix3(inkRgb, [240, 78, 35], audible('drive')).map(Math.round);
    g.fillStyle = SOFT; g.fillRect(0, H / 2 - 2.5, W, 5);
    g.globalAlpha *= 1 - 0.85 * dropVis;
    g.fillStyle = `rgb(${rgb.join(',')})`; g.fillRect(0, H / 2 - 2.5, W * db(tapeLvl), 5);
  });
  paint('grain', (g, W, H) => {
    const lit = audible('grains') > 0.005 && grains ? Math.min(12, grains.length / 4) : 0;
    for (let i = 0; i < 12; i++) { g.beginPath(); g.arc((i + 0.5) / 12 * W, H / 2, 2.4, 0, TWO_PI); g.fillStyle = i < lit ? HOT : SOFT; g.fill(); }
  });
  paint('evolve', (g, W, H) => {                    // feedback above, drift below
    g.fillStyle = SOFT; g.fillRect(0, 2, W, 4); g.fillRect(0, H - 6, W, 4);
    g.fillStyle = HOT; g.fillRect(0, 2, W * effective('gFeedback'), 4);
    g.fillStyle = INK_D; g.fillRect(0, H - 6, W * effective('gDrift'), 4);
  });
  paint('space', (g, W, H) => {
    for (let i = 0; i < 5; i++) {
      const v = clamp01((20 * Math.log10(Math.max(revLvl[i], 1e-5)) + 60) / 54);
      g.fillStyle = SOFT; g.fillRect(i / 5 * W + 1, 1, W / 5 - 2, H - 2);
      g.fillStyle = INK_D; g.fillRect(i / 5 * W + 1, 1 + (H - 2) * (1 - v), W / 5 - 2, (H - 2) * v);
    }
  });
  paint('master', (g, W, H) => {
    g.fillStyle = SOFT; g.fillRect(0, H / 2 - 2.5, W, 5);
    g.fillStyle = INK_D; g.fillRect(0, H / 2 - 2.5, W * db(peakOut), 5);
    const red = Math.min(1, -20 * Math.log10(Math.max(gr, 1e-3)) / 12);
    g.fillStyle = HOT; g.fillRect(W * (1 - red), H / 2 - 2.5, W * red, 5);
  });
}
const BAND_IDS = ['sLow', 'sMid', 'sMidHi', 'sHigh', 'sAir'], BAND_TAGS = ['LOW', 'MID', 'MID-HI', 'HIGH', 'HI-FI'];
function drawBandScope(cv, lvls, peaks, tags, xs, line, on, right) {
  if (!cv || !cv.clientWidth) return;
  const { g, W, H } = fit(cv);
  const padX = 8, top = 5, bot = H - 12, xr = W - padX - right;
  g.textBaseline = 'alphabetic'; g.font = '600 7.5px ' + FONT; g.textAlign = 'center';
  const segs = Math.max(4, Math.floor((bot - top) / 3.6)), segH = (bot - top) / segs, cw = Math.min(50, (xr - padX) / 5 - 14);
  const lvl = v => clamp01((20 * Math.log10(Math.max(v, 1e-5)) + 60) / 56);
  for (let i = 0; i < 5; i++) {
    const cx = padX + xs[i] * (xr - padX);
    g.fillStyle = DIM; g.fillText(tags[i], cx, H - 3);
    peaks[i] = Math.max(peaks[i] - 0.006, lvl(lvls[i]));
    const lit = Math.round(lvl(lvls[i]) * segs);
    for (let k = 0; k < segs; k++) { g.fillStyle = k < lit ? (on ? 'rgba(241,239,232,.88)' : 'rgba(241,239,232,.25)') : 'rgba(241,239,232,.07)'; g.fillRect(cx - cw / 2, bot - (k + 1) * segH + 1, cw, segH - 1.6); }
    if (peaks[i] > 0.02 && on) { g.fillStyle = INK; g.fillRect(cx - cw / 2, bot - peaks[i] * (bot - top) - 0.5, cw, 1); }
  }
  g.strokeStyle = on ? HOT : 'rgba(240,78,35,.4)'; g.fillStyle = g.strokeStyle; g.lineWidth = 1.5; g.lineJoin = 'round';
  line(g, padX, xr, top, bot);
  return { g, W, H, padX, top, bot };
}
function drawScopes(bypassed) {
  const xsEven = [0.1, 0.3, 0.5, 0.7, 0.9];
  drawBandScope($('#space-scope'), revLvl, revPeak, BAND_TAGS, xsEven, (g, xa, xb, top, bot) => {
    g.beginPath();
    BAND_IDS.forEach((id, i) => { const x = xa + xsEven[i] * (xb - xa), y = bot - effective(id) / 1.5 * (bot - top); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
    BAND_IDS.forEach((id, i) => { g.beginPath(); g.arc(xa + xsEven[i] * (xb - xa), bot - effective(id) / 1.5 * (bot - top), 2.4, 0, TWO_PI); g.fill(); });
  }, effective('onSpace') > .5 && !bypassed, 0);
  const fx = f => Math.log(f / 20) / Math.log(1000);
  const m = drawBandScope($('#master-scope'), outLvl, outPeak, ['100', '400', '1.5k', '5k', '12k'], [90, 400, 1500, 5000, 12500].map(fx), (g, xa, xb, top, bot) => {
    const y0 = top + (bot - top) * 0.42, perDb = (bot - top) / 30, fc = audible('lowCut'), gHi = Math.pow(10, audible('tone') * 6 / 20), gLo = 1 / gHi;
    g.beginPath();
    for (let px = 0; px <= xb - xa; px += 2) {
      const f = 20 * Math.pow(1000, px / (xb - xa)), a = f / fc, b = f / 900;
      const dbv = 20 * Math.log10(a * a / (1 + a * a) + 1e-9) + 10 * Math.log10((gLo * gLo + gHi * gHi * b * b) / (1 + b * b));
      const y = y0 - clamp(dbv, -22, 12) * perDb;
      px ? g.lineTo(xa + px, y) : g.moveTo(xa + px, y);
    }
    g.stroke();
  }, effective('onMaster') > .5 && !bypassed, 12);
  if (m) {
    const red = Math.min(1, -20 * Math.log10(Math.max(gr, 1e-3)) / 12);
    m.g.fillStyle = FAINT; m.g.fillRect(m.W - m.padX - 4, m.top, 4, m.bot - m.top);
    m.g.fillStyle = HOT; m.g.fillRect(m.W - m.padX - 4, m.top, 4, (m.bot - m.top) * red);
  }
}

function draw(now) {
  requestAnimationFrame(draw);
  const dt = Math.min(0.05, (now - lastT) / 1000 || 0); lastT = now;
  glideHolds(dt);
  let speed = playing ? 1 : 0, grNow = 1;
  while (meters.length) {
    const m = meters.shift();
    speed = m.speed;
    cents = 1200 * Math.log2(Math.max(m.speed, 0.02));
    dropGain = Math.min(m.dropL, m.dropR);
    peakIn = Math.max(peakIn * 0.9, m.peakIn); peakOut = Math.max(peakOut * 0.9, m.peakOut);
    tapeLvl = Math.max(tapeLvl * 0.9, m.peakTape || 0);
    grNow = Math.min(grNow, m.gr);
    frozen = m.frozen; grains = m.grains;
    for (let i = 0; i < 5; i++) { revLvl[i] = Math.max(revLvl[i] * 0.93, m.rev[i]); outLvl[i] = Math.max(outLvl[i] * 0.9, m.outBands[i]); }
    hPos = (hPos + 1) % HN; hCents[hPos] = cents; hDrop[hPos] = dropGain;
    if (m.wave) for (let i = 0; i < m.wave.length; i += 2) { wPos = (wPos + 1) % WN; wMin[wPos] = m.wave[i]; wMax[wPos] = m.wave[i + 1]; }
  }
  if (!playing) { speed = 0; cents = 0; dropGain = 1; peakIn *= 0.9; peakOut *= 0.9; tapeLvl *= 0.9; grains = null; for (let i = 0; i < 5; i++) { revLvl[i] *= 0.9; outLvl[i] *= 0.9; } }
  gr = Math.min(grNow, gr + (1 - gr) * Math.min(1, dt * 6));
  const bypassed = values.bypass > 0.5, show = document.body.classList.contains('show');
  // The tape moves only while there is sound: when what comes in falls silent (and nothing loud is still
  // ringing out) the reels coast to a stop, and they spin up again with the next sound.
  if (peakIn > 0.002 || peakOut > 0.02) quiet = 0; else quiet += dt;
  const reelTarget = playing && quiet < 0.7 ? Math.max(0, speed) : 0;
  reelSpeed += (reelTarget - reelSpeed) * Math.min(1, dt * (reelTarget > reelSpeed ? 9 : 3));
  reelAngle += dt * 1.9 * reelSpeed * (source === 'live' ? 1 : bufRate);
  played += dt * reelSpeed;
  tilt += ((bypassed ? 0 : clamp(cents / 60, -1, 1)) - tilt) * Math.min(1, dt * 10);
  const dv = bypassed ? 0 : 1 - dropGain;
  dropVis += (dv - dropVis) * Math.min(1, dt * (dv > dropVis ? 40 : 8));

  // the spectrum and waveform, straight from what is going out
  if (analyser && (show || skin !== 'unit')) {
    if (!freqData) { freqData = new Uint8Array(analyser.frequencyBinCount); timeData = new Float32Array(analyser.fftSize); }
    analyser.getByteFrequencyData(freqData); analyser.getFloatTimeDomainData(timeData);
    const hzPerBin = ctx.sampleRate / analyser.fftSize;
    for (let i = 0; i < BARS; i++) {
      const b0 = Math.max(1, Math.floor(40 * Math.pow(400, i / BARS) / hzPerBin)), b1 = Math.max(b0 + 1, Math.floor(40 * Math.pow(400, (i + 1) / BARS) / hzPerBin));
      let s = 0; for (let b = b0; b < b1 && b < freqData.length; b++) s = Math.max(s, freqData[b]);
      const v = playing ? s / 255 : 0;
      spec[i] = v > spec[i] ? v : spec[i] + (v - spec[i]) * Math.min(1, dt * 7);
    }
  }
  const { g, W, H } = fit(deckCv);
  if (skin !== 'unit' && typeof drawSkin === 'function') { drawSkin(g, W, H, dt, bypassed, show); if (!show) { drawMinis(bypassed); drawScopes(bypassed); } }
  else if (show) drawShow(g, W, H, dt);
  else { drawWork(g, W, H, dt, bypassed); drawMinis(bypassed); drawScopes(bypassed); }
}
requestAnimationFrame(draw);

// the screen under your finger: unmute, leave the Display, or drag the loop's ends
deckCv.addEventListener('pointerdown', e => {
  if (muted) { muted = false; if (master) master.gain.value = 1; return; }
  if (document.body.classList.contains('show')) { setShow(false); return; }
  if (!srcGeom) return;
  const r = deckCv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, G = srcGeom, t = curTape();
  if (y < G.top || y > G.bot || x < G.x0 - 22 || x > G.x1 + 22) return;
  const w = G.x1 - G.x0, xs = G.x0 + t.ls / G.dur * w, xe = G.x0 + t.le / G.dur * w, tm = clamp01((x - G.x0) / w) * G.dur, grab = e.pointerType === 'mouse' ? 10 : 24;
  const [fi, fo] = fades(t), di = Math.abs(x - (xs + fi / G.dur * w)), d2 = Math.abs(x - (xe - fo / G.dur * w));
  if (y >= G.pb - 2 && Math.min(di, d2) <= grab) drag = { fade: di <= d2 ? 'in' : 'out', moved: false, x };      // under the strip: a fade tab
  else if (Math.abs(x - xs) <= grab && Math.abs(x - xs) <= Math.abs(x - xe)) drag = { anchor: t.le, moved: true, x };
  else if (Math.abs(x - xe) <= grab) drag = { anchor: t.ls, moved: true, x };
  else drag = { anchor: tm, moved: false, x };          // away from both ends: sweep out a new loop, once you move
  try { deckCv.setPointerCapture(e.pointerId); } catch (_) {}
  e.preventDefault();
});
deckCv.addEventListener('pointermove', e => {
  if (!drag || !srcGeom) return;
  const r = deckCv.getBoundingClientRect(), x = e.clientX - r.left, G = srcGeom, t = curTape();
  if (!drag.moved && Math.abs(x - drag.x) < 6) return;
  drag.moved = true;
  const tm = clamp01((x - G.x0) / (G.x1 - G.x0)) * G.dur;
  if (drag.fade) {
    const len = t.le - t.ls, [fi, fo] = fades(t);
    if (drag.fade === 'in') t.fi = clamp(tm - t.ls, 0, len - fo); else t.fo = clamp(t.le - tm, 0, len - fi);
    if (t.fi < 0.02) t.fi = 0; if (t.fo < 0.02) t.fo = 0;
    return;
  }
  let a = Math.min(drag.anchor, tm), b = Math.max(drag.anchor, tm);
  if (b - a < 0.05) { b = Math.min(G.dur, a + 0.05); a = Math.max(0, b - 0.05); }
  t.ls = a; t.le = b;
});
const endDrag = () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (!d.moved) return;
  const t = curTape();
  if (playing) startBuf();
  const [fi, fo] = fades(t);
  say(d.fade ? (fi || fo ? `Loop fades in ${fi.toFixed(2)} s, out ${fo.toFixed(2)} s` : 'Loop fades off') : `Loops ${t.ls.toFixed(2)} – ${t.le.toFixed(2)} s`);
};
deckCv.addEventListener('pointerup', endDrag);
deckCv.addEventListener('pointercancel', endDrag);
deckCv.addEventListener('dblclick', e => {
  const t = curTape(); if (!srcGeom || !t) return;
  const r = deckCv.getBoundingClientRect(), y = e.clientY - r.top;
  if (y < srcGeom.top || y > srcGeom.bot) return;
  if (y >= srcGeom.pb - 2) { t.fi = 0; t.fo = 0; say('Loop fades off'); }        // on the tabs: clear the fades
  else { t.ls = 0; t.le = t.buf.duration; say('Loops the whole thing'); }
  if (playing) startBuf();
});
$('#show').addEventListener('click', () => { showSince = performance.now(); });

syncUI();
window.tapeloss = { values, effective, setValue, applyPreset, play, stop, toggleRec, setSource, setShow, holdStart, holdEnd, undo, redo, tape, meters,
  get ctx() { return ctx; }, get source() { return source; }, get playing() { return playing; }, get rec() { return rec; }, get muted() { return muted; }, set muted(v) { muted = v; if (master) master.gain.value = v ? 0 : 1; } };
