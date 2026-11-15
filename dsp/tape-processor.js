'use strict';
/*
 * WARBLE — tape loss machine. DSP core.
 *
 * One file, three uses:
 *   1. AudioWorklet module (registers the 'tape-warble' processor)
 *   2. plain <script> in the page (gives the UI PARAM_DEFS, and TapeCore for offline bounces)
 *   3. node require() for tests
 *
 * TapeCore is written to port line-for-line to C++ (JUCE → Audio Unit for Logic, AUv3 for iPad):
 * no allocation inside process(), no Web Audio types, its own random generator, plain numbers.
 *
 * Signal path, the order a real deck does it:
 *   record:    drive → pre-emphasis → tanh saturation (+ bias) → de-emphasis
 *   transport: modulated delay line = wow + flutter + drift + snags + tape stop
 *   grains:    what comes off the transport is recorded onto a second 8 s tape; up to 48 grains read it back from a
 *              read point that moves on its own (Position, Scan, Drift), with per-grain scatter,
 *              and the cloud can be recorded back onto that tape (Feedback) so it keeps changing
 *   playback:  dropouts → high-frequency loss → low cut → head bump → hiss (over tape and cloud alike)
 *   space:     a plate-style reverb
 *   mix:       dry/wet
 *   master:    low cut → tone tilt → width → glue compressor → output gain → limiter
 *   bypass crossfade
 *
 * Two engines, chosen by the `hq` switch. Classic is the path above at the sample rate. HQ does the same
 * things with less digital residue: the saturator runs at 4× the sample rate, the tape is kept at 2×,
 * grains that are pitched up read band-limited copies of their tape, and the dry signal is delayed to
 * stay in step with the wet one. With `hq` off none of that code runs and the output is the classic one.
 */

const TWO_PI = Math.PI * 2;

const PARAM_DEFS = [
  // speed is the tape's playing speed. The host applies it to the source (the page changes the loop's or file's
  // playback rate; a plugin would resample its input); the core itself does not read it.
  { id: 'speed',    label: 'Speed',    group: 'motion', min: 0.25, max: 2,   def: 1,    unit: 'spd', skew: 1.2224, bipolar: true, off: 1 },
  { id: 'wow',      label: 'Wow',      group: 'motion', min: 0,    max: 1,   def: 0.35, unit: '%', off: 0 },
  { id: 'wowRate',  label: 'Rate',     group: 'motion', min: 0.1,  max: 4,   def: 0.6,  unit: 'Hz', skew: 2 },
  { id: 'flutter',  label: 'Flutter',  group: 'motion', min: 0,    max: 1,   def: 0.25, unit: '%', off: 0 },
  { id: 'wobble',   label: 'Wobble',   group: 'motion', min: 0,    max: 1,   def: 0.3,  unit: '%', off: 0 },
  { id: 'spread',   label: 'Spread',   group: 'motion', min: 0,    max: 1,   def: 0.3,  unit: '%', off: 0 },

  { id: 'drive',    label: 'Saturate', group: 'tape',   min: 0,    max: 1,   def: 0.3,  unit: '%', off: 0 },
  { id: 'loss',     label: 'Loss',     group: 'tape',   min: 0,    max: 1,   def: 0.35, unit: '%', off: 0 },
  { id: 'dropouts', label: 'Dropouts', group: 'tape',   min: 0,    max: 1,   def: 0.15, unit: '%', off: 0 },
  { id: 'hiss',     label: 'Hiss',     group: 'tape',   min: 0,    max: 1,   def: 0.25, unit: '%', off: 0 },

  // grains: what each grain is
  { id: 'grains',   label: 'Amount',   group: 'grain',  min: 0,    max: 1,   def: 0,    unit: '%', off: 0 },
  { id: 'gPos',     label: 'Position', group: 'grain',  min: 0,    max: 6,   def: 0,    unit: 's', skew: 2 },
  { id: 'gSpray',   label: 'Spray',    group: 'grain',  min: 0,    max: 1,   def: 0.3,  unit: '%'  },
  { id: 'gSize',    label: 'Size',     group: 'grain',  min: 0.01, max: 2,   def: 0.15, unit: 'ms', skew: 3 },
  { id: 'gDensity', label: 'Density',  group: 'grain',  min: 0.5,  max: 120, def: 25,   unit: '/s', skew: 3 },
  { id: 'gShape',   label: 'Shape',    group: 'grain',  min: 0,    max: 1,   def: 0.5,  unit: '%', bipolar: true },
  { id: 'gTone',    label: 'Tone',     group: 'grain',  min: -1,   max: 1,   def: 0.3,  unit: 'cut', bipolar: true },

  // evolve: what makes the cloud move and change over time
  { id: 'gPitch',   label: 'Pitch',    group: 'evolve', min: -24,  max: 24,  def: 0,    unit: 'st', step: 1, big: 12, bipolar: true },
  { id: 'gScatter', label: 'Scatter',  group: 'evolve', min: 0,    max: 1,   def: 0,    unit: '%'  },
  { id: 'gReverse', label: 'Reverse',  group: 'evolve', min: 0,    max: 1,   def: 0.15, unit: '%'  },
  { id: 'gScan',    label: 'Scan',     group: 'evolve', min: -2,   max: 2,   def: 0,    unit: 'x', bipolar: true },
  { id: 'gFeedback', label: 'Feedback', group: 'evolve', min: 0,   max: 1,   def: 0,    unit: '%'  },
  { id: 'gDrift',   label: 'Drift',    group: 'evolve', min: 0,    max: 1,   def: 0.3,  unit: '%'  },

  { id: 'space',    label: 'Space',    group: 'space',  min: 0,    max: 1,   def: 0,    unit: '%', off: 0 },
  { id: 'sDecay',   label: 'Decay',    group: 'space',  min: 0,    max: 1,   def: 0.6,  unit: '%'  },
  { id: 'sTone',    label: 'Tone',     group: 'space',  min: 0,    max: 1,   def: 0.7,  unit: '%'  },
  // how much reverb each range gets: below 200 Hz, 200–800, 800–3k, 3k–8k, above 8k
  { id: 'sLow',     label: 'Low',      group: 'space',  min: 0,    max: 1.5, def: 0.4,  unit: '%', small: true },
  { id: 'sMid',     label: 'Mid',      group: 'space',  min: 0,    max: 1.5, def: 1,    unit: '%', small: true },
  { id: 'sMidHi',   label: 'Mid-Hi',   group: 'space',  min: 0,    max: 1.5, def: 1,    unit: '%', small: true },
  { id: 'sHigh',    label: 'High',     group: 'space',  min: 0,    max: 1.5, def: 1,    unit: '%', small: true },
  { id: 'sAir',     label: 'Hi-Fi',    group: 'space',  min: 0,    max: 1.5, def: 1,    unit: '%', small: true },

  { id: 'lowCut',   label: 'Low cut',  group: 'master', min: 20,   max: 300, def: 20,   unit: 'Hz', skew: 2, off: 20 },
  { id: 'tone',     label: 'Tone',     group: 'master', min: -1,   max: 1,   def: 0,    unit: 'tilt', bipolar: true, off: 0 },
  { id: 'glue',     label: 'Glue',     group: 'master', min: 0,    max: 1,   def: 0,    unit: '%', off: 0 },
  { id: 'width',    label: 'Width',    group: 'master', min: 0,    max: 2,   def: 1,    unit: '%', bipolar: true, off: 1 },
  { id: 'mix',      label: 'Mix',      group: 'master', min: 0,    max: 1,   def: 1,    unit: '%'  },
  { id: 'output',   label: 'Output',   group: 'master', min: -24,  max: 12,  def: 0,    unit: 'dB' },

  { id: 'stop',     label: 'Tape stop', group: 'switch', min: 0, max: 1, def: 0 },
  { id: 'bypass',   label: 'Bypass',    group: 'switch', min: 0, max: 1, def: 0 },
  { id: 'drop',     label: 'Dropout',   group: 'switch', min: 0, max: 1, def: 0 },   // held: tape off the head
  { id: 'freeze',   label: 'Freeze',    group: 'switch', min: 0, max: 1, def: 0 },   // held: grains loop what they have
  { id: 'limit',    label: 'Limiter',   group: 'switch', min: 0, max: 1, def: 1 },
  { id: 'hq',       label: 'HQ engine', group: 'switch', min: 0, max: 1, def: 1 },   // which engine: see the top of this file

  // one on/off per section; off sends that section's knobs to their neutral ("off") values
  { id: 'onMotion', label: 'Motion on', group: 'switch', min: 0, max: 1, def: 1 },
  { id: 'onTape',   label: 'Tape on',   group: 'switch', min: 0, max: 1, def: 1 },
  { id: 'onGrain',  label: 'Grains on', group: 'switch', min: 0, max: 1, def: 1 },
  { id: 'onSpace',  label: 'Space on',  group: 'switch', min: 0, max: 1, def: 1 },
  { id: 'onMaster', label: 'Master on', group: 'switch', min: 0, max: 1, def: 1 },
];

