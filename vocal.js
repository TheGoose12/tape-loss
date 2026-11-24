'use strict';
/* Tape Loss MK IV: Vocal mode. A fourth face, after Reel on the skin key. Kept on its own, like tempo.js.

   It takes the voice on the Loop or File source (between the loop's ends) and plays it as a melody:
     · the voice is cut where each new sound starts (its syllables), not on a fixed grid
     · the pitch each syllable sits on is measured
     · a row of steps, in tempo, each with a note of the chosen key and scale and one of the syllables. Tap a
       square in the grid to put that step on that note (tap it again for a rest); ROLL MELODY writes a line
     · VOICE says how a syllable gets to its note. TAPE: the tape runs faster or slower, so higher is shorter
       and thinner, as a sampler does it. NATURAL: the pitch is moved and the voice keeps its character; TUNE
       flattens the rise and fall of speech onto the note (the hard-tuned sound) and FIT makes each syllable
       last until the next note
     · TIMING. ON THE GRID: the syllables are played as steps, in tempo. AS SPOKEN: the voice keeps its own
       timing and order and only the notes change (each syllable starts on the scale note nearest to where it
       was spoken, which is plain auto-tune; tap the grid to move one)
     · STYLE, each its own switch: PUMP ducks the voice on every beat; SAT is tape saturation; DOUBLE is a second
       copy just behind and wobbling, spread left and right; AIR adds the notes an octave up; ECHO is a
       dotted-eighth repeat. REVERB is the engine's own Space
     · CALL & ANSWER. Off, it is just the melody. On (A B, or A A A B) the melody is the call, A, and an answer, B,
       is written from it: the same rhythm with the notes moved or the syllables changed, ending on the root.
       SHOWING: FOLLOW puts whichever phrase is playing on the grid, A or B pins one to edit; the letters
       over the screen light up one at a time as the phrases go by. NEW ANSWER writes another
     · SYLLABLES. IN ORDER: the sounding steps take the syllables as they were spoken, round and round, so the words
       come out in their own order. SHUFFLE deals them at random (press it again for another deal). The switch shows
       which it is, and IN ORDER always puts it back
     · MATCH: one note for each syllable in use, so the melody and the words are the same length and go round
       together. Notes are added on the strongest free beats or dropped from the weakest until the two agree; it is
       done again when a syllable is left out, the voice is trimmed or a melody is rolled, but not when a square is
       tapped by hand. The label over the switch counts both
     · TRIM: the voice row has a handle at each end. Drag one in to cut the start or the end off (it is the tape's own
       loop start and end, so the other modes see the same trim); a little of what was cut shows greyed either side,
       to pull a handle back out into. The melody is kept; the syllables are read again
     · while Rec is running the voice is drawn as it comes in, where the syllables will be
     · PRINT writes what is playing, with its style, into the sample bank, so it opens in any other mode
   The sums are in dsp/vocal-dsp.js. Checked there against two made-up voices, one clean and one rough (a
   consonant before every vowel, a shaky pitch, breath, a hissing room): every syllable found with its consonant
   kept on it, the pitch read to within 2 Hz, NATURAL landing within 2 cents of the note, FIT giving exactly the
   length asked for by drawing out the sung part and leaving the consonant as it was.
   A quiet recording is brought up before it is read, loud and soft syllables are evened half-way, and on the
   grid each syllable is placed by where its body starts, so the beat is felt on the vowel.

   TO PULL IT OUT: delete this file, dsp/vocal-dsp.js and their <script> lines. The two hooks in app.js are
   marked "vocal.js" and check that the function exists first. */

const VOX = { on: false, root: 9, scale: 'Minor pentatonic', steps: 16, div: 8, oct: 0, voice: 'tape', tune: 1, fit: true, pump: false, sens: 0.5, time: 'grid', bpm: 100, sat: false, dbl: false, air: false, echo: false, tab: 'melody', chain: 'off', order: 'order', follow: true, match: false };
try { Object.assign(VOX, JSON.parse(localStorage.getItem('tapeloss.vocal') || '{}')); } catch (_) {}
const vSave = () => { try { localStorage.setItem('tapeloss.vocal', JSON.stringify(VOX)); } catch (_) {} };
const V_SCALES = { 'Minor pentatonic': [0, 3, 5, 7, 10], 'Major pentatonic': [0, 2, 4, 7, 9], Minor: [0, 2, 3, 5, 7, 8, 10], Major: [0, 2, 4, 5, 7, 9, 11], Dorian: [0, 2, 3, 5, 7, 9, 10] };
const V_NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const vScale = () => V_SCALES[VOX.scale] || V_SCALES.Minor;
const vRows = () => vScale().length * 2 + 1;                              // two octaves of the scale, and the note on top
/** The note of a row. The grid sits round the voice itself: its middle row is the key's root nearest to where the
 *  voice speaks (vx.shift, found when it is read), so a melody starts within reach of it. OCTAVE moves the whole grid. */
const vMidi = deg => { const s = vScale(), L = s.length; return 48 + VOX.root + 12 * (VOX.oct + (vx ? vx.shift : 0)) + s[deg % L] + 12 * Math.floor(deg / L); };
const vHz = deg => 440 * Math.pow(2, (vMidi(deg) - 69) / 12);
const vName = midi => V_NOTES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
const vBpm = () => (typeof TEMPO !== 'undefined' ? TEMPO.bpm : VOX.bpm);                         // the tempo is tempo.js's, when it is there
function vSetBpm(v) {
  v = Math.max(40, Math.min(240, Math.round(v * 10) / 10));
  if (typeof TEMPO !== 'undefined' && typeof tSet === 'function') { TEMPO.guess = false; tSet('bpm', v); } else { VOX.bpm = v; vSave(); }
  vCache.clear(); vSync();
}
const vStepSec = () => 60 / vBpm() * 4 / VOX.div;
const vFree = () => VOX.time === 'free';                                 // AS SPOKEN: the voice keeps its own timing; only its notes are changed
const vPick = a => a[Math.floor(Math.random() * a.length)];

let vx = null;            // the voice as analysed: { key, sr, mono, f0, syl: [{ a, b, f, on }] }
let vSteps = [];          // one per step: { on, deg, syl }
let vSel = -1, vSelSyl = -1, vp = null, vBus = null, vFx = null, vNow = -1;
let vPhrase = 'A', vAlt = null, vPlaying = '';      // two phrases, A and B. The one on the grid lives in vSteps and in each syllable's deg; the other waits in vAlt as { steps, degs }
const vCache = new Map();

