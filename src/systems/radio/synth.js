// The voice bank: turns a track's event list into samples.
//
// Written as plain arithmetic on a Float32Array rather than as a graph of Web
// Audio nodes, for three reasons:
//
//  1. ONE implementation. The browser fills an AudioBuffer with this and node
//     writes a WAV with this, so what a reviewer listens to offline is exactly
//     what the store plays. The old engine could only be heard by opening the
//     store, which is why nobody ever listened to it.
//  2. Playback cost. The old engine created several hundred oscillator and
//     gain nodes per second, forever. A pre-rendered track is one buffer
//     source, so the audio thread does nothing but read memory.
//  3. Testability. Loudness, clipping and silence are measurable in node.
//
// Mono on purpose: a retail ceiling array is a distributed mono PA, and mono
// halves both the render time and the resident buffer size. The player adds a
// little decorrelation on the bus so it does not sound like a headphone mix.

import { mtof } from './theory.js';

// ---------------------------------------------------------------------------
// small DSP helpers
// ---------------------------------------------------------------------------
/** One-pole lowpass coefficient for a cutoff in Hz. */
const lp1 = (hz, sr) => Math.exp(-2 * Math.PI * hz / sr);

/** Cheap deterministic noise so renders are reproducible. */
function noiseGen(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return (s / 2147483648) - 1;
  };
}

/**
 * Two-pole RBJ biquad, stateful, one per note.
 *
 * This used to be a Chamberlin state-variable filter, which is only stable
 * below about sr/6. At the 22.05 kHz render rate that is 3.7 kHz — and the
 * closed hat sits at 7.8 kHz, so its filter self-oscillated to 3.4e38 and one
 * track in the library rendered as pure NaN (measured -240 dBFS, i.e. silence
 * with a corrupt meter). A biquad is stable to Nyquist.
 */
function svf(hz, q, sr, mode = 'bp') {
  const f0 = Math.min(hz, sr * 0.45);
  const w = 2 * Math.PI * f0 / sr;
  const cw = Math.cos(w), sw = Math.sin(w);
  const alpha = sw / (2 * Math.max(0.3, q));
  let b0, b1, b2;
  if (mode === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; }
  else if (mode === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; }
  else { b0 = alpha; b1 = 0; b2 = -alpha; }
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, z1: 0, z2: 0 };
}
function svfStep(s, x) {
  const y = s.b0 * x + s.z1;
  s.z1 = s.b1 * x - s.a1 * y + s.z2;
  s.z2 = s.b2 * x - s.a2 * y;
  return y;
}

// ---------------------------------------------------------------------------
// pitched voices
// ---------------------------------------------------------------------------

/** Karplus-Strong plucked string. The reason the guitars sound like guitars. */
function pluck(out, i0, n, freq, gain, sr, { damp = 0.5, bright = 0.5, drive = 0, body = 0 }, rnd) {
  const N = Math.max(2, Math.round(sr / freq));
  const buf = new Float32Array(N);
  // pick excitation: noise through a one-pole, brighter = harder pick
  let e = 0;
  const a = lp1(400 + bright * 6000, sr);
  for (let i = 0; i < N; i++) { e = rnd() * (1 - a) + e * a; buf[i] = e; }
  let p = 0, prev = 0, dc = 0;
  const loss = 0.5 * (1 - damp * 0.06);
  const end = Math.min(out.length, i0 + n);
  // terminal fade: the string is still ringing when its render span ends, and
  // a hard truncation of a ringing waveform is a click on every note end
  const fadeN = Math.max(1, Math.round(0.008 * sr));
  const fadeAt = end - i0 - fadeN;
  for (let i = i0; i < end; i++) {
    const cur = buf[p];
    let y = (cur + prev) * loss;
    prev = cur;
    buf[p] = y;
    p = (p + 1) % N;
    let s = y;
    if (drive) { s = Math.tanh(s * (1 + drive * 8)) / (1 + drive * 1.5); }
    if (body) { dc += (s - dc) * 0.02; s = s - dc * body; }
    const k = i - i0;
    out[i] += s * gain * (k >= fadeAt ? (end - i) / fadeN : 1);
  }
}

