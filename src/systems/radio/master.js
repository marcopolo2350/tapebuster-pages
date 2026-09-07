// Mastering: PA voicing, glue compression, loudness normalisation, limiting.
//
// The acceptance criterion "no obvious volume jumps" is not satisfiable by
// picking sensible per-instrument gains — a dense funk track and a sparse
// soundtrack cue built from the same gains differ by six or seven decibels,
// which is exactly the "quiet -> loud -> quiet" complaint. So every track is
// measured with a real BS.1770 K-weighted loudness meter and normalised to one
// target before it is ever heard, then peak-limited so two normalised tracks
// crossfading cannot clip each other.

const DB = (x) => 20 * Math.log10(Math.max(1e-12, x));
const LIN = (db) => Math.pow(10, db / 20);

// ---------------------------------------------------------------------------
// RBJ biquads, designed at the render rate (22.05 kHz) rather than copied from
// the 48 kHz coefficient table in the standard.
// ---------------------------------------------------------------------------
function biquad(type, f0, sr, Q, gainDb = 0) {
  const A = Math.pow(10, gainDb / 40);
  const w = 2 * Math.PI * f0 / sr;
  const cw = Math.cos(w), sw = Math.sin(w);
  const alpha = sw / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'highpass') {
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === 'lowpass') {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  } else if (type === 'highshelf') {
    const s = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) + (A - 1) * cw + s);
    b1 = -2 * A * ((A - 1) + (A + 1) * cw);
    b2 = A * ((A + 1) + (A - 1) * cw - s);
    a0 = (A + 1) - (A - 1) * cw + s;
    a1 = 2 * ((A - 1) - (A + 1) * cw);
    a2 = (A + 1) - (A - 1) * cw - s;
  } else { // peaking
    b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function applyBiquad(x, c, out = x) {
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = c.b0 * v + z1;
    z1 = c.b1 * v - c.a1 * y + z2;
    z2 = c.b2 * v - c.a2 * y;
    out[i] = y;
  }
  return out;
}

// ---------------------------------------------------------------------------
// BS.1770-4 integrated loudness (mono; the channel weight for a single centre
// channel is 1.0, so the mono case is the standard with one term).
// ---------------------------------------------------------------------------
export function measureLufs(buf, sr) {
  const k = new Float32Array(buf.length);
  k.set(buf);
  applyBiquad(k, biquad('highshelf', 1681.97, sr, 1 / Math.SQRT2, 3.999));
  applyBiquad(k, biquad('highpass', 38.135, sr, 0.5));

  const blockN = Math.round(0.4 * sr);
  const hopN = Math.round(0.1 * sr);
  if (k.length < blockN) return -70;
  const loud = [];
  for (let i = 0; i + blockN <= k.length; i += hopN) {
    let s = 0;
    for (let j = i; j < i + blockN; j++) s += k[j] * k[j];
    loud.push(-0.691 + 10 * Math.log10(Math.max(1e-16, s / blockN)));
  }
  const absGated = loud.filter(l => l > -70);
  if (!absGated.length) return -70;
  const meanOf = (arr) => {
    let s = 0;
    for (const l of arr) s += Math.pow(10, (l + 0.691) / 10);
    return -0.691 + 10 * Math.log10(s / arr.length);
  };
  const rel = meanOf(absGated) - 10;
  const relGated = absGated.filter(l => l > rel);
  return meanOf(relGated.length ? relGated : absGated);
}

export function peakOf(buf) {
  let p = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > p) p = a; }
  return p;
}

// ---------------------------------------------------------------------------
// dynamics
// ---------------------------------------------------------------------------
/** Soft-knee RMS compressor — glue, not loudness war. */
function compress(buf, sr, { threshDb = -22, ratio = 2.6, attack = 0.012, release = 0.18, makeup = 0 }) {
  const at = Math.exp(-1 / (attack * sr));
  const rt = Math.exp(-1 / (release * sr));
  const mk = LIN(makeup);
  let env = 0, g = 1;
  for (let i = 0; i < buf.length; i++) {
    const x = Math.abs(buf[i]);
    env = x > env ? x + (env - x) * at : x + (env - x) * rt;
    const db = DB(env);
    const over = db - threshDb;
    const targetG = over > 0 ? LIN(-over * (1 - 1 / ratio)) : 1;
    g += (targetG - g) * (targetG < g ? 0.25 : 0.02);
    buf[i] *= g * mk;
  }
  return buf;
}

/**
 * Look-ahead peak limiter — guarantees the ceiling, including under crossfade.
 *
 * The first version only shaped the gain BEFORE each peak (a backward pass
 * plus a forward min-smear both extend reduction earlier in time), so the
 * release after an isolated transient was instantaneous — a click on every
 * limited peak. Now: widen the minima over the look-ahead window, then run a
 * forward one-pole with instant attack and a ~90 ms release, which smooths
 * BOTH sides of the peak.
 */