/** Read the voice on the source in use. Done again whenever the tape, its loop ends or CUTS change. */
function vAnalyse() {
  const t = curTape();
  if (!t || !t.buf) { vx = null; return; }
  const key = [t.buf.length, t.buf.sampleRate, t.ls.toFixed(3), t.le.toFixed(3), VOX.sens].join();
  if (vx && vx.key === key && vx.buf === t.buf) return;
  const sr = t.buf.sampleRate, a = Math.round(t.ls * sr), b = Math.min(t.buf.length, Math.round(t.le * sr)), n = Math.max(1, b - a), mono = new Float32Array(n);
  for (let c = 0; c < t.buf.numberOfChannels; c++) { const d = t.buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[a + i] / t.buf.numberOfChannels; }
  let pk = 0; for (let i = 0; i < n; i++) { const v = mono[i] < 0 ? -mono[i] : mono[i]; if (v > pk) pk = v; }
  let gain = 1;
  if (pk > 1e-4) { gain = Math.min(16, 0.9 / pk); for (let i = 0; i < n; i++) mono[i] *= gain; }      // a quiet recording is brought up to work on
  const f0 = VocalDSP.pitchTrack(mono, sr), syl = VocalDSP.syllables(mono, sr, VOX.sens, f0), fr = x => Math.round(x / sr / VocalDSP.HOP);
  for (const s of syl) { s.f = VocalDSP.median(f0, fr(s.a), fr(s.b)); s.on = true; s.deg = -1; Object.assign(s, VocalDSP.shape(mono.subarray(s.a, s.b), sr)); }
  const lv = syl.map(q => q.rms).sort((p, q) => p - q), midLv = lv[lv.length >> 1] || 1;
  for (const s of syl) s.gain = Math.max(0.6, Math.min(2, Math.sqrt(midLv / (s.rms || midLv))));      // loud and soft syllables are brought half-way to each other
  const fresh = !vx || vx.buf !== t.buf;                                // the same tape, trimmed or cut another way, keeps its melody
  const sung0 = syl.filter(q => q.f > 0).map(q => 69 + 12 * Math.log2(q.f / 440)).sort((p, q) => p - q), mid = sung0.length ? sung0[sung0.length >> 1] : 60;
  vx = { key, buf: t.buf, sr, mono, f0, syl, t0: a / sr, gain, shift: Math.round((mid - (60 + VOX.root)) / 12) };      // whole octaves from the grid's own middle (C4 and up) to the voice
  vCache.clear();
  vAlt = null; vPhrase = 'A';                                           // the syllables are new ones: an answer written for the old ones no longer fits
  vNearest();
  if (fresh || vSteps.length !== VOX.steps) { vRoll(true); }
  vFlow(); vDeal(false);
  if (VOX.chain !== 'off') vAnswer(true);                               // call and answer is on: the new voice needs its answer
  const sung = syl.filter(s => s.f > 0).length;
  say(`Voice read: ${syl.length} syllable${syl.length === 1 ? '' : 's'}, ${sung} with a pitch, speaking round ${vName(Math.round(mid))}` + (syl.length < 2 ? '. Try CUTS + for more' : ''));
}
/** AS SPOKEN's notes: each syllable on the note of the scale nearest to where it was spoken. That is plain auto-tune. */
function vNearest() {
  if (!vx) return;
  for (const s of vx.syl) {
    s.deg = -1;
    if (!s.f) continue;
    let best = 1e9;
    for (let d = 0; d < vRows(); d++) { const e = Math.abs(Math.log(vHz(d) / s.f)); if (e < best) { best = e; s.deg = d; } }
  }
  vCache.clear();
}
/** Give each sounding step its syllable.
 *  IN ORDER: the sounding steps take the syllables as they were spoken, round and round. A rest takes none, and a step
 *  given another syllable by hand (◀ Syl ▶) keeps it. SHUFFLE: `again` deals every step at random; otherwise only the
 *  steps whose syllable has gone are mended. */
function vDeal(again) {
  if (!vx) return;
  const pool = vx.syl.map((s, i) => i).filter(i => vx.syl[i].on), inOrder = VOX.order !== 'mix';
  for (const list of vAlt ? [vSteps, vAlt.steps] : [vSteps]) { let k = 0; for (const st of list) {
    if (!pool.length) { st.syl = -1; continue; }
    if (inOrder) {
      if (!st.on) { st.syl = pool[k % pool.length]; st.own = false; continue; }
      const mine = pool[k++ % pool.length];
      if (!(st.own && pool.includes(st.syl))) { st.syl = mine; st.own = false; }
    } else if (again === true || !pool.includes(st.syl)) st.syl = vPick(pool);
  } }
  vCache.clear();
}
/** MATCH: as many sounding steps as there are syllables in use, so one pass of the melody is one pass of the words.
 *  Too few notes: rests are brought in, the strongest beats first, each on the note sounding before it. Too many: the
 *  weakest are dropped, from the end. The first step always sounds. */
function vMatch() {
  if (!vx || vFree()) return '';
  const want = vx.syl.filter(q => q.on).length;
  if (!want) return '';
  const weight = k => { if (!k) return 99; let z = 0; while (!(k & 1)) { k >>= 1; z++; } return z; };
  for (const list of vAlt ? [vSteps, vAlt.steps] : [vSteps]) {
    const n = list.length, idx = list.map((q, k) => k);
    let on = list.filter(q => q.on).length;
    for (const k of idx.filter(k => !list[k].on).sort((a, b) => weight(b) - weight(a) || a - b)) {
      if (on >= want) break;
      let d = vScale().length; for (let j = 1; j <= n; j++) { const q = list[(k - j + n) % n]; if (q.on) { d = q.deg; break; } }
      list[k].on = true; list[k].deg = d; on++;
    }
    for (const k of idx.filter(k => k && list[k].on).sort((a, b) => weight(a) - weight(b) || b - a)) {
      if (on <= want) break;
      list[k].on = false; on--;
    }
  }
  vCache.clear();
  const n = vSteps.length;
  return want > n ? `The voice has ${want} syllables and there are ${n} steps: every step plays and the last ${want - n} wait. Trim the voice, leave some out, or use 16 steps` : `Match: ${want} notes for ${want} syllables, so the melody and the words go round together`;
}
const vFlow = () => (VOX.match ? vMatch() : '');
/** The SYLLABLES switch. In order: back to how it was spoken (and anything set by hand is forgotten). Shuffle: a new deal. */
function vOrder(v) {
  VOX.order = v; vSave();
  if (v === 'order') { for (const list of vAlt ? [vSteps, vAlt.steps] : [vSteps]) for (const st of list) st.own = false; vDeal(); say('Syllables in order: the steps take them as they were spoken'); }
  else { vDeal(true); say('Syllables shuffled: ' + vSteps.map(q => (q.on && q.syl >= 0 ? q.syl + 1 : '·')).join(' ') + '. Shuffle again for another deal, In order to go back'); }
  vSync();
}
/** Write a melody: a short figure, said again a step higher or lower, and an ending that comes home to the root. */
function vRoll(quiet) {
  if (vFree() && vx && quiet !== true) {                                 // as spoken: the syllables stay where they are, and get a new line of notes
    const R = vRows(), L = vScale().length, sung = vx.syl.filter(q => q.f > 0);
    let d = L + vPick([0, 0, 2, -1, 1]);
    sung.forEach((q, k) => { if (k) d = Math.max(1, Math.min(R - 2, d + vPick([-2, -1, -1, 0, 1, 1, 2]))); q.deg = k === sung.length - 1 ? vPick([L, L, 0]) : d; });
    vCache.clear();
    say('New notes for the syllables: ' + sung.map(q => vName(vMidi(q.deg))).join(' '));
    return;
  }
  const L = vScale().length, R = vRows(), home = L, n = VOX.steps, fig = Math.max(2, n >> 2), was = vSteps;
  vSteps = [];
  let d = home + vPick([0, 0, 2, -1, 1]);
  const shift = vPick([0, 1, -1, 2]);
  for (let k = 0; k < n; k++) {
    const again = k >= fig * 2 && k < fig * 3 && vSteps[k - fig * 2];
    if (again) d = Math.max(0, Math.min(R - 1, again.deg + shift));
    else if (k) d = Math.max(1, Math.min(R - 2, d + vPick([-2, -1, -1, 0, 1, 1, 2])));
    const on = again ? again.on : k === 0 || Math.random() < (k % 2 ? 0.55 : 0.9);
    vSteps.push({ on, deg: d, syl: was[k] ? was[k].syl : -1 });
  }
  for (let k = n - 1; k >= 0; k--) if (vSteps[k].on) { vSteps[k].deg = vPick([home, home, home + L, 0]); break; }
  vCache.clear();
  if (quiet !== true) { vFlow(); vDeal(); say('New melody: ' + vSteps.map(s => (s.on ? vName(vMidi(s.deg)) : '·')).join(' ')); }
}
/* ── two phrases: the call and its answer ── */
const vClampDeg = d => Math.max(0, Math.min(vRows() - 1, d));
/** What phrase `ph` is made of: its steps (on the grid) and its note for each syllable (as spoken). */
function vData(ph) { return ph === vPhrase || !vAlt ? { steps: vSteps, degs: vx ? vx.syl.map(q => q.deg) : [] } : vAlt; }
/** Which phrases play, in order, before it all goes round. */
const vSeq = () => (VOX.chain === 'ab' ? ['A', 'B'] : VOX.chain === 'aaab' ? ['A', 'A', 'A', 'B'] : ['A']);      // off: just the melody
/** An answer to a phrase: the same rhythm, so it is heard as a reply, with the notes moved (a third up, a third down,
 *  or turned upside down) or the same notes on other syllables, and an ending that comes home to the root. */