/** Two-operator FM — electric piano, bell, marimba. */
function fm(out, i0, n, freq, gain, sr, { ratio = 2, index = 3, decay = 0.6, mdecay = 0.25, attack = 0.002 }) {
  const w = 2 * Math.PI * freq / sr;
  const wm = w * ratio;
  const end = Math.min(out.length, i0 + n);
  const atk = Math.max(1, attack * sr);
  const dk = Math.exp(-1 / (decay * sr));
  const mk = Math.exp(-1 / (mdecay * sr));
  let env = 0, menv = index, ph = 0, mph = 0;
  const fadeN = Math.max(1, Math.round(0.008 * sr));
  const fadeAt = (end - i0) - fadeN;
  for (let i = i0, k = 0; i < end; i++, k++) {
    env = k < atk ? k / atk : env * dk;
    if (k >= atk) menv *= mk;
    mph += wm; ph += w;
    out[i] += Math.sin(ph + menv * Math.sin(mph)) * env * gain * (k >= fadeAt ? (end - i) / fadeN : 1);
  }
}

/** Additive with inharmonicity — acoustic piano-ish. */
function piano(out, i0, n, freq, gain, sr) {
  const end = Math.min(out.length, i0 + n);
  const parts = [[1, 1, 1.1], [2, 0.42, 0.7], [3, 0.2, 0.5], [4, 0.11, 0.36], [5, 0.06, 0.28], [7, 0.03, 0.2]];
  const B = 0.0004;
  for (const [h, amp, life] of parts) {
    const f = freq * h * Math.sqrt(1 + B * h * h);
    if (f > sr * 0.45) continue;
    const w = 2 * Math.PI * f / sr;
    const dk = Math.exp(-1 / (life * (0.5 + 220 / freq) * sr));
    let env = 0, ph = 0;
    const atk = Math.max(1, 0.003 * sr);
    const fadeN = Math.max(1, Math.round(0.008 * sr));
    const fadeAt = (end - i0) - fadeN;
    for (let i = i0, k = 0; i < end; i++, k++) {
      env = k < atk ? k / atk : env * dk;
      ph += w;
      out[i] += Math.sin(ph) * env * amp * gain * (k >= fadeAt ? (end - i) / fadeN : 1);
    }
  }
}

/** Detuned saw stack through a lowpass with a slow envelope — pads, strings. */
function saws(out, i0, n, freq, gain, sr, { voices = 3, detune = 6, cut = 2000, attack = 0.25, release = 0.6, tri = 0, vib = 0 }) {
  const end = Math.min(out.length, i0 + n);
  const len = end - i0;
  const atk = Math.max(1, attack * sr);
  const rel = Math.max(1, release * sr);
  const a = lp1(cut, sr);
  const phs = new Float32Array(voices);
  const incs = new Float32Array(voices);
  for (let v = 0; v < voices; v++) {
    phs[v] = v * 0.31;
    incs[v] = freq * Math.pow(2, ((v - (voices - 1) / 2) * detune) / 1200) / sr;
  }
  let lpz = 0;
  const vw = 2 * Math.PI * 5.2 / sr;
  for (let i = i0, k = 0; i < end; i++, k++) {
    const env = Math.min(1, k / atk) * Math.min(1, (len - k) / rel);
    const vm = vib ? 1 + vib * Math.sin(vw * k) : 1;
    let s = 0;
    for (let v = 0; v < voices; v++) {
      phs[v] += incs[v] * vm;
      phs[v] -= Math.floor(phs[v]);
      s += tri ? (4 * Math.abs(phs[v] - 0.5) - 1) : (2 * phs[v] - 1);
    }
    s /= voices;
    lpz = s * (1 - a) + lpz * a;
    out[i] += lpz * env * gain;
  }
}

