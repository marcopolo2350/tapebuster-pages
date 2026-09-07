// Harmonic GRAMMARS — the fix for the previous radio's actual defect.
//
// The old engine had two hard-coded chord tables (SECTION_A / SECTION_B) shared
// by every "track". Transposing that table into twelve keys does not produce
// twelve songs, it produces one song in twelve keys, which is exactly what a
// listener hears after four minutes.
//
// Here each grammar is a different WAY OF MOVING between chords, not a
// different list of chords. Two tracks from the same grammar still differ,
// because the walk is seeded; two tracks from different grammars differ in the
// way pop differs from jazz — cadence rate, chord vocabulary, root motion.

import { ri, pick, wpick } from './theory.js';

// root offsets (semitones above the tonic) by common function
const T = 0, II = 2, bIII = 3, III = 4, IV = 5, V = 7, bVI = 8, VI = 9, bVII = 10;

/** Fill `bars` with chords produced by a stateful step function. */
function walk(bars, step, harmonicRhythm) {
  const out = [];
  let filled = 0;
  while (filled < bars) {
    const c = step(out.length, bars - filled);
    const len = Math.min(c.bars ?? harmonicRhythm(out.length), bars - filled);
    out.push({ root: c.root, quality: c.quality, bars: len });
    filled += len;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1 - functional major pop: tonic / subdominant / dominant walk with cadences
// ---------------------------------------------------------------------------
function popFunctional(r, bars, opt) {
  const TON = [[5, [T, 'maj']], [3, [VI, 'min']], [1.2, [III, 'min']]];
  const SUB = [[5, [IV, 'maj']], [3, [II, 'min']], [1, [IV, 'six']]];
  const DOM = [[5, [V, 'maj']], [2.5, [V, 'dom7']], [1, [V, 'dom7sus']]];
  const NEXT = {
    t: [[1.5, 't'], [4, 's'], [3, 'd']],
    s: [[1.5, 's'], [4, 'd'], [2, 't']],
    d: [[6, 't'], [1, 's'], [0.8, 'd']],
  };
  let fn = 't';
  const colour = opt.colour ?? 0.3;
  return walk(bars, (i, left) => {
    if (i > 0) fn = wpick(r, NEXT[fn]);
    if (left <= 1 && fn !== 't') fn = 't';
    let [root, quality] = wpick(r, fn === 't' ? TON : fn === 's' ? SUB : DOM);
    if (r() < colour) {
      if (quality === 'maj') quality = pick(r, ['maj7', 'add9', 'six', 'sus2']);
      else if (quality === 'min') quality = pick(r, ['min7', 'min9']);
    }
    return { root, quality };
  }, () => (r() < 0.22 ? 2 : 1));
}

// ---------------------------------------------------------------------------
// 2 - minor / aeolian pop: the vi-IV-I-V family and its rotations
// ---------------------------------------------------------------------------
function minorPop(r, bars) {
  const POOL = [[T, 'min'], [bVI, 'maj'], [bIII, 'maj'], [bVII, 'maj'], [IV, 'min'], [V, 'min'], [V, 'dom7'], [T, 'min7']];
  const NEXT = {
    0: [[1, 5], [3, 1], [2, 3], [1.5, 4]],
    1: [[3, 2], [2, 3], [1, 0]],
    2: [[3, 3], [2, 1], [1.5, 0]],
    3: [[4, 0], [1.5, 1], [1, 6]],
    4: [[2, 6], [2, 3], [1, 0]],
    5: [[3, 0], [1, 1]],
    6: [[5, 0], [1, 1]],
    7: [[2, 1], [2, 3], [1, 4]],
  };
  let i = r() < 0.5 ? 0 : 1;
  return walk(bars, (n, left) => {
    if (n > 0) i = wpick(r, NEXT[i]);
    if (left <= 1 && i !== 0 && r() < 0.6) i = 0;
    const [root, quality] = POOL[i];
    return { root, quality };
  }, () => (r() < 0.3 ? 2 : 1));
}

// ---------------------------------------------------------------------------
// 3 - modal vamp: two or three chords, slow, no cadence at all
// ---------------------------------------------------------------------------
function modalVamp(r, bars) {
  const SHAPES = [
    [[T, 'min7'], [IV, 'maj']],
    [[T, 'min9'], [bVII, 'maj'], [IV, 'maj']],
    [[T, 'dom7'], [bVII, 'maj']],
    [[T, 'sus2'], [bVII, 'six']],
    [[T, 'maj7'], [II, 'min7']],
    [[T, 'min11'], [bIII, 'maj7']],
  ];
  const shape = pick(r, SHAPES);
  const len = r() < 0.5 ? 2 : 1;
  let i = 0;
  return walk(bars, () => {
    const [root, quality] = shape[i % shape.length];
    i++;
    return { root, quality, bars: len };
  }, () => len);
}

// ---------------------------------------------------------------------------
// 4 - jazz cycle: ii-V chains, secondary dominants, occasional tritone sub
// ---------------------------------------------------------------------------
function jazzCycle(r, bars) {
  const out = [];
  const TARGETS = [[T, 'maj7'], [VI, 'min7'], [IV, 'maj7'], [II, 'min7']];
  let filled = 0;
  while (filled < bars) {
    const [troot, tq] = filled + 3 >= bars ? TARGETS[0] : pick(r, TARGETS);
    const v = (troot + V) % 12;
    const ii = (troot + II) % 12;
    const sub = (v + 6) % 12;
    const cell = [];
    if (r() < 0.75 && bars - filled >= 3) cell.push({ root: ii, quality: pick(r, ['min7', 'min9', 'm7b5']), bars: 1 });
    cell.push({ root: r() < 0.22 ? sub : v, quality: pick(r, ['dom7', 'dom9', 'dom13']), bars: 1 });
    cell.push({ root: troot, quality: tq === 'maj7' ? pick(r, ['maj7', 'maj9', 'six']) : tq, bars: r() < 0.4 ? 2 : 1 });
    for (const c of cell) {
      if (filled >= bars) break;
      c.bars = Math.min(c.bars, bars - filled);
      out.push(c);
      filled += c.bars;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5 - blues-derived: dominant sevenths, bVII, plagal motion, no leading tone
// ---------------------------------------------------------------------------
function bluesBased(r, bars) {
  const FORM = pick(r, [
    [T, T, IV, T, IV, IV, T, V],
    [T, IV, T, T, IV, IV, T, T, V, IV, T, V],
    [T, bVII, IV, T],
    [T, T, bVII, IV, T, T, V, IV],
  ]);
  let i = 0;
  return walk(bars, () => {
    const root = FORM[i % FORM.length];
    i++;
    const quality = root === T && r() < 0.35 ? 'maj' : r() < 0.7 ? 'dom7' : pick(r, ['dom9', 'maj', 'dom7sus']);
    return { root, quality, bars: 1 };
  }, () => 1);
}

// ---------------------------------------------------------------------------
// 6 - R&B extended: ninths and thirteenths, chromatic approach, soft cadence
// ---------------------------------------------------------------------------
function rnbExtended(r, bars) {
  const POOL = [
    [II, 'min9'], [V, 'dom13'], [T, 'maj9'], [VI, 'min11'], [IV, 'maj7'],
    [bIII, 'maj7'], [bVI, 'maj9'], [III, 'dom7'], [IV, 'min6'], [T, 'six'],
  ];
  const NEXT = {
    0: [[5, 1], [1, 4]], 1: [[5, 2], [1.5, 3]], 2: [[2, 3], [2, 0], [1.5, 4], [1, 5]],
    3: [[3, 0], [2, 4], [1, 1]], 4: [[3, 1], [2, 0], [1, 8]], 5: [[3, 6], [2, 1]],
    6: [[3, 1], [2, 2]], 7: [[4, 3], [1, 0]], 8: [[4, 2], [1, 1]], 9: [[3, 0], [2, 3]],
  };
  let i = 2;
  return walk(bars, (n, left) => {
    if (n > 0) i = wpick(r, NEXT[i]);
    if (left <= 1 && r() < 0.5) i = 2;
    const [root, quality] = POOL[i];
    return { root, quality };
  }, () => (r() < 0.35 ? 2 : 1));
}

// ---------------------------------------------------------------------------
// 7 - cinematic drift: mediant motion, lydian colour, very slow harmonic rhythm
// ---------------------------------------------------------------------------
function cinematicDrift(r, bars) {
  const POOL = [[T, 'maj7'], [III, 'min7'], [IV, 'maj7s11'], [VI, 'min9'], [bVII, 'maj'], [II, 'min7'], [bVI, 'maj7']];
  let i = 0;
  return walk(bars, (n) => {
    if (n > 0) { let j = i; while (j === i) j = ri(r, POOL.length); i = j; }
    const [root, quality] = POOL[i];
    return { root, quality };
  }, () => (r() < 0.65 ? 2 : 4));
}

// ---------------------------------------------------------------------------
// 8 - new-wave: root motion by step and by third, suspensions, minor/major mix
// ---------------------------------------------------------------------------
function newWaveSteps(r, bars) {
  const POOL = [[T, 'min'], [bVII, 'maj'], [bVI, 'maj'], [V, 'min'], [IV, 'maj'], [bIII, 'maj'], [T, 'sus4'], [IV, 'sus2']];
  let i = 0;
  return walk(bars, (n) => {
    if (n > 0) {
      const dir = r() < 0.6 ? 1 : -1;
      i = (i + dir * (r() < 0.75 ? 1 : 2) + POOL.length) % POOL.length;
    }
    const [root, quality] = POOL[i];
    return { root, quality, bars: r() < 0.15 ? 2 : 1 };
  }, () => 1);
}

export const GRAMMARS = {
  popFunctional, minorPop, modalVamp, jazzCycle, bluesBased, rnbExtended, cinematicDrift, newWaveSteps,
};

/** Build a progression of `bars` bars using the named grammar. */
export function makeProgression(name, r, bars, opt = {}) {
  const g = GRAMMARS[name];
  if (!g) throw new Error(`unknown harmonic grammar: ${name}`);
  const prog = g(r, bars, opt);
  const total = prog.reduce((s, c) => s + c.bars, 0);
  if (total !== bars) throw new Error(`grammar ${name} produced ${total} bars, wanted ${bars}`);
  return prog;
}

/** Stable fingerprint of a progression - used by the diversity tests. */
export function progressionKey(prog) {
  return prog.map(c => `${c.root}${c.quality}:${c.bars}`).join('|');
}
