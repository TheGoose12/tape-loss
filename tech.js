'use strict';
/* Tape Loss MK IV: the technical data, behind the badge.
   Tap "Tape Loss" in the top bar and the machine opens up: what each stage of the effect is doing right
   now, in numbers, with three small scopes and the switch between the two engines. Nothing here edits a
   sound. It reads the same values the engine hears (audible(), from app.js) and the engine's own meters. */

const techEl = document.createElement('div');
techEl.className = 'tech'; techEl.id = 'tech'; techEl.hidden = true;
techEl.setAttribute('role', 'dialog'); techEl.setAttribute('aria-label', 'Technical data');
techEl.innerHTML = `
  <header class="tech-head">
    <div class="tech-title"><h2>Tape Loss</h2><p>mk IV · technical data</p></div>
    <div class="tech-engine">
      <span>Engine</span>
      <div class="seg" id="engine" role="radiogroup" aria-label="Engine">
        <button type="button" role="radio" data-hq="0" aria-checked="false">Classic</button>
        <button type="button" role="radio" data-hq="1" aria-checked="false">HQ</button>
      </div>
    </div>
    <button type="button" class="key-btn" id="tech-close">Close</button>
  </header>
  <div class="tech-body" id="tech-body"></div>`;
document.body.appendChild(techEl);
const techBody = techEl.querySelector('#tech-body');

// ── numbers ──────────────────────────────────────────────────────────────────────────────────────
const tSr = () => (ctx ? ctx.sampleRate : 48000);
const tA = id => audible(id);
const tDb = (v, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d) + ' dB';
const tHz = f => (f >= 10000 ? (f / 1000).toFixed(1) + ' kHz' : f >= 1000 ? (f / 1000).toFixed(2) + ' kHz' : Math.round(f) + ' Hz');
const tMs = s => (s >= 1 ? s.toFixed(2) + ' s' : s >= 0.01 ? Math.round(s * 1000) + ' ms' : (s * 1000).toFixed(2) + ' ms');
const tPct = (v, d = 0) => (v * 100).toFixed(d) + ' %';
const tPeak = v => (v > 1e-5 ? tDb(20 * Math.log10(v)) + 'FS' : 'silent');
const hqOn = () => values.hq > 0.5;

/** The tape and master sections as a filter: level in dB at frequency f, for a quiet signal, at the knobs as they are.
 *  The same one-pole stages the engine runs (dsp/tape-processor.js), multiplied together. */
function techResponse(f) {
  const sr = tSr(), w = 2 * Math.PI * f / sr, co = fc => 1 - Math.exp(-2 * Math.PI * fc / sr);
  const lp = a => { const b = 1 - a, dr = 1 - b * Math.cos(w), di = b * Math.sin(w), m = a / (dr * dr + di * di); return [m * dr, -m * di]; };
  const mul = (x, y) => [x[0] * y[0] - x[1] * y[1], x[0] * y[1] + x[1] * y[0]];
  const drive = tA('drive'), loss = tA('loss'), emph = 0.9 * drive, de = emph / (1 + emph);
  const e = lp(co(2500));
  let h = mul([1 + emph * (1 - e[0]), -emph * e[1]], [1 - de * (1 - e[0]), de * e[1]]);                 // record and playback equalisation
  const l = lp(co(Math.min(20000 * Math.pow(0.07, loss), 0.45 * sr)));
  h = mul(h, mul(l, l));                                                                                // loss
  const b1 = lp(co(120)), b2 = lp(co(45)), bump = 0.25 + 0.9 * loss;
  h = mul(h, [1 + bump * (b1[0] - b2[0]), bump * (b1[1] - b2[1])]);                                     // head bump
  const hp = lp(co(20 + 230 * loss * loss));
  h = mul(h, [1 - hp[0], -hp[1]]);                                                                      // the tape's low cut
  const c = lp(co(tA('lowCut'))), lc = [1 - c[0], -c[1]];
  h = mul(h, mul(lc, lc));                                                                              // master low cut
  const t = lp(co(900)), gHi = Math.pow(10, tA('tone') * 6 / 20), gLo = 1 / gHi;
  h = mul(h, [t[0] * gLo + (1 - t[0]) * gHi, t[1] * (gLo - gHi)]);                                      // master tone
  return 20 * Math.log10(Math.hypot(h[0], h[1]) + 1e-9);
}
/** Where the response has fallen 3 dB below its level at 1 kHz, going up from 1 kHz (null if it never does). */
function techTop() {
  const ref = techResponse(1000);
  for (let f = 1000; f < 0.49 * tSr(); f *= 1.02) if (techResponse(f) < ref - 3) return f;
  return null;
}
function techBump() {
  const ref = techResponse(1000); let best = -99, at = 0;
  for (let f = 25; f < 400; f *= 1.04) { const v = techResponse(f) - ref; if (v > best) { best = v; at = f; } }
  return [best, at];
}
function techPitchPeak() {             // the largest pitch deviation the engine reported over the last six seconds, in cents
  const n = Math.min(HN, Math.floor(SPAN / (512 / tSr())));
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(hCents[(hPos - i + HN) % HN]));
  return pk;
}

