'use strict';
/* Tape Loss MK IV: sample tools. Kept on its own, like tempo.js.

   What it adds:
     · NORM   a key in the loop's strip, beside TEMPO. It brings a quiet recording or file up to full level
              (its loudest moment to 1 dB under full). Tap it again and the sample is as it was.
     · the sample bank, behind Load: up to 24 samples kept on this device, so they are still there after
       the page is closed. What goes in: every file that is loaded, every sound saved with Save WAV (as it was
       saved, effect included), and whatever KEEP CLEAN or KEEP WITH EFFECT is pressed on. A tap on a pad
       puts that sample on the File source and plays it; the pencil on a pad renames it. While this file is
       loaded the Load key reads BANK.
       Two separate things are kept with every pad: the sound (clean, or with the effect already in it) and
       the settings of the effect at that moment. The RECALL switch in the panel says whether a pad brings
       back only its sound, or its sound and those settings.

   TO PULL IT OUT: delete this file and its <script> line in index.html. The hooks in app.js are marked
   "sample.js" and check that the function exists first: Load opens the file picker again, Save WAV only saves. */

// ───────────────────────── NORM ─────────────────────────
const sHits = [];
let sHitsAt = 0, sPress = 0;
/** Draws the NORM key with its right edge at x1 on the strip's top line. Returns the width it took. */
function sampleChip(g, x1, top) {
  const t = curTape();
  sHits.length = 0; sHitsAt = performance.now();
  if (!t || !t.buf || rec) return 0;
  const on = !!(t.norm && t.norm.out === t.buf), label = on ? `NORM +${Math.round(t.norm.db)}` : 'NORM', down = performance.now() < sPress;
  g.save();
  g.font = '700 9px ' + FONT;
  const w = Math.ceil(g.measureText(label).width) + 14, x = x1 - w, y = top - 3 + (down ? 1 : 0);
  rr(g, x, y, w, 15, 4);
  if (on || down) { g.fillStyle = INK; g.fill(); } else { g.strokeStyle = 'rgba(241,239,232,.3)'; g.lineWidth = 1; g.stroke(); }
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = on || down ? '#0b0b0c' : 'rgba(241,239,232,.7)';
  g.fillText(label, x + w / 2, y + 8);
  g.restore();
  sHits.push({ x: x - 4, y: top - 8, w: w + 8, h: 25, act: sampleNorm });
  return w + 8;
}
/** Normalise the sample on the source in use, or undo it. Peak, not loudness: the loudest moment goes to -1 dB. */
function sampleNorm() {
  const t = curTape();
  if (!t || !t.buf || rec) return;
  const swap = buf => { t.buf = buf; t.peaks = makePeaks(buf); t.faded = null; if (playing) startBuf(); };
  if (t.norm && t.norm.out === t.buf) { const src = t.norm.src; t.norm = null; swap(src); say('Level back to how it was'); return; }
  let peak = 0;
  for (let c = 0; c < t.buf.numberOfChannels; c++) { const d = t.buf.getChannelData(c); for (let i = 0; i < d.length; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > peak) peak = v; } }
  if (peak < 1e-4) { say('Nothing to bring up: this sample is silent', true); return; }
  const gain = 0.891 / peak, db = 20 * Math.log10(gain);
  if (db < 0.5) { say('Already at full level: its loudest moment is at ' + (20 * Math.log10(peak)).toFixed(1) + ' dB'); return; }
  const out = ctx.createBuffer(t.buf.numberOfChannels, t.buf.length, t.buf.sampleRate);
  for (let c = 0; c < t.buf.numberOfChannels; c++) { const d = t.buf.getChannelData(c), o = out.getChannelData(c); for (let i = 0; i < d.length; i++) o[i] = d[i] * gain; }
  t.norm = { src: t.buf, out, db };
  swap(out);
  say(`Normalised: up ${db.toFixed(1)} dB. Tap NORM again to undo`);
}
document.querySelector('#screen').addEventListener('pointerdown', e => {       // the key is drawn on the canvas: its taps are caught here
  if (e.target !== deckCv || muted || guard || document.body.classList.contains('show')) return;
  if (performance.now() - sHitsAt > 400) return;
  const b = deckCv.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top, pad = e.pointerType === 'mouse' ? 0 : 4;
  const h = sHits.find(q => x >= q.x - pad && x <= q.x + q.w + pad && y >= q.y - pad && y <= q.y + q.h + pad);
  if (!h) return;
  e.stopPropagation(); e.preventDefault();
  sPress = performance.now() + 160;
  h.act();
}, true);