function limit(buf, sr, ceiling) {
  const look = Math.max(1, Math.round(0.003 * sr));
  const rel = Math.exp(-1 / (0.09 * sr));
  const n = buf.length;
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(buf[i]);
    need[i] = a > ceiling ? ceiling / a : 1;
  }
  const wide = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = need[i];
    const lo = Math.max(0, i - look), hi = Math.min(n - 1, i + look);
    for (let j = lo; j <= hi; j++) if (need[j] < m) m = need[j];
    wide[i] = m;
  }
  let g = 1;
  for (let i = 0; i < n; i++) {
    g = Math.min(wide[i], 1 - (1 - g) * rel);   // snap down, recover slowly
    buf[i] *= g;
  }
  return buf;
}

// ---------------------------------------------------------------------------
export const MASTER = {
  /** Everything the station plays is normalised here, and nowhere else. */
  targetLufs: -19,
  /** Headroom for two normalised tracks overlapping mid-crossfade. */
  ceiling: LIN(-4.5),
  paLow: 88,
  paHigh: 7200,
};

/**
 * PA voicing + glue + normalisation. Returns the measured result so the caller
 * (and the tests) can see what was actually done rather than trusting it.
 */
export function masterTrack(buf, sr, opt = {}) {
  const targetLufs = opt.targetLufs ?? MASTER.targetLufs;
  const ceiling = opt.ceiling ?? MASTER.ceiling;

  // 1 - PA voicing: a ceiling array is not a hi-fi. Roll off what a 4" driver
  //     in a tile cannot reproduce, and lift 2.5 kHz where speech and guitars
  //     live so the music stays legible over room noise.
  applyBiquad(buf, biquad('highpass', opt.paLow ?? MASTER.paLow, sr, 0.7));
  applyBiquad(buf, biquad('lowpass', opt.paHigh ?? MASTER.paHigh, sr, 0.7));
  applyBiquad(buf, biquad('peaking', 120, sr, 0.9, -4.5));
  applyBiquad(buf, biquad('peaking', 300, sr, 0.9, -2.0));
  applyBiquad(buf, biquad('peaking', 1100, sr, 0.8, 2.0));
  applyBiquad(buf, biquad('peaking', 3000, sr, 1.0, 2.5));

  // 2 - gentle glue so the arrangement holds together
  compress(buf, sr, { threshDb: -24, ratio: 2.4 });

  // 3 - measure, normalise, limit — then CHECK, because limiting a dense mix
  //     pulls a decibel of loudness back out and a station whose funk tracks
  //     land a decibel under its ballads has exactly the volume-jump problem
  //     normalisation was supposed to remove. Two corrective passes converge.
  const before = measureLufs(buf, sr);
  let total = LIN(targetLufs - before);
  for (let i = 0; i < buf.length; i++) buf[i] *= total;
  if (peakOf(buf) > ceiling) limit(buf, sr, ceiling);

  for (let pass = 0; pass < 2; pass++) {
    const got = measureLufs(buf, sr);
    const err = targetLufs - got;
    if (Math.abs(err) < 0.15) break;
    const g = LIN(err);
    total *= g;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
    if (peakOf(buf) > ceiling) limit(buf, sr, ceiling);
  }

  const lufs = measureLufs(buf, sr);
  const peak = peakOf(buf);
  return { lufs, peak, peakDb: DB(peak), gainDb: DB(total), preLufs: before, clipped: peak > 0.999 };
}

/**
 * Drop the silence after the last audible sample.
 *
 * A track's buffer is bars*barSec plus a tail for the outro to ring into. The
 * station starts the next track `crossfade` seconds before the buffer ENDS, so
 * any unused tail is spent fading one track into silence and then out of it —
 * which measured as three one-second holes in the first 30-minute render. Trim
 * first, then cross-fade, and the join lands on music at both ends.
 */
export function trimTail(buf, sr, floorDb = -60) {
  const floor = LIN(floorDb);
  let last = buf.length - 1;
  while (last > 0 && Math.abs(buf[last]) < floor) last--;
  const keep = Math.min(buf.length, last + Math.round(0.12 * sr));
  if (keep >= buf.length) return buf;
  const out = buf.subarray(0, keep);
  // a short ramp so the truncation itself cannot click
  const n = Math.min(out.length, Math.round(0.05 * sr));
  for (let i = 0; i < n; i++) out[out.length - 1 - i] *= i / n;
  return out;
}

export { DB, LIN, applyBiquad, biquad };
