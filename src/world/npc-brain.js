// THE BEHAVIOURAL HALF OF A STORE CUSTOMER.
//
// Deliberately free of THREE and of the scene graph: everything in here is
// arithmetic over scalars, so the whole customer model can be simulated
// headlessly in the test suite for minutes of store time. `npc.js` owns the
// body — meshes, colliders, the nav grid — and calls into this file for every
// decision a person makes.
//
// Two things this file exists to guarantee:
//
//   1. IDENTITY IS A PURE FUNCTION OF A SEED. The previous pass drew speed,
//      turn rate, cadence and patience from Math.random() in the constructor.
//      That is varied but not reproducible — two runs of the same store built
//      two different crowds, and nothing about a person could be asserted in a
//      test. traitsFor(seed) is total, deterministic and side-effect free.
//
//   2. CHANNELS ARE INDEPENDENT. The recurring defect in this project is a
//      fixed tuple indexed by position — PALETTES[i % 7], four discrete
//      heights, front-bank orientation applied to every bank. `i % N` over a
//      dozen people is visible as twins. Every trait here comes from its own
//      avalanche hash of (seed, channel), so trait A tells you nothing about
//      trait B and no channel has a repeat period inside a crowd.

// ---------------------------------------------------------------------------
// THE STATE MACHINE
//
// Thirteen states. The point is not clever AI; it is that the *transitions*
// are believable and that a customer arriving at a shelf goes through the
// stages a person goes through — slowing, looking, closing the distance,
// browsing, hesitating, reaching — rather than snapping from WALK to STOPPED.
// ---------------------------------------------------------------------------
export const STATES = [
  'ENTER',            // just through the doors (or turned around at them)
  'WALK',             // travelling to a destination at their own pace
  'SLOW',             // destination in sight, shedding speed
  'LOOK',             // stopped short of the shelf, scanning it
  'APPROACH',         // closing the last metre at a shuffle
  'BROWSE',           // at the shelf, reading along it
  'HESITATE',         // torn — the pause before committing
  'REACH',            // arm up to the shelf
  'INSPECT',          // case in hand, reading the back
  'TURN',             // pivoting in place before committing to a heading
  'WALK_AWAY',        // peeling off a fixture, still at browse pace
  'ESCALATOR_RIDE',   // carried between floors
  'EXIT',             // heading for the doors
];

/**
 * Legal successors. A transition NOT in this table is a bug in the caller, and
 * Brain.go counts it (see `illegal`) so the test suite can assert that a crowd
 * simulated for minutes of store time never made one.
 *
 * TURN appears as a successor of every locomotion state because wedge recovery
 * can fire at any moment while walking, and recovery is defined as "pivot onto
 * a fresh heading" rather than "teleport" — see NPC.unwedge.
 */
export const TRANSITIONS = {
  ENTER:          ['WALK', 'TURN'],
  WALK:           ['SLOW', 'TURN', 'ESCALATOR_RIDE', 'EXIT', 'WALK'],
  SLOW:           ['LOOK', 'APPROACH', 'TURN', 'WALK'],
  LOOK:           ['APPROACH', 'WALK_AWAY', 'TURN'],
  APPROACH:       ['BROWSE', 'LOOK', 'TURN'],
  BROWSE:         ['HESITATE', 'REACH', 'WALK_AWAY', 'LOOK'],
  HESITATE:       ['REACH', 'BROWSE', 'WALK_AWAY'],
  REACH:          ['INSPECT'],
  INSPECT:        ['BROWSE', 'WALK_AWAY'],
  TURN:           ['WALK', 'EXIT'],
  // WALK_AWAY → SLOW: peeling off one bay straight into the next one, which in
  // a shop with 1.5 m between fixtures is the common case, not an edge case.
  WALK_AWAY:      ['WALK', 'SLOW', 'EXIT', 'TURN'],
  // A customer on the mezzanine who has finished their visit rides down to
  // reach the doors, so EXIT and ESCALATOR_RIDE reach each other both ways.
  ESCALATOR_RIDE: ['WALK', 'WALK_AWAY', 'EXIT', 'TURN'],
  EXIT:           ['ENTER', 'ESCALATOR_RIDE', 'TURN'],
};

export function canTransition(from, to) {
  const next = TRANSITIONS[from];
  return !!next && next.includes(to);
}

/** States in which the body is translating under its own legs. */
export const LOCOMOTION_STATES = new Set(['WALK', 'SLOW', 'APPROACH', 'WALK_AWAY', 'EXIT']);
/** States in which the body is planted (micro-shuffles aside). */
export const STATIONARY_STATES = new Set(['ENTER', 'LOOK', 'BROWSE', 'HESITATE', 'REACH', 'INSPECT', 'TURN']);

// ---------------------------------------------------------------------------
// HASHING
// ---------------------------------------------------------------------------

/**
 * One avalanche hash per (seed, channel) → 0..1. This is the whole anti-clone
 * mechanism: `chan(i, SPEED)` and `chan(i, PATIENCE)` are uncorrelated for
 * every i, so there is no stride at which two people come back into phase the
 * way `arr[i % N]` guarantees they will.
 */
