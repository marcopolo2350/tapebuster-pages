// THE STORE'S ENVIRONMENTAL GRAPHICS PROGRAM.
//
// Part 1 fixed WHERE the signs are. This file is about what they ARE.
//
// What it replaces: one generator, one assembly, two board sizes, two global
// elevation constants and one unlit material serving all 39 signs across five
// different semantic jobs. Rendered, the tell was not the artwork — it was the
// hardware. Every sign hung from two 8 mm rods that ran up to 3.42 m and then
// simply intersected the ceiling tile: no canopy, no plate, no fixing. A rod
// that terminates at nothing is the clearest possible "developer artifact",
// and it was on all 39.
//
// THE RULE HERE: a sign's family, proportions, elevation, mounting and hardware
// derive from its SEMANTIC JOB and its architectural host — never from an array
// index, a wall index, or whichever sign was written first.
//
// AND THE COUNTER-RULE, which matters just as much: differentiation must be
// EARNED. Two families that genuinely hang from the same high ceiling over the
// same open floor should hang the same way. Inventing a third bracket system to
// make a checklist look complete is the same failure as having only one.
// So there are exactly TWO mounting systems, because the building only offers
// two honest ones — suspended from the deck, and fixed to a host structure —
// and the families differ in elevation, proportion and hardware weight, which
// is what actually differs about their jobs.

/**
 * Which job this sign does. Derived from what it SAYS and where it lives, so a
 * sign added later is classified by meaning rather than by being appended.
 */
export function familyOf(sign) {
  const t = (sign.text || '').trim();
  const sub = sign.sub || '';
  if (/TV & SERIES|MOVIES/.test(t) && /↑|↓/.test(t)) return 'escalator';
  if (/CHECKOUT|RETURNS|MEMBERSHIP/.test(t) || /RETURNS · MEMBERSHIP/.test(sub)) return 'service';
  if (/NEW RELEASES|STAFF PICKS|LEAVING SOON|BINGE ZONE|WEEKEND|FAMILY NIGHT|3 FOR 2/.test(t)) return 'promotional';
  if (/AISLES?\s/i.test(sub)) return 'department';
  return 'wayfinding';
}

/**
 * Per-family physical specification.
 *
 * `mount` is one of:
 *   'suspended' — hanger rods from the deck above, with a real canopy at the
 *                 slab and a clevis at the board. Everything over open floor.
 *   'fixed'     — the sign is carried by a structure that is already there
 *                 (the checkout bulkhead). No rods, because it does not need
 *                 them and a rod to a wall-adjacent sign would be theatre.
 *
 * `height` is the board-centre elevation this family WANTS above its own
 * floor, because that is what its job actually determines: a department sign
 * has to clear 2.33 m of wall unit, a promo card wants to be near the
 * merchandise it sells. It is then clamped so the sign and its hardware fit
 * under whatever is actually above it — the store has a 6.3 m shed ceiling, a
 * 3.04 m soffit under the mezzanine and a slab in between, and an elevation
 * expressed as a drop from the ceiling goes negative under the soffit.
 */
