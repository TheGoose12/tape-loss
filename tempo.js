'use strict';
/* Tape Loss MK IV: tempo. A TEST, kept on its own so it can be pulled out.

   What it adds, to the Loop and File sources:
     · a tempo, shown and set in the loop's strip on the display (tap TEMPO there to open the row; the first
       time, it is guessed from the loop's length)
     · 1-SHOT   the sample plays once each time it is triggered: Space, the TRIG key, or any MIDI note.
                REPEAT starts it from the top every time; SHUFFLE plays the next slice of the shuffle pattern
                on each press instead, so the presses step through the slices (the same pattern, slice size,
                ROLL, off slices and joined sections as SLICE has). ENV gives each of those presses an
                envelope: SOFT (a quick fade in, a fade out), SWELL (in and out), FADE (hard start, dies away)
     · BARS     the sample starts again every so many bars (pick how many, or AUTO for the nearest fit)
     · SLICE    the loop is cut on the grid and the pieces are played in tempo but out of order. SHUFFLE rolls
                one short pattern and repeats it, so it is a riff and not noise, and keeps each piece on the
                part of the beat it came from; ROLL makes a new one. VARY turns some pieces backwards,
                stutters them, or throws them an octave. In SHUFFLE a tap on a slice in the strip switches
                it off (its steps go to slices that are still on, and ROLL deals round it) or back on,
                and a drag across slices joins them into one section that plays in one piece, as long as
                it is, still on the grid; a tap on a section splits it again
     · a grid drawn behind the waveform, with its own on/off key. While it is on, a loop end that is dragged
       snaps to a whole number of bars (and beats) from the other end, and the loop's length is shown in bars
     · PRINT    what the mode is playing becomes the Loop's recording (see the end of this note)

   The tempo belongs to the tape: the grid sits on the waveform and stays there. Slow the tape with Speed
   and the beat slows with it, as it would on a deck.

   How it plays: with a mode on, this file takes over from the app's own looping player and starts short
   one-off players itself, on the audio clock, a little ahead of time (so the timing does not depend on the
   screen). Each one has a 1.5 ms fade at its edges so cuts do not click.

   TO PULL IT OUT: delete this file and its <script> line in index.html. Every hook left in app.js and
   skins.js is marked "tempo.js" and checks that the function exists first, so they simply do nothing.
   PRINT writes what a mode is playing into the Loop as a new recording, cut exactly to the grid, so a pattern
   can be kept, saved with Save WAV, or cut up again. UNPRINT puts back what was there. */

const TEMPO = { bpm: 120, guess: true, mode: 'loop', shot: 'whole', env: 'off', bars: 0, div: 8, order: 'shuffle', vary: 'none', grid: true, open: false, v: 2 };     // guess: the tempo has not been set by hand yet
try { const was = JSON.parse(localStorage.getItem('tapeloss.tempo') || '{}'); if (was.v !== 2) { delete was.order; was.v = 2; } Object.assign(TEMPO, was); } catch (_) {}     // settings from before SHUFFLE start on it
const tSave = () => { try { localStorage.setItem('tapeloss.tempo', JSON.stringify(TEMPO)); } catch (_) {} };
const T_MODES = [['loop', 'LOOP'], ['shot', '1-SHOT'], ['bars', 'BARS'], ['slice', 'SLICE']];
const T_BARS = [0, 0.5, 1, 2, 4, 8];                                     // 0 = AUTO
const T_DIVS = [[16, '1/16'], [8, '1/8'], [4, '1/4'], [2, '1/2'], [1, '1 BAR'], [0.5, '2 BARS']];      // slices to the bar
const T_ORDERS = [['shuffle', 'SHUFFLE'], ['rnd', 'RANDOM'], ['updown', 'UP-DOWN'], ['down', 'DOWN'], ['skip', 'SKIP']];
const T_VARY = [['none', 'PLAIN'], ['rev', 'REVERSE'], ['stut', 'STUTTER'], ['oct', 'OCTAVE'], ['all', 'ALL']];
const tName = (list, id) => (list.find(o => o[0] === id) || list[0])[1];
if (!T_DIVS.some(o => o[0] === TEMPO.div)) TEMPO.div = 8;
const T_ROW = 30;                                                        // height of the row of keys, px
if (!T_MODES.some(m => m[0] === TEMPO.mode)) TEMPO.mode = 'loop';

const tOn = () => TEMPO.mode !== 'loop';
const tBeat = () => 60 / TEMPO.bpm;                                      // seconds of tape in a beat
const tBar = () => 4 * tBeat();
const tStep = () => tBeat() * 4 / TEMPO.div;                             // seconds of tape in one slice
/** How many bars until the sample starts again: the setting, or with AUTO the nearest fit to the loop. */
function tBarsNow(t) {
  if (TEMPO.bars) return TEMPO.bars;
  const b = (t.le - t.ls) / tBar();
  return b < 0.375 ? 0.25 : b < 0.75 ? 0.5 : Math.max(1, Math.round(b));
}
/** A first guess at the tempo: the one between 70 and 140 BPM that makes the loop a round number of bars (1, 2, 4, 8…). */
function tGuess(t) {
  const len = t.le - t.ls;
  for (let n = 1; n <= 64; n *= 2) { const bpm = 240 * n / len; if (bpm >= 70 && bpm < 140) return Math.round(bpm * 10) / 10; }
  return 120;
}
const tBarsText = n => (n === 0.25 ? '1/4 BAR' : n === 0.5 ? '1/2 BAR' : n === 1 ? '1 BAR' : n + ' BARS');

// ── the player ───────────────────────────────────────────────────────────────────────────────────
let tp = null;        // while a mode is playing: { timer, next, k, idx, dir, voices, marks, pat }