export function chan(seed, k) {
  let h = (Math.imul(seed | 0, 0x9e3779b1) + Math.imul(k | 0, 0x85ebca77)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  // >>> 0 on the way out as well: `^=` yields a SIGNED 32-bit int, and a
  // negative channel silently inverts every range derived from it.
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Stable integer hash of a string — used to key department affinity. */
export function strHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** Small fast PRNG for the moment-to-moment coin flips, seeded per person. */
export function mulberry32(a) {
  let t = a >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Channel ids. Arbitrary and distinct; the hash does the mixing.
const C = {
  SPEED: 11, TURN: 23, CADENCE: 37, PATIENCE: 53, BROWSE: 71, HESITATE: 89,
  LOOK: 103, REACH: 113, INSPECT: 131, LOCAL: 149, CROSS: 167, CHECKOUT: 181,
  EXIT: 197, SHUFFLE: 211, SWEEP: 227, LATERAL: 239, SLOWR: 251, GAP: 269,
  SWAY: 281, PHASE: 293, KEEP: 307, REBROWSE: 311, HEIGHT: 331, STYLE: 347,
  SHIRT: 353, PANTS: 359, HAIR: 367, SKIN: 373, YAW: 379, WANDER: 389,
};

const TURN_RATE = 3.2;   // rad/s baseline — npc.js owns the same constant

/**
 * Everything about a person that does not change during their visit.
 *
 * Ranges are chosen so the SPREAD is visible at a glance across a dozen people
 * — a 0.74 m/s dawdler and a 1.40 m/s purposeful walker are obviously two
 * different customers — without anyone reading as sped-up or slowed-down.
 */
export function traitsFor(seed) {
  const c = (k) => chan(seed, k);
  return {
    seed,
    // --- locomotion -------------------------------------------------------
    speed:      0.74 + c(C.SPEED) * 0.66,            // 0.74 .. 1.40 m/s
    turnRate:   TURN_RATE * (0.70 + c(C.TURN) * 0.65),
    cadence:    3.10 + c(C.CADENCE) * 1.80,          // stride rate multiplier
    swayRate:   0.28 + c(C.SWAY) * 0.30,             // idle weight shift
    phase:      c(C.PHASE) * Math.PI * 2,            // nobody starts mid-stride together
    // --- dwell ------------------------------------------------------------
    patience:   0.60 + c(C.PATIENCE) * 1.70,         // scales LOOK/HESITATE/INSPECT
    browseBias: c(C.BROWSE),                         // 0 = skims, 1 = lingers
    inspectHold: 1.20 + c(C.INSPECT) * 3.00,         // s reading the back of a case
    // --- decisions --------------------------------------------------------
    hesitateP:  0.12 + c(C.HESITATE) * 0.46,
    lookP:      0.34 + c(C.LOOK) * 0.52,             // pause short of the shelf
    reachP:     0.16 + c(C.REACH) * 0.52,
    rebrowseP:  0.14 + c(C.REBROWSE) * 0.34,         // go back for a second look
    keepP:      0.25 + c(C.KEEP) * 0.50,             // carry the case away
    // --- routing ----------------------------------------------------------
    localBias:  0.46 + c(C.LOCAL) * 0.42,            // shops near where they stand
    crossFloorP: 0.04 + c(C.CROSS) * 0.17,
    checkoutP:  0.02 + c(C.CHECKOUT) * 0.11,
    // Destinations before they head for the doors. Measured at 4..11 the crowd
    // spent 12% of its life walking to the exit of a 55 m building, which reads
    // as a shop full of people leaving rather than a shop full of people
    // shopping. A visit is long; the walk out is the punctuation.
    exitAfter:  9 + Math.floor(c(C.EXIT) * 16),
    wander:     c(C.WANDER),                         // tie-break noise on shelf choice
    // --- micro-behaviour --------------------------------------------------
    shuffleP:   0.22 + c(C.SHUFFLE) * 0.50,          // sidestep along a shelf
    headSweep:  0.22 + c(C.SWEEP) * 0.46,            // rad — how far they look along it
    lateral:    0.20 + c(C.LATERAL) * 0.42,          // m — size of that sidestep
    slowRadius: 1.7 + c(C.SLOWR) * 1.7,              // m — where they start shedding speed
    approachGap: 0.60 + c(C.GAP) * 0.34,             // m — how close they stand to a face
    // --- appearance -------------------------------------------------------
    height:     0.90 + c(C.HEIGHT) * 0.22,           // 0.90 .. 1.12 scale
    style:      Math.floor(c(C.STYLE) * 12),
    shirtIdx:   Math.floor(c(C.SHIRT) * 4096),
    pantsIdx:   Math.floor(c(C.PANTS) * 4096),
    hairIdx:    Math.floor(c(C.HAIR) * 4096),
    skinIdx:    Math.floor(c(C.SKIN) * 4096),
    yaw0:       c(C.YAW) * Math.PI * 2,
  };
}

/**
 * How much this person cares about a department. A flat random weight would
 * make everyone equally interested in everything, which is exactly the
 * "randomly traversing the store" the brief rules out. The 4th power leaves
 * most departments near the floor value and a handful strongly preferred, so
 * each customer has two or three aisles they actually came for.
 */
export function deptAffinity(seed, dept) {
  if (!dept) return 0.35;
  const v = chan(seed ^ 0x5bf03635, strHash(dept) & 0x7fffffff);
  return 0.08 + Math.pow(v, 4) * 3.4;
}

/**
 * Browse dwell, drawn per visit from that person's own weighting of the three
 * bands the brief specifies: short 1–3 s, normal 3–7 s, long 7–15 s. A skimmer
 * (browseBias 0) draws short 42% of the time; a lingerer (1) draws long 46%.
 */
export function browseDuration(rng, traits) {
  const b = traits.browseBias;
  const pShort = 0.42 - b * 0.32;
  const pLong = 0.12 + b * 0.34;
  const r = rng();
  if (r < pShort) return 1 + rng() * 2;
  if (r > 1 - pLong) return 7 + rng() * 8;
  return 3 + rng() * 4;
}

/**
 * The per-person decision core. Holds the current state, its timer, and the
 * running tally of destinations visited this trip. Every stochastic choice
 * goes through `this.rng`, which is seeded, so a whole run is reproducible.
 */
export class Brain {
  constructor(seed) {
    this.seed = seed;
    this.traits = traitsFor(seed);
    this.rng = mulberry32((Math.imul(seed + 1, 0x9e3779b1) ^ 0x5bf03635) >>> 0);
    this.state = 'ENTER';
    this.prev = null;
    this.t = 0.4 + this.rng() * 1.6;   // beat inside the doors before setting off
    this.visits = 0;
    this.illegal = 0;      // transitions the table forbids — must stay 0
    this.transitions = 0;
  }

  /**
   * Move to `state`. Illegal moves are COUNTED rather than thrown: a hard throw
   * in a render loop would take the store down over a behaviour bug, and the
   * counter makes the same defect a test failure instead.
   */
  go(state, duration = 0) {
    if (!canTransition(this.state, state)) this.illegal++;
    this.prev = this.state;
    this.state = state;
    this.t = duration;
    this.transitions++;
    return state;
  }

  /** Countdown for timed states. True when the timer has run out. */
  tick(dt) {
    this.t -= dt;
    return this.t <= 0;
  }

  chance(p) { return this.rng() < p; }
  range(a, b) { return a + this.rng() * (b - a); }

  /** Dwell for a stop short of the shelf. */
  lookTime() { return this.range(0.35, 1.15) * this.traits.patience; }
  hesitateTime() { return this.range(0.45, 1.5) * this.traits.patience; }
  reachTime() { return this.range(0.55, 1.0); }
  inspectTime() { return this.traits.inspectHold * this.range(0.7, 1.35); }
  browseTime() { return browseDuration(this.rng, this.traits); }
  enterTime() { return this.range(0.6, 2.2) * this.traits.patience; }

  /** Do they stop and look before closing the last metre, or just walk up? */
  wantsLook() { return this.chance(this.traits.lookP); }

  /** What happens when a browse dwell expires. */
  afterBrowse() {
    if (this.chance(this.traits.hesitateP)) return 'HESITATE';
    if (this.chance(this.traits.reachP)) return 'REACH';
    return 'WALK_AWAY';
  }

  /** What happens after the torn pause. Hesitation makes a reach MORE likely. */
  afterHesitate() {
    if (this.chance(Math.min(0.85, this.traits.reachP * 1.7))) return 'REACH';
    if (this.chance(this.traits.rebrowseP)) return 'BROWSE';
    return 'WALK_AWAY';
  }

  /** After reading the back of the case. */
  afterInspect() {
    return this.chance(this.traits.rebrowseP) ? 'BROWSE' : 'WALK_AWAY';
  }

  /** Do they take a small sidestep along the shelf mid-browse? */
  wantsShuffle() { return this.chance(this.traits.shuffleP); }

  /** Do they carry the case away with them? */
  keepsCase() { return this.chance(this.traits.keepP); }

  /** Have they seen enough of the shop for one visit? */
  wantsExit() { return this.visits >= this.traits.exitAfter; }

  /** A fresh trip round the store — same body, new set of errands. */
  resetVisit() {
    this.visits = 0;
    this.traits.exitAfter = 9 + Math.floor(this.rng() * 16);
  }
}

/**
 * Score a candidate shelf for this person. Department affinity is the point;
 * distance only damps it, so a customer will still cross the shop for the one
 * aisle they care about, and `wander` keeps two people with similar taste from
 * queueing behind each other at the same fixture.
 */
export function scoreShelf(traits, f, fromX, fromZ, sameLevel, rnd) {
  const dept = f.dept || f.curated || f.section || null;
  const aff = deptAffinity(traits.seed, dept);
  const d = Math.hypot(f.x - fromX, f.z - fromZ);
  // localBias 0.46 → barely cares about distance; 0.88 → strongly local.
  const near = 1 / (1 + Math.pow(d / 9, 1 + traits.localBias * 2.2));
  const floor = sameLevel ? 1 : 0.75;
  return aff * (0.25 + 0.75 * near) * floor * (0.6 + rnd * 0.8);
}