function vMakeAnswer(from) {
  const L = vScale().length, kind = vPick(vFree() || VOX.order !== 'mix' ? ['up', 'down', 'mirror'] : ['up', 'down', 'mirror', 'swap']), n = from.steps.length, half = n >> 1;
  const move = (d, early) => vClampDeg(kind === 'mirror' ? 2 * L - d : kind === 'swap' ? d : d + (kind === 'up' ? 2 : -2) * (early ? 1 : 0.5));
  const pool = vx ? vx.syl.map((q, i) => i).filter(i => vx.syl[i].on) : [];
  const steps = from.steps.map((st, k) => ({ on: st.on, deg: Math.round(move(st.deg, k < half)), syl: kind === 'swap' && pool.length ? pool[(pool.length - 1 - (k % pool.length))] : st.syl, own: st.own }));
  for (let k = n - 1; k >= 0; k--) if (steps[k].on) { steps[k].deg = L; break; }
  const degs = from.degs.map(d => (d < 0 ? -1 : Math.round(move(d, true))));
  for (let i = degs.length - 1; i >= 0; i--) if (degs[i] >= 0) { degs[i] = Math.round(degs[i] / L) * L; break; }      // the last sung syllable lands on a root
  return { steps, degs, text: 'Answer written: ' + { up: 'the call a third higher', down: 'the call a third lower', mirror: 'the call turned upside down', swap: 'the same notes on other syllables' }[kind] + ', coming home on ' + vName(vMidi(L)) };
}
/** MAKE ANSWER: write phrase B from phrase A (again, for another one). */
function vAnswer(quiet) {
  if (!vx) return;
  const B = vMakeAnswer(vData('A'));
  if (vPhrase === 'B') { vSteps = B.steps; vx.syl.forEach((q, i) => { q.deg = B.degs[i]; }); } else vAlt = B;
  vCache.clear(); vSync();
  if (!quiet) say(B.text);
}
/** Put the other phrase on the grid. B is written the first time it is asked for. */
function vShow(ph, quiet) {
  if (ph === vPhrase || !vx) return;
  const cur = { steps: vSteps, degs: vx.syl.map(q => q.deg) }, other = vAlt || vMakeAnswer(cur);
  vAlt = cur; vSteps = other.steps; vx.syl.forEach((q, i) => { if (other.degs[i] !== undefined) q.deg = other.degs[i]; });
  vPhrase = ph; vSel = vSelSyl = -1; vSync();
  if (!quiet) say(ph === 'A' ? 'A, the call, is on the grid' : 'B, the answer, is on the grid: edit it like any melody' + (other.text ? '. ' + other.text : ''));
}
/** How many steps a note lasts: until the next one, four at most. */
function vLen(k, steps = vSteps) { let n = 1; while (n < 4 && k + n < steps.length && !steps[k + n].on) n++; return n; }
/** Syllable `si` on the pitch `hz` (0: as it is), as samples ready to play. slot: how long it may last, in samples
 *  (0: as long as it likes); with FIT it is stretched or squeezed to exactly that. AIR adds the same sound an octave up. */
function vRender(si, hz, slot) {
  const s = vx && vx.syl[si];
  if (!s) return null;
  const sr = vx.sr, natural = VOX.voice === 'natural', fit = natural && VOX.fit && slot ? slot : 0;
  const key = [si, hz.toFixed(2), VOX.voice, natural ? VOX.tune : 0, fit, slot, VOX.air].join();
  let buf = vCache.get(key);
  if (buf) return buf;
  const seg = vx.mono.subarray(s.a, s.b), fr = x => Math.round(x / sr / VocalDSP.HOP), track = vx.f0.subarray(fr(s.a), fr(s.b) + 1), to = s.f && hz ? hz : 0;
  // On the grid a syllable is placed by where its body starts, not by where it was cut: the breath or consonant that
  // leads into it (`pre`) sounds just before the step, so the part the ear hears as the beat lands on the beat.
  const rate = !natural && to ? Math.max(0.25, Math.min(4, to / s.f)) : 1, pre = slot ? Math.round((s.pre || 0) / rate) : 0, want = fit ? fit + pre : 0;
  const waver = natural && VOX.tune > 0 && (want || seg.length) / sr > 0.35;
  const y = natural ? VocalDSP.psola(seg, sr, track, s.f, to, VOX.tune, want, waver) : rate !== 1 ? VocalDSP.resample(seg, rate) : seg;
  const n = slot ? Math.min(y.length, slot + pre) : y.length, out = new Float32Array(n), at = Math.min(n >> 1, Math.round(sr * 0.003)), rel = Math.min(n >> 1, Math.round(sr * 0.03)), lvl = s.gain || 1;
  const up = VOX.air && to ? (natural ? VocalDSP.psola(seg, sr, track, s.f, to * 2, VOX.tune, y.length, waver) : VocalDSP.resample(seg, Math.min(8, 2 * to / s.f))) : null;
  for (let i = 0; i < n; i++) out[i] = (y[i] + (up && i < up.length ? up[i] * 0.32 : 0)) * lvl * Math.min(1, i / at, (n - 1 - i) / rel);
  buf = { data: out, node: null, pre };
  vCache.set(key, buf);
  return buf;
}
/** On the grid: step k's syllable on its note, lasting until the next note. */
function vNote(k, steps = vSteps) { const st = steps[k]; return st && st.on && st.syl >= 0 ? vRender(st.syl, vHz(st.deg), Math.round(vLen(k, steps) * vStepSec() * vx.sr)) : null; }
/** As spoken: syllable i on its own note, at its own length. */
function vSpoken(i, deg) { const s = vx.syl[i]; if (deg === undefined) deg = s.deg; return s.on ? vRender(i, deg >= 0 ? vHz(deg) : 0, 0) : null; }
const vAudio = b => { if (!b.node) { b.node = ctx.createBuffer(1, b.data.length, vx.sr); b.node.getChannelData(0).set(b.data); } return b.node; };

/* The style chain the voice goes through before the tape effect. Built from ordinary audio nodes on whichever context
   is given, so PRINT can run the very same chain off-line. SAT: tape saturation. DOUBLE: a second copy about 26 ms
   behind and wobbling, the two spread left and right (the doubletracker half of a Deco). ECHO: a dotted-eighth repeat. */