// ───────────────────────── the bank ─────────────────────────
const BANK_MAX = 24;
let bankFx = false; try { bankFx = localStorage.getItem('tapeloss.bankfx') === '1'; } catch (_) {}      // RECALL: false, a pad brings back its sound only; true, its settings too
let bankDb = null, bankList = [], bankCur = null, bankSaved = true;       // bankSaved: false when the device would not store it, and it lives only as long as the page
const bankMem = new Map();
const bankReady = (async () => {
  try {
    bankDb = await new Promise((res, rej) => {
      const rq = indexedDB.open('tapeloss-bank', 1);
      rq.onupgradeneeded = () => { rq.result.createObjectStore('meta', { keyPath: 'id' }); rq.result.createObjectStore('audio', { keyPath: 'id' }); };
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); rq.onblocked = () => rej(new Error('blocked'));
    });
    bankList = (await bankTx(['meta'], 'readonly', s => s.meta.getAll())).sort((a, b) => b.when - a.when);
  } catch (_) { bankDb = null; bankSaved = false; }
})();
/** One transaction over the named stores; `fn` gets them by name and may return a request whose result is wanted. */
function bankTx(names, mode, fn) {
  return new Promise((res, rej) => {
    const tx = bankDb.transaction(names, mode), stores = Object.fromEntries(names.map(n => [n, tx.objectStore(n)])), rq = fn(stores);
    tx.oncomplete = () => res(rq ? rq.result : undefined);
    tx.onerror = tx.onabort = () => rej(tx.error || new Error('The device refused'));
  });
}
/** Put a sample in the bank. `chans`: one Float32Array per channel. Returns true when it is in. */
async function bankStore(kind, title, chans, sr, extra) {
  await bankReady;
  const n = chans[0].length;
  const same = bankList.find(m => m.kind === kind && m.title === title && m.n === n && m.sr === sr);
  if (same && kind === 'file') {                                           // the same file again: it moves to the front
    same.when = Date.now(); bankList.sort((a, b) => b.when - a.when); bankCur = same.id;
    if (bankDb) bankTx(['meta'], 'readwrite', s => { s.meta.put(same); }).catch(() => {});
    bankDraw(); return true;
  }
  if (bankList.length >= BANK_MAX) { say(`The bank is full (${BANK_MAX}). Remove one to make room`, true); return false; }
  const P = 96, lo = new Float32Array(P), hi = new Float32Array(P), d = chans[0], stride = Math.max(1, Math.floor(n / P / 300));
  for (let b = 0; b < P; b++) { let mn = 0, mx = 0; for (let k = Math.floor(b * n / P), e = Math.floor((b + 1) * n / P); k < e; k += stride) { const v = d[k]; if (v < mn) mn = v; else if (v > mx) mx = v; } lo[b] = mn; hi[b] = mx; }
  const meta = Object.assign({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), kind, title, when: Date.now(), sr, n, chs: chans.length, dur: n / sr, lo, hi }, extra || {});
  if (typeof snap === 'function') meta.fx = snap();                        // how the effect was set when it was kept, whatever kind of sound it is
  const audio = { id: meta.id, ch: chans.map(c => c.slice()) };
  if (bankDb) {
    try {
      await bankTx(['meta', 'audio'], 'readwrite', s => { s.meta.put(meta); s.audio.put(audio); });
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});      // ask the browser not to clear it
    } catch (err) { say('No room left on this device for another sample', true); return false; }
  } else bankMem.set(meta.id, audio);
  bankList.unshift(meta); bankCur = meta.id;
  bankDraw();
  return true;
}
/** Keep a tape (the File or Loop source as it is, loop ends and fades included). */
function bankKeep(kind, t) {
  if (!t || !t.buf) return Promise.resolve(false);
  const chans = []; for (let c = 0; c < t.buf.numberOfChannels; c++) chans.push(t.buf.getChannelData(c));
  const extra = { ls: t.ls, le: t.le, fi: t.fi || 0, fo: t.fo || 0 };
  if (typeof TEMPO !== 'undefined' && (TEMPO.open || TEMPO.mode !== 'loop')) extra.bpm = TEMPO.bpm;      // tempo.js: the tempo belongs to the tape
  return bankStore(kind, t.title, chans, t.buf.sampleRate, extra);
}
/** Keep a sound that has been rendered through the effect (Save WAV, KEEP WITH EFFECT). */
function bankTake(name, L, R, sr, dry) { return bankStore(dry ? 'kept' : 'saved', name, [L, R], sr); }      // dry: saved without the effect
/** A pad was tapped: its sample goes on the File source and plays. */
async function bankRecall(id) {
  const m = bankList.find(q => q.id === id);
  if (!m) return;
  try {
    await ensureAudio();
    const a = bankDb ? await bankTx(['audio'], 'readonly', s => s.audio.get(id)) : bankMem.get(id);
    if (!a) throw new Error('missing');
    const buf = ctx.createBuffer(a.ch.length, m.n, m.sr);
    a.ch.forEach((c, i) => buf.getChannelData(i).set(c));
    setTape('file', buf, m.title);
    if (m.le > m.ls) Object.assign(tape.file, { ls: m.ls, le: Math.min(m.le, buf.duration), fi: m.fi || 0, fo: m.fo || 0 });
    if (m.bpm && typeof tSet === 'function') { TEMPO.guess = false; tSet('bpm', m.bpm); }      // tempo.js
    source = 'file'; document.body.dataset.src = 'file'; bankCur = id;
    const withFx = bankFx && m.fx && typeof applySnap === 'function';
    if (withFx) applySnap(m.fx);                                           // the settings too: Undo steps back from them
    bankShow(false);
    await play();
    const baked = m.kind === 'saved';
    say('From the bank: ' + m.title + (withFx ? (baked ? ', with its settings. The effect is already in the sound, so it now goes through it twice' : ', with its settings')
      : baked ? '. The effect is already in it (Bypass plays it as it was saved)' : bankFx ? '. It has no settings kept with it' : '. The settings were left as they are'));
  } catch (err) { say('Could not bring that sample back', true); }
}
/** Give a sample in the bank another name. The tape on the deck takes the name too, if it is that sample. */
async function bankRename(id, name) {
  const m = bankList.find(q => q.id === id);
  name = (name || '').trim().slice(0, 60);
  if (!m || !name || name === m.title) return;
  if (bankCur === id && tape.file.title === m.title) tape.file.title = name;
  m.title = name;
  if (bankDb) try { await bankTx(['meta'], 'readwrite', s => { s.meta.put(m); }); } catch (_) {}
  say('Renamed: ' + name);
}
/** The pencil on a pad: its name becomes a field to type in. Return or a tap elsewhere keeps it; Escape leaves it alone. */
function bankEdit(slot, m) {
  if (slot.querySelector('.brename')) return;
  const el = document.createElement('input');
  el.type = 'text'; el.className = 'brename'; el.value = m.title; el.maxLength = 60;
  el.setAttribute('aria-label', 'Name for ' + m.title); el.autocapitalize = 'off'; el.autocomplete = 'off'; el.spellcheck = false; el.enterKeyHint = 'done';
  let done = false;
  const end = async keep => { if (done) return; done = true; if (keep) await bankRename(m.id, el.value); bankDraw(); };
  el.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); end(true); } else if (e.key === 'Escape') { e.preventDefault(); end(false); } });
  el.addEventListener('keyup', e => e.stopPropagation());
  el.addEventListener('blur', () => end(true));
  slot.appendChild(el);
  el.focus(); el.select();
}
async function bankRemove(id) {
  bankList = bankList.filter(q => q.id !== id); bankMem.delete(id);
  if (bankDb) try { await bankTx(['meta', 'audio'], 'readwrite', s => { s.meta.delete(id); s.audio.delete(id); }); } catch (_) {}
  bankDraw();
}
async function bankClear() {
  bankList = []; bankMem.clear(); bankCur = null;
  if (bankDb) try { await bankTx(['meta', 'audio'], 'readwrite', s => { s.meta.clear(); s.audio.clear(); }); } catch (_) {}
  bankDraw(); say('The bank is empty');
}

