// TapeBuster — world constants. Everything is meters / seconds / radians.
export const WORLD = {
  // Store footprint: x in [-13, 13], z in [-halfD, halfD]. Front wall (entrance) at +z.
  // Two levels: movies on the ground floor, TV & series on a rear mezzanine
  // connected by an up/down escalator pair.
  //
  // halfW is FIXED at 13: the storefront in store.js is hand-modelled across
  // x ∈ [-12.2, 13], so widening the shell would open the front wall to the
  // void. halfD is DERIVED — see CORE_DEPTH / setStoreDepth below.
  halfW: 13,
  halfD: 9.5,
  ceilH: 6.3,        // top ceiling (over the double-height front + mezzanine)
  mezzY: 3.3,        // mezzanine floor height
  slabT: 0.24,       // mezzanine slab thickness (underside = ground ceiling at 3.06)
  mezzFrontZ: -3.2,  // mezzanine spans z ∈ [mezzBackZ, mezzFrontZ]
  // The mezzanine's REAR edge. Derived, like halfD — see setMezzDepth below.
  mezzBackZ: -9.5,

  escSpeed: 0.8,     // m/s along the escalator path

  eyeH: 1.62,
  crouchDrop: 0.9,       // eye drops to ~0.72m: level with the bottom shelf row
  playerRadius: 0.34,

  walkSpeed: 1.85,       // m/s max stroll/walk speed
  runSpeed: 2.6,         // shift on desktop
  accel: 4.2,            // m/s^2
  decel: 6.0,
  turnRate: 3.4,         // rad/s heading alignment during stroll

  // Camera
  baseFov: 62,           // desktop vertical FOV; mobile portrait gets more
  minFov: 34,
  maxFov: 74,
  pitchMin: -1.05,       // ~-60 deg
  pitchMax: 1.05,
  bobAmp: 0.016,
  bobFreq: 5.6,          // rad per meter-ish stride factor

  // Cases (rental keep-case)
  caseW: 0.135,
  caseH: 0.19,
  caseD: 0.025,
  casePitch: 0.155,      // horizontal spacing per slot

  // Interaction
  reachDist: 2.05,       // close enough to open a case directly
  lookAtDist: 3.4,       // max distance for look-at HUD
  standOff: 0.78,        // stand this far in front of a case

  // Pathfinding
  cell: 0.3,
  obstaclePad: 0.36,     // inflate obstacles by ~player radius
};

// THE CLERESTORY GLAZING BAND — one authority for the window line.
//
// These numbers used to exist only as locals inside store.js's glazing block,
// so nothing that had to STAY OUT of the windows could see them, and the wall
// art was hung straight through the glass.
export const CLERESTORY = {
  sillY: 4.30, headY: 5.50, paneW: 2.60, pitch: 4.0, reveal: 0.30,
  // The LOWEST built member is NOT the sill LINE: store.js hangs a stooled
  // sill at -H/2 - 0.14 with a 0.06-tall box, so the soffit art must clear is
  // sillY - 0.17. Anything reaching above this fouls the sill or lands in
  // front of the sky panel.
  underside: 4.13,
};

/**
 * WHERE THE CLERESTORY IS ALLOWED TO EXIST (window+loading repair directive
 * §1). The band is a fixed elevation (4.30–5.50): above the ground floor's
 * 2.28 m fixtures that is a legitimate clerestory over continuous shelving,
 * but the MEZZANINE floor is at 3.30, so along the balcony span the same
 * band sits in prime shelf height — it was costing 23 wall bays their full
 * height (clamped to ~0.9 m stubs) and breaking the TV wall runs. The
 * ruling: merchandising walls win. No pane may exist on a side wall where
 * the mezzanine puts shelves at band height; the back wall (which the
 * balcony never reaches) and the ground-floor-only side stretches keep
 * their windows, genuinely above everything.
 *
 * ONE predicate, consulted by BOTH the glazing builder (store.js) and the
 * fixture clamp (layout.js) — two definitions would let a bay be clamped
 * for a window that no longer exists, or a pane built through a full bay.
 * `u0..u1` is the interval along the wall (z on the side walls, x on the
 * back). Callers run after setMezzDepth, so WORLD.mezzBackZ is current.
 */
export function clerestoryAllowedAt(wall, u0, u1 = u0) {
  if (wall === 'back') return true;
  return u1 < WORLD.mezzBackZ - 0.2 || u0 > WORLD.mezzFrontZ + 0.2;
}

// The hand-authored core store's depth. buildLayout() GROWS the building from
// this baseline until every stocked title has a physical place — the projection
// is never trimmed to fit the building, so halfD cannot be a constant. Nothing
// here caps the title count; the only fixed dimension is the width.
export const CORE_DEPTH = 9.5;

/**
 * Set the derived store depth. Called by buildLayout() BEFORE the renderer runs,
 * so store.js / mezzanine.js / lighting.js — which all read WORLD.halfD inside
 * their build functions — raise a shell that matches the generated floor plan.
 */
export function setStoreDepth(halfD) {
  WORLD.halfD = Math.max(CORE_DEPTH, halfD);
  return WORLD.halfD;
}

// The shallowest the mezzanine is ever built, so a small store still gets a
// balcony worth riding up to rather than a ledge.
export const MEZZ_MIN_DEPTH = 12;

/**
 * Set the mezzanine's rear edge.
 *
 * THE MEZZANINE IS SIZED BY ITS OWN CONTENT, NOT BY THE BUILDING. It used to run
 * the full depth of the store, because the slab simply took `-halfD` — but halfD
 * is set by the GROUND floor, which carries ~79% of the stock. Series are only
 * about a fifth of the catalogue, so at 20,000 titles the TV floor filled 20m of
 * a 71m slab and the other 49m was bare carpet you had to walk to reach the far
 * wall. The gap widened every time capacity went up.
 *
 * Now the balcony ends where its aisles end, and the store below it opens to
 * full height. Clamped between MEZZ_MIN_DEPTH and the back wall.
 */
export function setMezzDepth(backZ) {
  const shallowest = WORLD.mezzFrontZ - MEZZ_MIN_DEPTH;
  WORLD.mezzBackZ = Math.max(-WORLD.halfD, Math.min(shallowest, backZ));
  return WORLD.mezzBackZ;
}

// Nominal spawn inside the entrance of the CORE store. The live spawn point is
// layout.spawn, which tracks the (derived) front wall; this stays put so it is
// always a walkable point on the sales floor whatever depth the store grew to.
export const SPAWN = { x: 0, z: 7.9, yaw: 0 }; // yaw 0 faces -z (into the store)

export const BRAND = {
  name: 'TAPEBUSTER',
  tag: 'BE KIND · REWIND · EXPLORE',
  navy: '#122a72',
  navyDark: '#0b1c50',
  gold: '#f2b705',
  goldLight: '#ffd23d',
  red: '#e5484d',
  cream: '#f4efe6',
};
