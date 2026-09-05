// Music theory primitives for the store radio.
//
// Deliberately free of the Web Audio API, of THREE, and of the DOM: everything
// here is arithmetic on numbers, so node:test can drive the SHIPPED harmony
// rather than a re-implementation of it. The previous radio failed review
// because tempo and key varied while the harmony never did — there was exactly
// one chord table in the file. This module exists so that harmony can be
// GENERATED per track from several different grammars instead.

/** Deterministic PRNG. Same seed, same track, forever. */
export function rng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Integer in [0, n). */
export const ri = (r, n) => Math.min(n - 1, (r() * n) | 0);
/** Uniform in [lo, hi]. */
export const rf = (r, lo, hi) => lo + r() * (hi - lo);
/** Pick one element. */
export const pick = (r, arr) => arr[ri(r, arr.length)];
/** Pick one element from [[weight, value], ...]. */
export function wpick(r, table) {
  let total = 0;
  for (const [w] of table) total += w;
  let x = r() * total;
  for (const [w, v] of table) { x -= w; if (x <= 0) return v; }
  return table[table.length - 1][1];
}

export const SCALES = {
  major:      [0, 2, 4, 5, 7, 9, 11],
  minor:      [0, 2, 3, 5, 7, 8, 10],
  dorian:     [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian:     [0, 2, 4, 6, 7, 9, 11],
};

// Chord qualities as semitone stacks above the root. The extensions matter:
// a station whose every chord is a plain triad reads as a MIDI demo, and one
// whose every chord is a maj9 reads as one lounge track on repeat. Families
// draw from different subsets of this table.
export const QUALITIES = {
  maj:     [0, 4, 7],
  min:     [0, 3, 7],
  sus4:    [0, 5, 7],
  sus2:    [0, 2, 7],
  six:     [0, 4, 7, 9],
  min6:    [0, 3, 7, 9],
  add9:    [0, 4, 7, 14],
  maj7:    [0, 4, 7, 11],
  min7:    [0, 3, 7, 10],
  dom7:    [0, 4, 7, 10],
  dom7sus: [0, 5, 7, 10],
  maj9:    [0, 4, 7, 11, 14],
  min9:    [0, 3, 7, 10, 14],
  dom9:    [0, 4, 7, 10, 14],
  min11:   [0, 3, 7, 10, 17],
  dom13:   [0, 4, 7, 10, 21],
  m7b5:    [0, 3, 6, 10],
  dim7:    [0, 3, 6, 9],
  maj7s11: [0, 4, 7, 11, 18],
  aug:     [0, 4, 8],
};

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const SUFFIX = {
  maj: '', min: 'm', sus4: 'sus4', sus2: 'sus2', six: '6', min6: 'm6', add9: 'add9',
  maj7: 'maj7', min7: 'm7', dom7: '7', dom7sus: '7sus4', maj9: 'maj9', min9: 'm9',
  dom9: '9', min11: 'm11', dom13: '13', m7b5: 'm7b5', dim7: 'dim7', maj7s11: 'maj7#11',
  aug: 'aug',
};

/** Absolute pitch classes of a chord rooted `root` semitones above the tonic. */
export function chordPitches(root, quality) {
  const q = QUALITIES[quality];
  if (!q) throw new Error(`unknown chord quality: ${quality}`);
  return q.map(i => root + i);
}

export function chordSymbol(key, root, quality) {
  return NAMES[(((key + root) % 12) + 12) % 12] + (SUFFIX[quality] ?? quality);
}

/** MIDI note for a scale degree (0-based, may exceed the octave). */
export function scaleNote(scale, degree, base = 60) {
  const s = SCALES[scale];
  const oct = Math.floor(degree / s.length);
  const idx = ((degree % s.length) + s.length) % s.length;
  return base + oct * 12 + s[idx];
}

/**
 * Voice a chord in a register window, moving as little as possible from the
 * previous voicing. Real voice leading is the single cheapest thing that makes
 * generated harmony stop sounding generated: parallel root-position triads
 * jumping around the keyboard is the giveaway sound of a chord-table player.
 */
export function voiceChord(pitches, prev, { center = 60, span = 14, voices = 4 } = {}) {
  const pcs = [...new Set(pitches.map(p => ((p % 12) + 12) % 12))];
  const wanted = Math.min(voices, pcs.length);
  // candidate notes for each pitch class inside the window
  const lo = center - span, hi = center + span;
  const cands = pcs.map((pc) => {
    const out = [];
    for (let m = lo - ((lo - pc) % 12 + 12) % 12; m <= hi; m += 12) if (m >= lo) out.push(m);
    return out.length ? out : [center + pc % 12];
  });
  // greedy: assign each previous voice to its nearest unused pitch class
  const chosen = [];
  const used = new Set();
  const prevNotes = (prev && prev.length) ? prev : [center - 5, center, center + 4, center + 7];
  for (const p of prevNotes) {
    if (chosen.length >= wanted) break;
    let best = null, bestD = Infinity, bestI = -1;
    for (let i = 0; i < cands.length; i++) {
      if (used.has(i)) continue;
      for (const m of cands[i]) {
        const d = Math.abs(m - p);
        if (d < bestD) { bestD = d; best = m; bestI = i; }
      }
    }
    if (best === null) break;
    used.add(bestI); chosen.push(best);
  }
  for (let i = 0; i < cands.length && chosen.length < wanted; i++) {
    if (used.has(i)) continue;
    used.add(i);
    let best = cands[i][0], bestD = Infinity;
    for (const m of cands[i]) { const d = Math.abs(m - center); if (d < bestD) { bestD = d; best = m; } }
    chosen.push(best);
  }
  return chosen.sort((a, b) => a - b);
}

/** Frequency of a MIDI note. */
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