/** The sections as the UI shows them. Knobs with an `off` value are silenced by the section's switch. */
const GROUPS = [
  { id: 'motion', label: 'Motion', sw: 'onMotion' },
  { id: 'tape',   label: 'Tape',   sw: 'onTape'   },
  { id: 'grain',  label: 'Grains', sw: 'onGrain', full: true },
  { id: 'evolve', label: 'Evolve', sw: 'onGrain', full: true, sub: true },   // second page of the grain engine
  { id: 'space',  label: 'Space',  sw: 'onSpace'  },
  { id: 'master', label: 'Master', sw: 'onMaster' },
];

/** xorshift32: the same numbers on every platform, so a bounce is repeatable. */
class Rng {
  constructor(seed) { this.s = (seed >>> 0) || 1; }
  next() {                       // 0 .. 1
    let s = this.s;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    this.s = s;
    return s / 4294967296;
  }
  bi() { return this.next() * 2 - 1; }   // -1 .. 1
}

/** A slow random wander in -1..1: jumps to a new target every 0.4–2.5 s, smoothed by two one-poles. */
class Wander {
  constructor(rng, sr, fc) {
    this.rng = rng; this.sr = sr;
    this.k = 1 - Math.exp(-TWO_PI * fc / sr);
    this.target = 0; this.a = 0; this.b = 0; this.count = 0; this.fired = false;
  }
  tick() {
    this.fired = false;
    if (--this.count <= 0) {
      this.target = this.rng.bi();
      this.count = ((0.4 + 2.1 * this.rng.next()) * this.sr) | 0;
      this.fired = true;
    }
    this.a += this.k * (this.target - this.a);
    this.b += this.k * (this.a - this.b);
    return this.b;
  }
}

function makeChannel() {
  return {
    e1: 0, e2: 0,            // pre / de-emphasis states
    lp1: 0, lp2: 0,          // loss low-pass
    hp: 0,                   // low cut
    b1: 0, b2: 0,            // head bump band
    n1: 0, n2: 0,            // flutter noise (two-pole)
    h1: 0, h2: 0,            // hiss shaping
    dPos: 0, dLen: 0, dDepth: 0,   // dropout in progress
    prevDelay: -1,           // -1 = nothing read yet
  };
}

const MIN_DELAY = 4;         // samples; the cubic read needs two samples either side
const MAX_GRAINS = 48;
const GRAIN_LOOP = 6;        // seconds of grain tape that Position and Scan travel over
const SCATTER = [12, -12, 7, 19, -5, 24, -24];   // semitone jumps Scatter can pick: octaves and fifths, so it stays in key
const KAP = 0.7;             // reverb diffusion

// ── HQ engine: the pieces ────────────────────────────────────────────────────────────────────────
const OS_LATENCY = 28;                    // samples the 4× saturator's filters take: (47 − 1) / 2 + (21 − 1) / 4
const HQ_DRY = MIN_DELAY + OS_LATENCY;    // so the dry signal waits this long, and Mix stays phase-true
// band-limited copies of the grain tape: [filter order, pass-band edge as a fraction of the sample rate].
// A grain played r times faster reads the first copy from r = 1.6, the second from 2.5, the third from 3.5.
const MIPS = [[6, 0.2], [4, 0.14], [4, 0.1]];

function bessel0(x) { let sum = 1, t = 1; for (let k = 1; k < 40; k++) { t *= (x / (2 * k)) * (x / (2 * k)); sum += t; } return sum; }
/** A Kaiser-windowed low-pass of N taps (N odd), cut-off fc as a fraction of the sample rate. */
function kaiserLowpass(N, fc, beta) {
  const h = new Float64Array(N), M = (N - 1) / 2, b0 = bessel0(beta);
  for (let n = 0; n < N; n++) {
    const k = n - M, r = k / M;
    h[n] = (k === 0 ? 2 * fc : Math.sin(TWO_PI * fc * k) / (Math.PI * k)) * bessel0(beta * Math.sqrt(1 - r * r)) / b0;
  }
  return h;
}
/** One ×2 step of the oversampler, built on a linear-phase low-pass h. up() turns one sample into two
 *  (a, then b); push() and out() run the same filter over the fast samples, to come back down (out() after
 *  the first of each pair) or just to band-limit them. Taps that are zero (half of them) are skipped. */
class Stage2 {
  constructor(h) {
    let se = 0, so = 0;
    for (let k = 0; k < h.length; k++) if (k & 1) so += h[k]; else se += h[k];
    const eI = [], eC = [], oI = [], oC = [], dI = [], dC = [];
    for (let k = 0; k < h.length; k++) {
      const c = h[k] / (k & 1 ? so : se);            // each of the two phases passes DC at exactly 1
      if (Math.abs(c) < 1e-9) continue;
      if (k & 1) { oI.push(k >> 1); oC.push(c); } else { eI.push(k >> 1); eC.push(c); }
      dI.push(k); dC.push(c * 0.5);
    }
    this.eI = Int32Array.from(eI); this.eC = Float64Array.from(eC);
    this.oI = Int32Array.from(oI); this.oC = Float64Array.from(oC);
    this.dI = Int32Array.from(dI); this.dC = Float64Array.from(dC);
    this.x = new Float64Array(32); this.xi = 0;      // slow samples, for going up
    this.d = new Float64Array(64); this.di = 0;      // fast samples, for coming down
    this.a = 0; this.b = 0;
  }
  reset() { this.x.fill(0); this.d.fill(0); this.a = this.b = 0; }
  up(v) {
    const x = this.x, i = this.xi = (this.xi + 1) & 31;
    x[i] = v;
    let a = 0, b = 0;
    const eI = this.eI, eC = this.eC, oI = this.oI, oC = this.oC;
    for (let j = 0; j < eC.length; j++) a += eC[j] * x[(i - eI[j]) & 31];
    for (let j = 0; j < oC.length; j++) b += oC[j] * x[(i - oI[j]) & 31];
    this.a = a; this.b = b;
  }
  push(v) { this.d[this.di = (this.di + 1) & 63] = v; }
  out() {
    const d = this.d, i = this.di, dI = this.dI, dC = this.dC;
    let y = 0;
    for (let j = 0; j < dC.length; j++) y += dC[j] * d[(i - dI[j]) & 63];
    return y;
  }
}
/** A Chebyshev low-pass (even order, `ripple` dB in the pass band, edge fc as a fraction of the sample
 *  rate) as second-order sections [b0, b1, b2, a1, a2], level centred on the ripple. */
function chebyLowpass(order, fc, ripple) {
  const eps = Math.sqrt(Math.pow(10, ripple / 10) - 1), a = Math.asinh(1 / eps) / order, K = Math.tan(Math.PI * fc);
  const out = [];
  for (let k = 1; k <= order / 2; k++) {
    const th = Math.PI * (2 * k - 1) / (2 * order), sg = -Math.sinh(a) * Math.sin(th), om = Math.cosh(a) * Math.cos(th);
    const W = (sg * sg + om * om) * K * K, B = -2 * sg * K, a0 = 1 + B + W;
    out.push([W / a0, 2 * W / a0, W / a0, (2 * W - 2) / a0, (1 - B + W) / a0]);
  }
  const g = Math.pow(10, -ripple / 40);
  for (let i = 0; i < 3; i++) out[0][i] *= g;
  return out;
}
class Cascade {
  constructor(sections) { this.c = Float64Array.from(sections.flat()); this.n = sections.length; this.z = new Float64Array(this.n * 2); }
  reset() { this.z.fill(0); }
  run(x) {
    const c = this.c, z = this.z;
    for (let k = 0, i = 0, j = 0; k < this.n; k++, i += 5, j += 2) {
      const y = c[i] * x + z[j];
      z[j] = c[i + 1] * x - c[i + 3] * y + z[j + 1];
      z[j + 1] = c[i + 2] * x - c[i + 4] * y;
      x = y;
    }
    return x;
  }
}

/** Soft limiter from Clouds: transparent when small, never exceeds ±1. */
function softLimit(x) { return x < -3 ? -1 : x > 3 ? 1 : x * (27 + x * x) / (27 + 9 * x * x); }
const CEILING = 0.966;       // limiter ceiling, -0.3 dBFS