// ── the panel ──
const bankEl = document.createElement('div');
bankEl.className = 'tech bank'; bankEl.id = 'bank'; bankEl.hidden = true;
bankEl.setAttribute('role', 'dialog'); bankEl.setAttribute('aria-label', 'Sample bank');
bankEl.innerHTML = `
  <header class="tech-head">
    <div class="tech-title"><h2>Sample bank</h2><p id="bank-sub"></p></div>
    <button type="button" class="key-btn" id="bank-file">Load file</button>
    <button type="button" class="key-btn" id="bank-keep">Keep clean</button>
    <button type="button" class="key-btn" id="bank-keepfx">Keep with effect</button>
    <button type="button" class="key-btn" id="bank-clear">Clear bank</button>
    <button type="button" class="key-btn" id="bank-close">Close</button>
  </header>
  <div class="bank-bar">
    <div class="tech-engine">
      <span>Recall</span>
      <div class="seg" id="bank-fx" role="radiogroup" aria-label="What a pad brings back">
        <button type="button" role="radio" data-fx="0" aria-checked="false">Sound only</button>
        <button type="button" role="radio" data-fx="1" aria-checked="false">Sound + settings</button>
      </div>
    </div>
    <p>Tap a pad to load it · ✎ renames · × removes</p>
  </div>
  <div class="bank-body" id="bank-body"></div>`;
