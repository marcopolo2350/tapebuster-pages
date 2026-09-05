// The track compiler: seed -> a whole song.
//
// Output is a plain object with a section plan, a per-bar chord chart and a
// flat, time-sorted event list. Nothing here touches audio: tests assert the
// SHIPPED structure, and scripts/render-radio.mjs renders the same objects to
// WAV so a human can listen to exactly what the browser will play.
//
// The old engine's fundamental unit was an infinite 8-bar loop. Here the unit
// is a SONG: an intro that is not the verse, verses and choruses on different
// progressions, a bridge that changes the arrangement, and a written ending.

import { rng, ri, rf, pick, wpick, SCALES, scaleNote, voiceChord, chordPitches, chordSymbol } from './theory.js';
import { makeProgression, progressionKey } from './harmony.js';
import { grooveBar, bassBar, chordBar } from './arrange.js';
import { FAMILIES } from './families.js';

// ---------------------------------------------------------------------------
// structure templates — bar counts get repeated until the track hits its
// family's target duration, so a 128 BPM pop tune and a 70 BPM soundtrack
// piece both land in the 2.5-5.5 minute window without sharing a bar count.
// ---------------------------------------------------------------------------
const STRUCTURES = {
  pop:      { intro: 4, outro: 6,  core: [['A', 8], ['B', 8], ['A2', 8], ['BRIDGE', 8], ['B2', 8], ['A3', 8], ['B3', 8]] },
  extended: { intro: 8, outro: 8,  core: [['A', 16], ['B', 8], ['A2', 16], ['BRIDGE', 8], ['B2', 16], ['A3', 16]] },
  vamp:     { intro: 8, outro: 8,  core: [['A', 16], ['B', 16], ['A2', 16], ['C', 8], ['B2', 16], ['A3', 16]] },
  ballad:   { intro: 8, outro: 10, core: [['A', 12], ['B', 8], ['A2', 12], ['BRIDGE', 8], ['B2', 12], ['A3', 12]] },
  jazzform: { intro: 4, outro: 8,  core: [['A', 16], ['B', 16], ['SOLO', 16], ['A2', 16], ['B2', 16]] },
};

// what each section role does to the arrangement
const ROLES = {
  INTRO:  { energy: 0.5,  density: 0.55, drums: 0.5, bass: 0.8, chords: 0.9, pad: 1.1, lead: 0 },
  A:      { energy: 0.82, density: 0.85, drums: 1,   bass: 1,   chords: 1,   pad: 0.7, lead: 1 },
  B:      { energy: 1.0,  density: 1,    drums: 1,   bass: 1,   chords: 1.05, pad: 1,  lead: 1 },
  BRIDGE: { energy: 0.62, density: 0.6,  drums: 0.7, bass: 0.9, chords: 0.95, pad: 1.2, lead: 0.4 },
  SOLO:   { energy: 0.9,  density: 0.9,  drums: 1,   bass: 1,   chords: 0.9, pad: 0.6, lead: 1.15 },
  C:      { energy: 0.42, density: 0.35, drums: 0,   bass: 0.7, chords: 0.9, pad: 1.3, lead: 0.5 },
  OUTRO:  { energy: 0.55, density: 0.5,  drums: 0.6, bass: 0.85, chords: 0.9, pad: 1.1, lead: 0.5 },
};
const roleOf = (name) => name.replace(/\d+$/, '');

// ---------------------------------------------------------------------------
// motifs — the reason a track sounds written rather than sampled from a
// distribution. One melodic cell per section family, then real variation
// operators, so a returning verse is recognisably the same tune.
// ---------------------------------------------------------------------------
function makeMotif(r, { bars = 2, sparse = 0.25 } = {}) {
  const cell = [];
  let beats = 0;
  const total = bars * 4;
  let deg = ri(r, 5);
  while (beats < total) {
    const dur = wpick(r, [[3, 0.5], [4, 1], [2, 1.5], [1.5, 2], [1, 0.25]]);
    if (beats + dur > total) break;
    if (r() < sparse) { beats += dur; continue; }           // a real rest
    cell.push({ at: beats, dur, deg });
    const leap = r() < 0.18 ? (r() < 0.5 ? 3 : -3) : (r() < 0.55 ? 1 : -1);
    deg = Math.max(-4, Math.min(9, deg + leap));
    beats += dur;
  }
  if (!cell.length) cell.push({ at: 0, dur: 2, deg: 0 });
  return cell;
}

