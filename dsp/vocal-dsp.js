'use strict';
/* Tape Loss MK IV: the sums behind Vocal mode. Plain functions on Float32Arrays, with no audio nodes in them, so each
   can be checked on its own (they are, against a made-up voice: see the notes in vocal.js).

     syllables(x, sr, sens, f0)  where the voice starts a new sound: [{ a, b }] in samples. Given the pitch track,
                              a consonant is kept with the vowel it leads into or closes
     pitchTrack(x, sr)        the pitch every 10 ms, in Hz, 0 where there is none (YIN, on a quarter-rate copy)
     median(track, a, b)      the pitch a stretch of that track sits on
     resample(x, rate)        tape pitch: faster is higher and shorter
     shape(x, sr)             where a syllable's body starts, and how loud it is
     psola(x, sr, f0, …)      natural pitch: moved to a note, flattened onto it as far as TUNE says, and made to last
                              as long as asked, with the voice's own character (its formants) left where it was */
const VocalDSP = (() => {
  const HOP = 0.01;                                                      // seconds between pitch readings

  function syllables(x, sr, sens = 0.5, f0) {
    const hop = Math.max(1, Math.round(sr * 0.005)), n = Math.floor(x.length / hop) - 1;
    if (n < 8) return [{ a: 0, b: x.length }];
    const raw = new Float32Array(n), e = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let j = i * hop, end = j + 2 * hop; j < end; j++) s += x[j] * x[j]; raw[i] = 10 * Math.log10(s / (2 * hop) + 1e-10); }
    let peak = -200;
    for (let i = 0; i < n; i++) { e[i] = (raw[Math.max(0, i - 1)] + raw[i] + raw[Math.min(n - 1, i + 1)]) / 3; if (e[i] > peak) peak = e[i]; }
    const sorted = Float32Array.from(e).sort(), floor = sorted[Math.floor(n * 0.1)];       // the quietest tenth: the room
    const gate = Math.max(peak - 42, Math.min(peak - 20, floor + 6)), rise = 10 - 7 * sens, gap = Math.round((0.16 - 0.09 * sens) / 0.005), look = 14, out = [];
    let last = -1e9, open = -1, quiet = 0;
    const close = i => { if (open >= 0) { out.push({ a: open * hop, b: Math.min(x.length, i * hop) }); open = -1; } };
    for (let i = 0; i < n; i++) {
      if (e[i] < gate) { if (++quiet >= 20 && open >= 0) close(i - 12); continue; }     // 100 ms of silence ends a sound, and 40 ms of it is kept as its tail
      quiet = 0;
      let lo = 1e9, at = i;
      for (let j = Math.max(0, i - look); j < i - 1; j++) if (e[j] < lo) { lo = e[j]; at = j; }
      const fresh = open < 0, jump = e[i] - lo >= rise && i - last >= gap && e[i] - e[Math.max(0, i - 3)] >= rise * 0.3;      // louder than a moment ago, and still getting louder
      if (fresh || jump) {
        const cut = fresh ? Math.max(0, i - 2) : Math.max(at, i - 8);    // at the dip before the rise, so cuts fall in the quiet
        close(cut); open = cut; last = i;
      }
    }
    close(n);
    const kept = [];
    for (const s of out) {                                               // nothing shorter than 60 ms stands alone
      if (s.b - s.a < sr * 0.06 && kept.length && s.a - kept[kept.length - 1].b < sr * 0.03) kept[kept.length - 1].b = s.b;
      else if (s.b - s.a >= sr * 0.04) kept.push(s);
    }
    let list = kept;
    if (f0 && kept.length > 1) {                                         // a consonant belongs to the vowel beside it: the two are one syllable
      const sung = q => { let v = 0, c = 0; for (let i = Math.round(q.a / sr / HOP), e2 = Math.round(q.b / sr / HOP); i < e2; i++) { c++; if (f0[i] > 0) v++; } return c ? v / c : 0; };
      const small = q => q.b - q.a < sr * 0.15 && sung(q) < 0.25, near = (p, q) => q.a - p.b < sr * 0.04, joined = [];
      for (let i = 0; i < kept.length; i++) {
        const q = kept[i], nx = kept[i + 1], pv = joined[joined.length - 1];
        if (nx && small(q) && near(q, nx) && !small(nx)) { nx.a = q.a; continue; }        // it leads into the next one
        if (pv && small(q) && near(pv, q)) { pv.b = q.b; continue; }                      // or closes the one before
        joined.push(q);
      }
      list = joined;
    }
    if (!list.length) return [{ a: 0, b: x.length }];
    // A piece with no body of its own (a breath, a click, the room) is not a syllable. How loud each piece gets, against
    // the usual one: 15 dB under, it goes to the syllable beside it, or, standing alone, is marked weak (left out to begin with).
    const body = q => { const v = []; for (let i = Math.floor(q.a / hop), e2 = Math.min(n, Math.ceil(q.b / hop)); i < e2; i++) v.push(e[i]); v.sort((p, r) => p - r); return v.length ? v[Math.floor(v.length * 0.9)] : -200; };
    for (const q of list) q.lv = body(q);
    const lv = list.map(q => q.lv).sort((p, r) => p - r), usual = lv[lv.length >> 1], strong = [];
    for (let i = 0; i < list.length; i++) {
      const q = list[i], nx = list[i + 1], pv = strong[strong.length - 1];
      if (q.lv < usual - 15) {
        if (pv && q.a - pv.b < sr * 0.3) { pv.b = q.b; continue; }                        // it trails off the one before
        if (nx && nx.a - q.b < sr * 0.1 && nx.lv >= usual - 15) { nx.a = q.a; continue; } // or leads into the next
        q.weak = true;
      }
      strong.push(q);
    }
    // Nothing is thrown away between syllables: each one runs on to where the next begins (the quiet end of a word
    // belongs to it), and before a pause it keeps a tail. So the pieces, laid end to end, are the voice as it was.
    for (let i = 0; i < strong.length; i++) {
      const q = strong[i], nx = strong[i + 1], lim = nx ? nx.a : x.length;
      q.b = lim - q.b < sr * 0.3 ? lim : Math.min(lim, q.b + Math.round(sr * 0.12));
      delete q.lv;
    }
    return strong.slice(0, 64);
  }

  function pitchTrack(x, sr, fmin = 70, fmax = 520) {
    const D = Math.max(1, Math.round(sr / 11025)), rs = sr / D, m = Math.floor(x.length / D), y = new Float32Array(m);
    for (let i = 0; i < m; i++) { let s = 0; for (let j = 0; j < D; j++) s += x[i * D + j]; y[i] = s / D; }
    const tauMax = Math.round(rs / fmin), tauMin = Math.max(2, Math.round(rs / fmax)), W = tauMax * 2, hop = Math.round(rs * HOP);
    const frames = Math.max(0, Math.floor((m - W - tauMax) / hop) + 1), total = Math.ceil(x.length / sr / HOP) + 1, f0 = new Float32Array(total), d = new Float32Array(tauMax + 1);
    for (let k = 0; k < frames; k++) {
      const s = k * hop;
      let en = 0; for (let j = 0; j < W; j++) en += y[s + j] * y[s + j];
      if (en / W < 1e-6) continue;                                       // too quiet to have a pitch
      let run = 0, best = -1, bestV = 1e9;
      d[0] = 1;
      for (let tau = 1; tau <= tauMax; tau++) {
        let sum = 0; for (let j = 0; j < W; j++) { const v = y[s + j] - y[s + j + tau]; sum += v * v; }
        run += sum; d[tau] = run > 0 ? sum * tau / run : 1;
      }
      for (let tau = tauMin; tau < tauMax; tau++) {
        if (d[tau] < 0.15 && d[tau] <= d[tau + 1]) { best = tau; break; }               // the first good dip: the true period, not a multiple of it
        if (d[tau] < bestV) { bestV = d[tau]; best = tau; }
      }
      if (best < 0 || d[best] > 0.3) continue;
      const a = d[best - 1], b = d[best], c = d[Math.min(tauMax, best + 1)], den = a - 2 * b + c, tau = best + (den ? 0.5 * (a - c) / den : 0);
      f0[Math.min(total - 1, Math.round((s + W / 2) / rs / HOP))] = rs / tau;      // the reading belongs to the middle of the stretch it was taken from
    }
    return f0;
  }

  function median(f0, a, b) {
    const v = [];
    for (let i = Math.max(0, a); i < Math.min(f0.length, b); i++) if (f0[i] > 0) v.push(f0[i]);
    if (v.length < Math.max(2, (b - a) * 0.2)) return 0;                 // mostly breath or consonant: no note to speak of
    v.sort((p, q) => p - q);
    return v[v.length >> 1];
  }

  function resample(x, rate) {
    const n = Math.max(1, Math.floor(x.length / rate)), out = new Float32Array(n), last = x.length - 1;
    for (let i = 0; i < n; i++) { const p = i * rate, k = Math.min(last, Math.floor(p)), f = p - k; out[i] = x[k] + (x[Math.min(last, k + 1)] - x[k]) * f; }
    return out;
  }

  /** Where a syllable's body starts (after any breath or consonant leading into it), in samples, and how loud it is. */
  function shape(x, sr) {
    const hop = Math.max(1, Math.round(sr * 0.0025)), n = Math.floor(x.length / hop), e = new Float32Array(n);
    let peak = 0, total = 0;
    for (let i = 0; i < n; i++) { let q = 0; for (let j = i * hop, end = j + hop; j < end; j++) q += x[j] * x[j]; total += q; e[i] = Math.sqrt(q / hop); if (e[i] > peak) peak = e[i]; }
    let pre = 0;
    for (let i = 0; i < n; i++) if (e[i] >= peak * 0.35) { pre = i * hop; break; }
    let sum = 0, cnt = 0;
    for (let i = 0; i < n; i++) if (e[i] >= peak * 0.25) { sum += e[i] * e[i]; cnt++; }      // how loud it is while it is sounding
    return { pre: Math.min(pre, Math.round(sr * 0.08)), rms: cnt ? Math.sqrt(sum / cnt) : Math.sqrt(total / Math.max(1, n * hop)) };
  }

  /** x: one syllable. f0: its own pitch track (a reading every 10 ms from its first sample). med: the pitch it sits on.
   *  target: the pitch to put it on, Hz (0 leaves it). tune 0…1: how far its own rise and fall is flattened onto that.
   *  outLen: how many samples it should last (0: as long as it is). vib: a slight waver on a long held note.
   *
   *  How: the wave is cut into grains two periods long, one centred on each period of the voice (found by lining each
   *  period up with the one before, where the two look most alike). Laying those grains down closer together or
   *  further apart moves the pitch and leaves the shape of each one, which is what makes a voice that voice, alone.
   *  Making it longer repeats grains of the sung part only: breath and consonants pass through at their own length,
   *  so a stretched word keeps a crisp start and holds its vowel. */
  function psola(x, sr, f0, med, target, tune, outLen, vib) {
    const N = x.length, M = Math.max(1, Math.round(outLen || N)), out = new Float32Array(M), Tu = sr * 0.005;
    const fAt = p => {
      const i = Math.round(p / sr / HOP);
      for (const k of [0, -1, 1, -2, 2]) { let v = f0[i + k]; if (v > 0) { while (v > med * 1.5) v /= 2; while (v < med / 1.5) v *= 2; return v; } }      // a reading an octave out is folded back
      return 0;
    };
    const marks = [], per = [];
    for (let p = 0, prev = -1; p < N;) {
      const f = med > 0 ? fAt(p) : 0;
      if (f > 0) {
        const T = sr / f, h = Math.max(8, Math.round(T / 2)), c0 = Math.round(p);
        let m = c0;
        if (prev < 0 || prev - h < 0) {                                  // the first of a sung stretch: the tallest peak in its first period
          const lo = Math.max(0, c0), hi = Math.min(N - 1, Math.ceil(p + T));
          m = lo; for (let j = lo; j <= hi; j++) if (x[j] > x[m]) m = j;
        } else {                                                         // after that: where the wave looks most like it did one period back
          const span = Math.round(T * 0.2);
          let best = -Infinity;
          for (let d = -span; d <= span; d++) {
            const c = c0 + d; if (c + h >= N) break;
            let q = 0; for (let j = -h; j <= h; j += 2) q += x[prev + j] * x[c + j];
            if (q > best) { best = q; m = c; }
          }
        }
        if (marks.length && m <= marks[marks.length - 1]) m = marks[marks.length - 1] + 1;
        marks.push(m); per.push(prev >= 0 ? Math.max(T * 0.6, Math.min(T * 1.6, m - prev)) : T); p = m + T; prev = m;
      } else { marks.push(Math.round(p)); per.push(0); p += Tu; prev = -1; }
    }
    if (!marks.length) return out;
    let sung = 0;
    for (let k = 0; k < marks.length; k++) if (per[k] > 0) sung += Math.min(k + 1 < marks.length ? marks[k + 1] - marks[k] : per[k], per[k] * 1.6);
    const r = sung > 0 ? (M - (N - sung)) / sung : 0, split = r >= 0.3 && r <= 8, even = M / N;      // split: only the sung part is drawn out or squeezed
    let k = 0, used = -1, flip = false;
    for (let ts = 0, tin = 0; ts < M && tin < N + Tu * 4;) {
      while (k + 1 < marks.length && Math.abs(marks[k + 1] - tin) <= Math.abs(marks[k] - tin)) k++;
      const m = marks[k], isV = per[k] > 0, Tin = isV ? per[k] : Tu;
      let Tout = Tin;
      if (isV && target > 0) {
        Tout = sr / (target * Math.pow((sr / Tin) / med, 1 - tune));
        if (vib) { const sec = ts / sr; Tout /= 1 + 0.0055 * Math.max(0, Math.min(1, (sec - 0.2) / 0.25)) * Math.sin(2 * Math.PI * 5.3 * sec); }      // about ±9 cents, coming in after a moment
      }
      Tout = Math.max(sr / 1200, Math.min(sr / 40, Tout));
      const half = Math.round(Tin), g = Math.max(0.35, Math.min(1.8, Tout / Tin)), c = Math.round(ts);
      flip = !isV && k === used ? !flip : false;                         // breath repeated to fill time: every other copy is turned round, so it does not buzz
      for (let j = -half; j <= half; j++) {
        const o = c + j, i = m + (flip ? -j : j);
        if (o < 0 || o >= M || i < 0 || i >= N) continue;
        out[o] += x[i] * g * (0.5 + 0.5 * Math.cos(Math.PI * j / half));
      }
      used = k; ts += Tout; tin += Tout / (split ? (isV ? r : 1) : even);
    }
    return out;
  }

  return { HOP, syllables, pitchTrack, median, resample, shape, psola };
})();
if (typeof module !== 'undefined' && module) module.exports = VocalDSP;