class TapeCore {
  constructor(sampleRate) {
    const sr = this.sr = sampleRate;
    let size = 1; while (size < sr * 2.5) size <<= 1;
    this.size = size; this.mask = size - 1;
    this.bufL = new Float32Array(size);
    this.bufR = new Float32Array(size);
    this.w = 0;

    this.ids = PARAM_DEFS.map(d => d.id);
    this.target = {};        // what the host asked for
    this.s = {};             // smoothed once per block
    for (const d of PARAM_DEFS) { this.target[d.id] = d.def; this.s[d.id] = d.def; }
    this.swOf = {}; this.offOf = {};          // which switch silences a knob, and to what value
    for (const d of PARAM_DEFS) {
      const grp = GROUPS.find(x => x.id === d.group);
      if (grp && d.off !== undefined) { this.swOf[d.id] = grp.sw; this.offOf[d.id] = d.off; }
    }

    this.rng = new Rng(0x9E3779B9);
    this.jit = new Wander(this.rng, sr, 0.5);      // makes the wow rate irregular
    this.driftA = new Wander(this.rng, sr, 1.2);   // random pitch drift
    this.driftB = new Wander(this.rng, sr, 1.2);   // a second one for the right channel (spread)
    this.L = makeChannel(); this.R = makeChannel();

    this.wowPh = 0; this.f1Ph = 0; this.f2Ph = 0;
    this.snagPos = 0; this.snagLen = 0; this.snagAmp = 0;
    this.dropCount = sr * 0.5;

    // tape stop
    this.speed = 1; this.sd = 0; this.sdOld = 0; this.xf = 1; this.xfading = false;
    this.sdMax = sr * 1.2;

    // per-sample smoothed gains and delay depths
    this.gD = 1; this.gMk = 1; this.gH = 0; this.gMix = 1; this.gOut = 1; this.gByp = 0;
    this.aW = 0; this.aF = 0; this.aD = 0;
    this.kFast = 1 - Math.exp(-1 / (0.005 * sr));
    this.kSlow = 1 - Math.exp(-1 / (0.15 * sr));

    // fixed filter coefficients
    const a = fc => 1 - Math.exp(-TWO_PI * fc / sr);
    this.aE = a(2500);                       // emphasis corner
    this.aB1 = a(120); this.aB2 = a(45);     // head bump band
    this.aN = a(18);                         // flutter noise
    this.nGain = 0.4 / Math.sqrt(this.aN / 12);
    this.aH1 = a(1000); this.aH2 = a(Math.min(8000, sr * 0.4));

    // held dropout
    this.fd = 0;
    this.kDropA = 1 - Math.exp(-1 / (0.012 * sr)); this.kDropR = 1 - Math.exp(-1 / (0.05 * sr));

    // grains: a second, longer tape of the tape output, read by up to MAX_GRAINS windows
    const gN = this.gN = Math.round(sr * 8);
    this.gbufL = new Float32Array(gN); this.gbufR = new Float32Array(gN);
    this.gw = 0; this.gNext = 0; this.gAmt = 0; this.gAny = false;
    this.gScanPh = 0;          // seconds the read point has slid away from Position
    this.gMorph = 0;           // frozen: where the cloud is being folded back into the held tape
    this.gNorm = 1; this.gCount = 0;
    this.gfL = 0; this.gfR = 0; this.ghL = 0; this.ghR = 0;    // last cloud sample and its high-pass state
    this.GT = { hl1: 0, hl2: 0, hr1: 0, hr2: 0, ll1: 0, ll2: 0, lr1: 0, lr2: 0 };   // cloud tone filters
    this.rvH = 0;                                                // reverb input high-pass state
    this.RB = new Float64Array(8);                               // reverb band splitters, 4 per side
    this.aRB = [200, 800, 3000, 8000].map(fc => 1 - Math.exp(-TWO_PI * Math.min(fc, sr * 0.4) / sr));
    this.gActive = new Uint8Array(MAX_GRAINS);
    this.gPos = new Float64Array(MAX_GRAINS); this.gRate = new Float64Array(MAX_GRAINS);
    this.gInv = new Float64Array(MAX_GRAINS);
    this.gAge = new Int32Array(MAX_GRAINS);   this.gLen = new Int32Array(MAX_GRAINS);
    this.gPk = new Float32Array(MAX_GRAINS);  this.gAmp = new Float32Array(MAX_GRAINS);
    this.gPanL = new Float32Array(MAX_GRAINS); this.gPanR = new Float32Array(MAX_GRAINS);
    this.gRep = new Float32Array(MAX_GRAINS * 4);
    this.rise = new Float32Array(514);                         // half a Hann window, 0 → 1 (and one spare, for reading between entries)
    for (let i = 0; i <= 512; i++) this.rise[i] = 0.5 - 0.5 * Math.cos(Math.PI * i / 512);
    this.rise[513] = 1;
    // Drift: four slow random wanders, one each for position, size, pitch and density
    this.wPos = new Wander(this.rng, sr, 0.22); this.wSize = new Wander(this.rng, sr, 0.3);
    this.wPitch = new Wander(this.rng, sr, 0.35); this.wDens = new Wander(this.rng, sr, 0.27);

    // HQ engine: a tape at twice the sample rate, the oversampler (one ×2 stage up to 2×, a second up to 4×,
    // per side), the dry signal's delay line, and the band-limited copies of the grain tape with their filters
    this.hq = false;
    this.buf2L = new Float32Array(size * 2); this.buf2R = new Float32Array(size * 2); this.mask2 = size * 2 - 1;
    const hA = kaiserLowpass(47, 0.25, 7), hB = kaiserLowpass(21, 0.25, 8);
    this.osL = [new Stage2(hA), new Stage2(hB)]; this.osR = [new Stage2(hA), new Stage2(hB)];
    this.t0 = 0; this.t1 = 0;
    this.dryL = new Float32Array(64); this.dryR = new Float32Array(64); this.dryI = 0;
    this.mipL = MIPS.map(() => new Float32Array(gN)); this.mipR = MIPS.map(() => new Float32Array(gN));
    this.mipFL = MIPS.map(([order, fc]) => new Cascade(chebyLowpass(order, fc, 0.5)));
    this.mipFR = MIPS.map(([order, fc]) => new Cascade(chebyLowpass(order, fc, 0.5)));
    this.mipValid = 0;                                           // how much of the copies has been written since HQ came on
    this.gLv = new Uint8Array(MAX_GRAINS);                       // which copy each grain reads: 0 = the tape itself

    // space: a plate-style reverb (the Griesinger loop used in Mutable Instruments Clouds, lengths at 32 kHz)
    const rs = sr / 32000;
    const line = len => { const m = Math.round(len * rs) + 1; return { b: new Float32Array(m), i: 0, n: m }; };
    this.rv = {
      ap: [113, 162, 241, 399].map(line),
      a1: line(1653), a2: line(2038), d1: line(3411),
      b1: line(1913), b2: line(1663), d2: line(4782 + 120),
      lpA: 0, lpB: 0, ph: 0, live: false,
    };
    this.rvTap = 4680 * rs; this.rvMod = 80 * rs; this.rvInc = TWO_PI * 0.3 / sr;
    this.gSp = 0;

    // master
    this.ML = { h1: 0, h2: 0, t: 0 }; this.MR = { h1: 0, h2: 0, t: 0 };
    this.aTilt = a(900);
    this.gHi = 1; this.gWd = 1;
    this.cEnv = 0; this.lg = 1;
    this.kCA = 1 - Math.exp(-1 / (0.010 * sr)); this.kCR = 1 - Math.exp(-1 / (0.12 * sr));
    this.kLR = 1 - Math.exp(-1 / (0.08 * sr));

    // meters, read and cleared by readMeter()
    this.mDev = 0; this.mCount = 0; this.mIn = 0; this.mOut = 0; this.mDropL = 1; this.mDropR = 1;
    this.mTape = 0; this.mGR = 1;
    this.mRev = new Float32Array(5);     // reverb level in each of the five ranges
    this.OB = new Float64Array(4); this.mOB = new Float32Array(5);   // the same split on the output
    // the waveform of what is recorded on the grain tape: one min/max pair per 128 samples
    this.wvBuf = new Float32Array(128); this.wvN = 0; this.wvMin = 0; this.wvMax = 0; this.wvCnt = 0;
    this.primed = false;
  }

  setParam(id, v) { if (id in this.target) this.target[id] = v; }

