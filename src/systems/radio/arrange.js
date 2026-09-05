// Rhythmic and instrumental grammars: how a bar is actually PLAYED.
//
// Three independent axes, each with its own vocabulary, so that two tracks
// sharing a chord progression still sound like different records:
//
//   GROOVES      what the kit does          (10 grammars)
//   BASS STYLES  what the low end does      (7 grammars)
//   CHORD STYLES what the comping does      (7 grammars)
//
// Everything returns plain event objects {t, voice, pitch, dur, gain, pan}
// with t in seconds. No audio API, no DOM — tests drive these directly.

import { ri, rf, pick } from './theory.js';

/** Position (in beats from the bar start) to absolute seconds, with swing. */
function swinger(bar0, beat, swing, sub) {
  const step = sub === 16 ? 0.25 : 0.5;
  return (pos) => {
    const k = Math.round(pos / step);
    const off = (k % 2 === 1) ? swing * beat * (sub === 16 ? 0.5 : 1) : 0;
    return bar0 + pos * beat + off;
  };
}

const ev = (t, voice, gain, { pitch = null, dur = 0.1, pan = 0 } = {}) => ({ t, voice, pitch, dur, gain, pan });

// ---------------------------------------------------------------------------
// GROOVES
// ---------------------------------------------------------------------------
// ctx: { bar0, beat, swing, density, energy, fill, first, kit, r }
const GROOVES = {
  // 1 - straight eights: the pop-rock backbeat
  straight8(ctx, out) {
    const { r, beat, energy, density, kit } = ctx;
    const at = swinger(ctx.bar0, beat, ctx.swing, 8);
    out.push(ev(at(0), 'kick', 0.9 * energy));
    if (r() < 0.55 * density) out.push(ev(at(2.5), 'kick', 0.7 * energy));
    out.push(ev(at(2), 'kick', 0.75 * energy));
    out.push(ev(at(1), kit.snare, 0.85 * energy));
    out.push(ev(at(3), kit.snare, 0.88 * energy));
    for (let e = 0; e < 8; e++) {
      if (density < 0.6 && e % 2) continue;
      out.push(ev(at(e * 0.5), kit.hat, (e % 2 ? 0.32 : 0.55) * energy, { pan: 0.18 }));
    }
    if (kit.extra === 'tamb' && energy > 0.7) for (let e = 1; e < 8; e += 2) out.push(ev(at(e * 0.5), 'tamb', 0.3 * energy, { pan: -0.25 }));
  },
  // 2 - straight sixteenths: funk kit, ghost notes, tight hats
  straight16(ctx, out) {
    const { r, beat, energy, density, kit } = ctx;
    const at = swinger(ctx.bar0, beat, ctx.swing, 16);
    out.push(ev(at(0), 'kick', 0.95 * energy));
    for (const p of [0.75, 1.5, 2.25, 2.75, 3.5]) if (r() < 0.45 * density) out.push(ev(at(p), 'kick', 0.6 * energy));
    out.push(ev(at(1), kit.snare, 0.9 * energy));
    out.push(ev(at(3), kit.snare, 0.9 * energy));
    for (const p of [0.75, 1.75, 2.5, 3.75]) if (r() < 0.4 * density) out.push(ev(at(p), kit.snare, 0.16 * energy)); // ghosts
    for (let e = 0; e < 16; e++) {
      const p = e * 0.25;
      const acc = e % 4 === 0 ? 0.5 : e % 2 === 0 ? 0.3 : 0.18;
      out.push(ev(at(p), kit.hat, acc * energy, { pan: 0.2 }));
    }
    if (kit.extra === 'shaker') for (let e = 0; e < 8; e++) out.push(ev(at(e * 0.5 + 0.25), 'shaker', 0.22 * energy, { pan: -0.3 }));
  },
  // 3 - swung sixteenths: R&B pocket
  swing16(ctx, out) {
    const { r, beat, energy, density, kit } = ctx;
    const at = swinger(ctx.bar0, beat, ctx.swing, 16);
    out.push(ev(at(0), 'kick', 0.88 * energy));
    for (const p of [1.75, 2.5, 3.25]) if (r() < 0.55 * density) out.push(ev(at(p), 'kick', 0.62 * energy));
    out.push(ev(at(1), kit.snare, 0.8 * energy));
    out.push(ev(at(3), kit.snare, 0.82 * energy));
    for (const p of [1.75, 3.5]) if (r() < 0.5) out.push(ev(at(p), kit.snare, 0.14 * energy));
    for (let e = 0; e < 16; e++) {
      if (density < 0.7 && e % 2) continue;
      out.push(ev(at(e * 0.25), kit.hat, (e % 4 === 0 ? 0.44 : e % 2 === 0 ? 0.26 : 0.14) * energy, { pan: 0.22 }));
    }
    if (kit.extra === 'shaker') for (let e = 0; e < 4; e++) out.push(ev(at(e + 0.5), 'shaker', 0.2 * energy, { pan: -0.3 }));
  },
  // 4 - shuffle: triplet ride, retro rock
  shuffle(ctx, out) {
    const { r, beat, energy, density, kit } = ctx;
    const at = (p) => ctx.bar0 + p * beat;
    out.push(ev(at(0), 'kick', 0.95 * energy));
    out.push(ev(at(2), 'kick', 0.85 * energy));
    if (r() < 0.4 * density) out.push(ev(at(2.667), 'kick', 0.55 * energy));
    out.push(ev(at(1), kit.snare, 0.9 * energy));
    out.push(ev(at(3), kit.snare, 0.92 * energy));
    for (let b = 0; b < 4; b++) {
      out.push(ev(at(b), kit.hat, 0.5 * energy, { pan: 0.2 }));
      out.push(ev(at(b + 0.667), kit.hat, 0.28 * energy, { pan: 0.2 }));
    }
  },
  // 5 - four on the floor: new-wave / synth-pop
  fourfloor(ctx, out) {
    const { beat, energy, density, kit, r } = ctx;
    const at = (p) => ctx.bar0 + p * beat;
    for (let b = 0; b < 4; b++) out.push(ev(at(b), 'kick', (b % 2 ? 0.82 : 0.95) * energy));
    out.push(ev(at(1), kit.snare, 0.8 * energy));
    out.push(ev(at(3), kit.snare, 0.84 * energy));
    for (let e = 0; e < 8; e++) {
      if (e % 2 === 1) out.push(ev(at(e * 0.5), 'ohat', 0.34 * energy, { pan: -0.15 }));
      else if (density > 0.7) out.push(ev(at(e * 0.5), 'hat', 0.2 * energy, { pan: 0.15 }));
    }
    if (r() < 0.3) out.push(ev(at(3.5), 'tom', 0.4 * energy, { pitch: 52 }));
  },
  // 6 - halftime: soundtrack space
  halftime(ctx, out) {
    const { beat, energy, density, kit, r } = ctx;
    const at = (p) => ctx.bar0 + p * beat;
    out.push(ev(at(0), 'kick', 0.8 * energy));
    if (r() < 0.35 * density) out.push(ev(at(1.5), 'kick', 0.5 * energy));
    out.push(ev(at(2), kit.snare, 0.7 * energy));
    if (density > 0.45) for (let e = 0; e < 4; e++) out.push(ev(at(e), kit.hat, 0.22 * energy, { pan: -0.2 }));
  },
  // 7 - brushed: jazz-pop, ride-led with feathered kick
  brushed(ctx, out) {
    const { beat, energy, kit, r } = ctx;
    const at = swinger(ctx.bar0, beat, Math.max(0.14, ctx.swing), 8);
    for (const [p, g] of [[0, 0.45], [1, 0.3], [1.5, 0.34], [2, 0.42], [3, 0.3], [3.5, 0.34]]) {
      out.push(ev(at(p), kit.hat, g * energy, { pan: 0.25 }));
    }
    out.push(ev(at(1), kit.snare, 0.35 * energy));
    out.push(ev(at(3), kit.snare, 0.38 * energy));
    for (let b = 0; b < 4; b++) out.push(ev(at(b), 'kick', 0.28 * energy));
    if (r() < 0.3) out.push(ev(at(2.5), kit.snare, 0.18 * energy));
  },
  // 8 - ballad: soft AC, rim on the backbeat
  ballad(ctx, out) {
    const { beat, energy, density, kit, r } = ctx;
    const at = swinger(ctx.bar0, beat, ctx.swing, 8);
    out.push(ev(at(0), 'kick', 0.72 * energy));
    out.push(ev(at(2), 'kick', 0.6 * energy));
    if (r() < 0.25 * density) out.push(ev(at(3.5), 'kick', 0.4 * energy));
    out.push(ev(at(1), kit.snare, 0.5 * energy));
    out.push(ev(at(3), kit.snare, 0.54 * energy));
    for (let e = 0; e < 8; e++) {
      if (density < 0.55 && e % 2) continue;
      out.push(ev(at(e * 0.5), kit.hat, (e % 2 ? 0.26 : 0.44) * energy, { pan: 0.2 }));
    }
  },
  // 9 - acoustic: shaker-led, light kit
  acoustic(ctx, out) {
    const { beat, energy, density, kit, r } = ctx;
    const at = swinger(ctx.bar0, beat, ctx.swing, 8);
    out.push(ev(at(0), 'kick', 0.8 * energy));
    out.push(ev(at(2), 'kick', 0.7 * energy));
    if (r() < 0.3 * density) out.push(ev(at(2.5), 'kick', 0.45 * energy));
    out.push(ev(at(1), kit.snare, 0.7 * energy));
    out.push(ev(at(3), kit.snare, 0.72 * energy));
    for (let e = 0; e < 8; e++) out.push(ev(at(e * 0.5), 'shaker', (e % 2 ? 0.18 : 0.3) * energy, { pan: -0.25 }));
    if (kit.extra === 'tamb' && energy > 0.75) { out.push(ev(at(1), 'tamb', 0.34 * energy, { pan: 0.3 })); out.push(ev(at(3), 'tamb', 0.34 * energy, { pan: 0.3 })); }
  },
  // 10 - push-pop: late-night, kick pushes into 3, rim backbeat, wide space
  pushPop(ctx, out) {
    const { beat, energy, density, kit, r } = ctx;
    const at = swinger(ctx.bar0, beat, ctx.swing, 16);
    out.push(ev(at(0), 'kick', 0.85 * energy));
    out.push(ev(at(1.75), 'kick', 0.62 * energy));
    if (r() < 0.4 * density) out.push(ev(at(3.25), 'kick', 0.45 * energy));
    out.push(ev(at(1), kit.snare, 0.6 * energy));
    out.push(ev(at(3), kit.snare, 0.62 * energy));
    for (let e = 0; e < 8; e++) {
      if (density < 0.5 && e % 2) continue;
      out.push(ev(at(e * 0.5), kit.hat, (e % 2 ? 0.14 : 0.24) * energy, { pan: e % 2 ? -0.22 : 0.22 }));
    }
  },
};