/** One stretch of the tape, played once: `dur` seconds of it from `off`, starting at `when` on the audio clock. */
function tVoice(buf, when, off, dur, rate, mark, out) {
  const src = ctx.createBufferSource(), amp = ctx.createGain(), real = dur / rate, edge = Math.min(0.0015, real * 0.25);
  src.buffer = buf; src.playbackRate.value = rate;
  src.connect(amp); amp.connect(out || node);                            // out: a press's envelope, when it has one
  amp.gain.setValueAtTime(0, when); amp.gain.linearRampToValueAtTime(1, when + edge);
  amp.gain.setValueAtTime(1, when + real - edge); amp.gain.linearRampToValueAtTime(0, when + real);
  src.start(when, off, dur + 0.01); src.stop(when + real + 0.02);
  const v = { src, amp, t0: when, end: when + real };
  src.onended = () => { try { amp.disconnect(); } catch (_) {} const i = tp ? tp.voices.indexOf(v) : -1; if (i >= 0) tp.voices.splice(i, 1); };
  tp.voices.push(v);
  tp.marks.push(Object.assign({ t0: when, off: mark.off, dur, rate }, mark));
  if (tp.marks.length > 16) tp.marks.shift();
}
/** Silence whatever is sounding at `when`, quickly but without a click, and drop anything due to start after it. */
function tChoke(when) {
  for (const v of tp.voices) {
    if (v.choked || v.end <= when) continue;
    v.choked = true;
    try {
      if (v.t0 >= when) { v.amp.gain.cancelScheduledValues(0); v.amp.gain.setValueAtTime(0, ctx.currentTime); v.src.stop(); }
      else { v.amp.gain.cancelScheduledValues(when); v.amp.gain.setTargetAtTime(0, when, 0.003); v.src.stop(when + 0.03); }
    } catch (_) {}
  }
  tp.marks = tp.marks.filter(m => m.t0 < when);
}
/** The whole sample, from the loop's start, with the loop's fades if it has any. */
function tFire(when) {
  const t = curTape();
  if (!tp || !t || !t.buf) return;
  tChoke(when);
  const fb = fadedBuf(t);
  tVoice(fb || t.buf, when, fb ? 0 : t.ls, Math.max(0.02, t.le - t.ls), bufRate, { off: t.ls });
}
/* The envelope on a 1-SHOT SHUFFLE press: how the level moves over the D seconds the slice lasts. */
const T_ENV = [['off', 'ENV'], ['soft', 'SOFT'], ['swell', 'SWELL'], ['fade', 'FADE']];
/** [attack, release] in seconds for a press D seconds long, or null with the envelope off. */
function tEnvShape(D) {
  const e = TEMPO.env;
  return e === 'soft' ? [Math.min(0.03, D * 0.1), D * 0.4] : e === 'swell' ? [D * 0.45, D * 0.45] : e === 'fade' ? [0, D * 0.9] : null;
}
/** The level x seconds into it: a straight rise, and a fall that drops away faster at first, as a note dying does. */
const tEnvGain = (x, D, A, R) => Math.min(A > 0 ? clamp01(x / A) : 1, R > 0 ? Math.pow(clamp01((D - x) / R), 1.6) : 1);
const tEnvText = () => ({ soft: 'Envelope soft: each slice comes in quickly and fades out over its last part', swell: 'Envelope swell: each slice fades in and fades out', fade: 'Envelope fade: each slice starts hard and dies away' }[TEMPO.env] || 'Envelope off: each slice starts and stops hard');
/** A gain stage that plays that envelope once from `when`; the press's pieces go through it. */
function tEnvNode(when, D, sh) {
  const g = ctx.createGain(), N = 256, curve = new Float32Array(N);
  for (let i = 0; i < N; i++) curve[i] = tEnvGain(i / (N - 1) * D, D, sh[0], sh[1]);
  try { g.gain.setValueCurveAtTime(curve, Math.max(when, ctx.currentTime), D); } catch (_) {}
  g.connect(node);
  setTimeout(() => { try { g.disconnect(); } catch (_) {} }, (Math.max(0, when - ctx.currentTime) + D + 0.4) * 1000);
  return g;
}
/** 1-SHOT on SHUFFLE: the trigger cuts what is sounding and plays the next slice of the pattern, once. */
function tFireSlice(when) {
  const t = curTape();
  if (!tp || !t || !t.buf) return;
  tChoke(when);
  tSlice(when);
}
/** The tape backwards, for slices played in reverse. Made once per recording and kept on it. */
function tReversed(t) {
  if (t.rev && t.rev.src === t.buf) return t.rev.buf;
  const out = ctx.createBuffer(t.buf.numberOfChannels, t.buf.length, t.buf.sampleRate);
  for (let c = 0; c < t.buf.numberOfChannels; c++) out.getChannelData(c).set(Float32Array.from(t.buf.getChannelData(c)).reverse());
  t.rev = { src: t.buf, buf: out };
  return out;
}
/** What to do to a slice, if anything: about one in three gets a variation when VARY is on. */
function tRollFx() {
  if (TEMPO.vary === 'none' || Math.random() > 0.34) return '';
  const kinds = TEMPO.vary === 'all' ? ['rev', 'stut', 'up', 'down'] : TEMPO.vary === 'oct' ? ['up', 'up', 'down'] : [TEMPO.vary];
  return kinds[Math.floor(Math.random() * kinds.length)];
}
/* Joined slices. tLink holds each i whose slice is joined to the one after it; a run of those is a section, and the
   pattern treats it as one long slice: dealt as a unit, played in one piece over as many steps as it has slices, and
   never entered in the middle. A step of a pattern is { i, fx, tie, span }: `span` is how many steps the piece that
   starts here runs for, and `tie` marks the steps after the first, where it is already sounding. */
const tLink = new Set(), tOff = new Set();
const tHead = i => { while (i > 0 && tLink.has(i - 1)) i--; return i; };                 // the first slice of the section slice i is in
const tLen = a => { let n = 1; while (tLink.has(a + n - 1)) n++; return n; };            // how many slices the section starting at a has
const tUnit = q => q && q.i >= 0 ? tHead(q.i) : -1;
const tPerBeat = step => Math.max(1, Math.round(tBeat() / step));
const tBlank = (S, j) => Object.assign(S[j], { i: -1, tie: false, span: 1 });
/** Empty what is at step j: all of it, if it is a section that runs over several steps. */
function tClear(S, j) {
  let s = j; while (s > 0 && S[s].tie) s--;
  const e = Math.min(S.length, s + (S[s].span || 1));
  for (let x = s; x < e; x++) tBlank(S, x);
}
/** Write the slice or section that starts at a into steps k … k + L - 1. What it lands on is emptied first. */
function tWrite(S, k, a, L) {
  const e = Math.min(S.length, k + L);
  for (let j = k; j < e; j++) tClear(S, j);
  for (let j = k; j < e; j++) Object.assign(S[j], { i: a + j - k, tie: j > k, span: j === k ? e - k : 1 });
}
/** A slice (or the first slice of a section) for step k of a pattern: one that is switched on, from the same part of
 *  the beat so a downbeat is still a downbeat, not the same as the step before or after, and short enough for the
 *  `room` there is. When only a few are on (no more than there are steps), the one heard least so far is taken, so
 *  they share the pattern. -1 (a rest) only when every slice is off. */
function tPick(steps, k, M, perBeat, total, room) {
  const on = j => !tOff.has(j) && tHead(j) === j, last = k > 0 ? tUnit(steps[k - 1]) : -1, next = tUnit(steps[k + 1]);
  if (k === 0 && on(0)) return 0;                                                                      // it opens on the loop's own first slice
  const every = [...Array(M).keys()].filter(on), fit = every.filter(j => tLen(j) <= room), all = fit.length ? fit : every;
  const beat = all.filter(j => j % perBeat === k % perBeat), apart = j => j !== last && j !== next;
  let pool = beat.filter(apart);
  if (!pool.length) pool = all.filter(apart);                                                          // none left there: any that is on
  if (!pool.length) pool = all.filter(j => j !== last);
  if (!pool.length) pool = all;
  if (pool.length > 1 && every.length <= total) { const c = j => steps.filter(q => q.i === j && !q.tie).length, m = Math.min(...pool.map(c)); pool = pool.filter(j => c(j) === m); }
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : -1;
}
/** Give every empty step of a pattern something to play. */
function tFill(pat) {
  const S = pat.steps, perBeat = tPerBeat(pat.step);
  for (let k = 0; k < S.length; k++) {
    if (S[k].i >= 0) continue;
    let room = 1; while (k + room < S.length && S[k + room].i < 0) room++;
    const i = tPick(S, k, pat.M, perBeat, S.length, room);
    if (i >= 0) tWrite(S, k, i, Math.min(tLen(i), room));
  }
}
/** Put the slice or section that starts at a into a pattern: on its own part of the beat where that can be, over empty
 *  steps first and then over whatever is heard most, leaving other sections whole if it can. Returns the step it went
 *  to. With `more` it only takes a step from a slice heard more than it is (that is how a few slices come to share a
 *  pattern), and returns -1 when there is none. */
