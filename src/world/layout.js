// TapeBuster store layout — the SINGLE SOURCE OF TRUTH for physical space.
// Pure module (no three.js, no DOM) so it is unit-testable in Node.
//
// The store has TWO LEVELS:
//   level 0 — ground floor: movies, checkout, entrance
//   level 1 — rear mezzanine (y = WORLD.mezzY): TV & series, reached by a
//             physical up/down escalator pair. Not a teleport — a nav link.
//
// buildLayout(catalog, curation) computes fixtures, props, slots, per-title
// records (address, stand point, level), obstacles per level, escalators,
// signs and HUD zones. Everything else derives from this.
//
// Conventions: rotY=0 faces +z. Facing dir = (sin rotY, cos rotY).
// The viewer reading a shelf left-to-right advances along the fixture's local +x.

import { WORLD, SPAWN, CORE_DEPTH, CLERESTORY, clerestoryAllowedAt, setStoreDepth, setMezzDepth, MEZZ_MIN_DEPTH } from '../config.js';
import { DEPARTMENTS } from '../data/departments.js';
import { FAMILIES as SIGN_FAMILIES } from './signage.js';

const { caseW, caseH, caseD, casePitch, standOff, mezzY, mezzFrontZ } = WORLD;

export function facingOf(rotY) {
  return { x: Math.sin(rotY), z: Math.cos(rotY) };
}
export function rotXZ(lx, lz, rotY) {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  return { x: lx * c + lz * s, z: -lx * s + lz * c };
}

const WALL_ROWS = [0.34, 0.70, 1.06, 1.42, 1.78];
const GONDOLA_ROWS = [0.42, 0.86, 1.30];

// TWO ESCALATOR BANKS, ONE PER SIDE.
//
// There used to be a single bank on the west side, which meant the whole eastern
// half of the balcony had no way down — you browsed TV at x=+10 and then walked
// the full width of the building to get off the floor. The banks are mirrored,
// so whichever side you are on there is a ride within a few metres.
//
// Both sit inside the hand-authored CORE (z ∈ [-9.5, 9.5]), which the annex pour
// never touches — that is why a second bank costs no shelving.
//
// Centerlines MUST land exactly on nav-grid cell centers, or riders board with a
// lateral offset and sidestep on and off. Cell centers are -13 + (i+0.5)*0.3, so
// the east pair is 7.55/8.75 rather than a naive mirror of 7.45/8.65 (neither of
// which is a cell center).
// A third bank sits at the BACK of the balcony, centred, so you can get off the
// top floor without walking its whole length back to the front. It hangs off the
// rear edge instead of the front one, which means it climbs the other way
// (zSign -1) and lands on the open sales floor behind the balcony.
const BANKS = [
  { side: 'w', up: -8.65, down: -7.45, edge: 'front' },
  { side: 'e', up: 8.75, down: 7.55, edge: 'front' },
  { side: 'c', up: 0.65, down: -0.55, edge: 'rear' },
];

// Every z in the hand-modelled front bank, as an offset from the slab edge it
// hangs off. The rear bank reuses them mirrored, so both are the same machine.
const ESC_Z = {
  boardZ: 5.10, lowCombZ: 4.45, inclineStartZ: 4.15,
  inclineEndZ: -1.57, topCombZ: -2.05, exitZ: -2.65,
};

// The escalator wells cut into the mezzanine slab (open to below), one per bank.
// Asymmetric on purpose, and preserved from the hand-modelled west bank: the
// opening runs 0.80m past the UP track (the outer one) and 0.90m past the DOWN
// track. Mirroring by side rather than by absolute x keeps the east bank
// identical in feel instead of subtly wider on the wrong flank.
// The well's DEPTH, as an offset from the slab edge the bank hangs off: it runs
// from the edge back to just past the top comb plate, so the machine emerges
// through a real opening instead of a seam.
// Offset from the slab edge to the far side of the opening, in the SAME signed
// convention bankEscalators uses: edgeZ + zSign * WELL_FAR. Front (zSign +1)
// gives -5.35 off mezzFrontZ; rear (zSign -1) gives -28.91 off mezzBackZ, i.e.
// INSIDE the balcony, which is where the rear machine actually surfaces.
const WELL_FAR = ESC_Z.topCombZ - 0.10;                  // -2.15

const wellFor = (b, edgeZ = mezzFrontZ, zSign = 1) => {
  const outer = b.up + (b.up < b.down ? -0.80 : 0.80);
  const inner = b.down + (b.down < b.up ? -0.90 : 0.90);
  // DERIVED FROM THE BANK, NOT HARDCODED TO THE FRONT EDGE. These z's used to be
  // the literals -5.35 and mezzFrontZ, which is correct for the two front banks
  // and silently wrong for the rear one: rearBankGap() called this and inherited
  // a front-edge opening 26 m from where the rear machine actually penetrates.
  // The rear escalator reaches full height 1.57 m INSIDE the balcony footprint,
  // so with no opening there it climbed through solid slab.
  const near = edgeZ;
  const far = edgeZ + zSign * WELL_FAR;
  return {
    minX: Math.min(outer, inner), maxX: Math.max(outer, inner),
    minZ: Math.min(near, far), maxZ: Math.max(near, far),
  };
};
const FRONT_BANKS = BANKS.filter(b => b.edge === 'front');
// The FRONT wells are fixed (they hang off mezzFrontZ, a constant). The rear
// bank's z depends on mezzBackZ, which moves with capacity, so its well and
// escalators are built per layout — see buildEscalators().
export const WELLS = FRONT_BANKS.map(b => wellFor(b));   // NOT .map(wellFor): map would pass the index as edgeZ
// Retained for consumers that only ever needed "a" well; prefer layout.wells.
export const WELL = WELLS[0];

/** Escalator pair for one bank, hung off `edgeZ` and climbing toward `zSign`. */
function bankEscalators(b, edgeZ, zSign) {
  const z = (k) => edgeZ + zSign * ESC_Z[k];
  return ['up', 'down'].map(dir => ({
    id: `esc-${dir}-${b.side}`, dir, x: dir === 'up' ? b.up : b.down, side: b.side,
    edge: b.edge, zSign,
    width: 1.06, stepW: 0.84, rise: mezzY,
    boardZ: z('boardZ'), lowCombZ: z('lowCombZ'), inclineStartZ: z('inclineStartZ'),
    inclineEndZ: z('inclineEndZ'), topCombZ: z('topCombZ'), exitZ: z('exitZ'),
  }));
}

/**
 * Every escalator in the building, for a given rear-edge position.
 * Front banks climb toward -z off mezzFrontZ; the rear bank climbs toward +z off
 * mezzBackZ, so its board pad lands on the open floor behind the balcony.
 */
export function buildEscalators(mezzBackZ, halfD = WORLD.halfD) {
  // A small store's balcony still reaches the back wall, leaving nowhere behind
  // it to land — the rear bank would board outside the building. It appears only
  // once the balcony genuinely ends in mid-air with floor beyond it.
  const rearFits = mezzBackZ - ESC_Z.boardZ - 1.3 > -halfD;
  return BANKS.flatMap(b => {
    if (b.edge === 'front') return bankEscalators(b, mezzFrontZ, 1);
    return rearFits ? bankEscalators(b, mezzBackZ, -1) : [];
  });
}

/**
 * The rear bank's opening — a REAL slab well, not just a gap in the railing.
 * Hung off mezzBackZ and climbing toward +z, mirroring the front banks.
 */
export function rearBankWell(mezzBackZ = WORLD.mezzBackZ) {
  const b = BANKS.find(x => x.edge === 'rear');
  return b ? wellFor(b, mezzBackZ, -1) : null;
}
/** Back-compat alias: the railing opening is the same rectangle as the well. */
export function rearBankGap(mezzBackZ = WORLD.mezzBackZ) {
  return rearBankWell(mezzBackZ);
}

// Default set, for consumers that just want the shape before a layout exists.
export const ESCALATORS = buildEscalators(-CORE_DEPTH);

// Arc-length parameterised position along an escalator (ground→top direction).
// Returns {x, y, z, grade} where grade is dy/ds on the incline (for step logic).
export function escalatorProfile(esc, s) {
  // zSign +1 travels toward -z going up (the front banks, which climb from the
  // sales floor into the building); -1 travels toward +z (the rear bank, which
  // climbs from behind the balcony forward onto it). Lengths are taken as
  // magnitudes so the same arithmetic serves both orientations.
  const sgn = esc.zSign ?? 1;
  const segA = Math.abs(esc.boardZ - esc.inclineStartZ);    // flat approach
  const run = Math.abs(esc.inclineStartZ - esc.inclineEndZ); // horizontal incline run
  const inclineLen = Math.hypot(run, esc.rise);
  const segC = Math.abs(esc.inclineEndZ - esc.exitZ);       // flat top
  const total = segA + inclineLen + segC;
  s = Math.max(0, Math.min(s, total));
  if (s <= segA) {
    return { x: esc.x, y: 0, z: esc.boardZ - sgn * s, grade: 0, total };
  }
  if (s <= segA + inclineLen) {
    const k = (s - segA) / inclineLen;
    return { x: esc.x, y: esc.rise * k, z: esc.inclineStartZ - sgn * run * k, grade: esc.rise / inclineLen, total };
  }
  const k = s - segA - inclineLen;
  return { x: esc.x, y: esc.rise, z: esc.inclineEndZ - sgn * k, grade: 0, total };
}
export function escalatorLength(esc) {
  return escalatorProfile(esc, Infinity).total;
}

// Nav links between levels (used by multi-level pathfinding)
// Link endpoints sit on the cell-aligned lane columns (the ride itself blends
// onto the escalator centerline during boarding).
/** Boarding/landing points, a step outside each comb plate, for every bank. */
export function navLinksFor(escs) {
  return escs.map((e) => {
    const sgn = e.zSign ?? 1;
    const board = { x: e.x, z: e.boardZ + sgn * 0.15 };
    const land = { x: e.x, z: e.exitZ - sgn * 0.10 };
    return e.dir === 'up'
      ? { esc: e.id, fromLevel: 0, toLevel: 1, from: board, to: land }
      : { esc: e.id, fromLevel: 1, toLevel: 0, from: land, to: board };
  });
}
export const NAV_LINKS = navLinksFor(ESCALATORS);

/**
 * Group the machines into BANKS — an up/down pair installed side by side is one
 * structure, and several things (its collider, its well, its footprint) belong
 * to the bank rather than to either machine.
 *
 * Derived by clustering on x within a bank's own width, so a third machine or a
 * seventh bank is grouped correctly the day it is generated; nothing here knows
 * how many banks there are or where they sit.
 */
export function escalatorBanks(escs) {
  const banks = [];
  for (const e of escs) {
    const sgn = e.zSign ?? 1;
    const lo = e.x - e.width / 2 - 0.07, hi = e.x + e.width / 2 + 0.07;
    const b = banks.find((b) => b.edge === e.edge
      && Math.abs(b.boardZ - e.boardZ) < 0.01
      && Math.min(hi, b.maxX) - Math.max(lo, b.minX) > -1.2);   // adjacent or touching
    if (b) {
      b.minX = Math.min(b.minX, lo); b.maxX = Math.max(b.maxX, hi);
      b.members.push(e);
    } else {
      banks.push({
        id: `bank-${e.edge}-${banks.length}`, edge: e.edge, zSign: sgn,
        boardZ: e.boardZ, exitZ: e.exitZ,
        inclineStartZ: e.inclineStartZ, inclineEndZ: e.inclineEndZ,
        lowCombZ: e.lowCombZ, topCombZ: e.topCombZ, rise: e.rise,
        minX: lo, maxX: hi, members: [e],
      });
    }
  }
  return banks;
}

// ---------------------------------------------------------------------------
// Mezzanine-only sections driven by predicates over the canonical catalog.
// These hold SECONDARY copies — a title's primary home stays in its department.
// ---------------------------------------------------------------------------
export const TV_SECTIONS = {
  crimeTv: {
    label: 'CRIME & THRILLER', code: 'CT',
    pred: (t) => t.type === 'series' && t.genres.some(g => ['Crime', 'Thriller', 'Mystery'].includes(g)),
  },
  scifiTv: {
    label: 'SCI-FI & FANTASY', code: 'ST',
    pred: (t) => t.type === 'series' && t.genres.some(g => ['Sci-Fi', 'Fantasy'].includes(g)),
  },
  limitedTv: {
    label: 'LIMITED SERIES', code: 'LM',
    pred: (t) => t.type === 'series' && t.seasons === 1,
  },
  ninetiesTv: {
    label: '90s TV', code: 'TN',
    pred: (t) => t.type === 'series' && t.year >= 1988 && t.year <= 1999,
  },
  prestigeTv: {
    label: 'PRESTIGE DRAMA', code: 'PD',
    // Defined by acclaim, not by certificate. There is no keyless source of TV
    // content ratings, so every series carries rating === null — keying this
    // section on 'TV-MA' left a signed 3.2m gondola completely bare. Critical
    // score plus a real audience is both available and a truer read of
    // "prestige" anyway.
    // Documentary and animation carry a Drama tag often enough that without
    // this exclusion the section fronts a Formula 1 docuseries and Death Note.
    pred: (t) => t.type === 'series' && t.genres.includes('Drama')
      && !t.genres.some(g => ['Documentary', 'Anime', 'Animation'].includes(g))
      && (t.score ?? 0) >= 8 && (t.votes ?? 0) >= 40_000,
  },
};

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------
let fixtureSeq = 0;