export const GROOVE_NAMES = Object.keys(GROOVES);

/** One bar of drums. Adds a fill on the bar before a section change. */
export function grooveBar(name, ctx, out) {
  const g = GROOVES[name];
  if (!g) throw new Error(`unknown groove: ${name}`);
  const before = out.length;
  g(ctx, out);
  if (ctx.fill) addFill(ctx, out);
  if (ctx.crash) out.push(ev(ctx.bar0, 'crash', 0.5 * ctx.energy, { pan: -0.1 }));
  // humanise: +/-9 ms and a small velocity spread, so the kit is not a grid
  for (let i = before; i < out.length; i++) {
    out[i].t += (ctx.r() - 0.5) * 0.018;
    out[i].gain *= 0.88 + ctx.r() * 0.24;
  }
  return out;
}

function addFill(ctx, out) {
  const { r, beat, energy, kit } = ctx;
  const at = (p) => ctx.bar0 + p * beat;
  // clear the last two beats so the fill is audible
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].t >= at(2) && (out[i].voice === kit.hat || out[i].voice === 'shaker')) out.splice(i, 1);
  }
  const style = ri(r, 3);
  if (style === 0) {
    for (const [p, pitch] of [[2, 57], [2.5, 55], [3, 52], [3.5, 48]]) out.push(ev(at(p), 'tom', 0.7 * energy, { pitch, pan: (pitch - 52) / 40 }));
  } else if (style === 1) {
    for (let i = 0; i < 8; i++) out.push(ev(at(2 + i * 0.25), kit.snare === 'clap' ? 'snare' : kit.snare, (0.3 + i * 0.06) * energy));
  } else {
    out.push(ev(at(3), kit.snare === 'clap' ? 'snare' : kit.snare, 0.5 * energy));
    out.push(ev(at(3.5), 'tom', 0.6 * energy, { pitch: 50 }));
    out.push(ev(at(3.75), 'tom', 0.65 * energy, { pitch: 45 }));
  }
}