function tPlace(pat, a, more) {
  const S = pat.steps, n = S.length, L = Math.min(tLen(a), n), perBeat = tPerBeat(pat.step);
  const count = j => S.filter(q => q.i === j && !q.tie).length, mine = count(a);
  let k = -1, top = -1e9;
  if (a === 0 && !more) k = 0;                                                 // the loop's first slice goes back to the front
  else for (let c = 0; c + L <= n; c++) {
    if (c === 0 && S[0].i === 0 && n > L) continue;                            // the opening step stays the loop's own first slice
    let sc = (c % perBeat === a % perBeat ? 40 : 0) + Math.random(), ok = true;
    for (let j = c; j < c + L && ok; j++) {
      const q = S[j];
      if (q.i < 0) sc += 1000;
      else if (tHead(q.i) === a) ok = false;                                   // not over itself
      else if (q.tie || q.span > 1) { sc -= 5000; if (more) ok = false; }      // it would break up another section: only if there is nowhere else
      else { sc += count(q.i) * 10; if (more && count(q.i) <= mine + 1) ok = false; }
    }
    if (tUnit(S[c - 1]) === a || tUnit(S[c + L]) === a) sc -= 8;               // not right next to itself, where it can be
    if (ok && sc > top) { top = sc; k = c; }
  }
  if (k < 0) { if (more) return -1; k = Math.max(0, n - L); }
  tWrite(S, k, a, L);
  return k;
}
/** SHUFFLE's pattern: two bars' worth of steps (at least four), each a slice picked at random from the ones that
 *  sit on the same part of the beat. Slices that are switched off are never dealt; joined sections always are. */
function tRoll(M, step) {
  const n = Math.max(1, Math.min(M, Math.max(4, Math.round(2 * tBar() / step)))), pat = { M, step, vary: TEMPO.vary, steps: [] };
  for (let k = 0; k < n; k++) pat.steps.push({ i: -1, fx: k === 0 ? '' : tRollFx(), tie: false, span: 1 });
  tFill(pat);
  for (let a = 0; a < M; a++) if (tLink.has(a) && tHead(a) === a && !pat.steps.some(q => q.i === a && !q.tie)) tPlace(pat, a);
  tFill(pat);
  return pat;
}
/** The pattern in use for this loop and slice size, dealt if there is none. It, the slices switched off and the ones
 *  joined are kept through Stop and Play; another loop or slice size starts afresh, because the slices are then different ones. */
let tPat = null, tPatKey = '', tFlash = null, tSwept = null;
function tPatNow(t) {
  const step = tStep(), M = Math.max(1, Math.floor(Math.max(0.02, t.le - t.ls) / step + 0.02)), key = [t.buf.length, t.ls.toFixed(4), step.toFixed(6), M].join();
  if (tPatKey !== key) { tPatKey = key; tOff.clear(); tLink.clear(); tPat = null; }
  if (!tPat) tPat = tRoll(M, step);
  if (tPat.vary !== TEMPO.vary) { tPat.vary = TEMPO.vary; tPat.steps.forEach((q, k) => { q.fx = k ? tRollFx() : ''; }); }      // VARY changed: same slices, new variations
  return tPat;
}
/** The slice under x on the strip (kept within the loop). */
function tSliceAt(t, pat, x) { return clamp(Math.floor((stripT(srcGeom, x) - t.ls) / pat.step + 1e-6), 0, pat.M - 1); }
/** A tap on the strip at x, in SHUFFLE. On a joined section: it is split into its slices again. On a slice: it goes off
 *  if the pattern is using it, and into the pattern if it is not. Off never leaves a hole: the steps it had are given
 *  to slices that are still on, so the pattern keeps going. */
function tempoTapStrip(x) {
  const t = curTape();
  if (!tempoOwnsTaps() || !t || !t.buf || !srcGeom) return false;
  const pat = tPatNow(t), S = pat.steps, tm = stripT(srcGeom, x), i = Math.floor((tm - t.ls) / pat.step + 1e-6);
  if (tm < t.ls || i < 0 || i >= pat.M) return false;
  const a = tHead(i), L = tLen(a);
  tFlash = { i: a, n: L, at: performance.now() };
  if (L > 1) {                                                              // split: the slices stay where they are in the pattern, each its own again
    for (let j = a; j < a + L - 1; j++) tLink.delete(j);
    for (const q of S) if (q.i >= a && q.i < a + L) { q.tie = false; q.span = 1; }
    say(`Slices ${a + 1}–${a + L} split: each is its own again`);
  } else if (S.some(q => q.i === i)) {
    tOff.add(i);
    S.forEach((q, k) => { if (q.i === i) tBlank(S, k); });
    tFill(pat);
    say(tOff.size >= pat.M ? 'Every slice is off: silence. Tap one to bring it back' : `Slice ${i + 1} off: the others play in its place. Tap it again to bring it back`);
  } else {
    tOff.delete(i);
    const share = Math.max(1, Math.round(S.length / Math.max(1, pat.M - tOff.size))), first = tPlace(pat, i);     // a fair share of the steps: one in a busy pattern, half when only two slices are on
    let placed = 1;
    while (placed < share && tPlace(pat, i, true) >= 0) placed++;
    tFill(pat);
    say(placed > 1 ? `Slice ${i + 1} on, in ${placed} of ${S.length} steps` : `Slice ${i + 1} on, at step ${first + 1} of ${S.length}`);
  }
  return true;
}
/** A drag across the strip from xa to xb, in SHUFFLE, while it is going on: the slices under it light up. */
function tempoSweep(xa, xb) {
  const t = curTape();
  if (!tempoOwnsTaps() || !t || !t.buf || !srcGeom) { tSwept = null; return; }
  const pat = tPatNow(t), i0 = tSliceAt(t, pat, xa), i1 = tSliceAt(t, pat, xb);
  tSwept = { a: Math.min(i0, i1), b: Math.max(i0, i1) };
}
/** The drag let go: the slices under it are joined into one section (any section it touched is taken in whole), which
 *  goes into the pattern as a unit, as many steps long as it has slices. No longer than the pattern itself. */