function shelfFixture({ code, style, dept = null, curated = null, section = null, filter = null,
  label, x, z, rotY, w, depth, rows, level = 0, height = null }) {
  return {
    id: code, kind: 'shelf', style, dept, curated, section, filter, label, code,
    x, z, rotY, w, depth, rows, level,
    baseY: level ? mezzY : 0,
    rowSlots: Math.floor((w - 0.14) / casePitch),
    height: height ?? (style === 'wall' ? 2.28 : 1.74),
    seq: fixtureSeq++,
  };
}

function slotWorld(f, rowIdx, posIdx) {
  const usable = f.rowSlots * casePitch;
  const lx = -usable / 2 + casePitch * posIdx + casePitch / 2;
  const lz = f.depth / 2 - caseD / 2 - 0.035;
  const o = rotXZ(lx, lz, f.rotY);
  return {
    x: f.x + o.x,
    y: f.baseY + f.rows[rowIdx] + caseH / 2 + 0.004,
    z: f.z + o.z,
    rotY: f.rotY,
  };
}

// ---------------------------------------------------------------------------
// The store plan
// ---------------------------------------------------------------------------
//
// The core is authored against the SHELL, not against absolute z: the back-wall
// units line the back wall and the entrance cluster sits inside the doors. Both
// walls move when the building grows, so both are expressed as offsets from
// them — `backZ` and `dz` below. Everything else (escalator, well, centre
// gondolas, side-wall departments) is absolute and untouched: the escalator's
// boarding lanes are carved at fixed coordinates in pathfind.js, so the core
// CANNOT slide, and the building therefore grows symmetrically around it.
function planFixtures(halfD = WORLD.halfD) {
  const F = [];
  const wallX = WORLD.halfW - 0.17;
  const unitPitch = 1.78;
  const dz = halfD - CORE_DEPTH;   // how far the front wall moved out

  // ---------------- GROUND FLOOR ----------------
  // Left wall: Horror, Sci-Fi, Thriller, Classics. Right wall: Action, Drama, Comedy, Family.
  const leftOrder = ['horror', 'scifi', 'thriller', 'classics'];
  const rightOrder = ['action', 'drama', 'comedy', 'family'];
  let zCursor = 7.3;
  const wallZ = [];
  for (let d = 0; d < 4; d++) {
    wallZ.push([zCursor, zCursor - unitPitch]);
    zCursor -= unitPitch * 2 + 0.36;
  }
  for (let d = 0; d < 4; d++) {
    for (let u = 0; u < 2; u++) {
      const dl = DEPARTMENTS[leftOrder[d]];
      F.push(shelfFixture({
        code: `${dl.code}-0${u + 1}`, style: 'wall', dept: dl.key, label: dl.name,
        x: -wallX, z: wallZ[d][u], rotY: Math.PI / 2, w: 1.7, depth: 0.34, rows: WALL_ROWS,
      }));
      const dr = DEPARTMENTS[rightOrder[d]];
      F.push(shelfFixture({
        code: `${dr.code}-0${u + 1}`, style: 'wall', dept: dr.key, label: dr.name,
        x: wallX, z: wallZ[d][u], rotY: -Math.PI / 2, w: 1.7, depth: 0.34, rows: WALL_ROWS,
      }));
    }
  }

  // Ground back wall (under the mezzanine): two high-variety curated walls —
  // single-title-forward merchandising, not repeated dept overflow.
  const backZ = -(halfD - 0.17);
  F.push(shelfFixture({
    code: 'AW-01', style: 'wall', curated: 'criticallyAcclaimed', label: 'CRITICALLY ACCLAIMED',
    x: -5.78, z: backZ, rotY: 0, w: 1.7, depth: 0.34, rows: WALL_ROWS,
  }));
  F.push(shelfFixture({
    code: 'SW-01', style: 'wall', curated: 'staffPicks', label: 'THE STAFF WALL',
    x: 5.78, z: backZ, rotY: 0, w: 1.7, depth: 0.34, rows: WALL_ROWS,
  }));

  // Center gondola G1: Documentary films / Anime films
  const g1x = -4.2, g1z = -0.6, g1Len = 2.6;
  F.push(shelfFixture({ code: 'DO-01', style: 'gondola', dept: 'documentary', filter: 'movie', label: 'DOCUMENTARY', x: g1x - 0.19, z: g1z, rotY: -Math.PI / 2, w: g1Len, depth: 0.38, rows: GONDOLA_ROWS }));
  F.push(shelfFixture({ code: 'AN-01', style: 'gondola', dept: 'anime', filter: 'movie', label: 'ANIME', x: g1x + 0.19, z: g1z, rotY: Math.PI / 2, w: g1Len, depth: 0.38, rows: GONDOLA_ROWS }));
  F.push(shelfFixture({ code: 'SP-01', style: 'endcap', curated: 'staffPicks', label: 'STAFF PICKS', x: g1x, z: g1z + g1Len / 2 + 0.24, rotY: 0, w: 0.9, depth: 0.4, rows: GONDOLA_ROWS }));
  F.push(shelfFixture({ code: 'CC-01', style: 'endcap', curated: 'cultClassics', label: 'CULT CLASSICS', x: g1x, z: g1z - g1Len / 2 - 0.24, rotY: Math.PI, w: 0.9, depth: 0.4, rows: GONDOLA_ROWS }));

  // Center gondola G2: One-Night Watch / Weekend Marathon
  const g2x = 4.2, g2z = -2.2, g2Len = 2.8;
  F.push(shelfFixture({ code: 'ON-01', style: 'gondola', curated: 'oneNightWatch', label: 'ONE-NIGHT WATCH', x: g2x - 0.19, z: g2z, rotY: -Math.PI / 2, w: g2Len, depth: 0.38, rows: GONDOLA_ROWS }));
  F.push(shelfFixture({ code: 'WM-01', style: 'gondola', curated: 'weekendMarathon', label: 'WEEKEND MARATHON', x: g2x + 0.19, z: g2z, rotY: Math.PI / 2, w: g2Len, depth: 0.38, rows: GONDOLA_ROWS }));
  F.push(shelfFixture({ code: 'NT-01', style: 'endcap', curated: 'ninetiesFavorites', label: "90s THROWBACKS", x: g2x, z: g2z + g2Len / 2 + 0.24, rotY: 0, w: 0.9, depth: 0.4, rows: GONDOLA_ROWS }));
  F.push(shelfFixture({ code: 'HG-01', style: 'endcap', curated: 'hiddenGems', label: 'HIDDEN GEMS', x: g2x, z: g2z - g2Len / 2 - 0.24, rotY: Math.PI, w: 0.9, depth: 0.4, rows: GONDOLA_ROWS }));

  // ROMANCE & ROM-COM endcap, in the curated cluster at the centre of the floor.
  //
  // Standalone rather than hung off a gondola end because all six ends are
  // already taken (SP/CC on G1, NT/HG on G2, LS/CA on New Releases) — an
  // endcap fixture is self-contained, so the ones above only HAPPEN to sit at
  // gondola ends. It faces +z, toward a shopper walking in from the entrance,
  // and stands clear of CC-01 and HG-01 by several metres so the aisle either
  // side of the centre gondolas stays walkable.
  F.push(shelfFixture({ code: 'RR-01', style: 'endcap', curated: 'romanceRomCom', label: 'ROMANCE & ROM-COM', x: 0, z: -5.6, rotY: 0, w: 0.9, depth: 0.4, rows: GONDOLA_ROWS }));

  // New Releases gondola near the entrance — tracks the front wall
  const nrx = -5.2, nrz = 6.6 + dz, nrLen = 2.7;
  F.push(shelfFixture({ code: 'NR-01', style: 'gondola', dept: 'newreleases', label: 'NEW RELEASES', x: nrx, z: nrz + 0.19, rotY: 0, w: nrLen, depth: 0.38, rows: GONDOLA_ROWS }));
  F.push(shelfFixture({ code: 'NR-02', style: 'gondola', dept: 'newreleases', label: 'NEW RELEASES', x: nrx, z: nrz - 0.19, rotY: Math.PI, w: nrLen, depth: 0.38, rows: GONDOLA_ROWS }));
  F.push(shelfFixture({ code: 'LS-01', style: 'endcap', curated: 'leavingSoon', label: 'LEAVING SOON', x: nrx + nrLen / 2 + 0.24, z: nrz, rotY: Math.PI / 2, w: 0.9, depth: 0.4, rows: GONDOLA_ROWS }));
  F.push(shelfFixture({ code: 'CA-01', style: 'endcap', curated: 'criticallyAcclaimed', label: 'CRITICALLY ACCLAIMED', x: nrx - nrLen / 2 - 0.24, z: nrz, rotY: -Math.PI / 2, w: 0.9, depth: 0.4, rows: GONDOLA_ROWS }));

  // Family Night table + Weekend Marathon bin
  F.push({
    id: 'FN-01', kind: 'table', style: 'table', dept: null, curated: 'familyNight', section: null, filter: null,
    label: 'FAMILY NIGHT', code: 'FN-01', x: 1.7, z: 5.3 + dz, rotY: 0, level: 0, baseY: 0,
    w: 1.15, depth: 0.8, rows: [0.74], rowSlots: 8, height: 0.74, seq: fixtureSeq++,
  });
  F.push({
    id: 'BB-01', kind: 'bin', style: 'bin', dept: null, curated: 'weekendMarathon', section: null, filter: null,
    label: 'WEEKEND MARATHON BIN', code: 'BB-01', x: 0.2, z: 1.9, rotY: 0, level: 0, baseY: 0,
    w: 1.1, depth: 1.1, rows: [0.62], rowSlots: 10, height: 0.72, seq: fixtureSeq++,
  });

  // ---------------- MEZZANINE (level 1) ----------------
  // THE ANCHOR RUN: TV Drama + TV Comedy (primary homes for series), back to
  // back across the width of the balcony.
  //
  // These used to be WALL units pinned to the store's back wall, which is where
  // the dead space came from: that wall is placed by the GROUND floor's depth,
  // so the TV floor's anchor ended up tens of metres behind its own last aisle.
  // They are now a double-sided run standing one promenade in from the balcony's
  // own railing — DRAMA facing the shopper coming off the escalator, COMEDY
  // facing the view, so the walk to the edge passes stock on both sides.
  // Spaced OUTWARD from the centre, because the rear escalator bank now rises
  // through the middle of this edge — the run used to reach x=-0.1 and 1.15,
  // straight through where the machine stands.
  //
  // THAT FIRST PASS MOVED THEM CLEAR OF THE MACHINE BUT NOT CLEAR OF THE
  // SHOPPER. Measured against the level-1 colliders, the machines' side rails
  // span x -1.15..1.25 at z -28.96..-27.86, and the innermost units sat at:
  //
  //     TD-04  inner edge -1.55   0.40 m from the rail
  //     TC-01  inner edge  1.55   0.30 m from the rail, and its z range
  //                              stopped 0.02 m short of the machine
  //
  // So stepping off the top of the up escalator put a gondola END WALL 30 cm
  // from your shoulder. Nothing collided and nothing overlapped, which is why
  // no geometry check ever complained — it was simply unwalkable and it read as
  // the machine being boxed in.
  //
  // Both runs move a further 0.7 m outward. That leaves >= 1.0 m of clear floor
  // between each rail and the nearest shelf end, keeps all seven units, their
  // 1.9 m pitch, their orientation and their department identity, and does not
  // move the escalator. TD-01 lands at x -9.65..-7.95 and TC-03 at 6.05..7.75,
  // both well inside the balcony's 13 m half-width.
  const anchorZ = mezzAnchorZ();
  // OPEN THE ROOM AROUND THE REAR ESCALATOR.
  //
  // The clearance that matters is not to the MACHINE, it is to the WELL: the
  // railing stands at x +/-1.57, a good 0.32 m outside the machines at +/-1.25.
  // With the inner gondolas ending at +/-2.25 a shopper had 0.68 m to squeeze
  // through, which is why the escalator read as blocked from the side even
  // though nothing overlapped and every collision test passed.
  //
  // Both runs move 0.6 m outward. The pitch stays a uniform 1.9 m, all seven
  // units stay, both departments stay, and no capacity is given up — the room
  // comes from the slack between the outermost gondola and the wall, which was
  // 3.35 m on one side and 5.25 m on the other. Clearance goes 0.68 -> 1.28 m.
  [[-9.4, 1], [-7.5, 2], [-5.6, 3], [-3.7, 4]].forEach(([x, i]) => F.push(shelfFixture({
    code: `TD-0${i}`, style: 'gondola', dept: 'tvdrama', label: 'TV DRAMA',
    x, z: anchorZ + 0.19, rotY: 0, w: 1.7, depth: 0.38, rows: WALL_ROWS, level: 1,
  })));
  [[3.7, 1], [5.6, 2], [7.5, 3]].forEach(([x, i]) => F.push(shelfFixture({
    code: `TC-0${i}`, style: 'gondola', dept: 'tvcomedy', label: 'TV COMEDY',
    x, z: anchorZ - 0.19, rotY: Math.PI, w: 1.7, depth: 0.38, rows: WALL_ROWS, level: 1,
  })));

  // Left wall upstairs: Anime series, Documentary series, Limited Series
  F.push(shelfFixture({ code: 'AS-01', style: 'gondola', dept: 'anime', filter: 'series', label: 'ANIME SERIES', x: -wallX, z: -4.7, rotY: Math.PI / 2, w: 1.5, depth: 0.34, rows: GONDOLA_ROWS, level: 1 }));
  F.push(shelfFixture({ code: 'DS-01', style: 'gondola', dept: 'documentary', filter: 'series', label: 'DOCUSERIES', x: -wallX, z: -6.5, rotY: Math.PI / 2, w: 1.3, depth: 0.34, rows: GONDOLA_ROWS, level: 1 }));
  F.push(shelfFixture({ code: 'LM-01', style: 'gondola', section: 'limitedTv', label: 'LIMITED SERIES', x: -wallX, z: -8.2, rotY: Math.PI / 2, w: 1.5, depth: 0.34, rows: GONDOLA_ROWS, level: 1 }));

  // Right wall upstairs: Crime & Thriller, Sci-Fi & Fantasy, 90s TV
  F.push(shelfFixture({ code: 'CT-01', style: 'wall', section: 'crimeTv', label: 'CRIME & THRILLER', x: wallX, z: -4.6, rotY: -Math.PI / 2, w: 1.7, depth: 0.34, rows: WALL_ROWS, level: 1 }));
  F.push(shelfFixture({ code: 'ST-01', style: 'wall', section: 'scifiTv', label: 'SCI-FI & FANTASY', x: wallX, z: -6.5, rotY: -Math.PI / 2, w: 1.7, depth: 0.34, rows: WALL_ROWS, level: 1 }));
  F.push(shelfFixture({ code: 'TN-01', style: 'gondola', section: 'ninetiesTv', label: '90s TV', x: wallX, z: -8.3, rotY: -Math.PI / 2, w: 1.5, depth: 0.34, rows: GONDOLA_ROWS, level: 1 }));

  // Center mezzanine gondola: Binge This Weekend / Prestige Drama
  // (kept ≥3.5m clear of the TV walls so its picks never mirror them)
  const m1x = -1.6, m1z = -5.55, m1Len = 3.2;
  F.push(shelfFixture({ code: 'BW-01', style: 'gondola', curated: 'bingeWorthy', label: 'BINGE THIS WEEKEND', x: m1x, z: m1z + 0.19, rotY: 0, w: m1Len, depth: 0.38, rows: GONDOLA_ROWS, level: 1 }));
  F.push(shelfFixture({ code: 'PD-01', style: 'gondola', section: 'prestigeTv', label: 'PRESTIGE DRAMA', x: m1x, z: m1z - 0.19, rotY: Math.PI, w: m1Len, depth: 0.38, rows: GONDOLA_ROWS, level: 1 }));

  return F;
}