const VARIATIONS = {
  same: (m) => m,
  transpose: (m, r) => { const d = pick(r, [1, 2, -1, -2]); return m.map(n => ({ ...n, deg: n.deg + d })); },
  invert: (m) => { const p = m[0].deg; return m.map(n => ({ ...n, deg: 2 * p - n.deg })); },
  displace: (m, r) => { const s = pick(r, [0.5, -0.5, 1]); return m.map(n => ({ ...n, at: Math.max(0, n.at + s) })); },
  ornament: (m, r) => m.flatMap(n => (n.dur >= 1 && r() < 0.45)
    ? [{ ...n, dur: n.dur / 2 }, { at: n.at + n.dur / 2, dur: n.dur / 2, deg: n.deg + (r() < 0.5 ? 1 : -1) }]
    : [n]),
  fragment: (m) => m.slice(0, Math.max(2, Math.ceil(m.length * 0.6))),
  sustain: (m) => m.map((n, i) => (i === m.length - 1 ? { ...n, dur: n.dur * 2 } : n)),
};
export const VARIATION_NAMES = Object.keys(VARIATIONS);

// ---------------------------------------------------------------------------
// track names — a station whose tracks are called "Track 41" is not a station
// ---------------------------------------------------------------------------
const NAME_A = ['Aisle', 'Late', 'Blue', 'Two For', 'Rewind', 'New Release', 'Closing', 'Be Kind', 'Snack', 'Family',
  'Overnight', 'Staff', 'Weekend', 'Double', 'Midnight', 'Saturday', 'Corner', 'Neon', 'Paper', 'Counter',
  'Back Row', 'First Run', 'Long Play', 'Cassette', 'Coming', 'Third', 'Open', 'Quiet', 'Bright', 'Slow'];
const NAME_B = ['Seven', 'Return', 'Sunday', 'Tuesday', 'Kids', 'Wall', 'Time', 'Rewind', 'Counter', 'Night',
  'Drop', 'Pick', 'Matinee', 'Feature', 'Shift', 'Aisle', 'Window', 'Sign', 'Sleeve', 'Queue',
  'Special', 'Preview', 'Hold', 'Deck', 'Attraction', 'Screen', 'Late', 'Hours', 'Lights', 'Lane'];

// ---------------------------------------------------------------------------