function tempoJoin(xa, xb) {
  const t = curTape(), sel = tSwept;
  tSwept = null;
  if (!tempoOwnsTaps() || !t || !t.buf || !srcGeom) return false;
  const pat = tPatNow(t), S = pat.steps, i0 = sel ? sel.a : tSliceAt(t, pat, Math.min(xa, xb)), i1 = sel ? sel.b : tSliceAt(t, pat, Math.max(xa, xb));
  if (i0 === i1 && tLen(tHead(i0)) === 1) return tempoTapStrip(xa);          // it never left the one slice: a tap
  const a = tHead(i0);
  let b = tHead(i1) + tLen(tHead(i1)) - 1;
  const cut = b - a + 1 > S.length;
  if (cut) b = a + S.length - 1;
  for (let j = a; j < b; j++) tLink.add(j);
  tLink.delete(b);                                                           // (if it was cut short, what is left over is its own section)
  for (let j = a; j <= b; j++) tOff.delete(j);
  S.forEach((q, k) => { if (S[k].i >= a && S[k].i <= b) tClear(S, k); });   // wherever its slices were playing on their own
  const k = tPlace(pat, a);
  tFill(pat);
  tFlash = { i: a, n: b - a + 1, at: performance.now() };
  say(`Slices ${a + 1}–${b + 1} joined: one piece, ${b - a + 1} steps long, from step ${k + 1}${cut ? ' (as long as the pattern allows)' : ''}. Tap it to split`);
  return true;
}
/** Are taps on the strip this file's? (Then a double tap there must not reset the loop.) */
const tempoOwnsTaps = () => tPatterned() && source !== 'live';
/** 1-SHOT on SHUFFLE: each trigger plays the next slice of the pattern. */
const tShotSlices = () => TEMPO.mode === 'shot' && TEMPO.shot === 'slices';
/** The loop is being played in slices. */
const tSlicing = () => TEMPO.mode === 'slice' || tShotSlices();
/** …and those slices come from the shuffle pattern (so they can be rolled, switched off and joined). */
const tPatterned = () => (TEMPO.mode === 'slice' && TEMPO.order === 'shuffle') || tShotSlices();
/** Which slice comes next, for the orders that are not SHUFFLE. `st` carries { idx, dir, k } from step to step. */
function tNextIndex(st, M) {
  let i = st.idx;
  if (M === 1) i = 0;
  else if (TEMPO.order === 'rnd') { do { i = Math.floor(Math.random() * M); } while (i === st.idx); }
  else if (TEMPO.order === 'down') i = i <= 0 || i >= M ? M - 1 : i - 1;
  else if (TEMPO.order === 'updown') {
    if (i < 0 || i >= M) { i = 0; st.dir = 1; }
    else { if (i + st.dir >= M || i + st.dir < 0) st.dir = -st.dir; i += st.dir; }
  } else { const q = st.k % M, half = Math.ceil(M / 2); i = q < half ? q * 2 : (q - half) * 2 + 1; }      // skip: every other one, then the ones between
  st.idx = i; st.k++;
  return i;
}
/** Slice i with variation fx, as the stretches of tape that make it up: when each starts within the step (`at`, in
 *  seconds of tape), where it reads from, how much, how fast, and whether backwards. The player and PRINT both use this. */
function tPieces(t, i, fx, step, len, span = 1) {
  const off = t.ls + i * step, dur = Math.min(step * span, len - i * step);        // span: a joined section, that many slices long
  if (fx === 'rev') return [{ at: 0, off, dur, rate: 1, back: true }];                                   // backwards
  if (fx === 'stut') return [{ at: 0, off, dur: dur / 2, rate: 1 }, { at: dur / 2, off, dur: dur / 2, rate: 1 }];      // its first half, twice
  if (fx === 'up') return [{ at: 0, off, dur, rate: 2 }, { at: dur / 2, off, dur, rate: 2 }];           // an octave up, twice to fill the step
  if (fx === 'down') return [{ at: 0, off, dur: dur / 2, rate: 0.5 }];                                   // an octave down: half of it, at half speed
  return [{ at: 0, off, dur, rate: 1 }];
}
/** One slice of the loop, chosen by the order in use, played plain or with its variation. */
function tSlice(when) {
  const t = curTape(), step = tStep(), len = Math.max(0.02, t.le - t.ls), M = Math.max(1, Math.floor(len / step + 0.02));
  let i, fx, span = 1;
  if (tPatterned()) {
    const pat = tPatNow(t), n = pat.steps.length;
    let q = pat.steps[tp.k++ % n];
    if (tShotSlices()) for (let c = 0; c < n && (q.i < 0 || q.tie); c++) q = pat.steps[tp.k++ % n];      // every press is a sound: steps that are not one are passed over
    i = q.i; fx = q.fx; span = q.span || 1;
    if (i < 0 || q.tie) return;                                          // a rest (every slice is off), or a joined section that is already sounding
  } else { i = tNextIndex(tp, M); fx = tRollFx(); }
  const r = bufRate, sdur = Math.min(step * span, len - i * step), sh = tShotSlices() ? tEnvShape(sdur / r) : null, out = sh ? tEnvNode(when, sdur / r, sh) : null;
  for (const p of tPieces(t, i, fx, step, len, span)) {
    if (p.back) tVoice(tReversed(t), when + p.at / r, t.buf.duration - p.off - p.dur, p.dur, r * p.rate, { off: p.off + p.dur, slice: i, sdur, back: true }, out);
    else tVoice(t.buf, when + p.at / r, p.off, p.dur, r * p.rate, { off: p.off, slice: i, sdur }, out);
  }
}
/** Runs forty times a second and books everything due in the next eighth of a second. */
function tTick() {
  if (!tp || !ctx) return;
  const t = curTape();
  if (!t || !t.buf) return;
  const now = ctx.currentTime;
  if (tp.next < now - 0.05) tp.next = now + 0.02;                        // the page was asleep: pick up from here
  while (tp.next < now + 0.125) {
    if (TEMPO.mode === 'bars') { tFire(tp.next); tp.next += tBarsNow(t) * tBar() / bufRate; }
    else if (TEMPO.mode === 'slice') { tSlice(tp.next); tp.next += tStep() / bufRate; }
    else break;
  }
}