export const FAMILIES = {
  department: {
    mount: 'suspended',
    height: 2.58,          // reads over the tops of the 2.33 m wall units
    w: 1.90, h: 0.62, depth: 0.075,
    rodR: 0.011, rodSpread: 0.36,
    tier: 1,
    face: { roughness: 0.62, metalness: 0.0, emissive: 0.10 },
    edge: 0x1b2c66,
  },
  escalator: {
    mount: 'suspended',
    // The mezzanine landing has only 3.0 m between deck and ceiling, so this
    // family's board has to be short enough to clear headroom up there as well
    // as read from the sales floor below. 0.92 m left 1.94 m of clearance.
    height: 2.95,
    w: 2.28, h: 0.80, depth: 0.085,
    rodR: 0.013, rodSpread: 0.40,
    tier: 2,
    face: { roughness: 0.55, metalness: 0.0, emissive: 0.16 },
    edge: 0x16265c,
  },
  wayfinding: {
    mount: 'suspended',
    height: 2.58,
    w: 1.62, h: 0.56, depth: 0.070,
    rodR: 0.010, rodSpread: 0.34,
    tier: 2,
    face: { roughness: 0.60, metalness: 0.0, emissive: 0.12 },
    edge: 0x1b2c66,
  },
  promotional: {
    mount: 'suspended',
    height: 2.32,          // hangs LOWER, closer to the merchandise it sells
    w: 1.44, h: 0.50, depth: 0.055,
    rodR: 0.008, rodSpread: 0.30,
    tier: 4,
    face: { roughness: 0.78, metalness: 0.0, emissive: 0.04 },  // printed card, not a lightbox
    edge: 0x3a2f28,
  },
  service: {
    // The checkout sign sits against the front bulkhead, which is a real wall.
    // Hanging it on 3.4 m of rod in front of a wall it could simply be fixed to
    // is exactly the manufactured hardware this system is meant to avoid.
    mount: 'fixed',
    // Above the TapeBuster identity plate its host wall already carries, which
    // runs 1.88-2.33. At 2.62 the board's bottom edge landed 25 mm off the
    // plate's top and the two read as one crowded object from the queue.
    height: 2.80,
    w: 1.72, h: 0.54, depth: 0.065,
    standoff: 0.09,      // held off its host on short spacers
    tier: 5,
    face: { roughness: 0.70, metalness: 0.0, emissive: 0.06 },
    edge: 0x2a2d34,
  },
};

export function specFor(sign) {
  return FAMILIES[familyOf(sign)];
}

/** Board size for a sign, from its family rather than a big/standard flag. */
export function boardSize(sign) {
  const f = specFor(sign);
  return { w: f.w, h: f.h, depth: f.depth };
}

/**
 * Board CENTRE height: derived from the ceiling that is actually above this
 * sign, minus its family's drop. Two absolute constants could not express
 * "hangs 3.42 m under whatever is above it" in a building with a 6.3 m shed
 * ceiling, a 3.3 m mezzanine soffit and a slab in between.
 */
export function centreY(sign, localCeilY, floorY = 0) {
  const f = specFor(sign);
  const want = floorY + f.height;
  // ...clamped so the board AND its hardware fit under whatever is above it
  const ceiling = localCeilY - HARDWARE_HEADROOM - f.h / 2;
  return Math.min(want, ceiling);
}

/**
 * Room a hanger needs between the board top and its host.
 *
 * This must be at least SIGN.minRod (0.12), or the clamp and the renderer
 * disagree: store.js draws `max(minRod, ceiling - boardTop)`, so a board
 * clamped to leave only 0.10 got a 0.12 rod and pushed 2 cm of steel through
 * the slab above its own canopy plate. It bit on exactly one sign — the level-1
 * MOVIES call-out, whose 2.95 m family target does not fit under the balcony's
 * own 3.0 m ceiling — which is precisely the kind of two-centimetre
 * disagreement that only shows up when the two numbers are made to agree.
 */
export const HARDWARE_HEADROOM = 0.14;

/**
 * Where a suspended sign's hangers attach, as x-offsets across the board.
 * Returned rather than assumed so the test can check the canopy sits directly
 * over the rod and the rod directly over the clevis.
 */
export function hangerOffsets(sign) {
  const f = specFor(sign);
  if (f.mount !== 'suspended') return [];
  return [-f.w * f.rodSpread, f.w * f.rodSpread];
}

/** Every family that hangs, and every family that does not. For tests. */
export const SUSPENDED = Object.keys(FAMILIES).filter((k) => FAMILIES[k].mount === 'suspended');
export const FIXED = Object.keys(FAMILIES).filter((k) => FAMILIES[k].mount === 'fixed');