// ── the sheet: one card per stage. A row is [label, text or function]; functions are read while the view is open ──
const live = fn => fn;
const TECH = [
  { id: 'sys', title: 'System', rows: [
    ['Sample rate', live(() => (ctx ? (tSr() / 1000).toFixed(1) + ' kHz, 32-bit float' : 'starts with the first sound'))],
    ['Block', live(() => '128 samples · ' + (128000 / tSr()).toFixed(1) + ' ms')],
    ['Engine delay', live(() => hqOn() ? `32 samples · ${(32000 / tSr()).toFixed(2)} ms, wet and dry alike` : 'dry 0 · wet 4 samples')],
    ['Output latency', live(() => { if (!ctx) return 'not running'; const b = ctx.baseLatency || 0, o = ctx.outputLatency || 0; return (b + o ? ((b + o) * 1000).toFixed(1) + ' ms' : 'not reported') + ' (this device)'; })],
    ['Engine load', live(() => (ctx ? tPct(engineLoad, 1) + ' of one processor core' : 'not running'))],
    ['Input', live(() => { const t = liveStream && liveStream.getAudioTracks()[0]; if (!t) return source === 'live' ? 'closed' : 'not in use (' + source + ')'; const st = t.getSettings ? t.getSettings() : {}; return (t.label || 'audio input') + (st.channelCount ? ' · ' + st.channelCount + ' ch' : ''); })],
    ['Levels now', live(() => `in ${tPeak(peakIn)} · out ${tPeak(peakOut)}`)],
    ['Privacy', 'Everything runs on this device. No sound is sent anywhere.'],
  ] },
  { id: 'speed', title: 'Speed', rows: [
    ['Now', live(() => { const r = values.bypass > .5 ? 1 : tA('speed'), st = 12 * Math.log2(r); return `${r.toFixed(2)}× · ${st > 0.05 ? '+' : st < -0.05 ? '−' : ''}${Math.abs(st).toFixed(1)} semitones`; })],
    ['Range', '0.25× to 2× (−24 to +12 semitones), detents at ½×, 1× and 2×'],
    ['Method', 'Varispeed: pitch and length move together, as on a deck. The loop is resampled by the browser (linear interpolation); a 40 ms glide stands in for the motor.'],
    ['Live input', 'Always 1×: sound that has not happened yet cannot be played faster.'],
  ] },
  { id: 'motion', title: 'Motion', rows: [
    ['Wow now', live(() => { const d = 0.04 * tA('wow') ** 2; return `±${(d * 100).toFixed(2)} % · ±${(1200 * Math.log2(1 + d)).toFixed(0)} cents at ${tA('wowRate').toFixed(2)} Hz`; })],
    ['Wow shape', live(() => `sine + 25 % second harmonic; rate wanders ±${Math.round(60 * tA('wobble'))} %`)],
    ['Flutter now', live(() => `±${(1.2 * tA('flutter') ** 2).toFixed(2)} % at 6.3 Hz + 11.7 Hz + noise under 18 Hz`)],
    ['Drift now', live(() => { const w = tA('wobble'); return w < 0.005 ? 'off' : `random, up to ${(10 * w * w).toFixed(1)} ms of lag; snags of 150–450 ms`; })],
    ['Spread now', live(() => `right channel ${Math.round(tA('spread') * 180 / Math.PI)}° behind on the wow`)],
    ['Measured', live(() => { const c = techPitchPeak(); return `±${c.toFixed(1)} cents · ±${((Math.pow(2, c / 1200) - 1) * 100).toFixed(2)} % peak, last 6 s`; })],
    ['Range', 'wow 0 to ±4 % at 0.1–4 Hz · flutter 0 to ±1.2 %'],
    ['Transport', live(() => hqOn() ? 'modulated delay, 4-point Hermite read of a tape kept at 2× the sample rate: a 15 kHz tone holds its level within 0.2 dB while it moves' : 'modulated delay, 4-point Hermite read at the sample rate: a 15 kHz tone ripples 2.5 dB in level while it moves')],
  ] },
  { id: 'tape', title: 'Tape', rows: [
    ['Saturation now', live(() => { const d = tA('drive'), g = 1 + 15 * d * d; return `${tDb(20 * Math.log10(g))} into tanh, make-up ${tDb(-14 * Math.log10(g))}`; })],
    ['Bias and EQ', live(() => { const d = tA('drive'); return `offset ${(0.18 * d).toFixed(3)} (even harmonics) · highs ${tDb(20 * Math.log10(1 + 0.9 * d))} above 2.5 kHz going in, restored coming out, so they saturate first`; })],
    ['Oversampling', live(() => hqOn() ? '4× · 47- and 21-tap linear-phase filters · aliasing 30–70 dB lower than Classic' : 'none: harmonics above half the sample rate fold back as aliasing')],
    ['Loss now', live(() => { const top = techTop(), [b, at] = techBump(); return `12 dB/oct above ${tHz(Math.min(20000 * Math.pow(0.07, tA('loss')), 0.45 * tSr()))}` + (top ? `, −3 dB at ${tHz(top)}` : '') + ` · low cut ${tHz(20 + 230 * tA('loss') ** 2)} · head bump ${tDb(b)} at ${tHz(at)}`; })],
    ['Dropouts now', live(() => { const d = tA('dropouts'); return d <= 0.005 ? 'off' : `${(0.15 + 5 * d * d).toFixed(1)} a second on average · 25–325 ms · down to ${tDb(20 * Math.log10(1 - Math.min(0.97, 0.35 + 0.65 * d)))}, treble falling with the level`; })],
    ['Hiss now', live(() => { const h = tA('hiss'); return h <= 0.005 ? 'off' : `${tDb(-39.4 + 40 * Math.log10(h))}FS rms, shaped towards 1–8 kHz, ducked by dropouts`; })],
  ] },
  { id: 'grain', title: 'Grains', rows: [
    ['Now', live(() => { const on = tA('grains') > 0.005; return on ? `${grains ? grains.length / 4 : 0} of 48 in flight · ${tMs(tA('gSize'))} × ${tA('gDensity').toFixed(1)} a second = ${(tA('gSize') * tA('gDensity')).toFixed(1)} overlapping` : 'off (Amount at 0)'; })],
    ['Tape', '8 s of what comes off the transport, recorded before loss and hiss; the read point sits 0–6 s back and can travel'],
    ['Pitch now', live(() => { const st = tA('gPitch'); return `${st > 0 ? '+' : st < 0 ? '−' : ''}${Math.abs(Math.round(st))} semitones (×${Math.pow(2, st / 12).toFixed(2)}) · Scatter picks from ±12, +7, +19, −5, ±24`; })],
    ['Window', live(() => `two Hann halves, peak ${Math.round((0.04 + 0.92 * tA('gShape')) * 100)} % of the way through`)],
    ['Read', live(() => hqOn() ? '4-point Hermite; grains faster than ×1.6 read band-limited copies of the tape (Chebyshev, 3 steps), aliasing 30–55 dB lower' : '4-point Hermite; pitched-up grains alias above half the sample rate')],
    ['Feedback now', live(() => { const f = tA('gFeedback'); return f <= 0.001 ? 'off' : `${Math.round(f * 100)} % of the cloud back on its tape, low cut ${tHz(70 + 230 * f * f)}, soft-limited`; })],
  ] },
  { id: 'space', title: 'Space', rows: [
    ['Type', 'Plate: four all-pass diffusers into a loop of two delays and four more all-passes, one tap swept at 0.3 Hz'],
    ['Decay now', live(() => { const k = 0.35 + 0.63 * tA('sDecay'); return tA('space') <= 0.0005 ? 'off (Space at 0)' : `RT60 ≈ ${(-3 * 0.48 / (2 * Math.log10(k))).toFixed(1)} s · loop gain ${k.toFixed(2)}, loop time 0.48 s`; })],
    ['Damping now', live(() => { const sr = tSr(), klp = 1 - Math.pow(1 - (0.35 + 0.63 * tA('sTone')), 32000 / sr); return `6 dB/oct above ${tHz(Math.min(0.49 * sr, -Math.log(1 - Math.min(klp, 0.999)) * sr / (2 * Math.PI)))} inside the loop`; })],
    ['Bands now', live(() => ['sLow', 'sMid', 'sMidHi', 'sHigh', 'sAir'].map(id => { const v = tA(id); return v < 0.01 ? 'off' : tDb(20 * Math.log10(v), 0).replace(' dB', ''); }).join(' / ') + ' dB, split at 200 Hz, 800 Hz, 3 kHz, 8 kHz')],
    ['Send and return', 'mono sum with a 60 Hz low cut going in; stereo coming back, one side from each half of the loop'],
    ['Lineage', 'The loop is the Griesinger plate as built in Mutable Instruments Clouds (MIT licence), run at any sample rate'],
  ] },
  { id: 'master', title: 'Master', rows: [
    ['Filters now', live(() => `low cut ${tHz(tA('lowCut'))} at 12 dB/oct · tilt ${tDb(tA('tone') * 6)} about 900 Hz · width ${Math.round(tA('width') * 100)} %`)],
    ['Glue now', live(() => { const g = tA('glue'); if (g <= 0.002) return 'off'; const r = 1 + 3 * g; return `threshold ${tDb(-4 - 20 * g)} · ratio ${r.toFixed(1)}:1 · 10 ms attack, 120 ms release · make-up ${tDb((4 + 20 * g) * (1 - 1 / r) * 0.6)}`; })],
    ['Limiter', live(() => effective('limit') > .5 && effective('onMaster') > .5 ? `ceiling −0.3 dBFS, instant attack, 80 ms release · reducing ${tDb(20 * Math.log10(Math.max(gr, 1e-3)))} now` : 'off')],
    ['Mix now', live(() => `${Math.round(tA('mix') * 100)} % wet` + (hqOn() ? ' · dry delayed 32 samples to stay in phase with the wet' : ' · dry not delayed: wet runs 4 samples late'))],
    ['Output now', live(() => tDb(tA('output')))],
  ] },
];