function vChain(ac, dest, rate) {
  const inp = ac.createGain(), sum = ac.createGain(), oscs = [], all = [inp, sum];
  let head = inp;
  if (VOX.sat) {
    const pre = ac.createGain(), ws = ac.createWaveShaper(), post = ac.createGain(), c = new Float32Array(1025);
    for (let i = 0; i < 1025; i++) c[i] = Math.tanh(2.4 * (i / 512 - 1)) / Math.tanh(2.4);
    ws.curve = c; ws.oversample = '4x'; pre.gain.value = 1.8; post.gain.value = 0.7;
    head.connect(pre); pre.connect(ws); ws.connect(post); head = post; all.push(pre, ws, post);
  }
  if (VOX.dbl) {
    const d = ac.createDelay(0.1), g = ac.createGain(), pan = v => { if (!ac.createStereoPanner) return ac.createGain(); const q = ac.createStereoPanner(); q.pan.value = v; return q; }, pl = pan(-0.4), pr = pan(0.4);
    d.delayTime.value = 0.026; g.gain.value = 0.9;
    for (const [f, depth] of [[0.63, 0.003], [0.17, 0.004]]) { const o = ac.createOscillator(), og = ac.createGain(); o.frequency.value = f; og.gain.value = depth; o.connect(og); og.connect(d.delayTime); o.start(); oscs.push(o); all.push(og); }
    head.connect(pl); pl.connect(sum); head.connect(d); d.connect(g); g.connect(pr); pr.connect(sum); all.push(d, g, pl, pr);
  } else head.connect(sum);
  if (VOX.echo) {
    const d = ac.createDelay(2), fb = ac.createGain(), wet = ac.createGain(), lp = ac.createBiquadFilter();
    d.delayTime.value = Math.min(1.9, 60 / vBpm() * 0.75 / rate); fb.gain.value = 0.38; wet.gain.value = 0.3; lp.type = 'lowpass'; lp.frequency.value = 3200;
    sum.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(wet); wet.connect(dest); all.push(d, fb, wet, lp);
  }
  sum.connect(dest);
  return { inp, stop() { for (const o of oscs) { try { o.stop(); } catch (_) {} } for (const q of all) { try { q.disconnect(); } catch (_) {} } } };
}
/** Where the notes go: a level stage (PUMP moves it), then the style chain, then the tape effect. */
function vOut() {
  const key = [VOX.sat, VOX.dbl, VOX.echo, vBpm(), bufRate.toFixed(3)].join();
  if (!vBus || vBus.context !== ctx) { vBus = ctx.createGain(); vFx = null; }
  if (!vFx || vFx.key !== key) { if (vFx) { try { vBus.disconnect(); } catch (_) {} vFx.stop(); } vFx = vChain(ctx, node, bufRate); vFx.key = key; vBus.connect(vFx.inp); }
  return vBus;
}
function vPlay(b, when) {
  if (!b) return;
  const src = ctx.createBufferSource(), amp = ctx.createGain();
  src.buffer = vAudio(b); src.playbackRate.value = bufRate;
  src.connect(amp); amp.connect(vOut());
  if (vp) {                                                              // one voice: the note before is let go as this one starts
    for (const v of vp.voices) { try { v.amp.gain.setTargetAtTime(0, when, 0.004); v.src.stop(when + 0.04); } catch (_) {} }
    vp.voices = [{ src, amp }];
  }
  const t0 = when - (b.pre || 0) / vx.sr / bufRate, now = ctx.currentTime;            // its lead-in comes before the beat
  if (t0 >= now) src.start(t0); else src.start(now, Math.min(b.data.length / vx.sr, (now - t0) * bufRate));
  src.onended = () => { try { amp.disconnect(); } catch (_) {} };
}
function vTick() {
  if (!vp || !ctx || !vx) return;
  const now = ctx.currentTime, horizon = now + 0.125, step = vStepSec() / bufRate, beat = 60 / vBpm() / bufRate;
  if (vp.next < now - 0.05 && vp.t0 + vx.mono.length / vx.sr / bufRate < now - 0.05) { vp.next = vp.t0 = vp.beat = now + 0.02; vp.i = 0; }      // the page was asleep
  for (; vp.beat < horizon; vp.beat += beat) if (VOX.pump) {             // on the beat: the level drops and swells back
    const g = vOut().gain; g.cancelScheduledValues(vp.beat); g.setValueAtTime(0.22, vp.beat); g.linearRampToValueAtTime(1, vp.beat + beat * 0.7);
  }
  const mark = (t, k, ph, c) => { vp.marks.push({ t, k, ph, c }); if (vp.marks.length > 12) vp.marks.shift(); }, seq = vSeq();
  if (vFree()) {                                                         // each syllable where it was spoken; the whole thing goes round
    const dur = Math.max(0.05, vx.mono.length / vx.sr / bufRate);
    for (let guard = 0; guard < 200; guard++) {
      const when = vp.t0 + vx.syl[vp.i].a / vx.sr / bufRate;
      if (when >= horizon) break;
      const ph = seq[vp.c % seq.length];
      if (when >= now - 0.01) { vPlay(vSpoken(vp.i, vData(ph).degs[vp.i]), when); mark(when, vp.i, ph, vp.c % seq.length); }
      if (++vp.i >= vx.syl.length) { vp.i = 0; vp.t0 += dur; vp.c++; }
    }
    vp.next = horizon;
    return;
  }
  if (vp.next < now - 0.05) vp.next = now + 0.02;
  while (vp.next < horizon) {
    const k = vp.k % vSteps.length, c = Math.floor(vp.k / vSteps.length) % seq.length, ph = seq[c];
    vPlay(vNote(k, vData(ph).steps), vp.next); mark(vp.next, k, ph, c);
    vp.k++; vp.next += step;
  }
}
/** Called by the app's startBuf(). True when Vocal mode is doing the playing. */
function vocalStart() {
  vocalStop();
  if (!VOX.on || !ctx) return false;
  vAnalyse();
  if (!vx) return false;
  const at = ctx.currentTime + 0.04;
  vp = { timer: 0, next: at, t0: at, beat: at, i: 0, k: 0, c: 0, voices: [], marks: [] };
  vOut().gain.cancelScheduledValues(0); vOut().gain.setValueAtTime(1, ctx.currentTime);
  vTick(); vp.timer = setInterval(vTick, 25);
  return true;
}
/** Called by the app's stopBuf(). */
function vocalStop() {
  if (!vp) return;
  clearInterval(vp.timer);
  for (const v of vp.voices) { try { v.src.stop(); v.amp.disconnect(); } catch (_) {} }
  vp = null;
}
/** Hear one note now (a tap on the grid while the tape is stopped). */
async function vAudition(b) {
  if (playing || !vx) return;
  try { await ensureAudio(); } catch (_) { return; }
  vOut().gain.cancelScheduledValues(0); vOut().gain.setValueAtTime(1, ctx.currentTime);
  vPlay(typeof b === 'function' ? b() : b, ctx.currentTime + 0.01);
}
/** The phrase through the style chain, off-line. What rings on past the end is laid back over the start, so it loops. */
async function vThrough(mono, sr) {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC || !(VOX.sat || VOX.dbl || VOX.echo)) return [mono, mono];
  const N = mono.length, tail = Math.round(sr * (VOX.echo ? 2.5 : 0.1)), ac = new OAC(2, N + tail, sr), b = ac.createBuffer(1, N, sr), src = ac.createBufferSource();
  b.getChannelData(0).set(mono); src.buffer = b; src.connect(vChain(ac, ac.destination, 1).inp); src.start(0);
  const r = await ac.startRendering();
  return [0, 1].map(c => { const d = r.getChannelData(Math.min(c, r.numberOfChannels - 1)), o = new Float32Array(N); o.set(d.subarray(0, N)); for (let i = 0; i < tail; i++) o[i % N] += d[N + i]; return o; });
}
/** PRINT: the phrase, once through, with its style, into the sample bank. */
async function vocalPrint() {
  if (!vx) return;
  const sr = vx.sr, stepN = Math.round(vStepSec() * sr), seq = vSeq(), one = vFree() ? vx.mono.length : stepN * vSteps.length, N = one * seq.length, out = new Float32Array(N), beatN = Math.round(60 / vBpm() * sr);
  const lay = (b, at) => { if (!b) return; at -= b.pre || 0; for (let i = Math.max(0, -at); i < b.data.length && at + i < N; i++) out[at + i] += b.data[i]; };
  seq.forEach((ph, j) => { const D = vData(ph); if (vFree()) vx.syl.forEach((q, i) => lay(vSpoken(i, D.degs[i]), j * one + q.a)); else D.steps.forEach((st, k) => lay(vNote(k, D.steps), j * one + k * stepN)); });
  if (VOX.pump) for (let i = 0; i < N; i++) out[i] *= Math.min(1, 0.22 + 0.78 * ((i % beatN) / (beatN * 0.7)));
  const t = curTape(), name = 'Vocal · ' + (t ? t.title.replace(/\.[^.]+$/, '').replace(/^Vocal · /, '') : 'phrase');
  if (typeof bankStore !== 'function') { say('The sample bank is not here to print into', true); return; }
  let chans; try { chans = await vThrough(out, sr); } catch (_) { chans = [out, out]; }
  let peak = 0; for (const c of chans) for (let i = 0; i < c.length; i++) { const v = c[i] < 0 ? -c[i] : c[i]; if (v > peak) peak = v; }
  if (peak > 0.97) { const k = 0.97 / peak; chans = chans[0] === chans[1] ? [chans[0].map(v => v * k)] : chans.map(c => c.map(v => v * k)); if (chans.length === 1) chans.push(chans[0]); }      // never over full level
  const ok = await bankStore('kept', name, chans, sr, { bpm: vBpm() });
  if (ok) say(`Printed to the bank: ${name}, ${(N / sr).toFixed(1)} s` + (seq.length > 1 ? ` (${seq.join(' ')})` : '') + '. Open it from Bank in any mode');
}