function planProps(halfD = WORLD.halfD) {
  // Front of house belongs to the ENTRANCE, so every one of these is measured
  // back from the front wall — store.js draws the storefront, doors, logos and
  // security gates at halfD too, and the two have to stay in register.
  const dz = halfD - CORE_DEPTH;
  return [
    { kind: 'counter', x: 8.8, z: 7.0 + dz, rotY: 0, w: 3.0, d: 0.7, h: 1.02, level: 0 },
    { kind: 'backcounter', x: 8.8, z: 9.18 + dz, rotY: 0, w: 2.7, d: 0.45, h: 0.92, level: 0 },
    { kind: 'returnbin', x: 3.3, z: 8.85 + dz, rotY: 0, w: 0.62, d: 0.62, h: 1.0, level: 0 },
    { kind: 'snackrack', x: 5.45, z: 9.1 + dz, rotY: Math.PI, w: 1.5, d: 0.5, h: 1.5, level: 0 },
    { kind: 'popcorn', x: 12.15, z: 8.9 + dz, rotY: Math.PI, w: 0.78, d: 0.78, h: 1.7, level: 0 },
    { kind: 'standee', x: -10.6, z: 8.1 + dz, rotY: 0.5, w: 0.72, d: 0.35, h: 1.62, poster: 0, level: 0 },
    { kind: 'standee', x: 11.6, z: -8.3, rotY: -0.9, w: 0.72, d: 0.35, h: 1.62, poster: 1, level: 0 },
    // security gates by the entrance (visuals built in store.js — same dims)
    { kind: 'gate', x: -1.85, z: halfD - 0.75, rotY: 0, w: 0.1, d: 0.44, h: 1.16, level: 0 },
    { kind: 'gate', x: 1.85, z: halfD - 0.75, rotY: 0, w: 0.1, d: 0.44, h: 1.16, level: 0 },
    // Binge Zone on the mezzanine, near the escalator landing
    { kind: 'bingezone', x: -4.9, z: -4.35, rotY: 0.3, w: 2.4, d: 1.7, h: 1.0, level: 1 },
  ];
}

// ===========================================================================
// PROCEDURAL EXPANSION — the building is generated to fit the projection.
//
// In personalized mode every eligible title is stocked, so the store has to
// physically hold whatever the projection hands it. The hand-authored plan
// above is the designed heart of the shop; past it we generate an ANNEX of
// double-sided gondola aisles, sized PER LEVEL from that level's own demand
// (availability data is series-heavy — Netflix alone is 1,321 series against
// 104 films — so the mezzanine usually needs far more new shelving than the
// ground floor), and grow the shell to contain it.
//
// Nothing here caps the title count. The one fixed dimension is the width:
// store.js hand-models the storefront across x ∈ [-12.2, 13], so the shell
// grows in DEPTH only, symmetrically about z = 0 — the back zone gains floor
// on both levels, the front zone gains ground-floor sales space ahead of the
// (relocated) entrance cluster.
// ===========================================================================

const SEG_BASE = 3.6;     // nominal shelf section: its own header + aisle code
const SPINE_TARGET = 2;   // inventory depth the annex is SIZED for (never a cap)
const BAY_OFF = 0.19;     // back-to-back offset of a double-sided run
const SIGN_GAP = 1.1;     // a hanging sign floats this far in front of the run it names
const AISLE_X = 10.8;     // aisle runs stop here; beyond is the side lane
const CROSS_EVERY = 4;    // bays between cross-aisles
const CROSS_EXTRA = 1.7;  // extra clearance at a cross-aisle
const OPEN_EVERY = 8;     // one bay in eight is left out as open floor
const ENTRANCE_D = 6.6;   // depth reserved inside the doors for front of house
const FRONT_Z0 = 10.4;    // first front-zone bay centre (clear of the core)
const BACK_Z0 = -10.2;    // first back-zone bay centre (clear of the core)
const MAX_UNITS = 96;     // aisle codes are XX-01..XX-99 (formatAddress pads 2)

// Per-level shelving character. Ground: low three-row gondolas you can see
// across, wide aisles — a movie floor. Mezzanine: full-height five-row stacks,
// tighter aisles — TV box sets are the dense floor, and it is the level that
// has to absorb the series-heavy shape of the availability data.
const LEVEL_BAY = [
  { rows: GONDOLA_ROWS, depth: 0.38, style: 'gondola', height: 1.74, walk: 2.35, corridor: 2.2 },
  { rows: WALL_ROWS, depth: 0.34, style: 'wall', height: 2.28, walk: 1.85, corridor: 1.6 },
];

// Departments read as one place, in a deliberate order: the crowd-pleasers meet
// you inside the doors, the deep catalogue is at the back of the store.
const ANNEX_ORDER = [
  'newreleases|', 'action|', 'comedy|', 'thriller|', 'horror|', 'scifi|',
  'drama|', 'family|', 'classics|', 'documentary|movie', 'anime|movie',
  'tvdrama|', 'tvcomedy|', 'documentary|series', 'anime|series',
];
// documentary and anime exist on both floors, so their two halves need
// distinguishable aisle codes (the core already uses DO/DS and AN/AS).
const GROUP_CODES = {
  'documentary|movie': 'DO', 'documentary|series': 'DS',
  'anime|movie': 'AN', 'anime|series': 'AS',
};