  /** Average speed (1 = normal), peak levels, lowest dropout / limiter gain and the grains in flight,
   *  all since the last call. grains is [seconds behind the head, rate, progress 0..1, seconds long] × n. */
  readMeter() {
    let n = 0;
    if (this.gAny) {
      const rep = this.gRep, gs = this.gN, sr = this.sr;
      for (let k = 0; k < MAX_GRAINS; k++) {
        if (!this.gActive[k]) continue;
        rep[n * 4] = ((this.gw + gs - this.gPos[k]) % gs) / sr;
        rep[n * 4 + 1] = this.gRate[k];
        rep[n * 4 + 2] = this.gAge[k] / this.gLen[k];
        rep[n * 4 + 3] = this.gLen[k] / sr;
        n++;
      }
    }
    const m = {
      speed: this.mCount ? 1 + this.mDev / this.mCount : 1,
      peakIn: this.mIn, peakOut: this.mOut, peakTape: this.mTape,
      dropL: this.mDropL, dropR: this.mDropR, gr: this.mGR,
      frozen: this.target.freeze > 0.5,
      grains: n ? this.gRep.slice(0, n * 4) : null,
      wave: this.wvN ? this.wvBuf.slice(0, this.wvN * 2) : null,
      rev: this.mRev.slice(), outBands: this.mOB.slice(),
    };
    this.wvN = 0; this.mRev.fill(0); this.mOB.fill(0);
    this.mDev = 0; this.mCount = 0; this.mIn = 0; this.mOut = 0; this.mDropL = 1; this.mDropR = 1;
    this.mTape = 0; this.mGR = 1;
    return m;
  }

  _read(buf, pos) {            // 4-point cubic Hermite
    const i = Math.floor(pos), f = pos - i, m = this.mask;
    const xm1 = buf[(i - 1) & m], x0 = buf[i & m], x1 = buf[(i + 1) & m], x2 = buf[(i + 2) & m];
    const c = (x1 - xm1) * 0.5, v = x0 - x1, w = c + v, a = w + v + (x2 - x0) * 0.5, b = w + a;
    return ((a * f - b) * f + c) * f + x0;
  }

  _read2(buf, pos) {           // the same read, on the HQ engine's 2× tape
    const i = Math.floor(pos), f = pos - i, m = this.mask2;
    const xm1 = buf[(i - 1) & m], x0 = buf[i & m], x1 = buf[(i + 1) & m], x2 = buf[(i + 2) & m];
    const c = (x1 - xm1) * 0.5, v = x0 - x1, w = c + v, a = w + v + (x2 - x0) * 0.5, b = w + a;
    return ((a * f - b) * f + c) * f + x0;
  }

  /** HQ record head. One driven sample in; out come the two samples that go on the 2× tape (t0, then t1).
   *  The sample is raised to 4×, saturated there, brought back to 2× and band-limited to the audio range. */
  _record2(os, u, bias, tb) {
    const A = os[0], B = os[1];
    A.up(u);
    const second = A.b;
    B.up(A.a); B.push(Math.tanh(B.a + bias) - tb); let d = B.out(); B.push(Math.tanh(B.b + bias) - tb);
    A.push(d); this.t0 = A.out();
    B.up(second); B.push(Math.tanh(B.a + bias) - tb); d = B.out(); B.push(Math.tanh(B.b + bias) - tb);
    A.push(d); this.t1 = A.out();
  }

  /** HQ: write the grain tape's band-limited copies at index i (each copy is the one before, filtered again).
   *  With `r` the sample is folded in by that much instead of replacing what is there (the frozen tape). */
  _mipWrite(i, l, r, fold) {
    for (let k = 0; k < MIPS.length; k++) {
      l = this.mipFL[k].run(l); r = this.mipFR[k].run(r);
      if (fold) { this.mipL[k][i] += fold * (l - this.mipL[k][i]); this.mipR[k][i] += fold * (r - this.mipR[k][i]); }
      else { this.mipL[k][i] = l; this.mipR[k][i] = r; }
    }
  }

  _startDropout(ch, len, depth) {
    if (ch.dLen > 0) return;
    ch.dLen = len; ch.dPos = 0; ch.dDepth = depth;
  }

  _spawnGrain(frozen) {
    const P = this.target, rng = this.rng, sr = this.sr, N = this.gN;
    const spray = P.gSpray, dr = P.gDrift, sc = P.gScatter;

    // when: Density sets the rate, Spray loosens the timing from a steady pulse towards random
    const dens = P.gDensity * Math.pow(2, dr * this.wDens.b);
    let u = rng.next(); if (u > 0.98) u = 0.98;
    const jitter = spray + 0.15 > 1 ? 1 : spray + 0.15;
    this.gNext = sr / dens * (1 + jitter * (-Math.log(1 - u) - 1));

    let k = -1;
    for (let i = 0; i < MAX_GRAINS; i++) if (!this.gActive[i]) { k = i; break; }
    if (k < 0) return;

    // pitch: the knob, sometimes a jump from the Scatter set, a little detune, and a slow drift
    let st = P.gPitch;
    if (sc > 0 && rng.next() < sc) st += SCATTER[(rng.next() * (1 + sc * (SCATTER.length - 1))) | 0];
    st += 0.15 * sc * rng.bi() + 0.25 * dr * this.wPitch.b;
    while (st > 36) st -= 12;
    while (st < -36) st += 12;
    const rate = Math.pow(2, st / 12);

    let len = P.gSize * sr * Math.pow(2, dr * this.wSize.b) * (1 + 0.3 * spray * rng.bi());
    if (len * rate > N * 0.45) len = N * 0.45 / rate;
    if (len < 48) len = 48;
    len = len | 0;
    const rev = rng.next() < P.gReverse;

    // where: Position, slid by Scan, wandered by Drift, scattered back in time by Spray
    let base = P.gPos - this.gScanPh;
    if (base < 0) base += GRAIN_LOOP; else if (base >= GRAIN_LOOP) base -= GRAIN_LOOP;
    let off = (base + dr * (0.5 + 0.5 * this.wPos.b) + spray * spray * 2 * rng.next()) * sr;
    // keep the grain between the record head and the end of the tape for its whole life
    const lead = rev ? 0 : frozen ? len * rate : rate > 1 ? len * (rate - 1) : 0;
    const reach = rev ? len * rate + (frozen ? 0 : len) : !frozen && rate < 1 ? len * (1 - rate) : 0;
    if (off < 8 + lead) off = 8 + lead;
    if (off > N - 16 - reach) off = N - 16 - reach;
    let pos = this.gw - off; if (pos < 0) pos += N;

    // HQ: a grain played well above normal speed reads a band-limited copy, so its top end cannot alias
    this.gLv[k] = this.hq && rate >= 1.6 && off + len * rate + 64 < this.mipValid ? (rate >= 3.5 ? 3 : rate >= 2.5 ? 2 : 1) : 0;
    this.gPos[k] = pos; this.gRate[k] = rev ? -rate : rate;
    this.gLen[k] = len; this.gInv[k] = 1 / len; this.gAge[k] = 0;
    // Shape: where the grain peaks. 0 = hit and decay, half = bell, 1 = swell
    let pk = 0.04 + 0.92 * P.gShape + 0.15 * dr * rng.bi();
    this.gPk[k] = pk < 0.03 ? 0.03 : pk > 0.97 ? 0.97 : pk;
    this.gAmp[k] = 1 - 0.5 * dr * rng.next();
    const ang = ((0.25 + 0.7 * spray) * rng.bi() + 1) * Math.PI / 4;
    this.gPanL[k] = Math.SQRT2 * Math.cos(ang); this.gPanR[k] = Math.SQRT2 * Math.sin(ang);
    this.gActive[k] = 1; this.gAny = true;
  }