// ───────────────────────── the face ─────────────────────────
const vEl = document.createElement('div');
vEl.className = 'vocal'; vEl.id = 'vocal'; vEl.hidden = true;
const vSeg = (id, label, opts) => `<div class="vgroup"><span>${label}</span><div class="seg" id="${id}" role="radiogroup" aria-label="${label}">${opts.map(([v, t]) => `<button type="button" role="radio" data-v="${v}">${t}</button>`).join('')}</div></div>`;
const V_STYLE = [['pump', 'Pump', 'Pump: the voice ducks on every beat and swells back'], ['sat', 'Sat', 'Sat: tape saturation, pushed'], ['dbl', 'Double', 'Double: a second copy just behind, wobbling, the two spread left and right'], ['air', 'Air', 'Air: the same notes an octave up, quietly, on top'], ['echo', 'Echo', 'Echo: a dotted-eighth repeat that fades away']];
vEl.innerHTML = `
  <div class="vscreen">
    <div class="vhead"><p class="vstatus" id="v-status"></p><div class="vseq" id="v-seq" hidden aria-label="Which phrase is playing"></div></div>
    <canvas id="v-wave" aria-label="The voice, cut into syllables. Tap one to leave it out or bring it back."></canvas>
    <canvas id="v-grid" aria-label="The melody: time across, notes up. Tap a square to put a step or a syllable on a note."></canvas>
  </div>
  <div class="vpanel">
    <div class="vrow vtop">
      ${vSeg('v-tab', 'Controls below', [['melody', 'Melody'], ['sound', 'Sound'], ['phrase', 'Call & answer']])}
      <button type="button" class="vkey big" id="v-roll">Roll melody</button>
      <div class="vgroup" id="v-ordg"><span id="v-count">Syllables</span><div class="vkeys"><div class="seg" id="v-order" role="radiogroup" aria-label="Syllables"><button type="button" role="radio" data-v="order">In order</button><button type="button" role="radio" data-v="mix">Shuffle</button></div><button type="button" class="vkey toggle" id="v-match" aria-pressed="false" aria-label="Match: one note for each syllable">Match</button></div></div>
      <button type="button" class="vkey big" id="v-deal" hidden>Nearest notes</button>
      <div class="vgroup"><span id="v-sel">Step</span><div class="vkeys"><button type="button" class="vkey" id="v-sylp" aria-label="Previous syllable for this step">◀ Syl</button><button type="button" class="vkey" id="v-syln" aria-label="Next syllable for this step">Syl ▶</button></div></div>
      <button type="button" class="vkey big hot" id="v-print">Print to bank</button>
    </div>
    <div class="vrow" data-tab="melody">
      <div class="vgroup"><span>Tempo</span><div class="vkeys"><button type="button" class="vkey" id="v-slower" aria-label="Slower">−</button><output class="vread" id="v-bpm">100</output><button type="button" class="vkey" id="v-faster" aria-label="Faster">+</button><button type="button" class="vkey" id="v-tap">Tap</button></div></div>
      <div class="vgroup"><span>Key</span><select id="v-root" aria-label="Key">${V_NOTES.map((n, i) => `<option value="${i}">${n}</option>`).join('')}</select></div>
      <div class="vgroup"><span>Scale</span><select id="v-scale" aria-label="Scale">${Object.keys(V_SCALES).map(n => `<option>${n}</option>`).join('')}</select></div>
      ${vSeg('v-oct', 'Octave', [[-1, '−'], [0, '0'], [1, '+']])}
      ${vSeg('v-time', 'Timing', [['grid', 'On the grid'], ['free', 'As spoken']])}
      ${vSeg('v-steps', 'Steps', [[8, '8'], [16, '16']])}
      ${vSeg('v-div', 'Rate', [[4, '1/4'], [8, '1/8'], [16, '1/16']])}
      <div class="vgroup"><span>Cuts</span><div class="vkeys"><button type="button" class="vkey" id="v-less" aria-label="Fewer cuts">−</button><button type="button" class="vkey" id="v-more" aria-label="More cuts">+</button></div></div>
    </div>
    <div class="vrow" data-tab="sound">
      ${vSeg('v-voice', 'Voice', [['tape', 'Tape'], ['natural', 'Natural']])}
      ${vSeg('v-tune', 'Tune', [[0, 'Off'], [0.5, 'Half'], [1, 'Hard']])}
      <div class="vgroup"><span>Length</span><button type="button" class="vkey toggle" id="v-fit" aria-pressed="false">Fit</button></div>
      <div class="vgroup"><span>Style</span><div class="vkeys">${V_STYLE.map(([k, t]) => `<button type="button" class="vkey toggle" id="v-${k}" aria-pressed="false">${t}</button>`).join('')}</div></div>
      <div class="vgroup grow"><span>Reverb</span><input type="range" id="v-verb" min="0" max="100" value="0" aria-label="Reverb"></div>
    </div>
    <div class="vrow" data-tab="phrase">
      ${vSeg('v-chain', 'Call & answer', [['off', 'Off'], ['ab', 'A B'], ['aaab', 'A A A B']])}
      ${vSeg('v-ph', 'Showing on the grid', [['follow', 'Follow'], ['A', 'A · the call'], ['B', 'B · the answer']])}
      <div class="vgroup"><span>Answer</span><button type="button" class="vkey big" id="v-answer">New answer</button></div>
    </div>
  </div>`;
document.querySelector('.stage').appendChild(vEl);
const vQ = s => vEl.querySelector(s), vWave = vQ('#v-wave'), vGrid = vQ('#v-grid');
const V_SEGS = [['v-oct', 'oct', 1], ['v-steps', 'steps', 1], ['v-div', 'div', 1], ['v-voice', 'voice', 0], ['v-tune', 'tune', 1], ['v-time', 'time', 0], ['v-tab', 'tab', 0], ['v-chain', 'chain', 0]];
function vSync() {
  vQ('#v-root').value = VOX.root; vQ('#v-scale').value = VOX.scale; vQ('#v-bpm').textContent = vBpm().toFixed(vBpm() % 1 ? 1 : 0);
  for (const [id, key] of V_SEGS) vEl.querySelectorAll(`#${id} button`).forEach(b => b.setAttribute('aria-checked', String(VOX[key]) === b.dataset.v));
  vQ('#v-fit').setAttribute('aria-pressed', VOX.fit);
  vEl.querySelectorAll('#v-ph button').forEach(b => { b.setAttribute('aria-checked', VOX.follow ? b.dataset.v === 'follow' : b.dataset.v === vPhrase); b.classList.toggle('sounding', b.dataset.v === vPlaying); b.disabled = VOX.chain === 'off'; });
  vEl.querySelectorAll('#v-order button').forEach(b => b.setAttribute('aria-checked', (VOX.order === 'mix' ? 'mix' : 'order') === b.dataset.v));
  { const el = vQ('#v-seq'), seq = vSeq(), want = VOX.chain === 'off' ? '' : seq.join('');           // the phrases in the order they play
    if (el.dataset.seq !== want) { el.dataset.seq = want; el.innerHTML = want ? '<span>Playing</span>' + seq.map(ph => `<b>${ph}</b>`).join('') : ''; vSeqAt = -2; }
    el.hidden = !want; }
  vQ('#v-answer').disabled = VOX.chain === 'off';
  for (const [k] of V_STYLE) vQ('#v-' + k).setAttribute('aria-pressed', !!VOX[k]);
  vEl.querySelectorAll('.vrow[data-tab]').forEach(r => { r.hidden = r.dataset.tab !== VOX.tab; });
  const nat = VOX.voice === 'natural', free = vFree();
  vEl.querySelectorAll('#v-tune button').forEach(b => { b.disabled = !nat; }); vQ('#v-fit').disabled = !nat || free;
  vEl.querySelectorAll('#v-steps button, #v-div button').forEach(b => { b.disabled = free; });
  if (typeof values !== 'undefined') vQ('#v-verb').value = Math.round((values.onSpace > 0.5 ? values.space : 0) * 100);
  const st = vSteps[vSel], sy = vx && vx.syl[vSelSyl];
  vQ('#v-sel').textContent = free ? (sy ? `Syllable ${vSelSyl + 1}` + (sy.deg >= 0 ? ' · ' + vName(vMidi(sy.deg)) : ' · no pitch') : 'Syllable') : st ? `Step ${vSel + 1}` + (st.on && st.syl >= 0 ? ` · syllable ${st.syl + 1}` : '') : 'Step';
  vQ('#v-sylp').disabled = vQ('#v-syln').disabled = free || !(st && st.on);
  vQ('#v-deal').hidden = !free; vQ('#v-ordg').hidden = free;
  vQ('#v-match').setAttribute('aria-pressed', !!VOX.match);
  { const ns = vx ? vx.syl.filter(q => q.on).length : 0, nn = vSteps.filter(q => q.on).length;
    vQ('#v-count').textContent = vx ? `${ns} syllable${ns === 1 ? '' : 's'} ${ns === nn ? '=' : '·'} ${nn} note${nn === 1 ? '' : 's'}` : 'Syllables'; }
}
function vSet(key, val, msg) {
  VOX[key] = val; vSave(); vCache.clear();
  if (key === 'steps') { vAlt = null; vPhrase = 'A'; vRoll(true); vFlow(); vDeal(); }
  if (key === 'time') { vFlow(); vDeal(false); }
  if (key === 'chain') { if (val === 'off') vShow('A', true); else if (!vAlt) vAnswer(true); if (playing && source !== 'live') startBuf(); }
  if (key === 'sens') vAnalyse();
  if (key === 'time' && playing && source !== 'live') startBuf();          // the other way of keeping time starts from the top
  vSync();
  if (msg) say(msg);
}
const V_SAY = { voice: { tape: 'Tape pitch: the tape runs faster or slower, so higher notes are shorter and thinner, as a sampler does it', natural: 'Natural pitch: the note moves and the voice keeps its character. TUNE and FIT now apply' },
  tune: { 0: 'Tune off: the speech keeps its own rise and fall, moved to the note', 0.5: 'Tune half', 1: 'Tune hard: every syllable is held flat on its note' },
  chain: { off: 'Call and answer off: just the melody plays, as before', ab: 'Call and answer on: the melody (A), then an answer to it (B), and round again', aaab: 'Call and answer on: the melody three times, then the answer' },
  time: { grid: 'On the grid: the syllables are played as steps, in tempo', free: 'As spoken: the voice keeps its own timing, and each syllable is tuned to a note. Tap the grid to move a syllable to another note' } };