function hash01(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

const blockPitch = (spines) => caseW + spines * SPINE_W + BLOCK_GAP;

/** Face-out display slots a shelf unit holds at a given inventory depth. */
function unitCapacity(w, rowCount, spines = SPINE_TARGET) {
  return rowCount * Math.max(0, Math.floor((w - 0.14 + BLOCK_GAP) / blockPitch(spines)));
}
const fixtureCapacity = (f, spines = SPINE_TARGET) =>
  unitCapacity(f.w, f.rows.length, spines);

/**
 * Group the stocked list exactly the way buildLayout assigns it to fixtures:
 * `${dept}|${filter}`, where documentary/anime split by content type.
 * A group's LEVEL is decided by the content it holds — series upstairs, films
 * downstairs — never by a hardcoded department list.
 */
function groupsOf(catalog) {
  const m = new Map();
  for (const t of catalog) {
    const filter = (t.dept === 'documentary' || t.dept === 'anime') ? t.type : '';
    const key = `${t.dept}|${filter}`;
    let g = m.get(key);
    if (!g) {
      g = {
        key, dept: t.dept, filter: filter || null, n: 0, series: 0, level: 0,
        label: DEPARTMENTS[t.dept].name, hue: DEPARTMENTS[t.dept].hue,
        prefix: GROUP_CODES[key] ?? DEPARTMENTS[t.dept].code,
      };
      m.set(key, g);
    }
    g.n++;
    if (t.type === 'series') g.series++;
  }
  for (const g of m.values()) g.level = g.series * 2 > g.n ? 1 : 0;
  return m;
}

/** Bay centre-lines for one level, marching away from the hand-authored core. */
function bayLine(halfD, level) {
  const bay = LEVEL_BAY[level];
  const half = bay.depth / 2 + BAY_OFF;
  const pitch = half * 2 + bay.walk;
  const zones = level === 1
    ? [{ z0: BACK_Z0, dir: -1, limit: (z) => z - half >= -halfD + 0.34 + bay.walk }]
    : [
      // front zone first: double-height, best lit, first thing you walk into
      { z0: FRONT_Z0, dir: 1, limit: (z) => z + half <= halfD - ENTRANCE_D },
      { z0: BACK_Z0, dir: -1, limit: (z) => z - half >= -halfD + 0.34 + bay.walk },
    ];
  const bays = [];
  for (let zi = 0; zi < zones.length; zi++) {
    const zone = zones[zi];
    let z = zone.z0;
    for (let i = 0; i < 240 && zone.limit(z); i++) {
      // leave the occasional bay out entirely, so the plan never reads as an
      // infinite repeating grid
      if (i === 0 || i % OPEN_EVERY !== OPEN_EVERY - 1) {
        bays.push({ z, dir: zone.dir, half, pitch, bay, level, seed: zi * 977 + i * 31 + level * 71 });
      }
      z += zone.dir * (pitch + ((i + 1) % CROSS_EVERY === 0 ? CROSS_EXTRA : 0));
    }
  }
  return bays;
}

/** The x-spans a bay's shelving actually occupies (varied length + centre corridor). */
function baySpans(b) {
  const trims = [0, 0, 1.4, 2.8, 0.7];
  const xa = -AISLE_X + trims[Math.floor(hash01(b.seed) * trims.length)];
  const xb = AISLE_X - trims[Math.floor(hash01(b.seed + 53) * trims.length)];
  const c = b.bay.corridor;
  const spans = [];
  if (-c - xa >= 2.4) spans.push([xa, -c]);
  if (xb - c >= 2.4) spans.push([c, xb]);
  return spans;
}

/**
 * Which stretches of perimeter wall the hand-authored core already owns, so the
 * generated wall runs never grow into HO-01 or TN-01. Measured from the core
 * plan itself rather than transcribed, because transcribed coordinates rot.
 */
function coreWallSpans(coreFixtures, coreProps) {
  const side = [[], []], back = [[], []];
  for (const f of coreFixtures) {
    if (f.kind !== 'shelf') continue;
    const quarter = Math.round(f.rotY / (Math.PI / 2)) % 2 !== 0;
    const hw = (quarter ? f.depth : f.w) / 2, hd = (quarter ? f.w : f.depth) / 2;
    if (Math.abs(f.x) > WORLD.halfW - 1.2) {
      side[f.level].push({ sign: Math.sign(f.x), z0: f.z - hd - 0.3, z1: f.z + hd + 0.3 });
    } else if (f.z < -(CORE_DEPTH - 1.2)) {
      back[f.level].push([f.x - hw - 0.25, f.x + hw + 0.25]);
    }
  }
  // A prop standing near a side wall blocks the SHELF IN FRONT OF IT — not the
  // shelf itself but the metre of floor a shopper has to stand on to read it,
  // which is what §30 checks. The front-of-house props are exempt: they move
  // with the doors and the front zone already keeps 6.6m clear of them.
  for (const p of coreProps) {
    if (p.z >= CORE_DEPTH - 4.6) continue;
    if (Math.abs(p.x) <= WORLD.halfW - 2.6) continue;
    const c = Math.abs(Math.cos(p.rotY)), s = Math.abs(Math.sin(p.rotY));
    const hd = (p.w * s + p.d * c) / 2;
    side[p.level ?? 0].push({ sign: Math.sign(p.x), z0: p.z - hd - 0.75, z1: p.z + hd + 0.75 });
  }
  for (const b of back) b.sort((a, c) => a[0] - c[0]);
  return { side, back };
}

/**
 * Lay out every generated shelf UNIT for a store of the given depth, in the
 * order a shopper walks them, and hand back plain descriptors. Cheap enough to
 * call repeatedly while searching for the depth that fits.
 */
function annexUnits(halfD, level, segLen, coreWalls, keepOut = null) {
  const units = [];
  const wallX = WORLD.halfW - 0.17;
  const sideBusy = coreWalls.side[level];

  const sideUnits = (b, sign, out) => {
    const z = b.z + sign * BAY_OFF;
    const rotY = sign > 0 ? 0 : Math.PI;
    for (const [a, e] of baySpans(b)) {
      const n = Math.max(1, Math.round((e - a) / segLen));
      const w = (e - a) / n;
      for (let i = 0; i < n; i++) {
        out.push({
          style: b.bay.style, x: a + w * (i + 0.5), z, rotY, w,
          depth: b.bay.depth, rows: b.bay.rows, height: b.bay.height, level,
        });
      }
    }
  };
  const capUnits = (b, out) => {
    // endcaps on the aisle ends — the face a shopper meets first
    for (const [a, e] of baySpans(b)) {
      for (const [x, ry] of [[a - 0.24, -Math.PI / 2], [e + 0.24, Math.PI / 2]]) {
        if (Math.abs(x) > wallX - 0.9) continue;
        out.push({
          style: 'endcap', x, z: b.z, rotY: ry, w: 0.9, depth: 0.4,
          rows: b.bay.rows, height: b.bay.height, level, endcap: true,
        });
      }
    }
  };

  for (const b of bayLine(halfD, level)) {
    const near = [], far = [];
    // "near" = the face pointing back toward the bay you just passed, so the
    // two sides of one walkway land next to each other in the fill order and a
    // department reads as one aisle rather than two half-aisles.
    sideUnits(b, b.dir > 0 ? -1 : 1, near);
    sideUnits(b, b.dir > 0 ? 1 : -1, far);
    capUnits(b, near);
    // the side walls the annex creates carry full-height wall runs, so the
    // building never shows a 40m stretch of blank plaster
    for (const sx of [-1, 1]) {
      const w = b.pitch - 0.12;
      const clash = sideBusy.some(s => s.sign === sx && b.z - w / 2 < s.z1 && b.z + w / 2 > s.z0);
      if (!clash && Math.abs(b.z) + w / 2 < halfD - 0.4) {
        near.push({
          style: 'wall', x: sx * wallX, z: b.z, rotY: sx < 0 ? Math.PI / 2 : -Math.PI / 2,
          w, depth: 0.34, rows: WALL_ROWS, height: 2.28, level,
        });
      }
    }
    units.push(...near, ...far);
  }

  // the back wall gains length as the store deepens — fill what the core's
  // own back-wall units leave free (TD-01..04 / TC-01..03 upstairs, the two
  // curated walls downstairs)
  // ...stopping a metre short of each corner. Shelving that runs right into the
  // return would put its stand point inside the side-wall unit around the
  // corner — legal geometry, unreachable shopper.
  // LEVEL 1 HAS NO BACK WALL ANY MORE. The mezzanine now ends in a railing you
  // look over, not masonry, so there is nothing up there to hang wall units on.
  // Level-1 demand is met by the bay runs above; if it ever isn't, sizeStore
  // grows the building, which is the correct answer rather than inventing a wall.
  if (level === 1) return units;

  // Drop any run that would be built through the rear escalator's landing.
  // Dropping units rather than reshaping bays keeps this a pure subtraction:
  // sizeStore simply finds the shell short and grows it, which is the same
  // answer it already gives for any other capacity shortfall.
  if (keepOut) {
    // TWO THINGS HAVE TO CLEAR THE MACHINE: the unit, and the shopper reading
    // it. The old test checked only the unit, and checked it with u.w as its
    // x-extent and u.depth as its z-extent regardless of rotY — so a run turned
    // side-on had its two dimensions swapped. Both bugs hid in the same place:
    // the DRAMA runs at x = +/-1.96 flank the rear bank, clear its footprint by
    // 0.2 m, and put their stand points at +/-1.01 — INSIDE a machine spanning
    // -1.15..1.25. That was invisible until the rear bank got the collider it
    // had been missing, whereupon a stand point ended up inside solid geometry.
    const hits = (x, z, hx = 0, hz = 0) =>
      x + hx > keepOut.minX && x - hx < keepOut.maxX
      && z + hz > keepOut.minZ && z - hz < keepOut.maxZ;
    const clear = (u) => {
      const rot = u.rotY ?? 0;
      const c = Math.abs(Math.cos(rot)), sn = Math.abs(Math.sin(rot));
      const d = u.depth ?? 0.38;
      if (hits(u.x, u.z, (u.w * c + d * sn) / 2, (u.w * sn + d * c) / 2)) return false;
      const dir = facingOf(rot);
      const gap = d / 2 + 0.75;                       // the same stand-off standPoint() uses
      return !hits(u.x + dir.x * gap, u.z + dir.z * gap, 0.30, 0.30);
    };
    for (let i = units.length - 1; i >= 0; i--) if (!clear(units[i])) units.splice(i, 1);
  }

  const coreBack = coreWalls.back[level];
  const backEdge = wallX - 1.0;
  let cursor = -backEdge;
  const backSpans = [];
  for (const [a, e] of coreBack) {
    if (a - cursor >= 2.4) backSpans.push([cursor, a]);
    cursor = Math.max(cursor, e);
  }
  if (backEdge - cursor >= 2.4) backSpans.push([cursor, backEdge]);
  for (const [a, e] of backSpans) {
    const n = Math.max(1, Math.round((e - a) / segLen));
    const w = (e - a) / n;
    for (let i = 0; i < n; i++) {
      units.push({
        style: 'wall', x: a + w * (i + 0.5), z: -(halfD - 0.17), rotY: 0, w,
        depth: 0.34, rows: WALL_ROWS, height: 2.28, level,
      });
    }
  }
  return units;
}

/**
 * Pour the departments that overflow the core into the generated units, in
 * order, so each department occupies one contiguous stretch of the building.
 * Returns null when this depth cannot hold them — the caller then grows it.
 */
function pourAnnex(halfD, groups, coreCap, segLen, coreWalls) {
  const assigned = [];
  // LEVEL 1 FIRST, deliberately. The rear escalator bank hangs off the balcony's
  // back edge, and that edge is only known once the mezzanine's own aisles have
  // been poured — so the ground floor has to be poured second, with the bank's
  // landing already carved out of it. Per-level assignment is independent, so
  // swapping the outer order changes nothing else.
  let keepOut = null;
  for (const level of [1, 0]) {
    const units = annexUnits(halfD, level, segLen, coreWalls, level === 0 ? keepOut : null);
    const wanted = ANNEX_ORDER
      .map(k => groups.get(k))
      .filter(g => g && g.level === level && g.n - (coreCap.get(g.key) || 0) > 0);
    for (const g of groups.values()) {
      if (g.level === level && !ANNEX_ORDER.includes(g.key)
        && g.n - (coreCap.get(g.key) || 0) > 0) wanted.push(g);
    }
    let ui = 0;
    for (const g of wanted) {
      let need = g.n - (coreCap.get(g.key) || 0);
      const taken = [];
      while (need > 0 && ui < units.length) {
        const u = units[ui++];
        taken.push(u);
        need -= unitCapacity(u.w, u.rows.length);
      }
      if (need > 0) return null;                       // this shell is too small
      if (taken.length > MAX_UNITS) return null;        // aisle codes would overflow
      assigned.push({ group: g, units: taken });
    }
    // The balcony's rear edge is now fixed by what level 1 just took, so the
    // ground floor below can be told where not to build.
    if (level === 1) keepOut = rearKeepOut(clampMezzBack(mezzBackFromPlan(assigned), halfD));
  }
  return assigned;
}

// Behind the last TV aisle sits the anchor run (TV DRAMA / TV COMEDY, back to
// back), and behind that a clear promenade along the railing — the point of the
// balcony is that you can walk its edge and look down over the movie floor.
const MEZZ_ANCHOR_GAP = 2.9;   // last aisle -> anchor run
const MEZZ_PROMENADE = 3.6;    // anchor run -> rear railing

/** setMezzDepth's clamp, without mutating WORLD — the pour needs it mid-search. */
function clampMezzBack(backZ, halfD) {
  return Math.max(-halfD, Math.min(mezzFrontZ - MEZZ_MIN_DEPTH, backZ));
}

/**
 * Ground-floor footprint the rear bank needs kept clear: its run, plus a pad to
 * step onto at the bottom. The front banks never needed this because they stand
 * inside the hand-authored core, which the pour never touches; the rear bank
 * lands out in generated aisles and would otherwise have shelving built through
 * it.
 */
function rearKeepOut(mezzBackZ) {
  const gap = rearBankGap(mezzBackZ);
  if (!gap) return null;
  // THE WHOLE MACHINE, not just its board pad. The old rectangle stopped at
  // mezzBackZ + 0.3, but the rear bank's incline carries on rising for another
  // 2.9 m past the slab edge before its top newel — so runs were being poured
  // alongside 2.6 m of escalator that the keep-out did not know was there.
  //
  // Expressed in the same signed convention bankEscalators uses, so it stays
  // right if the rear bank is ever re-hung: the outer face of the boarding
  // newel sits 0.40 m beyond boardZ, and the top newel 0.85 m beyond topCombZ.
  const near = mezzBackZ - (ESC_Z.boardZ + 0.40);
  const far = mezzBackZ - (ESC_Z.topCombZ - 0.85);
  return {
    minX: gap.minX - 0.3, maxX: gap.maxX + 0.3,
    minZ: Math.min(near, far) - 0.3,
    maxZ: Math.max(near, far) + 0.3,
  };
}

/** Where the mezzanine's rear edge belongs, given what the pour actually used. */
function mezzBackFromPlan(plan) {
  let deepest = BACK_Z0;
  for (const a of plan || []) {
    for (const u of a.units) if (u.level === 1 && u.z < deepest) deepest = u.z;
  }
  return deepest - MEZZ_ANCHOR_GAP - MEZZ_PROMENADE;
}

/** Centre-line of the anchor run, one promenade in from the railing. */
export function mezzAnchorZ() { return WORLD.mezzBackZ + MEZZ_PROMENADE; }

/**
 * THE BUILDING GROWS TO FIT THE PROJECTION.
 * Search for the shallowest store that physically holds every stocked title on
 * the right level. Never trims the projection; never assumes a maximum.
 */
function sizeStore(groups, coreCap, coreWalls) {
  // Sections are widened only if a single department would otherwise need more
  // than 96 aisle codes — the address format is XX-99 and must stay readable.
  let segLen = SEG_BASE;
  for (const g of groups.values()) {
    const need = g.n - (coreCap.get(g.key) || 0);
    if (need <= 0) continue;
    const rows = LEVEL_BAY[g.level].rows.length;
    const run = need * blockPitch(SPINE_TARGET) / rows;
    segLen = Math.max(segLen, run / (MAX_UNITS - 8));
  }
  const total = [...groups.values()].reduce((s, g) => s + Math.max(0, g.n - (coreCap.get(g.key) || 0)), 0);
  if (total === 0) return { halfD: CORE_DEPTH, segLen, plan: [] };

  let lo = CORE_DEPTH;
  for (let halfD = CORE_DEPTH; halfD <= 400; halfD += 0.4) {
    lo = halfD;
    if (pourAnnex(halfD, groups, coreCap, segLen, coreWalls)) break;
  }
  // refine downward so the shell is the SMALLEST that fits
  for (let halfD = Math.max(CORE_DEPTH, lo - 0.4); halfD <= lo + 0.001; halfD += 0.1) {
    const plan = pourAnnex(halfD, groups, coreCap, segLen, coreWalls);
    if (plan) return { halfD: Math.round(halfD * 100) / 100, segLen, plan };
  }
  const plan = pourAnnex(lo, groups, coreCap, segLen, coreWalls);
  return { halfD: lo, segLen, plan: plan || [] };
}

/** Materialise the poured plan as real fixtures (and their signage). */
function buildAnnex(plan, coreCount) {
  const fixtures = [], signs = [];
  const seq = new Map(coreCount);
  for (const { group, units } of plan) {
    const codes = [];
    for (const u of units) {
      const n = (seq.get(group.key) || 0) + 1;
      seq.set(group.key, n);
      const code = `${group.prefix}-${String(n).padStart(2, '0')}`;
      codes.push(code);
      fixtures.push(shelfFixture({
        code, style: u.style, dept: group.dept, filter: group.filter,
        label: group.label, x: u.x, z: u.z, rotY: u.rotY, w: u.w,
        depth: u.depth, rows: u.rows, level: u.level, height: u.height,
      }));
    }
    if (!units.length) continue;
    // one hanging sign per generated department run, out in its own walkway
    const mid = units[Math.floor(units.length / 2)];
    const dir = facingOf(mid.rotY);
    signs.push({
      text: group.label,
      sub: codes.length > 1 ? `AISLES ${codes[0]} to ${codes[codes.length - 1]}` : `AISLE ${codes[0]}`,
      x: Math.max(-11.2, Math.min(11.2, mid.x + dir.x * SIGN_GAP)),
      z: mid.z + dir.z * SIGN_GAP,
      rotY: mid.rotY, hue: group.hue, level: mid.level,
    });
  }
  return { fixtures, signs };
}

// ---------------------------------------------------------------------------
// Slot generation + title assignment
// ---------------------------------------------------------------------------
function sortKey(title) {
  return title.replace(/^(the|a|an)\s+/i, '').toUpperCase();
}

function seededRand(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


function makeSlot(f, e, titleId, primary, special = null) {
  const w = special ? special.pos : slotWorld(f, e.rowIdx, e.posIdx);
  return {
    id: `${f.id}-r${e.rowIdx}-p${e.posIdx}`,
    fixtureId: f.id,
    rowIdx: e.rowIdx, posIdx: e.posIdx,
    titleId, primary,
    level: f.level,
    x: w.x, y: w.y, z: w.z, rotY: w.rotY,
    lay: special ? special.lay : false,
    tilt: special ? special.tilt : 0,
    address: {
      section: f.label, aisle: f.code, floor: f.level ? 'MEZZANINE' : 'GROUND',
      shelf: e.shelfNo, position: e.positionNo,
      curated: !!(f.curated || f.section),
    },
  };
}

// ---------------------------------------------------------------------------
// MERCHANDISING — the visible-duplication rule, enforced at generation time.
// ONE face-out display copy per canonical title per section. Inventory depth
// is a packed spine-out block beside each face copy (how a human store manager
// stocks a rental wall). A global face-out registry guarantees the same title
// never appears face-out twice within VISUAL_DUP_RADIUS anywhere in the store.
// ---------------------------------------------------------------------------
export const VISUAL_DUP_RADIUS = 3.5;
const SPINE_W = 0.034, BLOCK_GAP = 0.055;

function placeSection(fs, titleIds, noteSlot, opts) {
  const { primary, faceReg, spines: [sMin, sMax] } = opts;
  const rows = [];
  for (const f of fs) {
    const usable = f.w - 0.14;
    for (let r = f.rows.length - 1; r >= 0; r--) rows.push({ f, rowIdx: r, usable });
  }
  // interleave rows ACROSS fixtures (eye-level first) so a multi-unit section
  // stocks every unit — never a full unit followed by a bare one
  rows.sort((a, b) => (b.rowIdx - a.rowIdx) || (a.f.seq - b.f.seq));
  const T = titleIds.length;
  if (!T || !rows.length) return;
  // capacity-driven inventory depth: the LARGEST spine block such that every
  // title still gets its face-out display copy (row packing, not averages)
  const capacityAt = (s) => {
    const bw = caseW + s * SPINE_W + BLOCK_GAP;
    return rows.reduce((sum, r) => sum + Math.floor((r.usable + BLOCK_GAP) / bw), 0);
  };
  let spines = sMax;
  while (spines > 0 && capacityAt(spines) < T) spines--;
  spines = Math.max(spines, 0);
  const blockW = caseW + spines * SPINE_W;

  let ri = 0, cursor = 0, blockNo = 0, rowBlock = 0;
  for (const titleId of titleIds) {
    while (ri < rows.length && cursor + blockW > rows[ri].usable) { ri++; cursor = 0; rowBlock = 0; }
    if (ri >= rows.length) break;
    const { f, rowIdx, usable } = rows[ri];
    const shelfNo = f.rows.length - rowIdx;
    const y = f.baseY + f.rows[rowIdx] + caseH / 2 + 0.004;
    const startX = -usable / 2 + cursor;
    const addr = (pos) => ({
      section: f.label, aisle: f.code, floor: f.level ? 'MEZZANINE' : 'GROUND',
      shelf: shelfNo, position: pos, curated: !!(f.curated || f.section),
    });
    // the ONE face-out display copy of this title in this section
    const fo = rotXZ(startX + caseW / 2, f.depth / 2 - caseD / 2 - 0.035, f.rotY);
    const faceSlot = {
      id: `${f.id}-b${blockNo}-f`, fixtureId: f.id, rowIdx, posIdx: rowBlock * 40,
      titleId, primary, level: f.level,
      x: f.x + fo.x, y, z: f.z + fo.z, rotY: f.rotY,
      lay: false, tilt: 0,
      address: addr(rowBlock + 1),
    };
    noteSlot(faceSlot);
    if (!faceReg.has(titleId)) faceReg.set(titleId, []);
    faceReg.get(titleId).push({
      x: faceSlot.x, z: faceSlot.z, level: f.level, fixtureId: f.id,
      fx: Math.sin(f.rotY), fz: Math.cos(f.rotY),
    });
    // spine-out inventory copies behind the display copy
    for (let j = 0; j < spines; j++) {
      const so = rotXZ(startX + caseW + SPINE_W * (j + 0.5), f.depth / 2 - caseW / 2 - 0.015, f.rotY);
      noteSlot({
        id: `${f.id}-b${blockNo}-s${j}`, fixtureId: f.id, rowIdx, posIdx: rowBlock * 40 + 1 + j,
        titleId, primary: false, level: f.level,
        x: f.x + so.x, y, z: f.z + so.z, rotY: f.rotY + Math.PI / 2,
        lay: false, tilt: 0, spineOut: true,
        address: addr(rowBlock + 1),
      });
    }
    cursor += blockW + BLOCK_GAP;
    blockNo++; rowBlock++;
  }
}

// candidates already face-out nearby OR CO-VISIBLE from this fixture are
// excluded — a curated display picks DIFFERENT titles instead.
// Co-visible = the two fronts point toward each other within SIGHTLINE_RANGE,
// so one casual glance could catch the same cover twice (the real acceptance
// criterion — the 3.5m radius alone misses across-the-aisle pairs).
export const SIGHTLINE_RANGE = 9;

// pad expands both thresholds — the generation-time filter passes the fixture
// half-width so the check stays conservative for any slot along the fixture
export function coVisible(a, b, pad = 0) {
  if (a.level !== b.level) return false;
  const dx = b.x - a.x, dz = b.z - a.z;
  const d = Math.hypot(dx, dz);
  if (d < VISUAL_DUP_RADIUS + pad) return true;
  if (d > SIGHTLINE_RANGE + pad) return false;
  const aSees = a.fx == null || (a.fx * dx + a.fz * dz) > 0.25 * d;
  const bSees = b.fx == null || (b.fx * -dx + b.fz * -dz) > 0.25 * d;
  return aSees && bSees;
}

function radiusFilter(ids, f, faceReg) {
  const fN = facingOf(f.rotY);
  const open = f.kind === 'table' || f.kind === 'bin';
  // probe the center AND both ends of the face line — a future slot can land
  // anywhere along it, so every extreme must clear the sightline rule
  const probes = [0, -f.w / 2, f.w / 2].map(lx => {
    const o = rotXZ(lx, f.depth / 2, f.rotY);
    return {
      x: f.x + o.x, z: f.z + o.z, level: f.level,
      fx: open ? null : fN.x, fz: open ? null : fN.z,
    };
  });
  return ids.filter(id => !(faceReg.get(id) || []).some(p =>
    probes.some(here => coVisible(p, here, 0.3))));
}

// A department is placed one AISLE-SIZED RUN at a time rather than as a single
// section spanning the whole store. placeSection interleaves rows across every
// fixture it is given (so no unit is left bare); over a 40-unit generated run
// that would smear the alphabet across the entire building one shelf at a time.
// Chunking keeps that behaviour inside a run — each run is uniformly stocked —
// while the runs themselves stay in alphabetical order down the aisle.
const RUN_UNITS = 8;

function placeDepartment(fs, titleIds, noteSlot, faceReg) {
  const chunks = [];
  for (let i = 0; i < fs.length; i += RUN_UNITS) chunks.push(fs.slice(i, i + RUN_UNITS));
  if (!chunks.length) return titleIds.length;
  const capT = chunks.map(c => c.reduce((s, f) => s + fixtureCapacity(f, SPINE_TARGET), 0));
  const capMax = chunks.map(c => c.reduce((s, f) => s + fixtureCapacity(f, 0), 0));
  const total = capT.reduce((a, b) => a + b, 0);
  const N = titleIds.length;
  const ratio = total > 0 ? Math.min(1, N / total) : 0;
  // Fill every run to the SAME fraction of its capacity: placeSection then
  // picks the same inventory depth throughout, so a thin department reads as
  // deeply stocked rather than as a run of half-empty shelves.
  const share = [];
  let left = N;
  for (let i = 0; i < chunks.length; i++) {
    const s = Math.min(left, capMax[i],
      i === chunks.length - 1 ? left : Math.round(capT[i] * ratio));
    share.push(s);
    left -= s;
  }
  for (let i = 0; left > 0 && i < chunks.length; i++) {
    const add = Math.min(capMax[i] - share[i], left);
    share[i] += add;
    left -= add;
  }
  let cursor = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (share[i] > 0) {
      placeSection(chunks[i], titleIds.slice(cursor, cursor + share[i]), noteSlot, {
        primary: true, faceReg, spines: [3, 12],
      });
    }
    cursor += share[i];
  }
  return left;
}


// ---------------------------------------------------------------------------
// NOTHING MAY GROW INTO THE CLERESTORY.
//
// The glazing band is a fixed elevation on the BUILDING (4.30..5.50, hanging to
// CLERESTORY.underside once its stooled sill is counted). On the ground floor
// that is comfortably above the tallest 2.28 m unit, which is why the original
// comment claimed the band sits "above every fixture". On the MEZZANINE that is
// false: the floor is already at 3.30, so a standard 2.28 m wall bay tops out at
// 5.655 — through the glass, above even the window head.
//
// Measured at STORE_CAPACITY, 14 level-1 bays stood inside the glazing volume
// and one interpenetrated a right-wall pane outright.
//
// The fix is to SHORTEN the offending bays, not to move or drop the windows. And
// it cannot key off `style: 'wall'` — that names the shelving CHARACTER (tall
// five-row stacks) and the mid-floor mezzanine gondolas share it. Only a bay
// whose footprint actually reaches a GLAZED wall is clamped; the 80 free-standing
// ones keep their full height. Note that repositioning a full-height bay off the
// wall would not have worked either: at 3.30 + 2.28 it would still stand in front
// of the 4.30..5.50 band and blank the window from the balcony.
const FIXTURE_CAP = 0.075;        // store.js caps a unit with a 0.05 board at H + 0.025
const GLAZING_CLEAR = 0.03;       // daylight between a cap board and the sill soffit

/** Tallest a unit standing on `baseY` may be and still pass under the glazing. */
export function maxHeightUnderClerestory(baseY) {
  return CLERESTORY.underside - baseY - FIXTURE_CAP - GLAZING_CLEAR;
}

/** Shelf rows that fit inside `height`, re-pitched rather than merely filtered. */
function rowsUnder(height) {
  const pitch = WORLD.caseH + 0.06;
  const out = [];
  for (let y = 0.22; y + WORLD.caseH <= height; y += pitch) out.push(Math.round(y * 100) / 100);
  return out.length ? out : [0.22];
}

/**
 * Clamp every fixture that would otherwise stand in the glazing. Runs BEFORE
 * slots are emitted, so a shortened bay simply offers fewer slots and
 * buildLayout grows the building to place the titles elsewhere — which is the
 * designed behaviour, and why this cannot silently drop stock.
 */
function clampToClerestory(fixtures, halfD) {
  const glazedX = WORLD.halfW, glazedZ = -halfD;
  for (const f of fixtures) {
    if (f.kind !== 'shelf') continue;
    const base = f.baseY ?? 0;
    const top = base + (f.height ?? 0) + FIXTURE_CAP;
    if (top <= CLERESTORY.sillY) continue;                  // never reaches the band
    const { hw, hd } = halfExtent(f);
    // Distance to each glazed plane. The storefront (maxZ) carries no
    // clerestory — and since the window repair, neither do the side-wall
    // stretches the mezzanine reaches: clerestoryAllowedAt is the SAME
    // authority store.js builds panes from, so a bay is only ever clamped
    // for glass that actually exists. This is what returned the 23 stub
    // bays (TV DRAMA/TV COMEDY wall runs) to full five-row height.
    const nearLeft = (f.x - hw) + glazedX < CLERESTORY.reveal
      && clerestoryAllowedAt('left', f.z - hd, f.z + hd);
    const nearRight = glazedX - (f.x + hw) < CLERESTORY.reveal
      && clerestoryAllowedAt('right', f.z - hd, f.z + hd);
    const nearBack = (f.z - hd) - glazedZ < CLERESTORY.reveal
      && clerestoryAllowedAt('back', f.x - hw, f.x + hw);
    if (!nearLeft && !nearRight && !nearBack) continue;     // no glass to respect
    const h = maxHeightUnderClerestory(base);
    f.height = Math.round(h * 1000) / 1000;
    f.rows = rowsUnder(h);
    f.rowSlots = Math.floor((f.w - 0.14) / casePitch);
    f.clampedBy = 'clerestory';
  }
  return fixtures;
}

/**
 * The order cover atlases should be PACKED in: by shelf position, not by
 * catalogue index.
 *
 * planCoverAtlases assigns a title to an atlas by its index in the array it is
 * given (atlas = floor(i / perAtlas)), while buildLayout places titles by
 * department and merchandising. Those two orders are unrelated, so an atlas's
 * 77 tiles were scattered over a 148 m building. Measured at the spawn point,
 * looking into the store:
 *
 *   packed by catalogue order   38 visible covers <- 11 atlases, 847 decodes   4.5% useful
 *   packed by shelf position    38 visible covers <-  2 atlases, 154 decodes  24.7% useful
 *
 * i.e. 5.5x less fetching and decoding to fill the first thing the player
 * looks at, and the median atlas z-extent falls from 45.9 m to 3.8 m — which
 * also gives the merged case batches bounds tight enough to be frustum-culled
 * at all.
 *
 * THIS IS A PERMUTATION AND NOTHING ELSE. Same titles, same count, same
 * membership, same layout, same merchandising. It only changes which tile of
 * which texture a cover is drawn into. Because the returned array is the one
 * handed to CoverStreamer, every `job.atlas * plan.perAtlas` expression inside
 * covers.js stays correct untouched.
 *
 * Titles are keyed on their PRIMARY slot. A curated front-of-store copy of a
 * title whose home shelf is at the back still smears one atlas across the
 * building — that is why the max extent stays high while the median collapses.
 */
export function spatialCoverOrder(stocked, layout) {
  const BAND = 2.0;                      // a little wider than one bay
  const key = new Map();
  for (const t of stocked) {
    const rec = layout.titles.get(t.id);
    const slot = rec && layout.slotById.get(rec.primarySlotId);
    key.set(t.id, slot
      ? { level: slot.level, band: Math.floor(slot.z / BAND), x: slot.x }
      : null);
  }
  return [...stocked].sort((a, b) => {
    const ka = key.get(a.id), kb = key.get(b.id);
    if (!ka && !kb) return 0;
    if (!ka) return 1;                   // unplaced titles trail the pack
    if (!kb) return -1;
    if (ka.level !== kb.level) return ka.level - kb.level;
    if (ka.band !== kb.band) return ka.band - kb.band;
    return ka.x - kb.x;
  });
}

export function buildLayout(catalog, curation) {
  fixtureSeq = 0;

  // ---- GROW THE BUILDING TO FIT THE PROJECTION ---------------------------
  // Core capacity first (it never depends on the shell), then the shortfall
  // per department, then the shallowest store that holds it.
  const groups = groupsOf(catalog);
  const coreProbe = planFixtures(CORE_DEPTH);
  const coreCap = new Map();
  const coreCount = new Map();
  for (const f of coreProbe) {
    if (f.kind !== 'shelf' || !f.dept) continue;
    const k = `${f.dept}|${f.filter || ''}`;
    coreCap.set(k, (coreCap.get(k) || 0) + fixtureCapacity(f, SPINE_TARGET));
    coreCount.set(k, (coreCount.get(k) || 0) + 1);
  }
  const coreWalls = coreWallSpans(coreProbe, planProps(CORE_DEPTH));
  const sized = sizeStore(groups, coreCap, coreWalls);
  const halfD = setStoreDepth(sized.halfD);
  // THE BALCONY IS SIZED BY ITS OWN AISLES. sized.plan already records which
  // level-1 units the pour actually used, so the mezzanine's rear edge is known
  // before a single fixture is placed: go as deep as the last TV aisle, then add
  // the anchor run and a promenade to stand on.
  setMezzDepth(mezzBackFromPlan(sized.plan));
  const escs = buildEscalators(WORLD.mezzBackZ, halfD);
  const hasRear = escs.some(e => e.edge === 'rear');

  fixtureSeq = 0;
  let fixtures = planFixtures(halfD);
  const annex = buildAnnex(sized.plan, coreCount);
  fixtures = fixtures.concat(annex.fixtures);
  // Before any slot exists: nothing may stand in the windows.
  clampToClerestory(fixtures, halfD);
  const props = planProps(halfD);
  const byId = new Map(catalog.map(t => [t.id, t]));

  const slots = [];
  const titles = new Map();

  const noteSlot = (slot) => {
    slots.push(slot);
    let rec = titles.get(slot.titleId);
    if (!rec) { rec = { slotIds: [], primarySlotId: null }; titles.set(slot.titleId, rec); }
    rec.slotIds.push(slot.id);
    if (slot.primary) rec.primarySlotId = slot.id;
  };

  // --- Department shelves. A dept may be split by content type across levels
  //     (e.g. anime films downstairs, anime series upstairs) — each (dept,filter)
  //     group is its own alphabetical run with its own primaries.
  const deptGroups = new Map();
  for (const f of fixtures) {
    if (f.kind !== 'shelf' || !f.dept) continue;
    const key = `${f.dept}|${f.filter || ''}`;
    if (!deptGroups.has(key)) deptGroups.set(key, []);
    deptGroups.get(key).push(f);
  }
  const faceReg = new Map(); // titleId -> face-out placements (global registry)
  for (const [key, fs] of deptGroups) {
    const [dept, filter] = key.split('|');
    fs.sort((a, b) => a.seq - b.seq);
    const deptTitles = catalog
      .filter(t => t.dept === dept && (!filter || t.type === filter))
      .sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title)));
    // spine blocks cap at 12 — deep enough to read as stock, never a spine wall
    const unplaced = placeDepartment(fs, deptTitles.map(t => t.id), noteSlot, faceReg);
    if (unplaced > 0) {
      // The shell is generated FROM this demand, so this is unreachable — but a
      // silently dropped title is exactly the failure this whole pass exists to
      // remove, so it fails loudly rather than shipping a shorter catalogue.
      throw new Error(`layout: ${unplaced} ${key} titles had nowhere to go`);
    }
  }

  // --- Curated + predicate sections: secondary copies of canonical titles.
  // Candidates already face-out within the visual radius are skipped, so a
  // curated display never mirrors the shelf a few steps away (§5/§6).
  const rng = seededRand(1337);
  for (const f of fixtures) {
    if (!f.curated && !f.section) continue;
    let ids;
    if (f.section) {
      ids = catalog.filter(TV_SECTIONS[f.section].pred)
        .sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title)))
        .map(t => t.id);
    } else {
      ids = (curation[f.curated] || []).filter(id => byId.has(id));
    }
    ids = radiusFilter([...new Set(ids)], f, faceReg);

    if (f.kind === 'table' || f.kind === 'bin') {
      // face-up displays: unique titles only, no modulo repeats
      const n = Math.min(f.rowSlots, ids.length);
      for (let i = 0; i < n; i++) {
        const titleId = ids[i];
        let pos, tilt;
        if (f.kind === 'table') {
          const col = i % 4, row = Math.floor(i / 4);
          pos = {
            x: f.x - 0.42 + col * 0.28, y: f.rows[0] + caseD / 2 + 0.004,
            z: f.z - 0.18 + row * 0.36, rotY: (rng() - 0.5) * 0.5,
          };
          tilt = 0.06;
        } else {
          const ang = rng() * Math.PI * 2, rr = rng() * 0.32;
          pos = {
            x: f.x + Math.cos(ang) * rr, y: f.rows[0] + caseD / 2 + rng() * 0.05,
            z: f.z + Math.sin(ang) * rr, rotY: rng() * Math.PI * 2,
          };
          tilt = (rng() - 0.5) * 0.5;
        }
        noteSlot(makeSlot(f, { rowIdx: 0, posIdx: i, shelfNo: 1, positionNo: i + 1 },
          titleId, false, { pos, lay: true, tilt }));
        if (!faceReg.has(titleId)) faceReg.set(titleId, []);
        // face-up copies are visible from every direction
        faceReg.get(titleId).push({ x: pos.x, z: pos.z, level: f.level, fixtureId: f.id, fx: null, fz: null });
      }
    } else {
      // endcaps: face-out only; curated shelves: face + a modest spine block
      placeSection([f], ids, noteSlot, {
        primary: false, faceReg,
        spines: f.style === 'endcap' ? [0, 0] : [2, 8],
      });
    }
  }

  // --- Drop curated displays that legitimately have nothing to show.
  // The sightline rule outranks the floor plan: a curated gondola or endcap
  // only ever holds SECONDARY copies, so when every candidate is already
  // face-out within view of it, the honest outcome is no fixture — not a lit,
  // signed, empty one. Wall departments are never dropped; they anchor the
  // store's geography even when a service filter leaves them thin.
  const emptyCurated = new Set(
    fixtures.filter(f => (f.curated || f.section)
      && !slots.some(s => s.fixtureId === f.id)).map(f => f.id));
  if (emptyCurated.size) {
    fixtures = fixtures.filter(f => !emptyCurated.has(f.id));
  }

  // --- Per-title address / stand point (carries level)
  const slotById = new Map(slots.map(s => [s.id, s]));
  for (const [titleId, rec] of titles) {
    if (!rec.primarySlotId) rec.primarySlotId = rec.slotIds[0];
    const s = slotById.get(rec.primarySlotId);
    rec.address = s.address;
    rec.level = s.level;
    rec.copies = rec.slotIds.length;
    const dir = facingOf(s.rotY);
    rec.standPoint = { x: s.x + dir.x * standOff, z: s.z + dir.z * standOff, level: s.level };
    rec.faceAt = { x: s.x, y: s.y, z: s.z };
  }

  // --- Obstacles per level (categorized: these ARE the collision source of truth)
  const obstacles = [[], []];
  for (const f of fixtures) {
    const quarter = Math.round(f.rotY / (Math.PI / 2)) % 2 !== 0;
    let hw = (quarter ? f.depth : f.w) / 2, hd = (quarter ? f.w : f.depth) / 2;
    if (f.kind === 'bin') { hw = f.w / 2; hd = f.depth / 2; }
    obstacles[f.level].push({ x: f.x, z: f.z, hw, hd, id: f.id, kind: f.kind, h: f.height });
  }
  for (const p of props) {
    const c = Math.abs(Math.cos(p.rotY)), s = Math.abs(Math.sin(p.rotY));
    obstacles[p.level ?? 0].push({
      x: p.x, z: p.z, hw: (p.w * c + p.d * s) / 2, hd: (p.w * s + p.d * c) / 2,
      id: p.kind, kind: p.kind, h: p.h,
    });
  }
  // ESCALATOR STRUCTURE, DERIVED PER MACHINE.
  //
  // This block used to be seven transcribed boxes at literal x=-8.05/-9.18/
  // -6.92 and z=1.62/-5.85 — the FRONT-WEST bank's coordinates, with a comment
  // naming that bank's spans. There are six escalators in three banks, so the
  // east pair and the rear pair had NO body collider and NO corridor rails at
  // all: measured, a 0.30 m circle at the centre of the east incline hit
  // nothing and the grid called the cell open, so the player and every NPC
  // walked straight through two thirds of the machines and the nav grid happily
  // routed them that way.
  //
  // Same defect class as wellFor()'s front-edge z and the NPC rider's
  // `r.dir > 0 ? 0 : PI` facing: a value that is right for the front bank,
  // transcribed and then applied to a varied population. Everything below is
  // read off each escalator's own record, so a seventh bank would be blocked
  // the day it is generated.
  // ONE BODY PER BANK, not per machine. Two boxes sharing a face leave a seam
  // that pushOut() can oscillate inside — measured as a recovery failure at
  // (-8.00, -2.20), exactly on the join between the up and down machines of the
  // west bank — and a bank is one structure anyway.
  for (const b of escalatorBanks(escs)) {
    const sgn = b.zSign;
    // The bank's footprint: the whole incline, extended past the TOP comb
    // (which lies at -sgn from the bottom, so the rear bank extends the other
    // way). The boarding flat is deliberately NOT included — it is a real
    // corridor you walk into, walled by the rails below.
    const zTop = b.inclineEndZ - sgn * 0.6;
    const zBot = b.inclineStartZ;
    obstacles[0].push({
      x: (b.minX + b.maxX) / 2, z: (zTop + zBot) / 2,
      hw: (b.maxX - b.minX) / 2,
      hd: Math.abs(zTop - zBot) / 2,
      id: `${b.id}-body`, kind: 'escalator', h: 1.4,
    });
  }
  for (const e of escs) {
    const sgn = e.zSign ?? 1;
    // Corridor rails either side of the boarding flat, and the matching pair at
    // the mezzanine landing. Between two machines of one bank the inner rails
    // overlap, which is what closes the gap the old hand-placed centre rail
    // covered.
    for (const side of [-1, 1]) {
      obstacles[0].push({
        x: e.x + side * e.width / 2, z: e.boardZ - sgn * 0.28,
        hw: 0.07, hd: 0.72, id: `${e.id}-rail-${side < 0 ? 'a' : 'b'}`, kind: 'escalator', h: 1.1,
      });
      obstacles[1].push({
        x: e.x + side * e.width / 2, z: e.exitZ,
        hw: 0.07, hd: 0.55, id: `${e.id}-land-${side < 0 ? 'a' : 'b'}`, kind: 'escalator', h: 1.1,
      });
    }
  }

  // --- Hanging signs (level-aware). Front-of-house and back-wall signage
  // tracks the walls it belongs to, exactly as the fixtures below them do.
  const signs = [];
  const dzSign = halfD - CORE_DEPTH;
  const wallSign = (deptKey, x, z, rotY, level = 0) => {
    const d = DEPARTMENTS[deptKey];
    signs.push({ text: d.name, sub: `AISLES ${d.code}-01 · ${d.code}-02`, x, z, rotY, hue: d.hue, level });
  };
  const leftPairs = [['horror', 6.41], ['scifi', 2.49], ['thriller', -1.42], ['classics', -5.34]];
  const rightPairs = [['action', 6.41], ['drama', 2.49], ['comedy', -1.42], ['family', -5.34]];
  for (const [k, z] of leftPairs) wallSign(k, -11.45, z, 0);
  for (const [k, z] of rightPairs) wallSign(k, 11.45, z, 0);
  // THE CENTRE GONDOLA'S TWO CALL-OUTS, DERIVED FROM THE FACES THEY NAME.
  //
  // These were hand-placed at x -4.95 and -3.45: literals chosen when this
  // family's board was 1.5 m wide, at 1.5 m centres. Part 1 gave the family a
  // 1.62 m board and the two signs ended up 0.12 m INSIDE ONE ANOTHER — the
  // only board-to-board intersection in the store. Both also hung over the
  // island itself rather than over the aisle each one serves, so a shopper in
  // the west aisle was being told ANIME was overhead when anime's shelves face
  // the other way.
  //
  // Derived instead from the fixture face each names, one SIGN_GAP clear of
  // it — which is what buildAnnex() already does for every generated run, and
  // what the mezzanine TD/TC signs were moved onto. The two boards end up 2.96 m
  // apart, each over its own aisle, and neither can drift into the other when
  // the family's board size changes again.
  const gondolaSign = (code, text, sub, hue) => {
    const f = fixtures.find((x) => x.code === code);
    const dir = facingOf(f.rotY);
    signs.push({
      text, sub, hue, level: f.level || 0, rotY: 0,
      x: f.x + dir.x * (f.depth / 2 + SIGN_GAP),
      z: f.z + dir.z * (f.depth / 2 + SIGN_GAP),
    });
  };
  gondolaSign('DO-01', 'DOCUMENTARY', 'FILMS · DO-01', DEPARTMENTS.documentary.hue);
  gondolaSign('AN-01', 'ANIME', 'FILMS · AN-01', DEPARTMENTS.anime.hue);
  signs.push({ text: 'NEW RELEASES', sub: 'NR-01 · NR-02', x: -5.2, z: 6.6 + dzSign, rotY: 0, hue: DEPARTMENTS.newreleases.hue, level: 0 });
  // THE CHECKOUT SIGN IS FIXED TO A WALL, SO IT HAS TO BE AT ONE.
  //
  // Its z was `7.0 + dzSign` — a hand-chosen offset, and the only sign in the
  // store whose family does not hang. Raycast from the board: the nearest
  // surface on the side its spacers point at was 2.30 m away, so a 90 mm
  // standoff was reaching for a host that was not there. Same failure the whole
  // of Part 1 was about — a support terminating at nothing — surviving in the
  // one sign that is not suspended, and invisible head-on because the front
  // wall renders directly behind it.
  //
  // Derived from the wall it is fixed to, so the spacers land ON it.
  const svc = SIGN_FAMILIES.service;
  signs.push({
    text: 'CHECKOUT', sub: 'RETURNS · MEMBERSHIP',
    x: 8.8, z: frontWallFaceZ() - (svc.depth / 2 + svc.standoff),
    rotY: 0, hue: 48, level: 0,
  });
  // ESCALATOR WAYFINDING, DERIVED FROM THE MACHINES.
  //
  // This looped over WELLS — the module constant, which is FRONT-ONLY by
  // construction — and hung each call-out at a literal z of 2.9, the front
  // banks' boarding line. The way DOWN was a single hand-placed sign at
  // x = -8.0. Measured against the six machines the building actually has:
  // esc-down-e had no sign at all, so the east half of the mezzanine had
  // nothing telling anyone how to get back down, and the entire rear bank had
  // neither an up nor a down call-out — 39 m from the nearest sign that
  // mentions it. Same defect as the rear well's missing fall-through collider
  // and the same fix: ask the machines, do not transcribe the west pair.
  //
  // One call-out per BANK per direction, hung off that bank's own boarding pad
  // and its own mezzanine landing, and turned to face whoever is walking toward
  // it — which for a bank climbing the other way is the other way round.
  for (const bank of escalatorBanks(escs)) {
    const sgn = bank.zSign;
    const bx = (bank.minX + bank.maxX) / 2;
    signs.push({
      text: 'TV & SERIES  ↑', sub: 'RIDE UP TO THE MEZZANINE',
      x: bx, z: bank.boardZ + sgn * 1.0, rotY: sgn > 0 ? 0 : Math.PI,
      hue: 260, level: 0, y: 3.55, big: true,
    });
    signs.push({
      text: '↓  MOVIES', sub: 'GROUND FLOOR',
      x: bx, z: bank.exitZ - sgn * 0.75, rotY: sgn > 0 ? Math.PI : 0,
      hue: 48, level: 1,
    });
  }
  // mezzanine sections
  // THE ANCHOR RUN'S OWN SIGNAGE. These used to hang at the SHELL's back wall —
  // which is where the TD/TC fixtures used to stand, as wall units. The run moved
  // onto the balcony when the mezzanine started being sized by its own aisles;
  // the signs did not, and were left pinned to a wall 41.5m behind the rear
  // railing, lit and clickable in mid-air over the movie floor with no level-1
  // deck under them. They now hang off the SAME anchor line the fixtures use,
  // one SIGN_GAP in front of the face each one names — the identical convention
  // buildAnnex() applies to every generated run.
  const tvAnchorZ = mezzAnchorZ();
  signs.push({ text: 'TV DRAMA', sub: 'AISLES TD-01 to TD-04', x: -3.8, z: tvAnchorZ + BAY_OFF + SIGN_GAP, rotY: 0, hue: DEPARTMENTS.tvdrama.hue, level: 1 });
  signs.push({ text: 'TV COMEDY', sub: 'AISLES TC-01 to TC-03', x: 3.9, z: tvAnchorZ - BAY_OFF - SIGN_GAP, rotY: Math.PI, hue: DEPARTMENTS.tvcomedy.hue, level: 1 });
  signs.push({ text: 'CRIME & THRILLER', sub: 'CT-01', x: 11.45, z: -4.6, rotY: 0, hue: 192, level: 1 });
  signs.push({ text: 'SCI-FI & FANTASY', sub: 'ST-01', x: 11.45, z: -6.5, rotY: 0, hue: 215, level: 1 });
  signs.push({ text: 'ANIME · DOCS', sub: 'AS-01 · DS-01', x: -11.45, z: -5.6, rotY: 0, hue: 320, level: 1 });
  signs.push({ text: 'BINGE ZONE', sub: 'GET COMFORTABLE', x: -4.9, z: -4.2, rotY: 0, hue: 300, level: 1 });
  // one hanging sign per generated department run
  signs.push(...annex.signs);

  // --- Aisle-awareness zones (level-aware)
  const zones = [];
  for (const f of fixtures) {
    const dir = facingOf(f.rotY);
    zones.push({
      label: f.label, code: f.code, level: f.level,
      x: f.x + dir.x * (f.depth / 2 + 0.9),
      z: f.z + dir.z * (f.depth / 2 + 0.9),
      r: Math.max(f.w / 2 + 0.55, 1.25),
    });
  }
  zones.push({ label: 'CHECKOUT', code: 'FRONT', x: 8.8, z: 5.9 + dzSign, r: 1.9, level: 0 });
  // ...and the HUD zones with them: both of these were pinned to x = -8.0, so
  // standing at the foot of the east or the rear machine told you nothing.
  for (const bank of escalatorBanks(escs)) {
    const bx = (bank.minX + bank.maxX) / 2;
    zones.push({ label: 'ESCALATOR', code: 'TV & SERIES ↑', x: bx, z: bank.boardZ, r: 1.5, level: 0 });
    zones.push({ label: 'ESCALATOR', code: '↓ MOVIES', x: bx, z: bank.exitZ, r: 1.4, level: 1 });
  }
  zones.push({ label: 'BINGE ZONE', code: 'MEZZANINE', x: -4.9, z: -4.4, r: 1.6, level: 1 });

  const layout = {
    fixtures, props, slots, titles, obstacles, signs, zones,
    slotById,
    // Built per layout: the rear bank hangs off mezzBackZ, which moves with
    // capacity, so these cannot be module constants any more.
    escalators: escs,
    navLinks: navLinksFor(escs),
    well: WELL,          // legacy single-well accessor
    // EVERY bank that exists gets a real opening. This was FRONT-only, with the
    // comment "the rear bank needs no slab hole" — but the rear machine climbs
    // from the floor BEHIND the balcony up onto it, so it crosses the slab plane
    // 1.57 m inside the footprint and had been driving straight through it.
    wells: hasRear ? [...WELLS, rearBankWell(WORLD.mezzBackZ)] : WELLS,
    rearGap: hasRear ? rearBankWell(WORLD.mezzBackZ) : null,
    // you arrive just inside the doors, wherever the front wall ended up
    spawn: { ...SPAWN, z: halfD - 1.6, level: 0 },
    bounds: { minX: -WORLD.halfW, maxX: WORLD.halfW, minZ: -halfD, maxZ: halfD },
    mezz: { minX: -WORLD.halfW, maxX: WORLD.halfW, minZ: WORLD.mezzBackZ, maxZ: mezzFrontZ },
    // what the expansion actually built, for HUD/QA reporting
    annex: {
      halfD, coreDepth: CORE_DEPTH, segLen: sized.segLen,
      fixtures: annex.fixtures.length,
      footprint: WORLD.halfW * 2 * halfD * 2,
      mezzFootprint: WORLD.halfW * 2 * (halfD + mezzFrontZ),
    },
  };
  layout.colliders = buildColliders(layout);
  return layout;
}