/** Drawbar organ — a few sine partials, near-instant attack. */
function organ(out, i0, n, freq, gain, sr) {
  const end = Math.min(out.length, i0 + n);
  const bars = [[1, 1], [2, 0.5], [3, 0.28], [4, 0.18], [6, 0.08]];
  const atk = Math.max(1, 0.008 * sr), rel = Math.max(1, 0.06 * sr);
  const len = end - i0;
  for (const [h, amp] of bars) {
    const f = freq * h;
    if (f > sr * 0.45) continue;
    const w = 2 * Math.PI * f / sr;
    let ph = 0;
    for (let i = i0, k = 0; i < end; i++, k++) {
      const env = Math.min(1, k / atk) * Math.min(1, (len - k) / rel);
      ph += w;
      out[i] += Math.sin(ph) * env * amp * gain;
    }
  }
}

/** Filtered saw/square lead with vibrato. */
function lead(out, i0, n, freq, gain, sr, { pulse = 0.35, cut = 3000, attack = 0.02 }) {
  const end = Math.min(out.length, i0 + n);
  const len = end - i0;
  const atk = Math.max(1, attack * sr), rel = Math.max(1, 0.08 * sr);
  const inc = freq / sr, a = lp1(cut, sr);
  let ph = 0, lpz = 0;
  const vw = 2 * Math.PI * 5.6 / sr;
  for (let i = i0, k = 0; i < end; i++, k++) {
    const env = Math.min(1, k / atk) * Math.min(1, (len - k) / rel);
    const vm = 1 + 0.004 * Math.sin(vw * k) * Math.min(1, k / (0.15 * sr));
    ph += inc * vm; ph -= Math.floor(ph);
    const s = (ph < pulse ? 1 : -1) * 0.5 + (2 * ph - 1) * 0.5;
    lpz = s * (1 - a) + lpz * a;
    out[i] += lpz * env * gain;
  }
}

/** Finger bass: sine fundamental, triangle octave, pluck transient. */
function fingerBass(out, i0, n, freq, gain, sr, rnd) {
  const end = Math.min(out.length, i0 + n);
  const len = end - i0;
  const w = 2 * Math.PI * freq / sr, w2 = w * 2;
  const dk = Math.exp(-1 / (0.9 * sr));
  const atk = Math.max(1, 0.006 * sr), rel = Math.max(1, 0.05 * sr);
  let ph = 0, ph2 = 0, env = 0, click = 1;
  const ck = Math.exp(-1 / (0.004 * sr));
  let cz = 0; const ca = lp1(1400, sr);
  for (let i = i0, k = 0; i < end; i++, k++) {
    env = (k < atk ? k / atk : env * dk) * Math.min(1, (len - k) / rel);
    ph += w; ph2 += w2;
    let s = Math.sin(ph) + 0.22 * (2 * Math.abs((ph2 / (2 * Math.PI)) % 1 - 0.5) * 2 - 1);
    click *= ck;
    cz = rnd() * (1 - ca) + cz * ca;
    out[i] += (s * env + cz * click * 0.5) * gain;
  }
}

/** Synth bass: saw through an enveloped lowpass plus a sub sine. */
function synthBass(out, i0, n, freq, gain, sr) {
  const end = Math.min(out.length, i0 + n);
  const len = end - i0;
  const inc = freq / sr, sw = 2 * Math.PI * freq / sr;
  const atk = Math.max(1, 0.004 * sr), rel = Math.max(1, 0.03 * sr);
  const fdk = Math.exp(-1 / (0.18 * sr));
  let ph = 0, sph = 0, fenv = 1, lpz = 0, lpz2 = 0;
  for (let i = i0, k = 0; i < end; i++, k++) {
    const env = Math.min(1, k / atk) * Math.min(1, (len - k) / rel);
    fenv *= fdk;
    const a = lp1(180 + fenv * 2200 + freq * 2, sr);
    ph += inc; ph -= Math.floor(ph);
    sph += sw;
    const s = (2 * ph - 1);
    lpz = s * (1 - a) + lpz * a;
    lpz2 = lpz * (1 - a) + lpz2 * a;
    out[i] += (lpz2 * 0.85 + Math.sin(sph) * 0.5) * env * gain;
  }
}