/** Called by the app's startBuf(). True when a tempo mode is on and this file is doing the playing. */
function tempoStart() {
  tempoStop();
  const t = curTape();
  if (!tOn() || !ctx || !t || !t.buf) return false;
  tp = { timer: 0, next: ctx.currentTime + 0.03, k: 0, idx: -1, dir: 1, voices: [], marks: [] };
  tempoMidi();                                                          // asks once, from the tap that started the sound
  if (TEMPO.mode === 'shot') (tShotSlices() ? tFireSlice : tFire)(tp.next);
  else { tTick(); tp.timer = setInterval(tTick, 25); }
  return true;
}
/** Called by the app's stopBuf(). */
function tempoStop() {
  if (!tp) return;
  clearInterval(tp.timer);
  for (const v of tp.voices) { try { v.src.onended = null; v.src.stop(); v.amp.disconnect(); } catch (_) {} }
  tp = null;
}
/** The trigger: Space, TRIG, a MIDI note. In 1-SHOT it plays the sample; in BARS and SLICE it starts the pattern again from now. */
function tempoTrig() {
  if (!tOn()) return;
  if (!playing) { play(); return; }                                      // starting to play fires it
  if (!tp) return;
  const when = ctx.currentTime + 0.005;
  if (TEMPO.mode === 'shot') (tShotSlices() ? tFireSlice : tFire)(when);
  else { tChoke(when); tp.next = when; tp.k = 0; tp.idx = -1; tp.dir = 1; tTick(); }
}
/** ROLL: a new shuffle pattern (and new variations), from the next step. */
function tempoRoll() {
  const t = curTape();
  if (!tSlicing() || !t || !t.buf) return;
  const was = tPatNow(t);
  tPat = tRoll(was.M, was.step); tRolledAt = performance.now();        // dealt now, so the strip can show it at once
  say('New pattern: ' + tPat.steps.map(q => (q.i < 0 ? '·' : q.i + 1)).join(' '));
}
// ── PRINT: what the mode is playing, written into the Loop ────────────────────────────────────────
// Worked out from the tape, not recorded as it plays, so it is done at once and is exactly a whole number of
// steps long: it loops without a seam and the grid still fits it. Printed at normal speed, before the effect.
let tPrinted = null;                  // { buf, prev: the Loop as it was, from: the source it came from, mode }
async function tempoPrint() {
  const t = curTape();
  if (!tOn() || !t || !t.buf || rec) return;
  const sr = t.buf.sampleRate, len = Math.max(0.02, t.le - t.ls), ev = [];
  let total, what;
  if (tSlicing()) {
    const step = tStep(), M = Math.max(1, Math.floor(len / step + 0.02));
    let seq;
    if (tPatterned()) seq = tPatNow(t).steps;
    else {                                                               // the other orders: one full pass (RANDOM: two bars of it)
      const st = { idx: -1, dir: 1, k: 0 }, n = TEMPO.order === 'rnd' ? Math.max(4, Math.round(2 * tBar() / step)) : TEMPO.order === 'updown' ? Math.max(1, 2 * M - 2) : M;
      seq = []; for (let k = 0; k < n; k++) seq.push({ i: tNextIndex(st, M), fx: tRollFx() });
    }
    seq.forEach((q, k) => {
      if (q.i < 0 || q.tie) return;
      const D = Math.min(step * (q.span || 1), len - q.i * step), sh = tShotSlices() ? tEnvShape(D) : null;
      for (const p of tPieces(t, q.i, q.fx, step, len, q.span || 1)) ev.push(Object.assign(p, { at: k * step + p.at }, sh ? { e0: k * step, eD: D, env: sh } : null));
    });
    total = seq.length * step; what = tName(T_ORDERS, tShotSlices() ? 'shuffle' : TEMPO.order).toLowerCase() + ' ' + tName(T_DIVS, TEMPO.div).toLowerCase();
  } else {
    total = TEMPO.mode === 'bars' ? tBarsNow(t) * tBar() : len;
    ev.push({ at: 0, off: t.ls, dur: Math.min(len, total), rate: 1, whole: true });
    what = TEMPO.mode === 'bars' ? tBarsText(tBarsNow(t)).toLowerCase() : 'one-shot';
  }
  if (total > 120) { say('Too long to print: over two minutes', true); return; }
  const N = Math.max(1, Math.round(total * sr)), ch = t.buf.numberOfChannels, out = ctx.createBuffer(ch, N, sr), [fi, fo] = fades(t);
  for (let c = 0; c < ch; c++) {
    const d = t.buf.getChannelData(c), o = out.getChannelData(c);
    for (const p of ev) {
      const real = p.dur / p.rate, n = Math.round(real * sr), edge = Math.max(1, Math.round(Math.min(0.0015, real * 0.25) * sr)), at = Math.round(p.at * sr);
      for (let k = 0; k < n && at + k < N; k++) {
        const pos = (p.back ? p.off + p.dur - k * p.rate / sr : p.off + k * p.rate / sr) * sr, i0 = Math.floor(pos), a = d[i0] || 0, b = d[i0 + 1] === undefined ? a : d[i0 + 1];
        let gain = Math.min(1, k / edge, (n - 1 - k) / edge);            // the same short fades the player puts on each piece
        if (p.whole && (fi || fo)) gain *= fadeGain(k / sr, len, fi, fo);
        if (p.env) gain *= tEnvGain((at + k) / sr - p.e0, p.eD, p.env[0], p.env[1]);      // 1-SHOT SHUFFLE's envelope
        o[at + k] += (a + (b - a) * (pos - i0)) * gain;
      }
    }
  }
  const L = tape.loop;
  tPrinted = { buf: out, prev: L.buf ? { buf: L.buf, title: L.title, ls: L.ls, le: L.le, fi: L.fi, fo: L.fo, peaks: L.peaks } : null, from: source, mode: TEMPO.mode };
  setTape('loop', out, 'Print · ' + what);
  TEMPO.mode = 'loop'; tSave();                                          // so what you hear next is the print itself, played straight
  await setSource('loop');
  say(`Printed ${total.toFixed(2)} s to the Loop (${what}). SLICE cuts it again; UNPRINT goes back`);
}
/** UNPRINT: the Loop as it was before the last print, and back to the source and mode it was made from. */
async function tempoUnprint() {
  const p = tPrinted;
  if (!p || tape.loop.buf !== p.buf || rec) return;
  tPrinted = null;
  if (p.prev) Object.assign(tape.loop, p.prev, { faded: null });
  TEMPO.mode = p.mode; tSave();
  await setSource(p.prev || p.from !== 'loop' ? p.from : 'loop');
  say(p.prev ? 'Unprinted: the Loop is as it was' : 'Back to where the print was made. The print itself is still in the Loop');
}
/** Where on the tape the sound is, for the playhead. undefined: not this file's business; null: nothing sounding. */
function tempoPos() {
  if (!tp) return undefined;
  const m = tMark();
  return m ? m.off + (ctx.currentTime - m.t0) * m.rate * (m.back ? -1 : 1) : null;
}
function tMark() {
  if (!tp) return null;
  const now = ctx.currentTime;
  let m = null;
  for (const k of tp.marks) if (k.t0 <= now) m = k;
  return m && (now - m.t0) * m.rate <= m.dur ? m : null;
}

// ── settings ─────────────────────────────────────────────────────────────────────────────────────
function tSet(key, val, msg) {
  TEMPO[key] = val; tSave();
  if (key === 'mode' && playing && source !== 'live') startBuf();          // the other settings are read as it plays, so the beat carries on
  if (key === 'mode' && val !== 'loop') tempoMidi();
  if (msg) say(msg);
}
const tCycle = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];
function tDescribe() {
  const t = curTape();
  if (tShotSlices()) return `One-shot, shuffle: each press of Space, TRIG or a MIDI note plays the next slice (${tName(T_DIVS, TEMPO.div).toLowerCase()})`;
  if (TEMPO.mode === 'shot') return 'One-shot: Space, TRIG or a MIDI note plays it from the top';
  if (TEMPO.mode === 'bars') return `Starts again every ${tBarsText(t ? tBarsNow(t) : 1).toLowerCase()} at ${TEMPO.bpm} BPM`;
  if (TEMPO.mode === 'slice') return `Slices of ${tName(T_DIVS, TEMPO.div).toLowerCase()}, ${tName(T_ORDERS, TEMPO.order).toLowerCase()}` + (TEMPO.vary === 'none' ? '' : `, ${tName(T_VARY, TEMPO.vary).toLowerCase()}`) + `, at ${TEMPO.bpm} BPM`;
  return 'Loop: plays round as before';
}

// ── on the display: the TEMPO key on the strip's top line, the row of keys under it, the grid ────
let tHits = [], tHitsAt = 0, tPress = null, tRolledAt = 0;
const tHit = (x, y, w, h, act) => tHits.push({ x, y, w, h, act });
function tKey(g, x, y, w, h, label, state, act) {
  if (tPress && performance.now() < tPress.until && Math.abs(tPress.x - x) < 2 && Math.abs(tPress.y - y) < 2) { state = 'on'; y += 1; }     // just tapped: it goes down for a moment
  rr(g, x, y, w, h, 5);
  if (state === 'on') { g.fillStyle = INK; g.fill(); }
  else if (state === 'hot') { g.fillStyle = HOT; g.fill(); }
  else { g.strokeStyle = 'rgba(241,239,232,.26)'; g.lineWidth = 1; g.stroke(); }
  g.font = '700 9px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = state ? '#0b0b0c' : 'rgba(241,239,232,.78)';
  g.fillText(label, x + w / 2, y + h / 2 + 0.5);
  if (act) tHit(x, y, w, h, act);
}
const tW = (g, label, pad) => { g.font = '700 9px ' + FONT; return Math.ceil(g.measureText(label).width) + 2 * (pad || 9); };