// ---------------------------------------------------------------------------
// HANGING SIGNS — ONE AUTHORITY FOR WHAT IS OVERHEAD.
//
// A hanging sign is a board on drop rods, and the rods have to reach THE CEILING
// THAT IS ACTUALLY ABOVE THAT POINT. Which ceiling that is, is a fact about the
// floor plan, not about the renderer — so it belongs here, for the same reason
// CLERESTORY moved into config.js: while the board size, the drop height and the
// ceiling test were locals inside store.js, nothing that had to agree with them
// could see them, and nothing could test them.
//
// The bug this replaces: the ceiling test was `z < mezzFrontZ`, unbounded below,
// so every ground-floor sign BEHIND the balcony was hung from a mezzanine slab
// that stops at mezzBackZ. Four department signs ended on 16cm stubs 3.26m under
// the real ceiling, in the tallest, most open part of the store.
// ---------------------------------------------------------------------------
/**
 * Inner face of the front wall — the surface a wall-FIXED sign or logo is
 * actually screwed to. store.js hung the three TapeBuster logos at a literal
 * `halfD - 0.2`; the checkout sign's z was a separate hand-chosen offset, and
 * the two disagreed by 2.3 m. One authority, so a fixed sign and its host
 * cannot drift apart again.
 */
export const frontWallFaceZ = () => WORLD.halfD - 0.2;