// ---------------------------------------------------------------------------
// drums
// ---------------------------------------------------------------------------
function kick(out, i0, gain, sr) {
  const n = Math.min(out.length - i0, Math.ceil(0.34 * sr));
  const dk = Math.exp(-1 / (0.09 * sr));
  const pk = Math.exp(-1 / (0.024 * sr));
  let ph = 0, env = 1, pe = 1;
  const fadeN = Math.max(1, Math.round(0.006 * sr));
  for (let i = 0; i < n; i++) {
    const f = 44 + 120 * pe;
    ph += 2 * Math.PI * f / sr;
    const edge = i >= n - fadeN ? (n - i) / fadeN : 1;
    out[i0 + i] += Math.tanh(Math.sin(ph) * 1.4) * env * gain * edge;
    env *= dk; pe *= pk;
  }
}
function noiseHit(out, i0, gain, sr, { dur, hz, q = 1, mode = 'bp', shape = 1.5 }, rnd) {
  const n = Math.min(out.length - i0, Math.ceil(dur * sr));
  const s = svf(hz, q, sr, mode);
  for (let i = 0; i < n; i++) {
    const env = Math.pow(1 - i / n, shape);
    out[i0 + i] += svfStep(s, rnd()) * env * gain;
  }
}
function snareHit(out, i0, gain, sr, rnd) {
  noiseHit(out, i0, gain * 0.85, sr, { dur: 0.16, hz: 1900, q: 0.8, mode: 'bp', shape: 1.7 }, rnd);
  const n = Math.min(out.length - i0, Math.ceil(0.1 * sr));
  const dk = Math.exp(-1 / (0.028 * sr));
  let e = 1, p1 = 0, p2 = 0;
  for (let i = 0; i < n; i++) {
    p1 += 2 * Math.PI * 185 / sr; p2 += 2 * Math.PI * 278 / sr;
    out[i0 + i] += (Math.sin(p1) * 0.6 + Math.sin(p2) * 0.4) * e * gain * 0.5;
    e *= dk;
  }
}
function metal(out, i0, gain, sr, { dur, hz, shape }, rnd) {
  const n = Math.min(out.length - i0, Math.ceil(dur * sr));
  const s1 = svf(hz, 0.7, sr, 'hp');
  const ratios = [1, 1.41, 1.68, 2.11, 2.63, 3.17];
  const phs = new Float32Array(ratios.length);
  for (let i = 0; i < n; i++) {
    const env = Math.pow(1 - i / n, shape);
    let m = 0;
    for (let k = 0; k < ratios.length; k++) { phs[k] += 2 * Math.PI * Math.min(hz * ratios[k], sr * 0.45) / sr; m += Math.sin(phs[k]); }
    out[i0 + i] += (svfStep(s1, rnd()) * 0.75 + m / ratios.length * 0.25) * env * gain;
  }
}
function tom(out, i0, gain, sr, pitch, rnd) {
  const f0 = mtof(pitch ?? 50);
  const n = Math.min(out.length - i0, Math.ceil(0.4 * sr));
  const dk = Math.exp(-1 / (0.13 * sr));
  const pk = Math.exp(-1 / (0.05 * sr));
  let ph = 0, env = 1, pe = 1;
  const fadeN = Math.max(1, Math.round(0.006 * sr));
  for (let i = 0; i < n; i++) {
    ph += 2 * Math.PI * (f0 * (1 + pe * 0.5)) / sr;
    const edge = i >= n - fadeN ? (n - i) / fadeN : 1;
    out[i0 + i] += (Math.sin(ph) * 0.9 + rnd() * 0.08 * env) * env * gain * edge;
    env *= dk; pe *= pk;
  }
}