/** Compile one complete track from a seed. Deterministic. */
export function composeTrack(seed, familyId = null) {
  const r = rng(seed);
  const fam = familyId ? FAMILIES.find(f => f.id === familyId) : FAMILIES[ri(r, FAMILIES.length)];
  if (!fam) throw new Error(`unknown family: ${familyId}`);

  const bpm = Math.round(rf(r, fam.bpm[0], fam.bpm[1]));
  const beat = 60 / bpm;
  const barSec = beat * 4;
  const key = ri(r, 12);
  const scale = pick(r, fam.scales);
  const grammar = wpick(r, fam.grammars.map(([g, w]) => [w, g]));
  const swing = rf(r, fam.swing[0], fam.swing[1]);
  const targetDur = rf(r, fam.duration[0], fam.duration[1]);

  // ---- structure -----------------------------------------------------------
  const st = STRUCTURES[fam.structure];
  // A section is a length of TIME, not a count of bars: eight bars at 128 BPM
  // is fifteen seconds, which reads as a fragment, while eight bars at 70 BPM
  // is a verse. Scaling by tempo is what keeps every family's form legible.
  const mult = bpm >= 118 ? 2 : bpm >= 100 ? 1.5 : 1;
  const scaleBars = (n) => Math.max(4, Math.round(n * mult / 4) * 4);
  const plan = [{ name: 'INTRO', bars: scaleBars(st.intro) }];
  const rot = ri(r, 2);
  const seen = Object.create(null);
  let bars = plan[0].bars;
  const outroBars = scaleBars(st.outro);
  for (let i = 0; bars + outroBars < targetDur / barSec && i < 24; i++) {
    const role = roleOf(st.core[(i + rot) % st.core.length][0]);
    const len = scaleBars(st.core[(i + rot) % st.core.length][1]);
    seen[role] = (seen[role] ?? 0) + 1;
    plan.push({ name: role + (seen[role] > 1 ? String(seen[role]) : ''), bars: len });
    bars += len;
  }
  while (plan.length < 5) {
    const [n, l] = st.core[plan.length - 1];
    const role = roleOf(n);
    seen[role] = (seen[role] ?? 0) + 1;
    plan.push({ name: role + (seen[role] > 1 ? String(seen[role]) : ''), bars: scaleBars(l) });
    bars += plan[plan.length - 1].bars;
  }
  // hard ceiling: nothing on a store radio should run past five and a half
  // minutes, and scaleBars() rounding can overshoot the family's target
  while (plan.length > 5 && (bars + outroBars) * barSec > 325) { bars -= plan.pop().bars; }
  plan.push({ name: 'OUTRO', bars: outroBars });
  bars += outroBars;

  let at = 0;
  for (const s of plan) { s.bar = at; s.role = roleOf(s.name); at += s.bars; }

  // ---- harmony: separate progressions for the verse / chorus / bridge -------
  const progs = {
    A: makeProgression(grammar, r, 8, { colour: fam.density * 0.4 }),
    B: makeProgression(grammar, r, 8, { colour: fam.density * 0.5 }),
    BRIDGE: makeProgression(wpick(r, fam.grammars.map(([g, w]) => [w, g])), r, 8, { colour: 0.5 }),
  };
  // A vamp grammar with a two-chord shape can deal the chorus the exact hand
  // it dealt the verse, and a track whose A and B sections share a chart has
  // no chorus at all. Redraw until they differ; the walk is stateful, so a
  // redraw is a different progression, not the same one reshuffled.
  for (let tries = 0; progressionKey(progs.B) === progressionKey(progs.A) && tries < 6; tries++) {
    progs.B = makeProgression(grammar, r, 8, { colour: Math.min(1, fam.density * 0.5 + 0.2) });
  }
  progs.C = progs.BRIDGE;
  progs.SOLO = progs.A;
  progs.INTRO = progs.A;
  progs.OUTRO = progs.A;

  // per-bar chart
  const chart = [];
  for (const s of plan) {
    const prog = progs[s.role] ?? progs.A;
    const flat = [];
    for (const c of prog) for (let i = 0; i < c.bars; i++) flat.push({ ...c, held: i > 0 });
    for (let b = 0; b < s.bars; b++) chart.push({ ...flat[b % flat.length], bar: s.bar + b, section: s });
  }

  // voice-led chord shapes, computed once for the whole track
  let prevVoicing = null;
  for (const c of chart) {
    if (c.held && prevVoicing) { c.notes = prevVoicing; continue; }
    const pcs = chordPitches(key + c.root, c.quality);
    c.notes = voiceChord(pcs, prevVoicing, { center: fam.chordCenter, voices: Math.min(4, pcs.length) });
    c.symbol = chordSymbol(key, c.root, c.quality);
    prevVoicing = c.notes;
  }
  for (let i = 0; i < chart.length; i++) {
    const nx = chart[(i + 1) % chart.length];
    chart[i].bassRoot = lowRoot(key + chart[i].root, fam.bassStyle);
    chart[i].nextRootRaw = key + nx.root;
  }
  for (const c of chart) c.nextRoot = lowRoot(c.nextRootRaw, fam.bassStyle);

  // ---- motifs --------------------------------------------------------------
  const motifs = { A: makeMotif(r, { sparse: 0.3 - fam.density * 0.1 }), B: makeMotif(r, { sparse: 0.2 }) };
  motifs.BRIDGE = VARIATIONS.invert(motifs.A, r);
  motifs.C = VARIATIONS.fragment(motifs.B, r);
  motifs.SOLO = motifs.A;
  motifs.OUTRO = VARIATIONS.fragment(motifs.A, r);
  motifs.INTRO = motifs.A;

  // ---- render events -------------------------------------------------------
  const events = [];
  const scaleRoot = key + (scale === 'minor' || scale === 'dorian' ? 0 : 0);
  const leadBase = nearestScaleBase(fam.leadCenter, scaleRoot, scale);

  for (const s of plan) {
    const role = ROLES[s.role] ?? ROLES.A;
    // per-section arrangement variation: the chorus is not the verse played
    // louder. Quiet sections hold the chords — but only on voices that can
    // hold. A clav or guitar handed a 'pad' bar rings for 200 ms and leaves
    // the rest empty, which put a 1.3 s hole of dead air in the middle of a
    // funk track's breakdown on the first full station render; plucked voices
    // arpeggiate their quiet sections instead.
    const sustains = !['egtr', 'agtr', 'dgtr', 'clav'].includes(fam.chordVoice);
    const quietStyle = sustains ? 'pad' : 'arp';
    const chordStyle = s.role === 'C' || (s.role === 'BRIDGE' && r() < 0.5) ? quietStyle : fam.chordStyle;
    const padOn = fam.padVoice && (role.pad > 0.6 || r() < 0.5);
    for (let b = 0; b < s.bars; b++) {
      const idx = s.bar + b;
      const c = chart[idx];
      const bar0 = idx * barSec;
      const last = b === s.bars - 1;
      // Shallow on purpose. These used to run 0.35 -> 1 and 1 -> 0.15, which
      // is fine in isolation and wrong on a station: the crossfade then joins
      // the quietest bar of one track to the quietest bar of the next, and the
      // first 30-minute render swung 16.9 LU short-term across the joins.
      const introRamp = s.role === 'INTRO' ? Math.min(1, 0.6 + 0.4 * b / Math.max(1, s.bars - 1)) : 1;
      const outroFade = s.role === 'OUTRO' ? Math.max(0.5, 1 - 0.5 * b / Math.max(1, s.bars - 1)) : 1;
      const energy = role.energy * introRamp * outroFade;
      const density = role.density * fam.density;

      // drums — silent through the first half of the intro and the last bars
      const drumsOn = role.drums > 0 && !(s.role === 'INTRO' && b < Math.floor(s.bars / 2)) && !(s.role === 'OUTRO' && b >= s.bars - 2);
      if (drumsOn) {
        grooveBar(fam.groove, {
          r, bar0, beat, swing, density, energy: energy * role.drums,
          kit: fam.kit, fill: last && s.role !== 'OUTRO' && r() < 0.75,
          crash: b === 0 && (s.role === 'B' || s.role === 'A') && idx > plan[0].bars,
        }, events);
      }
      if (role.bass > 0 && !(s.role === 'INTRO' && b < Math.min(2, s.bars - 1))) {
        bassBar(fam.bassStyle, { root: c.bassRoot, pitches: c.notes, nextRoot: last ? c.nextRoot : chart[idx].nextRoot }, {
          r, bar0, beat, swing, voice: fam.bassVoice, level: 0.30 * role.bass * (0.7 + energy * 0.4), last,
        }, events);
      }
      if (role.chords > 0) {
        chordBar(chordStyle, c.notes, {
          r, bar0, beat, swing, voice: fam.chordVoice, dense: density > 0.8,
          level: 0.46 * role.chords * (0.65 + energy * 0.45),
        }, events);
      }
      if (padOn && fam.padVoice) {
        const pn = c.notes.filter((_, i) => i % 2 === 0).map(m => m + 12);
        for (const m of pn) events.push({ t: bar0, voice: fam.padVoice, pitch: m, dur: barSec * 1.05, gain: fam.padLevel * 1.5 * role.pad * energy, pan: (r() - 0.5) * 0.5 });
      }
    }

    // ---- melody: motif phrases across the section, with variation ----------
    if (role.lead > 0) {
      const motif = motifs[s.role] ?? motifs.A;
      const phrases = Math.floor(s.bars / 2);
      for (let p = 0; p < phrases; p++) {
        if (s.role === 'BRIDGE' && p % 2 === 1) continue;
        if (r() > 0.86) continue;                                     // let the tune breathe
        const vname = p === 0 ? 'same'
          : p === phrases - 1 ? pick(r, ['fragment', 'sustain', 'ornament'])
            : pick(r, ['same', 'transpose', 'displace', 'ornament', 'invert']);
        const shape = VARIATIONS[vname](motif, r);
        const bar0 = (s.bar + p * 2) * barSec;
        for (const n of shape) {
          const t = bar0 + n.at * beat;
          const barIdx = Math.min(chart.length - 1, Math.floor(t / barSec));
          const ch = chart[barIdx];
          // degIndex() already carries the octave, so the base handed to
          // scaleNote() must be the bare tonic (0-11). Passing an octave-
          // corrected base counted the octave twice and sent the lead up to
          // MIDI 162 — 88 kHz — which made one whole family render at +81 dBFS.
          let pitch = scaleNote(scale, degIndex(scaleRoot, scale, leadBase) + n.deg, scaleRoot);
          if (!Number.isFinite(pitch)) continue;
          pitch = Math.max(36, Math.min(96, pitch));
          if (n.at % 1 === 0) pitch = snapToChord(pitch, ch.notes);
          events.push({
            t, voice: fam.leadVoice, pitch, dur: n.dur * beat * 0.95,
            gain: 0.46 * role.lead * (0.7 + r() * 0.3) * (ROLES[s.role].energy),
            pan: fam.leadStyle === 'riff' ? -0.15 : 0.12,
            // half the families play melody on the same voice as their
            // comping, so voice name alone cannot identify the melody — and a
            // melody test that counts chord notes is a test of nothing
            part: 'lead',
          });
        }
      }
    }
  }

  // A track must SPEAK within its first half-second. The 'comp' and 'skank'
  // styles can draw an opening cell whose first hit lands on beat 1.5, and an
  // intro bar carries no bass and no drums by design — so a track could open
  // with 1.1 s of silence, which a station crossfading into it renders as a
  // hole at the join (caught by the full-library dead-air sweep, not by the
  // one-per-family sample). If nothing sounds early, open on a downbeat chord.
  const firstAudible = events.length ? events.reduce((m, e) => Math.min(m, e.t), Infinity) : 0;
  if (firstAudible > 0.35) {
    const c0 = chart[0];
    c0.notes.forEach((m, i) => events.push({
      t: 0.04 + i * 0.012, voice: fam.chordVoice, pitch: m,
      dur: Math.max(barSec * 0.9, firstAudible), gain: 0.24, pan: i % 2 ? 0.2 : -0.2,
    }));
  }

  events.sort((a, b) => a.t - b.t);
  const durationSec = bars * barSec + 1.2;
  const name = `${NAME_A[(seed * 7 + key) % NAME_A.length]} ${NAME_B[(seed * 13 + bpm) % NAME_B.length]}`;

  return {
    id: `t${seed}`,
    seed,
    name,
    family: fam.id,
    familyLabel: fam.label,
    energy: fam.energy,
    bpm, key, scale, grammar, swing,
    groove: fam.groove,
    bassStyle: fam.bassStyle,
    chordStyle: fam.chordStyle,
    instruments: [fam.chordVoice, fam.bassVoice, fam.leadVoice, fam.padVoice].filter(Boolean),
    bars,
    barSec,
    durationSec,
    sections: plan.map(s => ({ name: s.name, role: s.role, bar: s.bar, bars: s.bars, startSec: s.bar * barSec })),
    progressions: { A: progressionKey(progs.A), B: progressionKey(progs.B), BRIDGE: progressionKey(progs.BRIDGE) },
    chart: chart.map(c => ({ bar: c.bar, symbol: c.symbol ?? null, notes: c.notes })),
    events,
    provenance: {
      origin: 'generated',
      method: 'deterministic seeded synthesis (TapeBuster radio engine)',
      recordings: 'none',
      licence: 'original work generated by this repository; no third-party audio bundled or fetched',
      seed,
    },
  };
}