/** Is there a row to make room for? The faces ask before they lay the strips out. */
function tempoRowH() {
  const t = curTape();
  return TEMPO.open && t && t.buf && !rec ? T_ROW : 0;
}
/** The TEMPO key at the right end of the strip's top line. Returns the width it took. */
function tempoChip(g, x1, top) {
  tHits = []; tHitsAt = performance.now();
  const label = tOn() || TEMPO.open ? `TEMPO ${TEMPO.bpm}` : 'TEMPO', w = tW(g, label, 7);
  g.save();
  rr(g, x1 - w, top - 3, w, 15, 4);
  if (TEMPO.open) { g.fillStyle = INK; g.fill(); } else { g.strokeStyle = tOn() ? HOT : 'rgba(241,239,232,.3)'; g.lineWidth = 1; g.stroke(); }
  g.font = '700 9px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = TEMPO.open ? '#0b0b0c' : tOn() ? HOT : 'rgba(241,239,232,.7)';
  g.fillText(label, x1 - w / 2, top + 5);
  g.restore();
  tHit(x1 - w - 4, top - 8, w + 8, 25, () => {
    const t = curTape();
    if (!TEMPO.open && TEMPO.guess && t && t.buf) { TEMPO.bpm = tGuess(t); say(`Tempo guessed from the loop's length: ${TEMPO.bpm} BPM. Drag it or tap it in to change`); }
    tSet('open', !TEMPO.open); if (TEMPO.open) tempoMidi();
  });
  return w + 8;
}
/** The row: tempo, the four modes, what the mode in use can be set to, and the grid's key. */
function tempoRow(g, x0, x1, y, h) {
  g.save();
  const kh = h - 6, t = curTape();
  let x = x0;
  // tempo: drag up or down to set it, tap in time to tap it in
  const tight = x1 - x0 < 720, bw = tight ? 72 : 88;
  rr(g, x, y, bw, kh, 5); g.fillStyle = '#060607'; g.fill(); g.strokeStyle = 'rgba(241,239,232,.26)'; g.lineWidth = 1; g.stroke();
  g.textBaseline = 'middle'; g.textAlign = 'right'; g.font = '600 13px ' + MONO; g.fillStyle = INK;
  g.fillText(TEMPO.bpm.toFixed(1), x + bw - 34, y + kh / 2 + 0.5);
  g.textAlign = 'left'; g.font = '700 8px ' + FONT; g.fillStyle = DIM; g.fillText('BPM', x + bw - 30, y + kh / 2 + 1);
  g.fillStyle = 'rgba(241,239,232,.5)';
  g.beginPath(); g.moveTo(x + bw - 8, y + kh / 2 - 3); g.lineTo(x + bw - 5, y + kh / 2 - 7); g.lineTo(x + bw - 2, y + kh / 2 - 3); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(x + bw - 8, y + kh / 2 + 3); g.lineTo(x + bw - 5, y + kh / 2 + 7); g.lineTo(x + bw - 2, y + kh / 2 + 3); g.closePath(); g.fill();
  tHit(x, y, bw, kh, e => { tDrag = { y: e.clientY, bpm: TEMPO.bpm, moved: false }; });
  x += bw + (tight ? 5 : 8);
  // the modes
  for (const [id, label] of T_MODES) {
    const w = tW(g, label, tight ? 6 : 9);
    tKey(g, x, y, w, kh, label, TEMPO.mode === id ? 'on' : '', () => { tSet('mode', id); say(tDescribe()); });
    x += w + 3;
  }
  x += tight ? 2 : 5;
  // what this mode can be set to
  if (TEMPO.mode === 'shot') {
    const sl = tShotSlices(), small = tight && sl, w = tW(g, 'TRIG', small ? 7 : 14);       // on a narrow strip, with SHUFFLE's extra keys, everything is cut closer
    tKey(g, x, y, w, kh, 'TRIG', 'hot', () => tempoTrig()); x += w + 3;
    const lab = sl ? (small ? 'SHUF' : 'SHUFFLE') : 'REPEAT', w2 = tW(g, small ? 'SHUF' : 'SHUFFLE', tight ? 6 : 9);      // what a press plays: the sample from the top, or the next slice
    tKey(g, x, y, w2, kh, lab, sl ? 'on' : '', () => { tSet('shot', sl ? 'whole' : 'slices'); if (tp) tp.k = 0; say(tDescribe()); }); x += w2 + 3;
    if (sl) {
      for (const key of ['div', 'vary']) { const w3 = tDrop(g, key, x, y, kh, tight); x += w3 + 3; }
      const w4 = tW(g, 'ROLL', tight ? 6 : 9); tKey(g, x, y, w4, kh, 'ROLL', '', tempoRoll); x += w4 + 3;
      const envOn = !!tEnvShape(1), el = tName(T_ENV, envOn ? TEMPO.env : 'off'), w5 = tW(g, el, tight ? 6 : 9);      // the envelope on each press: tap to step through the shapes
      tKey(g, x, y, w5, kh, el, envOn ? 'on' : '', () => { tSet('env', tCycle(T_ENV.map(e => e[0]), envOn ? TEMPO.env : 'off')); say(tEnvText()); }); x += w5 + 3;
    }
    if (!small) x += 3;
  } else if (TEMPO.mode === 'bars') {
    const label = (TEMPO.bars ? '' : 'AUTO · ') + tBarsText(t ? tBarsNow(t) : 1), w = tW(g, label);
    tKey(g, x, y, w, kh, label, '', () => { tSet('bars', tCycle(T_BARS, TEMPO.bars)); say(tDescribe()); }); x += w + 6;
  } else if (TEMPO.mode === 'slice') {
    for (const key of ['div', 'order', 'vary']) { const w = tDrop(g, key, x, y, kh, tight); x += w + 3; }
    if (TEMPO.order === 'shuffle') { const w = tW(g, 'ROLL', tight ? 6 : 9); tKey(g, x, y, w, kh, 'ROLL', '', tempoRoll); x += w + 3; }
    x += 3;
  }
  // PRINT: keep what this mode is playing, as the Loop. After a print, in LOOP, the same place takes it back
  if (tOn()) { const w = tW(g, 'PRINT', tight ? 6 : 9); if (x + w <= x1 - tW(g, 'GRID', tight ? 6 : 9) - 2) { tKey(g, x, y, w, kh, 'PRINT', '', tempoPrint); x += w + 6; } }      // never under the GRID key
  else if (tPrinted && tape.loop.buf === tPrinted.buf) { const w = tW(g, 'UNPRINT', tight ? 6 : 9); tKey(g, x, y, w, kh, 'UNPRINT', '', tempoUnprint); x += w + 6; }
  // the grid's key, at the right; and, with the tape off normal speed, the tempo you actually hear
  let gw = tW(g, 'GRID', tight ? 6 : 9);
  tKey(g, x1 - gw, y, gw, kh, 'GRID', TEMPO.grid ? 'on' : '', () => tSet('grid', !TEMPO.grid));
  if (typeof setLoopZoom === 'function') {                               // the app's own zoom: the strip shows just the loop
    const zw = tW(g, 'ZOOM', tight ? 6 : 9);
    if (x1 - gw - 3 - zw >= x - 2) {                                     // only where it does not run into the keys on the left
      tKey(g, x1 - gw - 3 - zw, y, zw, kh, 'ZOOM', loopZoom ? 'on' : '', () => setLoopZoom(!loopZoom));
      gw += 3 + zw;
    }
  }
  if (Math.abs(bufRate - 1) > 0.005 && x1 - gw - x > 96 && TEMPO.mode !== 'slice') {
    g.font = '600 9px ' + FONT; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillStyle = DIM;
    g.fillText(`${(TEMPO.bpm * bufRate).toFixed(1)} AT ${bufRate.toFixed(2)}×`, x1 - gw - 8, y + kh / 2 + 0.5);
  }
  g.restore();
}
/* ── loop ends on the beat ── */
let tSnapped = 0;                                                        // beats in the loop, while the end being dragged sits on a snap point
/** While a loop end is dragged: the time to use for it. Near a whole number of bars from the other end it goes exactly
 *  there, and near a whole number of beats too when there is room to tell them apart; anywhere else it is left alone,
 *  so any length can still be set. Only while the grid is on. */