// ---------------------------------------------------------------------------
// voice dispatch
// ---------------------------------------------------------------------------
export const VOICES = {
  // pitched
  egtr: (o, i0, n, f, g, sr, rnd) => pluck(o, i0, n, f, g * 0.55, sr, { damp: 0.55, bright: 0.6, body: 0.2 }, rnd),
  agtr: (o, i0, n, f, g, sr, rnd) => pluck(o, i0, n, f, g * 0.75, sr, { damp: 0.3, bright: 0.75, body: 0.35 }, rnd),
  dgtr: (o, i0, n, f, g, sr, rnd) => pluck(o, i0, n, f, g * 0.5, sr, { damp: 0.75, bright: 0.5, drive: 0.55 }, rnd),
  clav: (o, i0, n, f, g, sr, rnd) => pluck(o, i0, n, f, g * 0.5, sr, { damp: 0.95, bright: 0.95, drive: 0.2, body: 0.5 }, rnd),
  ep: (o, i0, n, f, g, sr) => fm(o, i0, n, f, g * 0.62, sr, { ratio: 3, index: 3.4, decay: 0.85, mdecay: 0.2 }),
  bell: (o, i0, n, f, g, sr) => fm(o, i0, n, f, g * 0.5, sr, { ratio: 2.01, index: 2.6, decay: 1.6, mdecay: 0.55 }),
  marimba: (o, i0, n, f, g, sr) => fm(o, i0, n, f, g * 0.6, sr, { ratio: 4, index: 2.2, decay: 0.22, mdecay: 0.05 }),
  piano: (o, i0, n, f, g, sr) => piano(o, i0, n, f, g * 0.55, sr),
  synpad: (o, i0, n, f, g, sr) => saws(o, i0, n, f, g * 0.34, sr, { voices: 4, detune: 11, cut: 1500, attack: 0.35, release: 0.7 }),
  strings: (o, i0, n, f, g, sr) => saws(o, i0, n, f, g * 0.3, sr, { voices: 5, detune: 9, cut: 2400, attack: 0.5, release: 0.9, vib: 0.003 }),
  organ: (o, i0, n, f, g, sr) => organ(o, i0, n, f, g * 0.3, sr),
  lead: (o, i0, n, f, g, sr) => lead(o, i0, n, f, g * 0.4, sr, { pulse: 0.32, cut: 3400 }),
  fbass: (o, i0, n, f, g, sr, rnd) => fingerBass(o, i0, n, f, g * 0.60, sr, rnd),
  synbass: (o, i0, n, f, g, sr) => synthBass(o, i0, n, f, g * 0.52, sr),
  // kit
  kick: (o, i0, n, f, g, sr) => kick(o, i0, g * 0.62, sr),
  snare: (o, i0, n, f, g, sr, rnd) => snareHit(o, i0, g * 0.5, sr, rnd),
  brush: (o, i0, n, f, g, sr, rnd) => noiseHit(o, i0, g * 0.42, sr, { dur: 0.2, hz: 2600, q: 0.6, mode: 'hp', shape: 1.1 }, rnd),
  rim: (o, i0, n, f, g, sr, rnd) => noiseHit(o, i0, g * 0.5, sr, { dur: 0.05, hz: 1700, q: 3.2, mode: 'bp', shape: 2.6 }, rnd),
  clap: (o, i0, n, f, g, sr, rnd) => {
    for (let k = 0; k < 3; k++) noiseHit(o, i0 + Math.round(k * 0.009 * sr), g * 0.3, sr, { dur: 0.03, hz: 1500, q: 0.9, mode: 'bp', shape: 2 }, rnd);
    noiseHit(o, i0 + Math.round(0.027 * sr), g * 0.34, sr, { dur: 0.16, hz: 1300, q: 0.7, mode: 'bp', shape: 2.4 }, rnd);
  },
  hat: (o, i0, n, f, g, sr, rnd) => noiseHit(o, i0, g * 0.22, sr, { dur: 0.045, hz: 7000, q: 0.8, mode: 'hp', shape: 2.6 }, rnd),
  ohat: (o, i0, n, f, g, sr, rnd) => noiseHit(o, i0, g * 0.26, sr, { dur: 0.26, hz: 6800, q: 0.8, mode: 'hp', shape: 1.8 }, rnd),
  ride: (o, i0, n, f, g, sr, rnd) => metal(o, i0, g * 0.16, sr, { dur: 0.55, hz: 5200, shape: 2.2 }, rnd),
  crash: (o, i0, n, f, g, sr, rnd) => metal(o, i0, g * 0.2, sr, { dur: 1.5, hz: 3600, shape: 1.4 }, rnd),
  shaker: (o, i0, n, f, g, sr, rnd) => noiseHit(o, i0, g * 0.15, sr, { dur: 0.07, hz: 5200, q: 0.7, mode: 'hp', shape: 1.4 }, rnd),
  tamb: (o, i0, n, f, g, sr, rnd) => noiseHit(o, i0, g * 0.14, sr, { dur: 0.14, hz: 7400, q: 0.6, mode: 'hp', shape: 1.8 }, rnd),
  tom: (o, i0, n, f, g, sr, rnd, pitch) => tom(o, i0, g * 0.6, sr, pitch, rnd),
};