  process(inL, inR, outL, outR, n) {
    const sr = this.sr, P = this.target, S = this.s, rng = this.rng;
    const L = this.L, R = this.R, bufL = this.bufL, bufR = this.bufR, size = this.size, mask = this.mask;

    // ── block rate: smooth the knobs, derive coefficients ──────────────────────────────────────
    const kb = this.primed ? 1 - Math.exp(-n / (0.03 * sr)) : 1;   // first block: jump to the knobs
    for (let i = 0; i < this.ids.length; i++) {
      const id = this.ids[i], sw = this.swOf[id];
      S[id] += kb * ((sw !== undefined && P[sw] < 0.5 ? this.offOf[id] : P[id]) - S[id]);
    }

    const drive = S.drive;
    const tgD = 1 + drive * drive * 15;              // up to +24 dB into the tape
    const tgMk = 1 / Math.pow(tgD, 0.7);             // make-up, keeps loudness roughly level
    const emph = 0.9 * drive, de = emph / (1 + emph);
    const bias = 0.18 * drive, tb = Math.tanh(bias); // asymmetry → even harmonics

    // Depths are set as pitch deviation, then turned into delay swing, so Rate does not change depth.
    const wowHz = S.wowRate;
    const wInc = TWO_PI * wowHz / sr;
    const tgW = 0.04 * S.wow * S.wow / (TWO_PI * wowHz * 1.5) * sr;          // up to ±4 % (~70 cents)
    const tgF = 0.012 * S.flutter * S.flutter / (TWO_PI * 6.3 * 1.6) * sr;   // up to ±1.2 %
    const wob = S.wobble;
    const tgDr = wob * wob * 0.005 * sr;
    const wobJ = 0.6 * wob;
    const f1Inc = TWO_PI * 6.3 / sr, f2Inc = TWO_PI * 11.7 / sr;
    const sp = S.spread;

    const fcLP = Math.min(20000 * Math.pow(0.07, S.loss), 0.45 * sr);        // 20 kHz → 1.4 kHz
    const aLP = 1 - Math.exp(-TWO_PI * fcLP / sr);
    const aHP = 1 - Math.exp(-TWO_PI * (20 + 230 * S.loss * S.loss) / sr);   // 20 Hz → 250 Hz
    const bump = 0.25 + 0.9 * S.loss;

    const dr = S.dropouts;
    const dropRate = dr > 0.005 ? 0.15 + 5 * dr * dr : 0;                    // events per second
    const crinkle = 0.3 * dr * dr;
    const pSingle = 0.15 + 0.5 * sp;                                         // one-channel dropouts

    const tgH = S.hiss * S.hiss * 0.03;
    const tgMix = S.mix, tgOut = Math.pow(10, S.output / 20);
    const tgByp = P.bypass > 0.5 ? 1 : 0;
    const stopOn = P.stop > 0.5;
    const stopDec = 1 / (0.8 * sr), startInc = 1 / (0.25 * sr), xfInc = 1 / (0.04 * sr);
    const dropHeld = P.drop > 0.5 ? 0.93 : 0, kDropA = this.kDropA, kDropR = this.kDropR;

    // grains
    const tgG = S.grains, frozen = P.freeze > 0.5;
    const grainsOn = tgG > 0.0005 || this.gAmt > 0.0005;
    if (!grainsOn && this.gAny) { this.gActive.fill(0); this.gAny = false; this.gNext = 0; this.gfL = this.gfR = 0; }
    let live = 0;
    for (let k = 0; k < MAX_GRAINS; k++) live += this.gActive[k];
    this.gCount += 0.3 * (live - this.gCount);
    const tgNorm = 1 / Math.sqrt(this.gCount > 2 ? this.gCount - 1 : 1);     // grains add in power
    const fb = grainsOn && P.onGrain > 0.5 ? S.gFeedback : 0;
    const aFb = 1 - Math.exp(-TWO_PI * (70 + 230 * fb * fb) / sr);          // feedback is high-passed so lows cannot pile up
    // grain Tone: right of centre cuts lows (30 Hz → 1.2 kHz), left of centre cuts highs (18 kHz → 800 Hz)
    const gt = S.gTone, GT = this.GT;
    const aGH = 1 - Math.exp(-TWO_PI * 30 * Math.pow(40, gt > 0 ? gt : 0) / sr);
    const aGL = 1 - Math.exp(-TWO_PI * Math.min(18000 * Math.pow(800 / 18000, gt < 0 ? -gt : 0), 0.45 * sr) / sr);
    const scan = Math.abs(P.gScan) < 0.005 ? 0 : P.gScan;
    if (scan === 0) this.gScanPh = 0;
    const scanInc = scan / sr, loopN = Math.round(GRAIN_LOOP * sr);
    const gbufL = this.gbufL, gbufR = this.gbufR, gN = this.gN, rise = this.rise;
    const gActive = this.gActive, gPos = this.gPos, gRate = this.gRate, gAge = this.gAge, gLen = this.gLen;
    const gInv = this.gInv, gPk = this.gPk, gAmp = this.gAmp, gPanL = this.gPanL, gPanR = this.gPanR;

    // space
    const tgSp = S.space;
    const spaceOn = tgSp > 0.0005 || this.gSp > 0.0005;
    const rv = this.rv;
    if (!spaceOn && rv.live) {                    // switched off: empty it, so it cannot spill out later
      for (const d of rv.ap) d.b.fill(0);
      for (const key of ['a1', 'a2', 'd1', 'b1', 'b2', 'd2']) rv[key].b.fill(0);
      rv.lpA = rv.lpB = 0; rv.live = false;
    }
    const krt = 0.35 + 0.63 * S.sDecay;
    const klp = 1 - Math.pow(1 - (0.35 + 0.63 * S.sTone), 32000 / sr);
    const aRvH = 1 - Math.exp(-TWO_PI * 60 / sr);                            // keep rumble out of the reverb
    const OB = this.OB, mOB = this.mOB;
    const mRev = this.mRev, RB = this.RB, aR0 = this.aRB[0], aR1 = this.aRB[1], aR2 = this.aRB[2], aR3 = this.aRB[3];
    const bLow = S.sLow, bMid = S.sMid, bMidHi = S.sMidHi, bHigh = S.sHigh, bAir = S.sAir;
    const rvTap = this.rvTap, rvMod = this.rvMod, rvInc = this.rvInc;

    // master
    const aLC = 1 - Math.exp(-TWO_PI * S.lowCut / sr);
    const tgHi = Math.pow(10, S.tone * 6 / 20);                              // ±6 dB tilt around 900 Hz
    const tgWd = S.width;
    const glue = S.glue, glueOn = glue > 0.002;
    const cThr = Math.pow(10, (-4 - 20 * glue) / 20);
    const cRatio = 1 + 3 * glue, cSlope = 1 / cRatio - 1;
    const cMakeup = Math.pow(10, (4 + 20 * glue) * (1 - 1 / cRatio) * 0.6 / 20);
    const limitOn = P.limit > 0.5 && P.onMaster > 0.5;
    const ML = this.ML, MR = this.MR, aTilt = this.aTilt, kCA = this.kCA, kCR = this.kCR, kLR = this.kLR;

    if (!this.primed) {
      this.primed = true;
      this.gD = tgD; this.gMk = tgMk; this.gH = tgH; this.gMix = tgMix; this.gOut = tgOut; this.gByp = tgByp;
      this.aW = tgW; this.aF = tgF; this.aD = tgDr;
      this.gAmt = tgG; this.gHi = tgHi; this.gWd = tgWd;
    }

    const hq = P.hq > 0.5;
    if (hq !== this.hq) {            // changing engine: start the one coming in from an empty tape
      this.hq = hq;
      if (hq) { this.buf2L.fill(0); this.buf2R.fill(0); } else { bufL.fill(0); bufR.fill(0); }
      for (const st of this.osL) st.reset();
      for (const st of this.osR) st.reset();
      this.dryL.fill(0); this.dryR.fill(0);
      for (const f of this.mipFL) f.reset();
      for (const f of this.mipFR) f.reset();
      this.mipValid = 0; L.e2 = R.e2 = 0;
    }
    const buf2L = this.buf2L, buf2R = this.buf2R, dryL = this.dryL, dryR = this.dryR, mipL = this.mipL, mipR = this.mipR, gLv = this.gLv;

    const kF = this.kFast, kS = this.kSlow, aE = this.aE, aN = this.aN, nGain = this.nGain;
    let w = this.w;

    for (let i = 0; i < n; i++) {
      const xl = inL[i], xr = inR[i];

      this.gD += kF * (tgD - this.gD);   this.gMk += kF * (tgMk - this.gMk);
      this.gH += kF * (tgH - this.gH);   this.gMix += kF * (tgMix - this.gMix);
      this.gOut += kF * (tgOut - this.gOut); this.gByp += kF * (tgByp - this.gByp);
      this.aW += kS * (tgW - this.aW);   this.aF += kS * (tgF - this.aF);  this.aD += kS * (tgDr - this.aD);
      const gD = this.gD, gMk = this.gMk;

      // ── record head: saturate, write to tape ─────────────────────────────────────────────────
      L.e1 += aE * (xl - L.e1);
      R.e1 += aE * (xr - R.e1);
      if (hq) {                      // saturate at 4×, write the 2× tape; the de-emphasis moves to the playback side
        this._record2(this.osL, (xl + emph * (xl - L.e1)) * gD, bias, tb);
        buf2L[2 * w] = this.t0 * gMk; buf2L[2 * w + 1] = this.t1 * gMk;
        this._record2(this.osR, (xr + emph * (xr - R.e1)) * gD, bias, tb);
        buf2R[2 * w] = this.t0 * gMk; buf2R[2 * w + 1] = this.t1 * gMk;
      } else {
        let y = (Math.tanh((xl + emph * (xl - L.e1)) * gD + bias) - tb) * gMk;
        L.e2 += aE * (y - L.e2);
        bufL[w] = y - de * (y - L.e2);
        y = (Math.tanh((xr + emph * (xr - R.e1)) * gD + bias) - tb) * gMk;
        R.e2 += aE * (y - R.e2);
        bufR[w] = y - de * (y - R.e2);
      }

      // ── transport: how far behind the record head are we reading? ────────────────────────────
      const j = this.jit.tick();
      this.wowPh += wInc * (1 + wobJ * j);
      if (this.wowPh > TWO_PI) this.wowPh -= TWO_PI;
      this.f1Ph += f1Inc * (1 + 0.3 * wobJ * j); if (this.f1Ph > TWO_PI) this.f1Ph -= TWO_PI;
      this.f2Ph += f2Inc;                        if (this.f2Ph > TWO_PI) this.f2Ph -= TWO_PI;
      const wp = this.wowPh, p1 = this.f1Ph, p2 = this.f2Ph;

      L.n1 += aN * (rng.bi() - L.n1); L.n2 += aN * (L.n1 - L.n2);
      R.n1 += aN * (rng.bi() - R.n1); R.n2 += aN * (R.n1 - R.n2);
      let nzL = L.n2 * nGain; if (nzL > 1.5) nzL = 1.5; else if (nzL < -1.5) nzL = -1.5;
      let nzR = R.n2 * nGain; if (nzR > 1.5) nzR = 1.5; else if (nzR < -1.5) nzR = -1.5;
      nzR = nzL + sp * (nzR - nzL);

      const dA = this.driftA.tick(), dB = this.driftB.tick();
      // a snag: the tape catches for a moment, pitch dips and springs back
      if (this.driftA.fired && this.snagLen === 0 && rng.next() < wob * 0.2) {
        this.snagLen = ((0.15 + 0.3 * rng.next()) * sr) | 0;
        this.snagAmp = (0.002 + 0.008 * rng.next()) * sr * wob;
        this.snagPos = 0;
      }
      let snag = 0;
      if (this.snagLen > 0) {
        snag = this.snagAmp * 0.5 * (1 - Math.cos(TWO_PI * this.snagPos / this.snagLen));
        if (++this.snagPos >= this.snagLen) this.snagLen = 0;
      }

      const aW = this.aW, aF = this.aF, aD = this.aD;
      const dl = MIN_DELAY + snag
        + aW * (1.25 + Math.sin(wp) + 0.25 * Math.sin(2 * wp + 1.3))
        + aF * (1.4 + 0.6 * Math.sin(p1) + 0.25 * Math.sin(p2) + 0.35 * nzL)
        + aD * (1 + dA);
      const wr = wp + sp, drR = dA + 0.7 * sp * (dB - dA);
      const dlR = MIN_DELAY + snag
        + aW * (1.25 + Math.sin(wr) + 0.25 * Math.sin(2 * wr + 1.3))
        + aF * (1.4 + 0.6 * Math.sin(p1 + 2 * sp) + 0.25 * Math.sin(p2 + 3 * sp) + 0.35 * nzR)
        + aD * (1 + drR);

      // tape stop: the motor winds down, the read head falls behind; on release it spins up, then
      // a short crossfade drops the lag so the effect is live again.
      if (stopOn) { if (this.speed > 0) { this.speed -= stopDec; if (this.speed < 0) this.speed = 0; } }
      else if (this.speed < 1) { this.speed += startInc; if (this.speed > 1) this.speed = 1; }
      const speed = this.speed;
      if (speed < 1) {
        this.sd += 1 - speed; if (this.sd > this.sdMax) this.sd = this.sdMax;
        if (this.xfading) { this.sdOld += 1 - speed; if (this.sdOld > this.sdMax) this.sdOld = this.sdMax; }
      } else if (this.sd > 0 && !this.xfading) {
        this.sdOld = this.sd; this.sd = 0; this.xf = 0; this.xfading = true;
      }
      const sg = speed >= 0.25 ? 1 : (speed * 4) * (speed * 4);

      const base = w + size;
      let yl, yr;
      if (hq) {
        yl = this._read2(buf2L, 2 * (base - dl - this.sd));
        yr = this._read2(buf2R, 2 * (base - dlR - this.sd));
        if (this.xfading) {
          const ol = this._read2(buf2L, 2 * (base - dl - this.sdOld));
          const or = this._read2(buf2R, 2 * (base - dlR - this.sdOld));
          yl = ol + (yl - ol) * this.xf; yr = or + (yr - or) * this.xf;
          this.xf += xfInc; if (this.xf >= 1) this.xfading = false;
        }
        L.e2 += aE * (yl - L.e2); yl -= de * (yl - L.e2);
        R.e2 += aE * (yr - R.e2); yr -= de * (yr - R.e2);
      } else {
        yl = this._read(bufL, base - dl - this.sd);
        yr = this._read(bufR, base - dlR - this.sd);
        if (this.xfading) {
          const ol = this._read(bufL, base - dl - this.sdOld);
          const or = this._read(bufR, base - dlR - this.sdOld);
          yl = ol + (yl - ol) * this.xf; yr = or + (yr - or) * this.xf;
          this.xf += xfInc; if (this.xf >= 1) this.xfading = false;
        }
      }
      if (L.prevDelay >= 0) { this.mDev += (L.prevDelay - dl) + (speed - 1); this.mCount++; }
      L.prevDelay = dl;

      // ── grains ───────────────────────────────────────────────────────────────────────────────
      // The grain tape records what comes off the transport, BEFORE the playback head's loss and hiss,
      // so grains are cut from clear audio and the tape character is laid over the cloud afterwards.
      if (!frozen) {
        let wl = yl, wr = yr;
        if (fb > 0.001) {       // Feedback: the cloud itself, high-passed and soft-limited, goes back on the tape
          this.ghL += aFb * (this.gfL - this.ghL); this.ghR += aFb * (this.gfR - this.ghR);
          wl += fb * (softLimit(1.4 * fb * (this.gfL - this.ghL) + wl) - wl);
          wr += fb * (softLimit(1.4 * fb * (this.gfR - this.ghR) + wr) - wr);
        }
        gbufL[this.gw] = wl; gbufR[this.gw] = wr;
        if (hq) { this._mipWrite(this.gw, wl, wr, 0); if (this.mipValid < gN) this.mipValid++; }
        if (++this.gw >= gN) this.gw = 0;
        if (wl < this.wvMin) this.wvMin = wl; else if (wl > this.wvMax) this.wvMax = wl;
        if (++this.wvCnt >= 128) {
          if (this.wvN < 64) { this.wvBuf[this.wvN * 2] = this.wvMin; this.wvBuf[this.wvN * 2 + 1] = this.wvMax; this.wvN++; }
          this.wvMin = 0; this.wvMax = 0; this.wvCnt = 0;
        }
      } else if (fb > 0.001) {
        // Frozen: nothing new is recorded, but the cloud is slowly folded back into the held tape,
        // so a capture keeps turning into something else instead of looping unchanged.
        let idx = this.gw - loopN + this.gMorph; if (idx < 0) idx += gN;
        const r = fb * 0.5;
        gbufL[idx] += r * (softLimit(this.gfL) - gbufL[idx]);
        gbufR[idx] += r * (softLimit(this.gfR) - gbufR[idx]);
        if (hq) this._mipWrite(idx, softLimit(this.gfL), softLimit(this.gfR), r);
        if (++this.gMorph >= loopN) this.gMorph = 0;
      }
      this.gAmt += kF * (tgG - this.gAmt);
      if (grainsOn) {
        this.wPos.tick(); this.wSize.tick(); this.wPitch.tick(); this.wDens.tick();
        if (scanInc !== 0) {
          this.gScanPh += scanInc;
          if (this.gScanPh >= GRAIN_LOOP) this.gScanPh -= GRAIN_LOOP; else if (this.gScanPh < 0) this.gScanPh += GRAIN_LOOP;
        }
        if (--this.gNext <= 0) this._spawnGrain(frozen);
        let cL = 0, cR = 0;
        for (let k = 0; k < MAX_GRAINS; k++) {
          if (!gActive[k]) continue;
          const gx = gAge[k] * gInv[k], pk = gPk[k];
          const ep = gx < pk ? gx / pk * 512 : (1 - gx) / (1 - pk) * 512, e0 = ep | 0;
          const env = (hq ? rise[e0] + (ep - e0) * (rise[e0 + 1] - rise[e0]) : rise[e0]) * gAmp[k];   // HQ reads between the table's entries
          const lv = gLv[k], tL = lv ? mipL[lv - 1] : gbufL, tR = lv ? mipR[lv - 1] : gbufR;
          let pos = gPos[k];
          const i0 = pos | 0, fr = pos - i0;
          let im = i0 - 1; if (im < 0) im += gN;
          let i1 = i0 + 1; if (i1 >= gN) i1 -= gN;
          let i2 = i1 + 1; if (i2 >= gN) i2 -= gN;
          // cubic read: keeps the top end when a grain is pitched, where a straight-line read dulls it
          let xm = tL[im], x0 = tL[i0], x1 = tL[i1], x2 = tL[i2];
          let hc = (x1 - xm) * 0.5, hv = x0 - x1, hw = hc + hv, ha = hw + hv + (x2 - x0) * 0.5;
          cL += (((ha * fr - (hw + ha)) * fr + hc) * fr + x0) * env * gPanL[k];
          xm = tR[im]; x0 = tR[i0]; x1 = tR[i1]; x2 = tR[i2];
          hc = (x1 - xm) * 0.5; hv = x0 - x1; hw = hc + hv; ha = hw + hv + (x2 - x0) * 0.5;
          cR += (((ha * fr - (hw + ha)) * fr + hc) * fr + x0) * env * gPanR[k];
          pos += gRate[k];
          if (pos >= gN) pos -= gN; else if (pos < 0) pos += gN;
          gPos[k] = pos;
          if (++gAge[k] >= gLen[k]) gActive[k] = 0;
        }
        this.gNorm += kF * (tgNorm - this.gNorm);
        cL *= this.gNorm; cR *= this.gNorm;
        // Tone: clear the low end out of the cloud (or darken it), two poles each way
        GT.hl1 += aGH * (cL - GT.hl1); cL -= GT.hl1; GT.hl2 += aGH * (cL - GT.hl2); cL -= GT.hl2;
        GT.hr1 += aGH * (cR - GT.hr1); cR -= GT.hr1; GT.hr2 += aGH * (cR - GT.hr2); cR -= GT.hr2;
        GT.ll1 += aGL * (cL - GT.ll1); GT.ll2 += aGL * (GT.ll1 - GT.ll2); cL = GT.ll2;
        GT.lr1 += aGL * (cR - GT.lr1); GT.lr2 += aGL * (GT.lr1 - GT.lr2); cR = GT.lr2;
        this.gfL = cL; this.gfR = cR;
        const ga = this.gAmt;
        yl += ga * (cL - yl); yr += ga * (cR - yr);
      }

      // ── dropouts: the tape lifts off the head, level and treble fall together ────────────────
      if (--this.dropCount <= 0) {
        if (dropRate > 0) {
          const u = rng.next(), v = rng.next();
          let depth = (0.3 + 0.7 * u * u) * (0.35 + 0.65 * dr); if (depth > 0.97) depth = 0.97;
          const len = ((0.025 + 0.3 * v * v) * sr) | 0;
          if (rng.next() < pSingle) this._startDropout(rng.next() < 0.5 ? L : R, len, depth);
          else { this._startDropout(L, len, depth); this._startDropout(R, len, depth); }
          this.dropCount = -Math.log(1 - rng.next()) / dropRate * sr;
        } else this.dropCount = sr * 0.1;
      }
      let envL = 0, envR = 0;
      if (L.dLen > 0) {
        envL = L.dDepth * 0.5 * (1 - Math.cos(TWO_PI * L.dPos / L.dLen));
        if (++L.dPos >= L.dLen) L.dLen = 0;
      }
      if (R.dLen > 0) {
        envR = R.dDepth * 0.5 * (1 - Math.cos(TWO_PI * R.dPos / R.dLen));
        if (++R.dPos >= R.dLen) R.dLen = 0;
      }
      // a held dropout (the Drop pad): the tape is pulled off the head until release
      this.fd += (dropHeld > this.fd ? kDropA : kDropR) * (dropHeld - this.fd);
      if (this.fd > 0.001) { envL = 1 - (1 - envL) * (1 - this.fd); envR = 1 - (1 - envR) * (1 - this.fd); }
      const cl = nzL > 1 ? 1 : nzL < -1 ? -1 : nzL, cr = nzR > 1 ? 1 : nzR < -1 ? -1 : nzR;
      const dgL = (1 - envL) * (1 - crinkle * (0.5 + 0.5 * cl));
      const dgR = (1 - envR) * (1 - crinkle * (0.5 + 0.5 * cr));
      if (dgL < this.mDropL) this.mDropL = dgL;
      if (dgR < this.mDropR) this.mDropR = dgR;

      // ── playback head: loss, low cut, head bump, hiss ────────────────────────────────────────
      let a = aLP * (1 - 0.85 * envL);
      L.lp1 += a * (yl * dgL - L.lp1); L.lp2 += a * (L.lp1 - L.lp2);
      yl = L.lp2;
      L.b1 += this.aB1 * (yl - L.b1); L.b2 += this.aB2 * (yl - L.b2);
      yl += bump * (L.b1 - L.b2);
      L.hp += aHP * (yl - L.hp); yl -= L.hp;

      a = aLP * (1 - 0.85 * envR);
      R.lp1 += a * (yr * dgR - R.lp1); R.lp2 += a * (R.lp1 - R.lp2);
      yr = R.lp2;
      R.b1 += this.aB1 * (yr - R.b1); R.b2 += this.aB2 * (yr - R.b2);
      yr += bump * (R.b1 - R.b2);
      R.hp += aHP * (yr - R.hp); yr -= R.hp;

      const hs = this.gH * (0.3 + 0.7 * sg);
      let wn = rng.bi();
      L.h1 += this.aH1 * (wn - L.h1); L.h2 += this.aH2 * (wn - 0.75 * L.h1 - L.h2);
      let wetL = yl * sg + L.h2 * hs * dgL;
      wn = rng.bi();
      R.h1 += this.aH1 * (wn - R.h1); R.h2 += this.aH2 * (wn - 0.75 * R.h1 - R.h2);
      let wetR = yr * sg + R.h2 * hs * dgR;
      const at = wetL < 0 ? -wetL : wetL;
      if (at > this.mTape) this.mTape = at;

      // ── space ────────────────────────────────────────────────────────────────────────────────
      this.gSp += kF * (tgSp - this.gSp);
      if (spaceOn) {
        rv.live = true;
        let x = (wetL + wetR) * 0.2, d, t, v;
        this.rvH += aRvH * (x - this.rvH); x -= this.rvH;
        for (let q = 0; q < 4; q++) {                       // four diffusers smear the input
          d = rv.ap[q]; t = d.b[d.i]; v = x + KAP * t; d.b[d.i] = v; if (++d.i >= d.n) d.i = 0; x = t - KAP * v;
        }
        // loop A feeds the left, loop B the right; each is fed by the other's delay
        rv.ph += rvInc; if (rv.ph > TWO_PI) rv.ph -= TWO_PI;
        const d2 = rv.d2;
        let rp = d2.i - (rvTap + rvMod * Math.sin(rv.ph)); if (rp < 0) rp += d2.n;
        const r0 = rp | 0, r1 = r0 + 1 >= d2.n ? 0 : r0 + 1;
        let a = x + krt * (d2.b[r0] + (rp - r0) * (d2.b[r1] - d2.b[r0]));
        rv.lpA += klp * (a - rv.lpA); a = rv.lpA;
        d = rv.a1; t = d.b[d.i]; v = a - KAP * t; d.b[d.i] = v; if (++d.i >= d.n) d.i = 0; a = t + KAP * v;
        d = rv.a2; t = d.b[d.i]; v = a + KAP * t; d.b[d.i] = v; if (++d.i >= d.n) d.i = 0; a = t - KAP * v;
        d = rv.d1; const d1tail = d.b[d.i]; d.b[d.i] = a; if (++d.i >= d.n) d.i = 0;
        let b = x + krt * d1tail;
        rv.lpB += klp * (b - rv.lpB); b = rv.lpB;
        d = rv.b1; t = d.b[d.i]; v = b + KAP * t; d.b[d.i] = v; if (++d.i >= d.n) d.i = 0; b = t - KAP * v;
        d = rv.b2; t = d.b[d.i]; v = b - KAP * t; d.b[d.i] = v; if (++d.i >= d.n) d.i = 0; b = t + KAP * v;
        d2.b[d2.i] = b; if (++d2.i >= d2.n) d2.i = 0;
        const sp = this.gSp;
        // split each side of the reverb into five ranges and set each one's level
        a *= 2; b *= 2;
        RB[0] += aR0 * (a - RB[0]); RB[1] += aR1 * (a - RB[1]); RB[2] += aR2 * (a - RB[2]); RB[3] += aR3 * (a - RB[3]);
        const q0 = bLow * RB[0], q1 = bMid * (RB[1] - RB[0]), q2 = bMidHi * (RB[2] - RB[1]), q3 = bHigh * (RB[3] - RB[2]), q4 = bAir * (a - RB[3]);
        a = q0 + q1 + q2 + q3 + q4;
        // meter: how much reverb each range is putting out (left side), after its knob and the Space amount
        let mv = (q0 < 0 ? -q0 : q0) * sp; if (mv > mRev[0]) mRev[0] = mv;
        mv = (q1 < 0 ? -q1 : q1) * sp; if (mv > mRev[1]) mRev[1] = mv;
        mv = (q2 < 0 ? -q2 : q2) * sp; if (mv > mRev[2]) mRev[2] = mv;
        mv = (q3 < 0 ? -q3 : q3) * sp; if (mv > mRev[3]) mRev[3] = mv;
        mv = (q4 < 0 ? -q4 : q4) * sp; if (mv > mRev[4]) mRev[4] = mv;
        RB[4] += aR0 * (b - RB[4]); RB[5] += aR1 * (b - RB[5]); RB[6] += aR2 * (b - RB[6]); RB[7] += aR3 * (b - RB[7]);
        b = bLow * RB[4] + bMid * (RB[5] - RB[4]) + bMidHi * (RB[6] - RB[5]) + bHigh * (RB[7] - RB[6]) + bAir * (b - RB[7]);
        wetL = wetL * (1 - 0.45 * sp) + a * sp; wetR = wetR * (1 - 0.45 * sp) + b * sp;
      }

      // ── mix, then master: low cut → tone tilt → width → glue → output → limiter ───────────────
      const mix = this.gMix;
      let dxl = xl, dxr = xr;
      if (hq) {                      // the dry signal waits as long as the wet one took, so the two mix without combing
        const di = this.dryI;
        dryL[di] = xl; dryR[di] = xr;
        dxl = dryL[(di - HQ_DRY) & 63]; dxr = dryR[(di - HQ_DRY) & 63];
        this.dryI = (di + 1) & 63;
      }
      let ol = dxl + mix * (wetL - dxl), or = dxr + mix * (wetR - dxr);

      ML.h1 += aLC * (ol - ML.h1); ol -= ML.h1; ML.h2 += aLC * (ol - ML.h2); ol -= ML.h2;
      MR.h1 += aLC * (or - MR.h1); or -= MR.h1; MR.h2 += aLC * (or - MR.h2); or -= MR.h2;

      this.gHi += kF * (tgHi - this.gHi); this.gWd += kF * (tgWd - this.gWd);
      const gHi = this.gHi, gLo = 1 / gHi;
      ML.t += aTilt * (ol - ML.t); ol = ML.t * gLo + (ol - ML.t) * gHi;
      MR.t += aTilt * (or - MR.t); or = MR.t * gLo + (or - MR.t) * gHi;

      const mid = (ol + or) * 0.5, side = (ol - or) * 0.5 * this.gWd;
      ol = mid + side; or = mid - side;

      let red = 1;
      if (glueOn) {
        const al = ol < 0 ? -ol : ol, ar = or < 0 ? -or : or, pk = al > ar ? al : ar;
        this.cEnv += (pk > this.cEnv ? kCA : kCR) * (pk - this.cEnv);
        if (this.cEnv > cThr) red = Math.pow(this.cEnv / cThr, cSlope);
        ol *= red * cMakeup; or *= red * cMakeup;
      }

      const og = this.gOut;
      ol *= og; or *= og;

      if (limitOn) {                 // instant attack, 80 ms release: the output never passes the ceiling
        const al = ol < 0 ? -ol : ol, ar = or < 0 ? -or : or, pk = al > ar ? al : ar;
        this.lg += kLR * (1 - this.lg);
        if (pk * this.lg > CEILING) this.lg = CEILING / pk;
        ol *= this.lg; or *= this.lg; red *= this.lg;
      }
      if (red < this.mGR) this.mGR = red;

      const byp = this.gByp;
      ol += byp * (xl - ol); or += byp * (xr - or);
      outL[i] = ol; outR[i] = or;

      // meter: the output in five ranges (left side), for the display on the master section
      OB[0] += aR0 * (ol - OB[0]); OB[1] += aR1 * (ol - OB[1]); OB[2] += aR2 * (ol - OB[2]); OB[3] += aR3 * (ol - OB[3]);
      let ov = OB[0]; if (ov < 0) ov = -ov; if (ov > mOB[0]) mOB[0] = ov;
      ov = OB[1] - OB[0]; if (ov < 0) ov = -ov; if (ov > mOB[1]) mOB[1] = ov;
      ov = OB[2] - OB[1]; if (ov < 0) ov = -ov; if (ov > mOB[2]) mOB[2] = ov;
      ov = OB[3] - OB[2]; if (ov < 0) ov = -ov; if (ov > mOB[3]) mOB[3] = ov;
      ov = ol - OB[3]; if (ov < 0) ov = -ov; if (ov > mOB[4]) mOB[4] = ov;

      const ai = xl < 0 ? -xl : xl, ao = ol < 0 ? -ol : ol;
      if (ai > this.mIn) this.mIn = ai;
      if (ao > this.mOut) this.mOut = ao;

      w = (w + 1) & mask;
    }
    this.w = w;
  }
}