export const SIGN = {
  w: 1.5, h: 0.59,          // standard board
  bigW: 2.35, bigH: 0.92,   // the oversized wayfinding call-outs
  groundY: 2.58,            // board centre height on the ground floor
  mezzDrop: 2.45,           // ...and above the mezzanine deck
  minRod: 0.12,             // never draw a zero-length rod
};

/** Board size of a sign. */
export const signBoard = (s) => (s.big ? { w: SIGN.bigW, h: SIGN.bigH } : { w: SIGN.w, h: SIGN.h });
/** Board centre height of a sign. */
export const signCentreY = (s) => s.y ?? ((s.level ? mezzY + SIGN.mezzDrop : SIGN.groundY));

/**
 * The ceiling really above a point. The mezzanine slab roofs the ground floor
 * ONLY where the slab exists: it runs z ∈ [mezzBackZ, mezzFrontZ] and behind its
 * rear edge the store opens to full height. Bounded on BOTH sides, deliberately.
 */
export function ceilingYAt(z, level = 0) {
  if (level) return WORLD.ceilH;                     // the balcony's own sky
  const underSlab = z < mezzFrontZ && z >= WORLD.mezzBackZ;
  return underSlab ? WORLD.mezzY - WORLD.slabT - 0.02 : WORLD.ceilH;
}