export const VOICE_NAMES = Object.keys(VOICES);

/**
 * Extra render time past the notated duration, per voice.
 *
 * Decaying voices (plucks, FM, piano) shape themselves with an exponential
 * envelope, so cutting the buffer at the notated length chops the ring and
 * clicks. Sustained voices (pads, organ, lead, both basses) derive their
 * release from the length they are given, so ANY tail lengthens the note —
 * a blanket +0.6 s tail is what made the first render's pads run over the
 * chord changes.
 */
const TAIL = {
  egtr: 0.45, agtr: 0.5, dgtr: 0.4, clav: 0.25,
  ep: 0.7, bell: 1.5, marimba: 0.25, piano: 0.9,
};
/** Voices that ignore `pitch` — used by the composer's validity checks. */
export const UNPITCHED = new Set(['kick', 'snare', 'brush', 'rim', 'clap', 'hat', 'ohat', 'ride', 'crash', 'shaker', 'tamb']);

/**
 * Render a compiled track to a mono Float32Array.
 *
 * `budgetEvents` renders only a slice of the event list, so the browser can
 * spread the work over many animation frames instead of blocking a frame for
 * a second. Call repeatedly with the returned cursor until it reports done.
 */
export function renderInto(buf, track, sr, from = 0, count = Infinity) {
  const ev = track.events;
  const to = Math.min(ev.length, from + count);
  for (let i = from; i < to; i++) {
    const e = ev[i];
    const fn = VOICES[e.voice];
    if (!fn) continue;
    // per-EVENT noise stream: one generator shared across events made the
    // audio depend on which slice of the event list this call rendered, so a
    // chunked render differed from a whole-track render of the same seed
    const rnd = noiseGen((track.seed * 2654435761 ^ (i + 1) * 40503) >>> 0 || 1);
    const i0 = Math.round(e.t * sr);
    if (i0 < 0 || i0 >= buf.length) continue;
    const n = Math.max(1, Math.round((e.dur + (TAIL[e.voice] ?? 0)) * sr));
    // Belt and braces: a pitched voice handed a frequency above Nyquist has
    // no phase wrap that behaves, and one bad note poisons a whole track.
    const f = e.pitch == null ? 0 : Math.min(mtof(e.pitch), sr * 0.45);
    if (!Number.isFinite(f) || !Number.isFinite(e.gain)) continue;
    fn(buf, i0, n, f, e.gain, sr, rnd, e.pitch);
  }
  return to;
}

/** Render a whole track in one go (node / tests / offline WAV). */
export function renderTrack(track, sr = 22050) {
  const buf = new Float32Array(Math.ceil(track.durationSec * sr));
  renderInto(buf, track, sr, 0, Infinity);
  return buf;
}