// ── 1. AudioWorklet ──────────────────────────────────────────────────────────────────────────────
if (typeof registerProcessor === 'function') {
  class TapeProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return PARAM_DEFS.map(d => ({
        name: d.id, defaultValue: d.def, minValue: d.min, maxValue: d.max, automationRate: 'k-rate',
      }));
    }
    constructor() {
      super();
      this.core = new TapeCore(sampleRate);
      this.silence = new Float32Array(128);
      this.scratch = new Float32Array(128);
      this.blocks = 0;
      // how hard the engine is working: time spent in process() against the time of audio it made
      this.clock = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();
      this.busy = 0; this.made = 0; this.load = 0;
      // recorder: copies the input ('in') or the finished output ('out') and posts it to the page in chunks.
      // With `wait` (a level, 0..1) it holds off until the sound first passes that level, then starts with
      // the 30 ms before it, so the attack is whole, and tells the page with { recStarted }.
      this.rec = null;
      this.port.onmessage = e => {
        const m = e.data;
        if (!m || !('rec' in m)) return;
        if (m.rec) {
          const P = Math.round(sampleRate * 0.03);
          this.rec = { mode: m.rec, left: Math.round(sampleRate * (m.max || 15)), L: new Float32Array(4096), R: new Float32Array(4096), n: 0,
            wait: m.wait > 0 ? m.wait : 0, pre: m.wait > 0 ? { L: new Float32Array(P), R: new Float32Array(P), pos: 0, fill: 0 } : null };
        }
        else this.endRec();
      };
    }
    flushRec() {
      const r = this.rec;
      if (!r || !r.n) return;
      const L = r.L.slice(0, r.n), R = r.R.slice(0, r.n);
      this.port.postMessage({ recChunk: [L, R] }, [L.buffer, R.buffer]);
      r.n = 0;
    }
    endRec() { if (!this.rec) return; this.flushRec(); this.rec = null; this.port.postMessage({ recDone: true }); }
    process(inputs, outputs, parameters) {
      const inp = inputs[0], out = outputs[0], n = out[0].length;
      if (this.silence.length < n) { this.silence = new Float32Array(n); this.scratch = new Float32Array(n); }
      const inL = inp[0] || this.silence, inR = inp[1] || inL;
      const core = this.core;
      for (let i = 0; i < core.ids.length; i++) { const id = core.ids[i]; core.target[id] = parameters[id][0]; }
      const t0 = this.clock();
      core.process(inL, inR, out[0], out[1] || this.scratch, n);
      this.busy += this.clock() - t0; this.made += n * 1000 / sampleRate;
      if (this.made >= 1000) { this.load = this.busy / this.made; this.busy = 0; this.made = 0; }
      const r = this.rec;
      if (r) {
        const sL = r.mode === 'in' ? inL : out[0], sR = r.mode === 'in' ? inR : (out[1] || out[0]);
        let i = 0;
        if (r.wait > 0) {                       // waiting for sound: remember the last moment, watch the level
          const p = r.pre, P = p.L.length;
          for (; i < n; i++) {
            if (Math.abs(sL[i]) > r.wait || Math.abs(sR[i]) > r.wait) break;
            p.L[p.pos] = sL[i]; p.R[p.pos] = sR[i]; p.pos = (p.pos + 1) % P; if (p.fill < P) p.fill++;
          }
          if (i < n) {
            for (let k = p.fill; k > 0; k--) {
              const q = (p.pos - k + P) % P;
              r.L[r.n] = p.L[q]; r.R[r.n] = p.R[q];
              if (++r.n >= 4096) this.flushRec();
            }
            r.wait = 0; r.pre = null;
            this.port.postMessage({ recStarted: true });
          }
        }
        if (r.wait <= 0) {
          for (; i < n && r.left > 0; i++, r.left--) {
            r.L[r.n] = sL[i]; r.R[r.n] = sR[i];
            if (++r.n >= 4096) this.flushRec();
          }
          if (r.left <= 0) this.endRec();
        }
      }
      if (++this.blocks >= 4) { this.blocks = 0; const m = core.readMeter(); m.load = this.load; this.port.postMessage(m); }
      return true;
    }
  }
  registerProcessor('tape-warble', TapeProcessor);
}

// ── 3. node ──────────────────────────────────────────────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) module.exports = { TapeCore, PARAM_DEFS, GROUPS, OS_LATENCY, HQ_DRY, MIPS, kaiserLowpass, chebyLowpass, Cascade, Stage2 };