function tempoSnap(tm, anchor, G) {
  tSnapped = 0;
  if (!(TEMPO.open || tOn()) || !TEMPO.grid || anchor === undefined) return tm;
  const beat = tBeat(), pxs = (G.x1 - G.x0) / (G.b - G.a), dir = tm >= anchor ? 1 : -1, d = Math.abs(tm - anchor);
  const hit = (unit, reach) => { const at = anchor + dir * Math.max(1, Math.round(d / unit)) * unit; return at >= -1e-6 && at <= G.dur + 1e-6 && Math.abs(at - tm) * pxs <= reach ? clamp(at, 0, G.dur) : null; };
  let unit = tBar(); while (unit * pxs < 28) unit *= 2;                  // zoomed far out: every second bar, every fourth…
  let at = hit(unit, 11);
  if (at === null && beat * pxs >= 18) at = hit(beat, 7);
  if (at === null) return tm;
  tSnapped = Math.round(Math.abs(at - anchor) / beat);
  return at;
}
/** How long the loop is at this tempo: "2 BARS", "1 BAR 2 BEATS", or "2.13 BARS" when it is not a whole number of beats. */
function tempoLenText(t) {
  if (!(TEMPO.open || tOn()) || !t) return '';
  const beat = tBeat(), beats = (t.le - t.ls) / beat, whole = Math.round(beats);
  if (whole < 1 || Math.abs(beats - whole) * beat > Math.max(0.004, beat * 0.004)) return (beats / 4).toFixed(2) + ' BARS';
  const bars = Math.floor(whole / 4), rem = whole % 4, bt = rem ? `${rem} BEAT${rem > 1 ? 'S' : ''}` : '';
  return bars ? `${bars} BAR${bars > 1 ? 'S' : ''}${bt ? ' ' + bt : ''}` : bt;
}
/** An end of the loop is being dragged (not a fade tab, not a join). */
const tDragging = () => typeof drag !== 'undefined' && drag && drag.anchor !== undefined && drag.moved && (TEMPO.open || tOn());
/** Over the waveform, in SHUFFLE: an orange underline beneath each slice the pattern uses, so a new deal can be seen
 *  (for a moment after ROLL those slices flash); slices switched off are dimmed; a joined section has a bracket over it
 *  and one unbroken underline; and the slices under a drag in progress are lit. */
function tempoMarks(g, t, x0, px, pt, bot) {
  if (tDragging()) {                                                   // beside the end being dragged: the loop's length, lit when it is on a snap point
    const end = Math.abs(t.ls - drag.anchor) < 1e-6 ? t.le : t.ls, x = x0 + end * px, label = tempoLenText(t);
    g.save(); g.font = '700 9px ' + FONT;
    const w = Math.ceil(g.measureText(label).width) + 10, bx = end > drag.anchor ? x - w - 6 : x + 6;
    rr(g, bx, pt + 1, w, 14, 3); g.fillStyle = tSnapped ? HOT : 'rgba(9,9,10,.82)'; g.fill();
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = tSnapped ? '#0b0b0c' : 'rgba(241,239,232,.85)'; g.fillText(label, bx + w / 2, pt + 8.5);
    g.restore();
  }
  if (!tempoOwnsTaps()) return;
  const pat = tPatNow(t), step = pat.step, now = performance.now(), flash = clamp01(1 - (now - tRolledAt) / 450), used = new Set(pat.steps.map(q => q.i));
  const box = (i, n = 1) => [x0 + (t.ls + i * step) * px, Math.max(2, n * step * px - 2)];
  const bracket = (x, w, ink) => { g.fillStyle = ink; g.fillRect(x, pt - 3, w, 2); g.fillRect(x, pt - 3, 2, 7); g.fillRect(x + w - 2, pt - 3, 2, 7); };
  for (const i of tOff) {                                              // switched off: dimmed, with a grey foot
    const [x, w] = box(i);
    g.fillStyle = 'rgba(9,9,10,.68)'; g.fillRect(x, pt - 2, w + 1, bot - pt + 4);
    g.fillStyle = 'rgba(241,239,232,.3)'; g.fillRect(x + 1, bot - 1, w - 1, 2.5);
  }
  for (const i of used) {
    if (i < 0) continue;
    const [x, w] = box(i);
    if (flash > 0) { g.fillStyle = `rgba(240,78,35,${0.45 * flash})`; g.fillRect(x, pt - 2, w, bot - pt + 4); }
    g.fillStyle = HOT; g.fillRect(x + 1, bot - 1, w - 1, 2.5);
  }
  for (let a = 0; a < pat.M; a++) {                                    // joined sections
    if (!tLink.has(a) || tHead(a) !== a) continue;
    const [x, w] = box(a, tLen(a)), inPat = used.has(a);
    g.fillStyle = 'rgba(240,78,35,.1)'; g.fillRect(x, pt - 1, w, bot - pt + 2);
    bracket(x, w, inPat ? HOT : 'rgba(241,239,232,.45)');
    if (inPat) { g.fillStyle = HOT; g.fillRect(x + 1, bot - 1, w - 1, 2.5); }
  }
  if (tSwept && tSwept.b > tSwept.a) {                                       // being dragged over: what will be joined
    const [x, w] = box(tSwept.a, tSwept.b - tSwept.a + 1);
    g.fillStyle = 'rgba(240,78,35,.24)'; g.fillRect(x, pt - 2, w, bot - pt + 4);
    bracket(x, w, 'rgba(241,239,232,.9)');
  }
  if (tFlash && now - tFlash.at < 300) { const [x, w] = box(tFlash.i, tFlash.n || 1); g.fillStyle = `rgba(241,239,232,${0.4 * (1 - (now - tFlash.at) / 300)})`; g.fillRect(x, pt - 2, w, bot - pt + 4); }     // the one just tapped or joined
}
/** The grid, drawn before the waveform so it sits behind it: bars, beats, and in SLICE the slices, from the loop's start. */
function tempoGrid(g, t, x0, w, pt, bot, dur) {
  if (!TEMPO.grid || !(TEMPO.open || tOn())) return;
  const beat = tBeat(), px = w / dur, sub = tSlicing() ? Math.min(tStep(), beat) : beat, len = t.le - t.ls;
  g.save();
  const m = tMark();
  if (tSlicing() && m && m.slice !== undefined) {              // the slice that is sounding
    g.fillStyle = 'rgba(240,78,35,.3)'; g.fillRect(x0 + (t.ls + m.slice * tStep()) * px, pt - 3, Math.max(2, m.sdur * px), bot - pt + 6);
  }
  const perBeat = Math.round(beat / sub);
  for (let k = 0; k * sub < len - 1e-4 && k < 4000; k++) {
    const isBeat = k % perBeat === 0, isBar = k % (perBeat * 4) === 0;
    if (!isBeat && sub * px < 4) continue;
    if (!isBar && beat * px < 3) continue;
    g.fillStyle = isBar ? 'rgba(241,239,232,.42)' : isBeat ? 'rgba(241,239,232,.2)' : 'rgba(241,239,232,.1)';
    g.fillRect(x0 + (t.ls + k * sub) * px - 0.5, isBar ? pt - 4 : pt - 1, 1, isBar ? bot - pt + 8 : bot - pt + 2);
  }
  if (TEMPO.mode === 'bars') {                                           // where it starts again
    const at = t.ls + tBarsNow(t) * tBar();
    if (at <= t.buf.duration + 1e-3) { g.fillStyle = HOT; for (let y = pt - 4; y < bot + 4; y += 6) g.fillRect(x0 + at * px - 1, y, 2, 3); }
  }
  if (tDragging()) {                                                   // an end is being dragged: where it would snap, counted from the other end
    const all = t.buf.duration;
    for (let k = -2000; k <= 2000; k++) {
      const at = drag.anchor + k * beat, bar = k % 4 === 0;
      if (!k || at < -1e-6 || at > all + 1e-6 || (!bar && beat * px < 18) || (bar && beat * 4 * px < 7)) continue;
      g.fillStyle = bar ? HOT : 'rgba(240,78,35,.5)';
      g.fillRect(x0 + at * px - 1, pt - 6, 2, bar ? 8 : 4); g.fillRect(x0 + at * px - 1, bot + 6 - (bar ? 8 : 4), 2, bar ? 8 : 4);
    }
  }
  g.restore();
}