document.body.appendChild(bankEl);
const bankBody = bankEl.querySelector('#bank-body'), bankQ = s => bankEl.querySelector(s);
const bankAgo = when => { const s = (Date.now() - when) / 1000; return s < 90 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(when).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };
const BANK_KIND = { file: 'File', saved: 'With effect', kept: 'Clean' };
/** A key that has to be tapped twice: the first tap arms it for a moment, the second does it. */
function bankTwice(btn, armedText, fn) {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (btn.dataset.armed) { clearTimeout(+btn.dataset.armed); delete btn.dataset.armed; btn.textContent = btn.dataset.label; fn(); return; }
    btn.dataset.label = btn.textContent; btn.textContent = armedText;
    btn.dataset.armed = setTimeout(() => { delete btn.dataset.armed; btn.textContent = btn.dataset.label; }, 2600);
  });
}
function bankDraw() {
  if (bankEl.hidden) return;
  const t = curTape(), has = !!(t && t.buf);
  bankQ('#bank-sub').textContent = `${bankList.length} of ${BANK_MAX} · ` + (bankSaved ? 'kept on this device' : 'kept until this page is closed');
  bankQ('#bank-keep').disabled = bankQ('#bank-keepfx').disabled = !has;
  bankQ('#bank-clear').disabled = !bankList.length;
  bankEl.querySelectorAll('#bank-fx button').forEach(b => b.setAttribute('aria-checked', (b.dataset.fx === '1') === bankFx));
  bankBody.textContent = '';
  const slots = Math.min(BANK_MAX, Math.max(8, Math.ceil((bankList.length + 1) / 4) * 4));
  for (let i = 0; i < slots; i++) {
    const m = bankList[i], slot = document.createElement('div');
    slot.className = 'bslot' + (m ? '' : ' empty') + (m && m.id === bankCur ? ' cur' : '');
    const num = String(i + 1).padStart(2, '0');
    if (!m) { slot.innerHTML = `<div class="bpad"><span class="bnum">${num}</span><i></i></div>`; bankBody.appendChild(slot); continue; }
    const pad = document.createElement('button');
    pad.type = 'button'; pad.className = 'bpad'; pad.setAttribute('aria-label', 'Load ' + m.title);
    pad.innerHTML = `<span class="bnum">${num}</span><canvas></canvas><b></b><small></small>`;
    pad.querySelector('b').textContent = m.title.replace(/\.[^.]+$/, '');
    const set = m.fx ? (m.fx.preset ? m.fx.preset.replace(/^user:/, 'User ') : 'Custom') : '';      // the settings kept with it, by the name they had
    pad.querySelector('small').textContent = `${BANK_KIND[m.kind] || 'Sample'} · ${m.dur < 10 ? m.dur.toFixed(1) : Math.round(m.dur)} s` + (set ? ` · ${set}` : '') + ` · ${bankAgo(m.when)}`;
    pad.addEventListener('click', () => bankRecall(m.id));
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'bdel'; del.textContent = '×'; del.setAttribute('aria-label', 'Remove ' + m.title);
    bankTwice(del, 'Remove?', () => bankRemove(m.id));
    const ren = document.createElement('button');
    ren.type = 'button'; ren.className = 'bdel bren'; ren.textContent = '✎'; ren.setAttribute('aria-label', 'Rename ' + m.title);
    ren.addEventListener('click', e => { e.stopPropagation(); bankEdit(slot, m); });
    slot.append(pad, ren, del); bankBody.appendChild(slot);
    const cv = pad.querySelector('canvas'), W = 240, H = 56, g = cv.getContext('2d');      // the little screen on the pad
    cv.width = W; cv.height = H;
    g.fillStyle = m.kind === 'saved' ? '#f04e23' : '#f1efe8';
    const P = m.lo.length, bw = W / P;
    for (let b = 0; b < P; b++) { const y0 = H / 2 - Math.min(1, m.hi[b] * 1.2) * (H / 2 - 3), y1 = H / 2 - Math.max(-1, m.lo[b] * 1.2) * (H / 2 - 3); g.fillRect(b * bw, y0 - 0.5, Math.max(1, bw - 0.6), Math.max(1, y1 - y0 + 1)); }
    if (m.le > m.ls && (m.ls > 0.01 || m.le < m.dur - 0.01)) { g.fillStyle = 'rgba(11,11,12,.6)'; g.fillRect(0, 0, m.ls / m.dur * W, H); g.fillRect(m.le / m.dur * W, 0, W, H); }     // outside its loop: dimmed
  }
}
function bankShow(on) {
  if (on === !bankEl.hidden) return;
  bankEl.hidden = !on;
  if (on) bankReady.then(bankDraw);
}
/** Called by the app's Load key, which reads BANK while this file is here. */
function bankOpen() { bankShow(true); }
{ const k = document.querySelector('#load'); if (k) { k.textContent = 'Bank'; k.dataset.help = 'The sample bank: load a file, keep what is playing, or bring back a sample you kept.'; } }
bankQ('#bank-close').addEventListener('click', () => bankShow(false));
bankQ('#bank-file').addEventListener('click', () => document.querySelector('#file').click());
document.querySelector('#file').addEventListener('change', () => bankShow(false));
bankQ('#bank-keep').addEventListener('click', async () => {
  const t = curTape();
  if (!t || !t.buf) return;
  if (await bankKeep('kept', t)) say('Kept in the bank: ' + t.title);
});
bankQ('#bank-keepfx').addEventListener('click', async () => {
  const b = bankQ('#bank-keepfx');
  b.disabled = true; b.textContent = 'Keeping…';
  await saveWav({ bankOnly: true });
  b.textContent = 'Keep with effect'; bankDraw();
});
bankTwice(bankQ('#bank-clear'), 'Tap again to clear', bankClear);
bankEl.querySelectorAll('#bank-fx button').forEach(b => b.addEventListener('click', () => {
  bankFx = b.dataset.fx === '1';
  try { localStorage.setItem('tapeloss.bankfx', bankFx ? '1' : '0'); } catch (_) {}
  bankDraw();
  say(bankFx ? 'A pad brings back its sound and the settings it was kept with' : 'A pad brings back its sound only; the settings stay as they are');
}));
window.addEventListener('keydown', e => { if (e.key === 'Escape' && !bankEl.hidden && e.target.tagName !== 'INPUT') bankShow(false); });
if (window.tapeloss) Object.assign(window.tapeloss, { bankOpen, bankKeep, bankClear, sampleNorm });