// ---------------------------------------------------------------------------
// BASS
// ---------------------------------------------------------------------------
// chord: { root (midi, low register), pitches (midi pcs), nextRoot (midi) }
const BASS = {
  root(ch, ctx, out) {
    const at = swinger(ctx.bar0, ctx.beat, ctx.swing, 8);
    out.push(ev(at(0), ctx.voice, 0.9, { pitch: ch.root, dur: ctx.beat * 1.6 }));
    out.push(ev(at(2), ctx.voice, 0.8, { pitch: ch.root, dur: ctx.beat * 1.6 }));
    if (ctx.last && ctx.r() < 0.6) out.push(ev(at(3.5), ctx.voice, 0.6, { pitch: approach(ch), dur: ctx.beat * 0.4 }));
  },
  halfnote(ch, ctx, out) {
    out.push(ev(ctx.bar0, ctx.voice, 0.85, { pitch: ch.root, dur: ctx.beat * 3.6 }));
    if (ctx.last) out.push(ev(ctx.bar0 + ctx.beat * 3.5, ctx.voice, 0.55, { pitch: approach(ch), dur: ctx.beat * 0.5 }));
  },
  pump(ch, ctx, out) {
    const at = (p) => ctx.bar0 + p * ctx.beat;
    for (let e = 0; e < 8; e++) {
      const p = e * 0.5;
      const pitch = (e === 7 && ctx.last) ? approach(ch) : ch.root;
      out.push(ev(at(p), ctx.voice, e % 2 ? 0.62 : 0.9, { pitch, dur: ctx.beat * 0.42 }));
    }
  },
  octave(ch, ctx, out) {
    const at = (p) => ctx.bar0 + p * ctx.beat;
    for (let e = 0; e < 8; e++) out.push(ev(at(e * 0.5), ctx.voice, e % 2 ? 0.6 : 0.9, { pitch: ch.root + (e % 2 ? 12 : 0), dur: ctx.beat * 0.4 }));
  },
  sync16(ch, ctx, out) {
    const at = swinger(ctx.bar0, ctx.beat, ctx.swing, 16);
    const r = ctx.r;
    const tones = [ch.root, ch.root + 12, ch.root + (ch.pitches[1] - ch.pitches[0]), ch.root + 7];
    const grid = [0, 0.75, 1.5, 1.75, 2.5, 3, 3.75];
    out.push(ev(at(0), ctx.voice, 0.95, { pitch: ch.root, dur: ctx.beat * 0.35 }));
    for (const p of grid.slice(1)) {
      if (p !== 2.5 && r() > 0.62) continue;   // the mid-bar anchor always lands
      const pitch = r() < 0.6 ? ch.root : pick(r, tones);
      out.push(ev(at(p), ctx.voice, 0.55 + r() * 0.3, { pitch, dur: ctx.beat * 0.3 }));
    }
    if (ctx.last) out.push(ev(at(3.75), ctx.voice, 0.7, { pitch: approach(ch), dur: ctx.beat * 0.3 }));
  },
  walk(ch, ctx, out) {
    const at = (p) => ctx.bar0 + p * ctx.beat;
    const r = ctx.r;
    let prev = ch.root;
    for (let b = 0; b < 4; b++) {
      let pitch;
      if (b === 0) pitch = ch.root;
      else if (b === 3) pitch = approach(ch);
      else {
        const opts = ch.pitches.map(p => nearOctave(p, prev)).filter(p => p !== prev);
        pitch = opts.length ? opts[ri(r, opts.length)] : prev + (r() < 0.5 ? 2 : -2);
      }
      out.push(ev(at(b), ctx.voice, b === 0 ? 0.9 : 0.72, { pitch, dur: ctx.beat * 0.9 }));
      prev = pitch;
    }
  },
  melodic(ch, ctx, out) {
    const at = swinger(ctx.bar0, ctx.beat, ctx.swing, 8);
    const r = ctx.r;
    out.push(ev(at(0), ctx.voice, 0.92, { pitch: ch.root, dur: ctx.beat * 1.3 }));
    const fifth = nearOctave(ch.pitches[2] ?? ch.pitches[0] + 7, ch.root);
    if (r() < 0.7) out.push(ev(at(1.5), ctx.voice, 0.6, { pitch: fifth, dur: ctx.beat * 0.5 }));
    out.push(ev(at(2), ctx.voice, 0.82, { pitch: ch.root, dur: ctx.beat * 1.1 }));
    if (r() < 0.5) out.push(ev(at(3), ctx.voice, 0.6, { pitch: nearOctave(ch.pitches[1], ch.root), dur: ctx.beat * 0.5 }));
    if (ctx.last) out.push(ev(at(3.5), ctx.voice, 0.66, { pitch: approach(ch), dur: ctx.beat * 0.5 }));
  },
};
export const BASS_NAMES = Object.keys(BASS);