// the signal path, in the order the engine runs it
const PATH = [
  ['IN', () => source.toUpperCase(), () => playing],
  ['RECORD', () => `tanh${hqOn() ? ' · 4×' : ''}`, () => tA('drive') > 0.005],
  ['TRANSPORT', () => 'wow · flutter', () => tA('wow') + tA('flutter') + tA('wobble') > 0.005],
  ['GRAINS', () => '48 voices', () => tA('grains') > 0.005],
  ['PLAYBACK', () => 'loss · hiss', () => tA('loss') + tA('hiss') + tA('dropouts') > 0.005],
  ['SPACE', () => 'plate', () => tA('space') > 0.005],
  ['MIX', () => Math.round(tA('mix') * 100) + ' % wet', () => true],
  ['MASTER', () => 'glue · limit', () => effective('onMaster') > .5],
  ['OUT', () => (values.bypass > .5 ? 'BYPASSED' : 'stereo'), () => playing],
];

const techLive = [];
{
  const path = document.createElement('section');
  path.className = 'tcard tpath';
  path.innerHTML = '<h3>Signal path</h3><ol>' + PATH.map(p => `<li><b>${p[0]}</b><i></i></li>`).join('') + '</ol>';
  techBody.appendChild(path);
  path.querySelectorAll('li').forEach((li, i) => techLive.push(() => { const t = PATH[i][1](); const el = li.querySelector('i'); if (el.textContent !== t) el.textContent = t; li.classList.toggle('on', !!PATH[i][2]()); }));

  const scopes = document.createElement('section');
  scopes.className = 'tcard tscopes';
  scopes.innerHTML = ['Response', 'Saturation', 'Pitch'].map((n, i) => `<figure><figcaption><b>${n}</b><span id="tscope-t${i}"></span></figcaption><canvas id="tscope-${i}"></canvas></figure>`).join('');
  techBody.appendChild(scopes);

  for (const card of TECH) {
    const el = document.createElement('section');
    el.className = 'tcard'; el.dataset.card = card.id;
    const dl = document.createElement('dl');
    for (const [label, val] of card.rows) {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = label;
      if (typeof val === 'function') { dd.className = 'now'; techLive.push(() => { let t; try { t = val(); } catch (_) { t = 'not available'; } if (dd.textContent !== t) dd.textContent = t; }); }
      else dd.textContent = val;
      dl.append(dt, dd);
    }
    const h = document.createElement('h3'); h.textContent = card.title;
    el.append(h, dl); techBody.appendChild(el);
  }
}