for (const [id, key, num] of V_SEGS) vEl.querySelectorAll(`#${id} button`).forEach(b => b.addEventListener('click', () => vSet(key, num ? +b.dataset.v : b.dataset.v, (V_SAY[key] || {})[b.dataset.v] || '')));
vQ('#v-root').addEventListener('change', e => vSet('root', +e.target.value));
vQ('#v-scale').addEventListener('change', e => { VOX.scale = e.target.value; vSave(); vAlt = null; vPhrase = 'A'; vNearest(); vRoll(true); vFlow(); vDeal(); if (VOX.chain !== 'off') vAnswer(true); vSync(); });
vEl.querySelectorAll('#v-ph button').forEach(b => b.addEventListener('click', () => {
  const v = b.dataset.v;
  VOX.follow = v === 'follow'; vSave();
  if (VOX.follow) { say('Follow: the grid shows whichever phrase is playing'); vSync(); } else if (v === vPhrase) { say(v + ' stays on the grid while both play'); vSync(); } else vShow(v);
}));
vEl.querySelectorAll('#v-order button').forEach(b => b.addEventListener('click', () => vOrder(b.dataset.v)));
vQ('#v-match').addEventListener('click', () => {
  VOX.match = !VOX.match; vSave();
  const msg = VOX.match ? vMatch() : 'Match off: the melody keeps its own number of notes, and the words go round it';
  vDeal(false); vSync(); say(msg);
});
vQ('#v-answer').addEventListener('click', () => vAnswer());
vQ('#v-fit').addEventListener('click', () => vSet('fit', !VOX.fit, VOX.fit ? 'Each syllable keeps its own length' : 'Each syllable is stretched or squeezed to last until the next note'));
for (const [k, t, on] of V_STYLE) vQ('#v-' + k).addEventListener('click', () => vSet(k, !VOX[k], VOX[k] ? t + ' off' : on));
vQ('#v-less').addEventListener('click', () => vSet('sens', Math.max(0, +(VOX.sens - 0.25).toFixed(2))));
vQ('#v-more').addEventListener('click', () => vSet('sens', Math.min(1, +(VOX.sens + 0.25).toFixed(2))));
vQ('#v-verb').addEventListener('input', e => { const v = +e.target.value / 100; setValue('onSpace', v > 0 ? 1 : 0); setValue('space', v); });
vQ('#v-roll').addEventListener('click', () => vRoll());
vQ('#v-deal').addEventListener('click', () => { vNearest(); say('Every syllable is back on the note nearest to where it was spoken'); vSync(); });
vQ('#v-print').addEventListener('click', vocalPrint);
const vStepSyl = dir => {
  const st = vSteps[vSel]; if (!st || !st.on || !vx) return;
  const pool = vx.syl.map((s, i) => i).filter(i => vx.syl[i].on); if (!pool.length) return;
  st.syl = pool[(Math.max(0, pool.indexOf(st.syl)) + dir + pool.length) % pool.length]; st.own = true;      // set by hand: In order leaves it be
  vCache.clear(); vSync(); vAudition(() => vNote(vSel));
};
vQ('#v-sylp').addEventListener('click', () => vStepSyl(-1));
vQ('#v-syln').addEventListener('click', () => vStepSyl(1));
// tempo: − and + (held, they run), and TAP
for (const [id, dir] of [['v-slower', -1], ['v-faster', 1]]) {
  const b = vQ('#' + id); let timer = 0;
  const end = () => { clearTimeout(timer); clearInterval(timer); timer = 0; };
  b.addEventListener('pointerdown', e => { e.preventDefault(); end(); vSetBpm(Math.round(vBpm()) + dir); timer = setTimeout(() => { timer = setInterval(() => vSetBpm(Math.round(vBpm()) + dir), 70); }, 380); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, end);
}
{ let taps = [];
  vQ('#v-tap').addEventListener('pointerdown', e => {
    e.preventDefault();
    const now = performance.now(); taps = taps.filter(t => now - t < 2400); taps.push(now);
    if (taps.length >= 2) { vSetBpm(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1))); say(`Tempo tapped in: ${vBpm()} BPM`); } else say('Tap again, in time');
  });
}

// ── drawing: the voice with its syllables, and the grid ──
const V_GUT = 40;
let vSeqAt = -2, vRecPk = null, vTrim = null;
/** The stretch of tape the voice row shows, in seconds: the part in use and a little of what is trimmed off either side,
 *  to pull an end back out into. It holds still while an end is being dragged. */
