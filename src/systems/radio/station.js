// Station programming — the difference between a playlist and a radio station.
//
// The old selector banned the last four names and the last mood. Over a long
// browsing session that still let a track come back inside two minutes, let
// two guitar tracks in the same key sit next to each other, and had no idea
// what energy the store was supposed to have. This one programmes an energy
// clock the way a real format does, and enforces separation on every axis a
// listener actually notices: the song, the family, the tempo, the key and the
// harmonic material.

import { rng } from './theory.js';
import { energyRank } from './families.js';

/**
 * The hour clock. A format wheel: each slot names the energy the store should
 * have next, so the station breathes instead of shuffling.
 */
export const CLOCK = [
  'calm', 'medium', 'up', 'groove', 'up', 'medium',
  'low', 'calm', 'medium', 'groove', 'up', 'medium',
  'low', 'groove', 'up', 'calm',
];
// Slot counts (calm 3 / low 2 / medium 4 / groove 3 / up 4) shape the ARC of
// an hour; they are deliberately NOT proportional to how many families sit at
// each energy, so per-track exposure varies somewhat by energy (measured
// 116..203 plays per track over 10,000 selections). The least-recently-played
// scorer, not the wheel, is what keeps the rotation from abandoning anyone.
// It STEPS rather than teleports — low never sits against up, including
// across the wrap — because a shop that cuts from a shuffle to a whispered
// pad sounds like someone changed the CD, not like a station.


export const POLICY = {
  /** A track cannot return until this many others have played. */
  historyDepth: 24,
  /** ...nor may its family, for this many. */
  familyGap: 3,
  /** ...nor its harmonic material (verse progression), for this many. */
  progressionGap: 6,
  /** Consecutive tempi must differ by more than this. */
  bpmGap: 5,
  /** Consecutive tracks must not share a key. */
  keyGap: 2,
  /** Crossfade window, seconds. */
  crossfade: [2.2, 6.0],
};

export class Station {
  constructor(tracks, { seed = 1, policy = POLICY, clock = CLOCK } = {}) {
    if (!tracks || !tracks.length) throw new Error('Station needs a track library');
    this.tracks = tracks;
    this.policy = policy;
    this.clock = clock;
    this.r = rng(seed);
    this.history = [];        // track ids, most recent last
    this.recent = [];         // full track objects, most recent last
    this.slot = Math.floor(this.r() * clock.length);
    this.playCount = new Map(tracks.map(t => [t.id, 0]));
    this.lastPlayedAt = new Map();
    this.n = 0;
    /** how often each relaxation tier had to be used — a QA read-out */
    this.tiers = [0, 0, 0, 0];
  }

  /** Candidate filter at a given strictness. Tier 0 is the real policy. */
  _pool(targetEnergy, tier) {
    const p = this.policy;
    const last = this.recent[this.recent.length - 1] ?? null;
    const histDepth = [p.historyDepth, Math.floor(p.historyDepth / 2), 6, 1][tier];
    const famGap = [p.familyGap, 2, 1, 0][tier];
    const progGap = [p.progressionGap, 3, 1, 0][tier];
    const energySlack = [0, 1, 2, 4][tier];

    // slice(-0) === slice(0) in JS: a gap of zero would return the WHOLE
    // history and ban everything — the exact inverse of "no constraint"
    const recentIds = histDepth > 0 ? new Set(this.history.slice(-histDepth)) : new Set();
    const recentFams = famGap > 0 ? new Set(this.recent.slice(-famGap).map(t => t.family)) : new Set();
    const recentProgs = progGap > 0 ? new Set(this.recent.slice(-progGap).map(t => t.progressions.A)) : new Set();

    return this.tracks.filter((t) => {
      if (recentIds.has(t.id)) return false;
      if (recentFams.has(t.family)) return false;
      if (recentProgs.has(t.progressions.A)) return false;
      if (Math.abs(energyRank(t.energy) - energyRank(targetEnergy)) > energySlack) return false;
      if (last && tier < 2) {
        if (Math.abs(t.bpm - last.bpm) <= p.bpmGap) return false;
        if (t.key === last.key) return false;
      }
      if (last && tier === 2 && t.key === last.key && t.bpm === last.bpm) return false;
      return true;
    });
  }