/** Drop-rod length for a hanging sign: board top to the ceiling above it. */
export function signRodLength(s) {
  return ceilingYAt(s.z, s.level) - (signCentreY(s) + signBoard(s).h / 2);
}

// ---------------------------------------------------------------------------
// WALL ART
//
// Poster spots used to be nine literal coordinates, which put every frame in the
// first fifth of a generated store and hung several of them behind whatever
// shelving the annex had since grown against that wall.
//
// Instead: find the stretches of perimeter wall nothing is standing in front of,
// and hang art down them at a constant pitch. Capped, because each poster is its
// own canvas + texture and the building has no upper size.
//
// This lives in layout.js, not store.js: it is pure geometry over the floor
// plan, and every constraint it has to respect — the fixtures, the balcony's
// real extent, the glazing band — is bookkeeping this module already owns.
// ---------------------------------------------------------------------------
//
// `max` used to be a flat 24 for the whole store. That was right for the
// hand-authored 19m building and starved every generated one: a 26x31m Netflix
// store has ~50% more wall, a nine-service store nearly triple, and the thinning
// pass spent the same 24 frames over all of it — the long rear wall ended up
// with a single poster on 20m of bare paint. The cap now scales with the wall
// area it has to cover, so frame DENSITY is what stays constant.
//
// EVERY ELEVATION HERE IS BOUNDED BY CLERESTORY.underside. The high band used to
// hang at 3.62 and the mezzanine art at mezzY + 1.85 = 5.15, so their 1.28m-tall
// frames spanned 2.98..4.26 and 4.51..5.79 — through the sill and clean across
// the glass. Posters rendered inside the windows.
const BAND_SCALE = 1.25, MEZZ_SCALE = 0.5;
const POSTER = {
  pitch: 5.2, minRun: 1.4, edge: 1.3, near: 1.45, bandPitch: 7.5,
  // High band: FRAME (1.28 * scale) stops 0.05 under the clerestory soffit and
  // still clears the tallest level-0 fixture TOP (2.33 incl. its 0.05 cap
  // board) by 0.15.
  bandScale: BAND_SCALE,
  bandY: CLERESTORY.underside - 0.05 - 0.64 * BAND_SCALE,   // 3.28 -> frame 2.48..4.08
  // Mezzanine: balcony floor 3.30, soffit 4.13 = 0.83m of wall. A full-size
  // 1.28m frame does not fit; this does. Smaller frames get a tighter pitch.
  mezzScale: MEZZ_SCALE,
  // KEPT for the rare stretch that really is under glass (the back wall, when
  // the balcony reaches it). Frame 3.43..4.07 — 13 cm off the balcony floor.
  mezzY: WORLD.mezzY + 0.64 * MEZZ_SCALE + 0.13,            // 3.75 -> frame 3.43..4.07
  // AND THE HEIGHT FOR WALLS THAT HAVE NO CLERESTORY, which is every stretch
  // the balcony runs along.
  //
  // mezzY was derived from "balcony floor 3.30, soffit 4.13 = 0.83 m of wall",
  // but that soffit is the clerestory's stooled sill — and the window repair
  // SUPPRESSED clerestory panes wherever the mezzanine puts shelves at band
  // height. clerestoryAllowedAt() returns false for any side-wall span inside
  // [mezzBackZ, mezzFrontZ], and mezzanine posters hang strictly inside it, so
  // those walls are clear from the balcony floor at 3.30 to the ceiling at
  // 6.30. The posters were pinned low by a window that is not built there.
  //
  // Upstairs eye height is 3.30 + 1.62 = 4.92. A centre of 4.70 puts the frame
  // at 4.38..5.02 — just below eye line, 1.08 m clear of the floor, and well
  // under the 5.50 clerestory head even where one does exist.
  mezzHighY: WORLD.mezzY + 1.40,                            // 4.70 -> frame 4.38..5.02
  mezzPitch: 2.6, mezzMinRun: 0.9,
  perMetre: 0.34, minMax: 24, hardMax: 90,
};