function vView(t) {
  if (vTrim) return vTrim.view;
  const m = (t.le - t.ls) * 0.09;
  return [Math.max(0, t.ls - m), Math.min(t.buf.duration, t.le + m)];
}
/** While Rec runs: the voice as it comes in, drawn where the syllables will be. Before it: the input level. */
function vDrawRec(g, W, H) {
  const x0 = V_GUT, w = W - V_GUT, mid = 16 + (H - 18) / 2, half = (H - 22) / 2, HOT = '#f04e23', INK = '#f1efe8', FAINT = 'rgba(241,239,232,.1)';
  const lvl = (v, floor) => Math.max(0, Math.min(1, (20 * Math.log10(Math.max(v, 1e-4)) + floor) / floor));
  g.font = '700 9px ' + FONT; g.textAlign = 'left'; g.textBaseline = 'top';
  if (!rec || rec.armed) {                                               // not recording yet: what is coming in, as a bar
    g.fillStyle = rec ? (Math.floor(performance.now() / 450) % 2 ? HOT : 'rgba(240,78,35,.45)') : 'rgba(241,239,232,.6)';
    g.fillText(rec ? 'WAITING FOR SOUND · STARTS WHEN THE LEVEL PASSES THE MARK' : 'INPUT LEVEL · PRESS REC AND SPEAK', x0, 3);
    g.fillStyle = FAINT; g.fillRect(x0, mid - 5, w, 10);
    g.fillStyle = INK; g.fillRect(x0, mid - 5, w * lvl(peakIn, rec ? 60 : 48), 10);
    if (rec) { g.fillStyle = HOT; g.fillRect(x0 + w * lvl(REC_LEVEL, 60) - 1, mid - 11, 2, 22); }
    return;
  }
  const B = 512;                                                         // one high and one low for every 512 samples that have arrived
  if (!vRecPk || vRecPk.of !== rec) vRecPk = { of: rec, k: 0, lo: [], hi: [], peak: 0.05 };
  const P = vRecPk;
  for (; P.k < rec.L.length; P.k++) {
    const L = rec.L[P.k], R = rec.R[P.k];
    for (let a = 0; a < L.length; a += B) {
      let lo = 0, hi = 0;
      for (let i = a, e = Math.min(L.length, a + B); i < e; i++) { const v = (L[i] + R[i]) / 2; if (v < lo) lo = v; else if (v > hi) hi = v; }
      P.lo.push(lo); P.hi.push(hi); if (hi > P.peak) P.peak = hi; if (-lo > P.peak) P.peak = -lo;
    }
  }
  const sr = ctx.sampleRate, el = rec.len / sr, span = Math.max(4, el), n = P.lo.length, gain = Math.min(12, 0.9 / P.peak), end = el / span * w;
  g.fillStyle = HOT; g.fillText(`RECORDING ${el.toFixed(1)} / ${REC_MAX} S · PRESS REC TO STOP`, x0, 3);
  g.fillStyle = FAINT; g.fillRect(x0, mid, w, 1);
  g.fillStyle = INK;
  for (let px = 0; px < end; px++) {
    const a = Math.floor(px / end * n), b = Math.max(a + 1, Math.floor((px + 1) / end * n)); let lo = 0, hi = 0;
    for (let i = a; i < b && i < n; i++) { if (P.lo[i] < lo) lo = P.lo[i]; if (P.hi[i] > hi) hi = P.hi[i]; }
    const top = Math.min(1, hi * gain), bot = Math.max(-1, lo * gain);
    g.fillRect(x0 + px, mid - top * half, 1, Math.max(1, (top - bot) * half));
  }
  g.fillStyle = HOT; g.fillRect(x0 + Math.min(w - 2, end), 16, 2, H - 18);         // where the tape is now
}
function vFit(cv) {
  const r = cv.getBoundingClientRect(), d = Math.min(2, window.devicePixelRatio || 1), w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const g = cv.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, r.width, r.height);
  return [g, r.width, r.height];
}
function vDraw() {
  if (!VOX.on) return;
  requestAnimationFrame(vDraw);
  const t = curTape();
  vQ('#v-status').textContent = source === 'live' ? 'Vocal mode works on the Loop or File source: record or load a voice' : !t || !t.buf ? 'Record a voice with Rec, or load one from Bank' : statusText;
  if (source !== 'live' && t && t.buf && !rec && !vTrim && !(typeof drag !== 'undefined' && drag)) vAnalyse();      // does nothing unless the tape or its loop ends have changed
  if (vTrim && vTrim.moved) vTrimTo();                                    // held at the edge, the view keeps opening
  { let m = null; if (vp && ctx) for (const q of vp.marks) if (q.t <= ctx.currentTime) m = q;
    const was = vPlaying; vPlaying = m ? m.ph : '';
    if (VOX.follow && VOX.chain !== 'off' && vPlaying && vPlaying !== vPhrase && !rec) vShow(vPlaying, true);      // FOLLOW: the grid goes with the phrase that is playing
    vNow = m && m.ph === vPhrase ? m.k : -1;
    if (was !== vPlaying) vEl.querySelectorAll('#v-ph button').forEach(b => b.classList.toggle('sounding', b.dataset.v === vPlaying));
    const at = m && VOX.chain !== 'off' ? m.c : -1;
    if (at !== vSeqAt) { vSeqAt = at; vQ('#v-seq').querySelectorAll('b').forEach((el, i) => el.classList.toggle('on', i === at)); } }
  const INKc = '#f1efe8', HOTc = '#f04e23';
  { // the voice
    const [g, W, H] = vFit(vWave);
    g.font = '800 22px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = vPlaying && vPlaying !== vPhrase ? 'rgba(241,239,232,.35)' : '#f04e23'; if (VOX.chain !== 'off' && !rec) g.fillText(vPhrase, V_GUT / 2 - 2, H / 2 + 8);      // with call and answer on: which phrase this is
    if (rec || (source === 'loop' && !(t && t.buf))) vDrawRec(g, W, H);
    else if (vx && t && t.buf === vx.buf) {
      const w = W - V_GUT, sr = vx.sr, [va, vb] = vView(t), X = sec => V_GUT + (sec - va) / (vb - va) * w, pps = w / (vb - va);
      const st = vSteps[vNow], sounding = vFree() ? vNow : st && st.on ? st.syl : -1, mine = vFree() ? vSelSyl : vSteps[vSel] && vSteps[vSel].on ? vSteps[vSel].syl : -1;
      vx.syl.forEach((s, i) => {
        const x = X(vx.t0 + s.a / sr), sw = Math.max(2, (s.b - s.a) / sr * pps - 1);
        g.fillStyle = i === sounding ? 'rgba(240,78,35,.5)' : s.on ? (i % 2 ? 'rgba(241,239,232,.09)' : 'rgba(241,239,232,.15)') : 'rgba(241,239,232,.03)';
        g.fillRect(x, 16, sw, H - 18);
        if (i === mine) { g.strokeStyle = HOTc; g.lineWidth = 2; g.strokeRect(x + 1, 17, sw - 2, H - 20); }
        g.font = '700 9px ' + FONT; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillStyle = s.on ? INKc : 'rgba(241,239,232,.3)';
        g.fillText(String(i + 1) + (s.f && sw > 34 ? ' ' + vName(Math.round(69 + 12 * Math.log2(s.f / 440))) : ''), x + 2, 3);
      });
      const mid = 16 + (H - 18) / 2, half = (H - 22) / 2, d0 = t.buf.getChannelData(0), d1 = t.buf.numberOfChannels > 1 ? t.buf.getChannelData(1) : d0, N = d0.length, k = vx.gain * 0.7;
      g.fillStyle = INKc;
      for (let px = 0; px < w; px++) {
        const a = Math.max(0, Math.floor((va + px / pps) * sr)), b = Math.min(N, Math.floor((va + (px + 1) / pps) * sr)), stride = Math.max(1, (b - a) >> 6); let lo = 0, hi = 0;
        for (let i = a; i < b; i += stride) { const v = (d0[i] + d1[i]) * k; if (v < lo) lo = v; else if (v > hi) hi = v; }
        g.fillRect(V_GUT + px, mid - Math.min(1, hi) * half, 1, Math.max(1, (Math.min(1, hi) - Math.max(-1, lo)) * half));
      }
      vx.syl.forEach(s => { if (!s.on) { g.fillStyle = 'rgba(11,11,12,.72)'; g.fillRect(X(vx.t0 + s.a / sr), 16, Math.max(2, (s.b - s.a) / sr * pps - 1), H - 18); } });
      // what is trimmed off, greyed, and the handle at each end
      const xs = X(t.ls), xe = X(t.le);
      g.fillStyle = 'rgba(11,11,12,.78)'; if (xs > V_GUT) g.fillRect(V_GUT, 0, xs - V_GUT, H); if (xe < W) g.fillRect(xe, 0, W - xe, H);
      for (const [x, dir, end] of [[xs, 1, 'ls'], [xe, -1, 'le']]) {
        const hot = vTrim && vTrim.end === end, tx = dir > 0 ? x : x - 11;
        g.fillStyle = HOTc; g.fillRect(dir > 0 ? x : x - 3, 0, 3, H);
        g.beginPath(); if (g.roundRect) g.roundRect(tx, mid - 16, 11, 32, 3); else g.rect(tx, mid - 16, 11, 32); g.fill();
        g.fillStyle = '#140a06'; g.fillRect(tx + 3, mid - 8, 1.5, 16); g.fillRect(tx + 6.5, mid - 8, 1.5, 16);
        if (hot) { g.font = '700 9px ' + FONT; g.textBaseline = 'bottom'; g.textAlign = dir > 0 ? 'left' : 'right'; g.fillStyle = HOTc; g.fillText((end === 'ls' ? t.ls : t.le).toFixed(2) + ' S', x + dir * 15, H - 2); }
      }
    }
  }
  { // the grid
    const [g, W, H] = vFit(vGrid), R = vRows(), n = vSteps.length || VOX.steps, cw = (W - V_GUT) / n, ch = H / R, L = vScale().length, small = (x, y, txt) => { g.font = '700 9px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#140a06'; g.fillText(txt, x, y + 0.5); };
    for (let r = 0; r < R; r++) {
      const deg = R - 1 - r, y = r * ch, rootRow = deg % L === 0;
      g.fillStyle = rootRow ? 'rgba(241,239,232,.1)' : 'rgba(241,239,232,.04)'; g.fillRect(V_GUT, y + 1, W - V_GUT, ch - 2);
      g.font = '700 9px ' + FONT; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillStyle = rootRow ? INKc : 'rgba(241,239,232,.5)';
      g.fillText(vName(vMidi(deg)), V_GUT - 6, y + ch / 2);
    }
    if (vFree() && vx) {                                                 // as spoken: each syllable under itself in the voice above, on its note
      const tp = curTape(), w = W - V_GUT, sr = vx.sr, [va, vb] = tp && tp.buf === vx.buf ? vView(tp) : [vx.t0, vx.t0 + vx.mono.length / sr], pps = w / (vb - va), beatPx = 60 / vBpm() * pps;
      if (beatPx > 6) for (let x = V_GUT + (vx.t0 - va) * pps; x < W; x += beatPx) { g.fillStyle = 'rgba(241,239,232,.1)'; g.fillRect(x, 0, 1, H); }
      vx.syl.forEach((q, i) => {
        if (q.deg < 0) return;
        const x = V_GUT + (vx.t0 + q.a / sr - va) * pps, sw = Math.max(5, (q.b - q.a) / sr * pps - 1), y = (R - 1 - q.deg) * ch;
        g.fillStyle = !q.on ? 'rgba(241,239,232,.16)' : i === vNow ? INKc : HOTc; g.fillRect(x, y + 2, sw, ch - 4);
        if (i === vSelSyl) { g.strokeStyle = INKc; g.lineWidth = 2; g.strokeRect(x, y + 2, sw, ch - 4); }
        if (sw > 14 && ch > 12) small(x + sw / 2, y + ch / 2, String(i + 1));
      });
    } else for (let k = 0; k < n; k++) {
      const x = V_GUT + k * cw, st = vSteps[k];
      if ((k * 4) % VOX.div === 0) { g.fillStyle = k % VOX.div === 0 ? 'rgba(241,239,232,.3)' : 'rgba(241,239,232,.12)'; g.fillRect(x, 0, 1, H); }      // beats, and bars
      if (k === vNow) { g.fillStyle = 'rgba(241,239,232,.12)'; g.fillRect(x, 0, cw, H); }
      if (!st || !st.on) continue;
      const y = (R - 1 - st.deg) * ch, len = vLen(k);
      g.fillStyle = 'rgba(240,78,35,.35)'; g.fillRect(x + 2, y + ch * 0.3, cw * len - 4, ch * 0.4);          // how long it lasts
      g.fillStyle = k === vNow ? INKc : HOTc; g.fillRect(x + 2, y + 2, cw - 4, ch - 4);
      if (k === vSel) { g.strokeStyle = INKc; g.lineWidth = 2; g.strokeRect(x + 2, y + 2, cw - 4, ch - 4); }
      if (st.syl >= 0 && cw > 16 && ch > 12) small(x + cw / 2, y + ch / 2, String(st.syl + 1));
    }
  }
}
vGrid.addEventListener('pointerdown', e => {
  const r = vGrid.getBoundingClientRect(), fx = (e.clientX - r.left - V_GUT) / (r.width - V_GUT), deg = vRows() - 1 - Math.floor((e.clientY - r.top) / (r.height / vRows()));
  if (fx < 0 || fx > 1 || deg < 0 || deg >= vRows()) return;
  e.preventDefault();
  if (vFree()) {                                                         // as spoken: the syllable under the finger goes to that note
    if (!vx) return;
    const tp = curTape(), [va, vb] = tp && tp.buf === vx.buf ? vView(tp) : [vx.t0, vx.t0 + vx.mono.length / vx.sr], pos = (va + fx * (vb - va) - vx.t0) * vx.sr;
    let i = vx.syl.findIndex(q => pos >= q.a && pos < q.b);
    if (i < 0) { let best = 1e12; vx.syl.forEach((q, j) => { const d = Math.abs((q.a + q.b) / 2 - pos); if (d < best) { best = d; i = j; } }); }
    const q = vx.syl[i];
    vSelSyl = i;
    if (!q.f) say(`Syllable ${i + 1} is breath or a consonant: it has no pitch to move`); else { q.deg = deg; vCache.clear(); vAudition(() => vSpoken(i)); }
    vSync();
    return;
  }
  const n = vSteps.length, k = Math.min(n - 1, Math.floor(fx * n)), st = vSteps[k];
  if (st.on && st.deg === deg) st.on = false;                              // the same square again: a rest
  else { st.on = true; st.deg = deg; }
  vDeal(false);                                                          // in order: the syllables after this step move along with it
  vSel = k; vCache.clear(); vSync();
  if (st.on) vAudition(() => vNote(k));
});
vWave.addEventListener('pointerdown', e => {
  const t = curTape();
  if (!vx || !t || t.buf !== vx.buf || rec) return;
  const r = vWave.getBoundingClientRect(), w = r.width - V_GUT, x = e.clientX - r.left, [va, vb] = vView(t), X = sec => V_GUT + (sec - va) / (vb - va) * w;
  const ds = Math.abs(x - X(t.ls)), de = Math.abs(x - X(t.le));
  if (Math.min(ds, de) <= 20) {                                           // on a handle: trim that end
    e.preventDefault();
    vTrim = { end: ds <= de ? 'ls' : 'le', view: [va, vb], x, w, moved: false };
    try { vWave.setPointerCapture(e.pointerId); } catch (_) {}
    return;
  }
  const pos = (va + (x - V_GUT) / w * (vb - va) - vx.t0) * vx.sr, i = vx.syl.findIndex(s => pos >= s.a && pos < s.b);
  if (i < 0) return;
  e.preventDefault();
  vx.syl[i].on = !vx.syl[i].on;
  vFlow(); vDeal(false); vSync();
  say(vx.syl[i].on ? `Syllable ${i + 1} is back in` : `Syllable ${i + 1} left out: its steps take the others`);
});
/** Put the end being dragged under the finger. Near the edge of the row the view opens out, to reach tape that is out of sight. */
function vTrimTo() {
  const t = curTape(), d = vTrim;
  if (!d || !t || !t.buf) return;
  const dur = t.buf.duration, v = d.view, grow = (v[1] - v[0]) * 0.012;
  if (d.moved && d.end === 'ls' && d.x < V_GUT + 12) v[0] = Math.max(0, v[0] - grow);
  if (d.moved && d.end === 'le' && d.x > V_GUT + d.w - 12) v[1] = Math.min(dur, v[1] + grow);
  const sec = v[0] + (d.x - V_GUT) / d.w * (v[1] - v[0]);
  if (d.end === 'ls') t.ls = Math.max(0, Math.min(t.le - 0.2, sec)); else t.le = Math.min(dur, Math.max(t.ls + 0.2, sec));
}
vWave.addEventListener('pointermove', e => {
  if (!vTrim) return;
  const x = e.clientX - vWave.getBoundingClientRect().left;
  if (!vTrim.moved && Math.abs(x - vTrim.x) < 4) return;
  vTrim.moved = true; vTrim.x = x; vTrimTo();
});
for (const ev of ['pointerup', 'pointercancel']) vWave.addEventListener(ev, () => {
  if (!vTrim) return;
  const d = vTrim, t = curTape(); vTrim = null;
  if (!d.moved || !t) return;
  if (playing && source !== 'live') startBuf(); else vAnalyse();          // the trimmed voice is read again; the melody stays
  say(`Voice trimmed to ${t.ls.toFixed(2)} – ${t.le.toFixed(2)} s of ${t.buf.duration.toFixed(2)}: ${vx ? vx.syl.length : 0} syllables`);
});

// ── in and out: the skin key goes Unit, Cassette, Reel, Vocal ──
function setVocal(on) {
  if (on === VOX.on) return;
  VOX.on = on; vSave();
  vEl.hidden = !on; document.body.classList.toggle('vocal-on', on);
  const key = document.querySelector('#skin');
  if (on) {
    if (key) key.textContent = 'Vocal';
    vAnalyse(); vSync(); requestAnimationFrame(vDraw);
    say('Vocal mode: the voice on the tape, played as a melody. Tap squares to write it, or Roll melody');
  } else if (key && typeof setSkin === 'function') setSkin(skin, true);    // puts the key's own name back
  if (playing && source !== 'live') startBuf();
}
{ const key = document.querySelector('#skin');
  if (key) key.addEventListener('click', e => {
    if (VOX.on) { setVocal(false); return; }                                // leaving: the click carries on to the next face
    if (typeof SKINS !== 'undefined' && skin === SKINS[SKINS.length - 1]) { e.stopImmediatePropagation(); setVocal(true); }
  }, true);
}
if (VOX.on || /[?&]vocal\b/.test(location.search)) { VOX.on = false; setVocal(true); }
if (window.tapeloss) Object.assign(window.tapeloss, { vocal: VOX, setVocal, vocalPrint });