// ── the scopes ───────────────────────────────────────────────────────────────────────────────────
function techScopes() {
  const cap = i => techEl.querySelector('#tscope-t' + i);
  // 1. response: the tape and master sections as a filter, 20 Hz to 20 kHz, ±18 dB
  {
    const { g, W, H } = fit(techEl.querySelector('#tscope-0')), fx = f => Math.log(f / 20) / Math.log(1000) * W, y = d => H / 2 - d / 18 * (H / 2 - 4);
    g.strokeStyle = FAINT; g.lineWidth = 1; g.fillStyle = DIM; g.font = '8px ' + FONT; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    for (const f of [100, 1000, 10000]) { g.beginPath(); g.moveTo(fx(f), 0); g.lineTo(fx(f), H); g.stroke(); g.fillText(f >= 1000 ? f / 1000 + 'k' : f, fx(f) + 3, H - 3); }
    for (const d of [-12, 0, 12]) { g.beginPath(); g.moveTo(0, y(d)); g.lineTo(W, y(d)); g.stroke(); if (d) g.fillText((d > 0 ? '+' : '−') + Math.abs(d), 3, y(d) - 3); }
    const ref = 0; g.beginPath();
    for (let x = 0; x <= W; x += 2) { const f = 20 * Math.pow(1000, x / W), v = clamp(techResponse(f) - ref, -30, 30); x ? g.lineTo(x, y(v)) : g.moveTo(x, y(v)); }
    g.strokeStyle = INK; g.lineWidth = 1.8; g.lineJoin = 'round'; g.stroke();
    const top = techTop(); cap(0).textContent = 'tape + master, quiet signal' + (top ? ' · −3 dB at ' + tHz(top) : '');
  }
  // 2. saturation: what goes on to the tape for what comes in, with a mark at the level on the tape now
  {
    const { g, W, H } = fit(techEl.querySelector('#tscope-1')), d = tA('drive'), gD = 1 + d * d * 15, gMk = 1 / Math.pow(gD, 0.7), bias = 0.18 * d, tb = Math.tanh(bias);
    const s = Math.min(W, H) / 2 - 4, cx = W / 2, cy = H / 2, f = x => (Math.tanh(x * gD + bias) - tb) * gMk;
    g.strokeStyle = FAINT; g.lineWidth = 1;
    g.beginPath(); g.moveTo(cx - s, cy); g.lineTo(cx + s, cy); g.moveTo(cx, cy - s); g.lineTo(cx, cy + s); g.stroke();
    g.setLineDash([3, 4]); g.beginPath(); g.moveTo(cx - s, cy + s); g.lineTo(cx + s, cy - s); g.stroke(); g.setLineDash([]);
    g.beginPath();
    for (let i = 0; i <= 80; i++) { const x = -1 + i / 40, px = cx + x * s, py = cy - clamp(f(x), -1, 1) * s; i ? g.lineTo(px, py) : g.moveTo(px, py); }
    g.strokeStyle = INK; g.lineWidth = 1.8; g.lineJoin = 'round'; g.stroke();
    const lv = Math.min(1, peakIn);
    if (playing && lv > 0.003) { g.fillStyle = HOT; for (const sg of [-1, 1]) { g.beginPath(); g.arc(cx + sg * lv * s, cy - clamp(f(sg * lv), -1, 1) * s, 3.5, 0, 2 * Math.PI); g.fill(); } }
    cap(1).textContent = `in → tape · ${tDb(20 * Math.log10(gD))} drive`;
  }
  // 3. pitch: the speed the tape is really running at, last six seconds
  {
    const { g, W, H } = fit(techEl.querySelector('#tscope-2')), msgDt = 512 / tSr(), n = Math.min(HN, Math.floor(SPAN / msgDt)), pk = techPitchPeak(), rng = Math.max(10, pk * 1.25);
    g.strokeStyle = FAINT; g.lineWidth = 1; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
    g.beginPath();
    for (let i = 0; i < n; i++) { const x = i * msgDt / SPAN * W, y = H / 2 - clamp(hCents[(hPos - i + HN) % HN] / rng, -1, 1) * (H / 2 - 4); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.strokeStyle = INK; g.lineWidth = 1.6; g.lineJoin = 'round'; g.stroke();
    g.fillStyle = DIM; g.font = '8px ' + FONT; g.textAlign = 'left'; g.fillText('±' + Math.round(rng) + ' cents', 3, 10);
    cap(2).textContent = `speed, last 6 s · ±${((Math.pow(2, pk / 1200) - 1) * 100).toFixed(2)} % peak`;
  }
}

// ── opening, closing, the engine switch ──────────────────────────────────────────────────────────
let techTimer = 0, techRaf = 0;
function techTick() { for (const fn of techLive) fn(); }
function techFrame() { techRaf = requestAnimationFrame(techFrame); techScopes(); }
function syncEngine() { techEl.querySelectorAll('#engine button').forEach(b => b.setAttribute('aria-checked', String((b.dataset.hq === '1') === hqOn()))); }
function setTech(on) {
  if (on === !techEl.hidden) return;
  techEl.hidden = !on; document.body.classList.toggle('tech-open', on);
  clearInterval(techTimer); cancelAnimationFrame(techRaf);
  if (on) { syncEngine(); techTick(); techTimer = setInterval(techTick, 200); techFrame(); techEl.querySelector('#tech-close').focus({ preventScroll: true }); }
}
function setEngine(hq) {
  setValue('hq', hq ? 1 : 0, true);
  try { localStorage.setItem('tapeloss.hq', hq ? '1' : '0'); } catch (_) {}
  syncEngine(); techTick();
  say(hq ? 'Engine: HQ' : 'Engine: Classic');
}
techEl.querySelectorAll('#engine button').forEach(b => b.addEventListener('click', () => setEngine(b.dataset.hq === '1')));
techEl.querySelector('#tech-close').addEventListener('click', () => setTech(false));
{
  const brand = document.querySelector('#brand');
  brand.addEventListener('click', () => setTech(true));
  brand.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTech(true); } });
}
window.addEventListener('keydown', e => { if (e.key === 'Escape' && !techEl.hidden) setTech(false); });
window.tapeloss.setTech = setTech;
window.tapeloss.setEngine = setEngine;