  /** Next track for the station. Never returns null. */
  next() {
    const target = this.clock[this.slot % this.clock.length];
    this.slot++;
    let pool = [], tier = 0;
    for (; tier < 4; tier++) {
      pool = this._pool(target, tier);
      if (pool.length) break;
    }
    if (!pool.length) { pool = this.tracks.slice(); tier = 3; }
    this.tiers[Math.min(3, tier)]++;

    // among the legal candidates, favour the one heard least recently, so the
    // rotation stays even instead of drifting into favourites
    let best = null, bestScore = -Infinity;
    for (const t of pool) {
      const since = this.n - (this.lastPlayedAt.get(t.id) ?? -this.tracks.length * 2);
      const score = since + (this.r() - 0.5) * this.tracks.length * 0.5 - this.playCount.get(t.id) * 0.4;
      if (score > bestScore) { bestScore = score; best = t; }
    }

    this.n++;
    this.history.push(best.id);
    if (this.history.length > 256) this.history.shift();
    this.recent.push(best);
    if (this.recent.length > 64) this.recent.shift();
    this.playCount.set(best.id, this.playCount.get(best.id) + 1);
    this.lastPlayedAt.set(best.id, this.n);
    return best;
  }

  /**
   * Crossfade INTO a track, in seconds. Slow music gets a long blend, up-tempo
   * music a short one, because a six-second fade over a shuffle sounds like a
   * mistake and a two-second fade under a pad sounds like a cut.
   */
  crossfadeFor(track) {
    const [lo, hi] = this.policy.crossfade;
    const e = energyRank(track.energy) / 4;          // 0 low .. 1 up
    const base = hi - (hi - lo) * e;
    const jitter = ((track.seed * 2654435761) % 1000) / 1000 * 0.8 - 0.4;
    return Math.max(lo, Math.min(hi, base + jitter));
  }

  /** Snapshot for the debug HUD and for tests. */
  state() {
    const now = this.recent[this.recent.length - 1];
    return {
      played: this.n,
      nowPlaying: now ? now.name : null,
      family: now ? now.familyLabel : null,
      library: this.tracks.length,
      tiers: this.tiers.slice(),
    };
  }
}

/**
 * Programme simulation used by the tests and by the QA report: pull `count`
 * selections and measure everything a listener would notice.
 */
export function simulate(tracks, count, opt = {}) {
  const st = new Station(tracks, opt);
  const pol = st.policy;
  const seq = [];
  for (let i = 0; i < count; i++) seq.push(st.next());

  const gapAt = (n) => {
    // starts at i=1, not i=n: the first n-1 positions have PARTIAL windows,
    // and skipping them undercounted early repeats
    let bad = 0;
    for (let i = 1; i < seq.length; i++) {
      const win = Math.min(n, i);
      for (let j = 1; j <= win; j++) if (seq[i].id === seq[i - j].id) { bad++; break; }
    }
    return bad;
  };
  const sameNext = (key) => {
    let c = 0;
    for (let i = 1; i < seq.length; i++) if (key(seq[i]) === key(seq[i - 1])) c++;
    return c;
  };
  const dist = (key) => {
    const m = {};
    for (const t of seq) m[key(t)] = (m[key(t)] ?? 0) + 1;
    return m;
  };
  // longest run between two plays of the same track
  const lastSeen = new Map();
  let minReturn = Infinity;
  seq.forEach((t, i) => {
    if (lastSeen.has(t.id)) minReturn = Math.min(minReturn, i - lastSeen.get(t.id));
    lastSeen.set(t.id, i);
  });
  const counts = Object.values(dist(t => t.id));

  return {
    count,
    unique: new Set(seq.map(t => t.id)).size,
    immediateRepeats: gapAt(1),
    repeatWithin3: gapAt(3),
    repeatWithin5: gapAt(5),
    repeatWithin: (n) => gapAt(n),
    minReturnGap: Number.isFinite(minReturn) ? minReturn : count,
    sameFamilyAdjacent: sameNext(t => t.family),
    sameEnergyAdjacent: sameNext(t => t.energy),
    sameProgressionAdjacent: sameNext(t => t.progressions.A),
    sameKeyAdjacent: sameNext(t => t.key),
    closeBpmAdjacent: (() => { let c = 0; for (let i = 1; i < seq.length; i++) if (Math.abs(seq[i].bpm - seq[i - 1].bpm) <= pol.bpmGap) c++; return c; })(),
    familyDist: dist(t => t.family),
    energyDist: dist(t => t.energy),
    grooveDist: dist(t => t.groove),
    playSpread: { min: Math.min(...counts), max: Math.max(...counts) },
    tiers: st.tiers.slice(),
    sequence: seq,
  };
}