// low register root for the bass, style-dependent
function lowRoot(pc, style) {
  const base = style === 'walk' || style === 'sync16' ? 40 : 38;
  let m = ((pc % 12) + 12) % 12 + base - (base % 12);
  while (m < base - 2) m += 12;
  while (m > base + 9) m -= 12;
  return m;
}

function nearestScaleBase(center, root, scale) {
  const s = SCALES[scale];
  let best = center, bd = 99;
  for (let o = -12; o <= 12; o++) for (const d of s) {
    const m = root + d + Math.round((center - root) / 12) * 12 + o;
    const dist = Math.abs(m - center);
    if (dist < bd) { bd = dist; best = m; }
  }
  return best;
}
function degIndex(root, scale, note) {
  const s = SCALES[scale];
  const rel = ((note - root) % 12 + 12) % 12;
  const oct = Math.floor((note - root) / 12);
  let i = s.indexOf(rel);
  if (i < 0) i = s.findIndex(x => x >= rel);
  if (i < 0) i = 0;
  return oct * s.length + i;
}
function snapToChord(pitch, notes) {
  let best = pitch, bd = 99;
  for (const n of notes) for (const o of [-24, -12, 0, 12, 24]) {
    const m = n + o, d = Math.abs(m - pitch);
    if (d < bd) { bd = d; best = m; }
  }
  return bd <= 2 ? best : pitch;
}

/**
 * Build the whole station library. Deterministic: same library every boot.
 *
 * `light` drops the note list and the chord chart once the track's metadata
 * exists. The scheduler only ever reads metadata, and the renderer re-composes
 * from the seed anyway, so keeping 200,000 event objects resident in a page
 * that is already holding 20,000 cases buys nothing.
 */
export function buildLibrary({ perFamily = 7, seed0 = 1000, light = false } = {}) {
  const tracks = [];
  let s = seed0;
  for (const fam of FAMILIES) {
    for (let i = 0; i < perFamily; i++) {
      const t = composeTrack(s++, fam.id);
      if (light) { t.eventCount = t.events.length; t.events = null; t.chart = null; }
      tracks.push(t);
    }
  }
  return tracks;
}