// ── drop-downs: the key is drawn on the canvas like the others, and a real, invisible <select> is laid exactly
// over it, so a tap opens the system's own list (on the iPad, its picker) ──
const T_DROPS = { div: T_DIVS, order: T_ORDERS, vary: T_VARY }, tSel = {};
for (const key in T_DROPS) {
  const el = document.createElement('select');
  el.className = 'tempo-drop'; el.setAttribute('aria-label', { div: 'Slice size', order: 'Slice order', vary: 'Slice variation' }[key]);
  el.style.cssText = 'position:absolute;margin:0;padding:0;border:0;min-width:0;min-height:0;box-sizing:border-box;opacity:0;font-size:16px;display:none;-webkit-appearance:none;appearance:none;cursor:pointer;z-index:3';
  for (const [val, label] of T_DROPS[key]) { const o = document.createElement('option'); o.value = String(val); o.textContent = val === 'all' ? 'All three' : label[0] + label.slice(1).toLowerCase(); el.appendChild(o); }
  el.addEventListener('change', () => { const hit = T_DROPS[key].find(o => String(o[0]) === el.value); if (hit) { tSet(key, hit[0]); say(tDescribe()); } el.blur(); });
  document.querySelector('#screen').appendChild(el);
  tSel[key] = { el, at: 0, box: '' };
}
/** Draws the key for one drop-down at (x, y) and puts its <select> over it. Returns the key's width. */
function tDrop(g, key, x, y, h, tight) {
  const label = tName(T_DROPS[key], TEMPO[key]), w = tW(g, label, tight ? 6 : 9) + 11, q = tSel[key];
  const on = key === 'vary' && TEMPO.vary !== 'none';                      // lit only when it is adding something
  tKey(g, x, y, w, h, '', on ? 'on' : '');
  g.font = '700 9px ' + FONT; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillStyle = on ? '#0b0b0c' : 'rgba(241,239,232,.78)';
  g.fillText(label, x + (tight ? 6 : 9), y + h / 2 + 0.5);
  g.beginPath(); g.moveTo(x + w - 12, y + h / 2 - 2); g.lineTo(x + w - 6, y + h / 2 - 2); g.lineTo(x + w - 9, y + h / 2 + 2.5); g.closePath(); g.fill();     // the mark of a drop-down
  const box = [Math.round(x - 2), Math.round(y - 4), Math.round(w + 4), Math.round(h + 8)].join();
  if (q.box !== box) { q.box = box; const [l, t2, ww, hh] = box.split(','); Object.assign(q.el.style, { left: l + 'px', top: t2 + 'px', width: ww + 'px', height: hh + 'px', display: 'block' }); }
  if (q.el.value !== String(TEMPO[key])) q.el.value = String(TEMPO[key]);
  q.at = performance.now();
  return w;
}
setInterval(() => {                                                      // a drop-down whose key is no longer drawn must not stay in the way
  const now = performance.now();
  for (const key in tSel) { const q = tSel[key]; if (q.box && now - q.at > 250 && document.activeElement !== q.el) { q.box = ''; q.el.style.display = 'none'; } }
}, 200);

// ── touch: the keys above are drawn on the canvas, so taps on them are caught here, before the app's own handler ──
let tDrag = null, tTaps = [];
document.querySelector('#screen').addEventListener('pointerdown', e => {
  if (e.target !== deckCv || muted || guard || document.body.classList.contains('show')) return;
  if (performance.now() - tHitsAt > 400) return;                         // the strip is not on screen
  const b = deckCv.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top, pad = e.pointerType === 'mouse' ? 0 : 5;
  const h = tHits.find(q => x >= q.x - pad && x <= q.x + q.w + pad && y >= q.y - pad && y <= q.y + q.h + pad);
  if (!h) return;
  e.stopPropagation(); e.preventDefault();
  tPress = { x: h.x, y: h.y, until: performance.now() + 160 };
  h.act(e);
}, true);
window.addEventListener('pointermove', e => {
  if (!tDrag) return;
  const dy = e.clientY - tDrag.y;
  if (!tDrag.moved && Math.abs(dy) < 5) return;
  tDrag.moved = true;
  TEMPO.bpm = clamp(Math.round(tDrag.bpm - dy * 0.25), 40, 240); TEMPO.guess = false;
});
const tDragEnd = () => {
  if (!tDrag) return;
  const d = tDrag; tDrag = null;
  if (d.moved) { tSave(); say(`Tempo ${TEMPO.bpm} BPM`); return; }
  const now = performance.now();                                         // not dragged: a tap, for tapping the tempo in
  if (tTaps.length && now - tTaps[tTaps.length - 1] > 2000) tTaps = [];
  tTaps.push(now); if (tTaps.length > 6) tTaps.shift();
  if (tTaps.length >= 2) {
    TEMPO.bpm = clamp(Math.round(600000 * (tTaps.length - 1) / (now - tTaps[0])) / 10, 40, 240); TEMPO.guess = false; tSave();
    say(`Tempo ${TEMPO.bpm} BPM, tapped`);
  } else say('Tap again in time to set the tempo, or drag up and down');
};
window.addEventListener('pointerup', tDragEnd);
window.addEventListener('pointercancel', tDragEnd);

// Space: in 1-SHOT it is the trigger (the Play key still starts and stops). Caught before the app's own key handler.
window.addEventListener('keydown', e => {
  if (e.key !== ' ' || TEMPO.mode !== 'shot' || source === 'live' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (!e.repeat) tempoTrig();
}, true);

// MIDI: any note from any controller is the trigger. Asked for once, the first time a mode is switched on or played.
let tMidi = null;
function tempoMidi() {
  if (tMidi) return;
  if (!navigator.requestMIDIAccess) { tMidi = 'none'; return; }          // Safari, and so the iPad, has no MIDI for web pages
  tMidi = 'asking';
  navigator.requestMIDIAccess().then(acc => {
    tMidi = acc;
    const listen = () => acc.inputs.forEach(inp => { inp.onmidimessage = m => { if ((m.data[0] & 0xf0) === 0x90 && m.data[2] > 0) tempoTrig(); }; });
    listen(); acc.onstatechange = listen;
  }, () => { tMidi = 'refused'; });
}
if (window.tapeloss) Object.assign(window.tapeloss, { tempo: TEMPO, tempoTrig, tempoRoll, tempoPrint, tempoUnprint, tempoSet: tSet });