const nearOctave = (pc, ref) => {
  let m = ((pc % 12) + 12) % 12;
  while (m < ref - 6) m += 12;
  while (m > ref + 6) m -= 12;
  return m;
};
const approach = (ch) => {
  if (ch.nextRoot == null) return ch.root;
  const target = nearOctave(ch.nextRoot, ch.root);
  return target === ch.root ? ch.root - 1 : target + (target > ch.root ? -1 : 1);
};

export function bassBar(style, ch, ctx, out) {
  const b = BASS[style];
  if (!b) throw new Error(`unknown bass style: ${style}`);
  const before = out.length;
  b(ch, ctx, out);
  for (let i = before; i < out.length; i++) {
    out[i].t += (ctx.r() - 0.5) * 0.014;
    out[i].gain *= (0.9 + ctx.r() * 0.16) * ctx.level;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CHORDS / COMPING
// ---------------------------------------------------------------------------
const CHORDS = {
  pad(notes, ctx, out) {
    notes.forEach((m, i) => out.push(ev(ctx.bar0 + i * 0.012, ctx.voice, 0.62, { pitch: m, dur: ctx.beat * 4.4, pan: i % 2 ? 0.22 : -0.22 })));
  },
  stab(notes, ctx, out) {
    const at = swinger(ctx.bar0, ctx.beat, ctx.swing, 8);
    const hits = ctx.r() < 0.45 ? [0, 2, 3.5] : [0, 2];
    for (const p of hits) notes.forEach((m, i) => out.push(ev(at(p) + i * 0.006, ctx.voice, 0.7, { pitch: m, dur: ctx.beat * 0.7, pan: i % 2 ? 0.2 : -0.2 })));
  },
  skank(notes, ctx, out) {
    const at = swinger(ctx.bar0, ctx.beat, ctx.swing, 8);
    for (const p of [0.5, 1.5, 2.5, 3.5]) {
      if (ctx.r() < 0.15) continue;
      notes.slice(1).forEach((m, i) => out.push(ev(at(p) + i * 0.005, ctx.voice, 0.6, { pitch: m, dur: ctx.beat * 0.34, pan: i % 2 ? 0.24 : -0.24 })));
    }
  },
  arp(notes, ctx, out) {
    const at = swinger(ctx.bar0, ctx.beat, ctx.swing, 8);
    const up = [...notes, ...notes.slice(0, -1).reverse()];
    const step = ctx.dense ? 0.25 : 0.5;
    for (let k = 0; k * step < 4; k++) {
      const m = up[k % up.length] + (k >= up.length && ctx.r() < 0.3 ? 12 : 0);
      out.push(ev(at(k * step), ctx.voice, 0.55 + (k % up.length === 0 ? 0.16 : 0), { pitch: m, dur: ctx.beat * 0.9, pan: (k % 3 - 1) * 0.2 }));
    }
  },
  strum(notes, ctx, out) {
    const at = swinger(ctx.bar0, ctx.beat, ctx.swing, 8);
    const pattern = ctx.dense ? [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] : [0, 1, 1.5, 2.5, 3];
    for (const p of pattern) {
      const down = (Math.round(p * 2) % 2) === 0;
      const seq = down ? notes : [...notes].reverse();
      seq.forEach((m, i) => out.push(ev(at(p) + i * 0.011, ctx.voice, (down ? 0.66 : 0.45), { pitch: m, dur: ctx.beat * 0.8, pan: (i / seq.length - 0.5) * 0.5 })));
    }
  },
  comp(notes, ctx, out) {
    const at = swinger(ctx.bar0, ctx.beat, ctx.swing, 8);
    const r = ctx.r;
    const cells = [[0.5, 2.5], [0, 1.5, 3], [1.5, 2.5], [0, 2.5, 3.5], [1, 3]];
    for (const p of cells[ri(r, cells.length)]) {
      notes.forEach((m, i) => out.push(ev(at(p) + i * 0.008, ctx.voice, 0.58 + r() * 0.18, { pitch: m, dur: ctx.beat * (r() < 0.4 ? 1.6 : 0.55), pan: i % 2 ? 0.2 : -0.2 })));
    }
  },
  pulse16(notes, ctx, out) {
    const at = swinger(ctx.bar0, ctx.beat, ctx.swing, 16);
    const top = notes.slice(-2);
    for (let e = 0; e < 16; e++) {
      // beats 1 and 3 always sound. The gate is what makes the part funky,
      // but nine skipped slots in a row once put a 1.35 s hole of silence in
      // an intro where the clav was the only instrument playing.
      if (e % 8 !== 0 && ctx.r() < 0.42) continue;
      top.forEach((m, i) => out.push(ev(at(e * 0.25) + i * 0.005, ctx.voice, (e % 4 === 0 ? 0.66 : 0.44), { pitch: m, dur: ctx.beat * 0.18, pan: i ? 0.26 : -0.26 })));
    }
  },
};
export const CHORD_NAMES = Object.keys(CHORDS);

export function chordBar(style, notes, ctx, out) {
  const c = CHORDS[style];
  if (!c) throw new Error(`unknown chord style: ${style}`);
  const before = out.length;
  c(notes, ctx, out);
  for (let i = before; i < out.length; i++) {
    out[i].t += (ctx.r() - 0.5) * 0.016;
    out[i].gain *= (0.9 + ctx.r() * 0.18) * ctx.level;
  }
  return out;
}