/** Free stretches of [min,max] once every blocked interval is removed. */
function freeRuns(blocked, min, max, minRun) {
  const b = blocked
    .filter(s => s[1] > min && s[0] < max)
    .map(s => [Math.max(min, s[0]), Math.min(max, s[1])])
    .sort((p, q) => p[0] - q[0]);
  const runs = [];
  let cur = min;
  for (const [a, e] of b) {
    if (a - cur >= minRun) runs.push([cur, a]);
    cur = Math.max(cur, e);
  }
  if (max - cur >= minRun) runs.push([cur, max]);
  return runs;
}

/** Footprint half-extents of a fixture or prop, world-axis aligned. */
export function halfExtent(o) {
  if (o.kind === 'shelf' || o.kind === 'table' || o.kind === 'bin') {
    const quarter = Math.round((o.rotY ?? 0) / (Math.PI / 2)) % 2 !== 0;
    if (o.kind === 'bin') return { hw: o.w / 2, hd: o.depth / 2 };
    return { hw: (quarter ? o.depth : o.w) / 2, hd: (quarter ? o.w : o.depth) / 2 };
  }
  const c = Math.abs(Math.cos(o.rotY ?? 0)), s = Math.abs(Math.sin(o.rotY ?? 0));
  const w = o.w ?? 0.6, d = o.d ?? o.depth ?? 0.6;
  return { hw: (w * c + d * s) / 2, hd: (w * s + d * c) / 2 };
}

/**
 * Every wall-art position in the building. Each spot carries an explicit `kind`
 * — 'low' (eye-level, ground floor), 'mezz' (balcony) or 'band' (the high strip
 * above the ground-floor fixtures) — so the elevation tests assert on what a
 * spot IS rather than inferring it from its scale.
 */
export function planPosterSpots(layout) {
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const things = [...layout.fixtures, ...layout.props];
  const spots = [];

  const hang = (runs, level, place) => {
    // Balcony frames are half-size, so they need a tighter pitch or the wall
    // reads as bare with the odd stamp on it.
    const pit = level ? POSTER.mezzPitch : POSTER.pitch;
    for (const [a, e] of runs) {
      const len = e - a;
      const n = Math.max(1, Math.round(len / pit));
      for (let i = 0; i < n; i++) spots.push(place(a + (len * (i + 0.5)) / n, level));
    }
  };

  for (const level of [0, 1]) {
    const y = level ? POSTER.mezzY : 1.85;
    const sc = level ? POSTER.mezzScale : 1;
    // Per SPOT, not per level: hang at proper wall height wherever no pane is
    // built, and stay under the soffit where one is. The predicate is the same
    // authority store.js builds glazing from, so art can never be hung through
    // a window that exists, nor crouched under one that does not.
    const halfSpan = 0.45 * sc + 0.17;
    const hangY = (wall, u) => (level && !clerestoryAllowedAt(wall, u - halfSpan, u + halfSpan))
      ? POSTER.mezzHighY : y;
    const kind = level ? 'mezz' : 'low';
    const minRun = level ? POSTER.mezzMinRun : POSTER.minRun;
    const zHi = level ? mezzFrontZ - 0.7 : maxZ - 5.4;   // ground stops short of the storefront
    // Level-1 art hangs where the BALCONY is, not where the SHELL is.
    const zLo = (level ? Math.max(minZ, WORLD.mezzBackZ) : minZ) + POSTER.edge;

    // --- side walls: blocked by anything standing within `near` of them
    for (const sign of [-1, 1]) {
      const wallX = sign > 0 ? maxX : minX;
      const blocked = things
        .filter(o => (o.level ?? 0) === level && Math.abs(o.x - wallX) < POSTER.near + halfExtent(o).hw)
        .map(o => [o.z - halfExtent(o).hd - 0.35, o.z + halfExtent(o).hd + 0.35]);
      hang(freeRuns(blocked, zLo, zHi, minRun), level,
        (z) => ({
          x: wallX - sign * 0.03, z, rotY: sign > 0 ? -Math.PI / 2 : Math.PI / 2,
          y: hangY(sign > 0 ? 'right' : 'left', z), scale: sc, kind,
        }));
    }

    // --- back wall, but only where the level in question actually reaches it.
    // The balcony is sized by its own aisles: at 20,000 titles it ends at
    // z = -31.06 while the back wall is at -74, so level-1 back-wall art hung
    // 42.9m behind the balcony edge, in mid-air over the movie floor, one frame
    // dead-centre on a window pane.
    if (level === 0 || WORLD.mezzBackZ <= minZ + 0.5) {
      const blockedX = things
        .filter(o => (o.level ?? 0) === level && o.z - halfExtent(o).hd < minZ + POSTER.near)
        .map(o => [o.x - halfExtent(o).hw - 0.35, o.x + halfExtent(o).hw + 0.35]);
      hang(freeRuns(blockedX, minX + POSTER.edge, maxX - POSTER.edge, minRun), level,
        (x) => ({ x, z: minZ + 0.03, rotY: 0, y: hangY('back', x), scale: sc, kind }));
    }
  }

  // --- high band, ground floor only.
  // A rental store's side walls are shelving almost end to end — measuring the
  // free stretches honestly turns up only the handful of metres past the last
  // unit, which is why the frames all ended up at the deep end of a big store.
  // The wall ABOVE the fixtures is the surface that is actually empty, and in
  // the double-height front zone (no slab overhead) there is 3m of it. So the
  // art hangs there, clear of the 2.33m fixture tops below, of the mezzanine
  // edge, and of the clerestory soffit above.
  const bandLo = mezzFrontZ + 1.2;
  const bandHi = maxZ - 5.4;
  if (bandHi - bandLo >= POSTER.minRun) {
    const n = Math.max(1, Math.round((bandHi - bandLo) / POSTER.bandPitch));
    for (const sign of [-1, 1]) {
      const wallX = sign > 0 ? maxX : minX;
      for (let i = 0; i < n; i++) {
        spots.push({
          x: wallX - sign * 0.03, z: bandLo + ((bandHi - bandLo) * (i + 0.5)) / n,
          rotY: sign > 0 ? -Math.PI / 2 : Math.PI / 2,
          y: POSTER.bandY, scale: POSTER.bandScale, kind: 'band',
        });
      }
    }
  }

  // Perimeter of both levels' usable wall, so the budget tracks the building.
  const perim = 2 * ((maxX - minX) + (maxZ - minZ));
  const budget = Math.min(POSTER.hardMax, Math.max(POSTER.minMax, Math.round(perim * POSTER.perMetre)));
  if (spots.length <= budget) return spots;
  // Thin evenly rather than truncating, so the art stays spread over the whole
  // building instead of piling into whichever wall was walked first.
  const keep = [];
  for (let i = 0; i < budget; i++) keep.push(spots[Math.floor(((i + 0.5) * spots.length) / budget)]);
  return keep;
}

// ---------------------------------------------------------------------------
// COLLISION SOURCE OF TRUTH — categorized world-space AABBs per level.
// Everything physical is SOLID unless explicitly non-colliding (posters,
// hanging signs, ceiling tiles are out of reach; the player's y is always
// floor/ride-prescribed, so floors and ceilings cannot be violated).
// ---------------------------------------------------------------------------
export function buildColliders(layout) {
  const { bounds } = layout;
  const per = [[], []];
  const add = (level, minX, maxX, minZ, maxZ, kind, id, h = 3, yBase = 0) =>
    per[level].push({ minX, maxX, minZ, maxZ, kind, id, h, yBase });

  for (const level of [0, 1]) {
    // perimeter walls (both levels share the shell)
    add(level, bounds.minX - 1, bounds.minX, bounds.minZ - 1, bounds.maxZ + 1, 'wall', 'wall-west', 6.3);
    add(level, bounds.maxX, bounds.maxX + 1, bounds.minZ - 1, bounds.maxZ + 1, 'wall', 'wall-east', 6.3);
    add(level, bounds.minX - 1, bounds.maxX + 1, bounds.minZ - 1, bounds.minZ, 'wall', 'wall-back', 6.3);
    add(level, bounds.minX - 1, bounds.maxX + 1, bounds.maxZ, bounds.maxZ + 1, 'wall', 'wall-front', 6.3);
    // every fixture/prop/escalator obstacle, with its real footprint
    for (const o of layout.obstacles[level]) {
      add(level, o.x - o.hw, o.x + o.hw, o.z - o.hd, o.z + o.hd, o.kind || 'solid', o.id, o.h ?? 2);
    }
  }

  // mezzanine edge: railing segments (solid), the open void beyond the slab,
  // and the escalator well. Belt and suspenders: even a railing gap cannot
  // drop the player, because the void itself is a collider.
  const fz = WORLD.mezzFrontZ;
  // Front edge, in the gaps BETWEEN the wells — with two banks the edge is now
  // three runs (outside west, between, outside east) rather than two.
  //
  // WELLS (the module constant) is deliberately FRONT-ONLY — the rear bank's
  // opening depends on mezzBackZ, so it is built per layout and lives on
  // layout.wells. Using the constant here gave the rear well no fall-through
  // collider and no side railings at all: measured, a 2.90 x 2.15 m hole in the
  // balcony that the player could walk straight across. Same defect class as
  // the front-west-only escalator colliders. The front EDGE logic still wants
  // only the wells that actually break that edge, so derive those instead of
  // reaching for the constant.
  const allWells = layout.wells || WELLS;
  const frontWells = allWells.filter((w) => Math.abs(w.maxZ - fz) < 0.05);
  const gaps = [bounds.minX, ...frontWells.flatMap(w => [w.minX - 0.02, w.maxX + 0.02]), bounds.maxX];
  for (let i = 0; i < gaps.length; i += 2) {
    if (gaps[i + 1] - gaps[i] < 0.05) continue;
    add(1, gaps[i], gaps[i + 1], fz - 0.12, fz, 'railing', `railing-front-${i}`, 1.08, WORLD.mezzY);
  }
  // ...and the returns down each side of EVERY well, over that well's own z
  // extent (which for a front well is exactly minZ..fz, as before).
  allWells.forEach((w, i) => {
    add(1, w.minX - 0.12, w.minX, w.minZ, w.maxZ, 'railing', `railing-well-${i}-w`, 1.08, WORLD.mezzY);
    add(1, w.maxX, w.maxX + 0.12, w.minZ, w.maxZ, 'railing', `railing-well-${i}-e`, 1.08, WORLD.mezzY);
  });
  add(1, bounds.minX, bounds.maxX, fz, bounds.maxZ + 1, 'void', 'mezz-void', 3, WORLD.mezzY);
  allWells.forEach((w, i) => add(1, w.minX, w.maxX, w.minZ, w.maxZ, 'void', `escalator-well-${i}`, 3, WORLD.mezzY));

  // The REAR edge, which is now a balcony over the back of the movie floor
  // rather than the store's back wall. Same belt-and-braces as the front: a
  // railing you cannot walk through, and the drop behind it is a collider in its
  // own right, so no gap in the railing can ever put the player over the void.
  // ...but only when there IS a rear edge. A small store's balcony still reaches
  // the back wall, and a railing standing against masonry would be furniture in
  // the way of the shelves rather than a safety rail.
  const bz = WORLD.mezzBackZ;
  if (bz > -WORLD.halfD + 0.5) {
    // Broken by the rear bank's opening — otherwise the railing would fence off
    // the escalator you are meant to walk onto.
    const gap = layout.rearGap;
    const runs = gap
      ? [[bounds.minX, gap.minX], [gap.maxX, bounds.maxX]]
      : [[bounds.minX, bounds.maxX]];
    runs.forEach(([a, b], i) => {
      if (b - a > 0.05) add(1, a, b, bz, bz + 0.12, 'railing', `railing-rear-${i}`, 1.08, WORLD.mezzY);
    });
    // The drop behind the balcony stays a collider across the full width; the
    // ride itself moves the player directly, exactly as it does through the
    // front banks' wells.
    add(1, bounds.minX, bounds.maxX, bounds.minZ - 1, bz, 'void', 'mezz-void-rear', 3, WORLD.mezzY);
  }

  return per;
}

export function formatAddress(addr) {
  const shelf = String(addr.shelf).padStart(2, '0');
  const pos = String(addr.position).padStart(2, '0');
  const floor = addr.floor === 'MEZZANINE' ? 'MEZZANINE · ' : '';
  return `${addr.section} · ${floor}AISLE ${addr.aisle} · SHELF ${shelf} · POS ${pos}`;
}
