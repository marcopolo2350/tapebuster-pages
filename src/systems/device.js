// DEVICE POLICY — one authority for "what may this device be asked to do".
//
// Before this module, `isMobileDevice` existed as a local in main.js and was
// consulted for cover budgets, NPC count, DPR and the radio delay — and for
// nothing in scene construction. Measured consequence
// (scripts/qa/scene-census.mjs): a phone built byte-for-byte the same building
// as a desktop — same 19 real-time point lights, same shadow-map size while
// walking, same 134 MiB of generated texture, same 1,025 draw calls.
// `enableShadows({ mobile })` even took the flag and only echoed it back in
// its stats object.
//
// So the policy lives here, is set once at boot from the real hardware, and is
// read by lighting.js, texture-budget.js and main.js rather than re-sniffed.
//
// WHAT MAY DEGRADE ON A PHONE: resolution, light count, shadow cadence,
// draw-call ceiling, cover hydration rate.
// WHAT MAY NEVER DEGRADE: catalogue membership, store correctness, navigation,
// title identity, availability semantics, merchandising semantics. Nothing in
// this file can see any of them.

const DESKTOP = {
  mobile: false,
  maxTextureSize: null,
  maxAxisPolicy: 4096,
  maxPointLights: Infinity,  // pools placed by lighting.placeAccentLights
  caseBatchShadows: true,// do the 260 merged case batches cast into the map?
  shadowHz: 0,           // 0 = every frame (three.js default autoUpdate)
  coverCommitsPerFrame: 3,
};

const MOBILE = {
  mobile: true,
  maxTextureSize: null,
  maxAxisPolicy: 2048,
  // 19 real-time point lights means every MeshStandardMaterial fragment runs a
  // 19-iteration light loop. At DPR 1.8 that is ~1.0-1.3 M fragments a frame on
  // a phone, and it was the same count as desktop. placeAccentLights adds in
  // scene-importance order — counter, escalator landings, lounge, then roving
  // accents — so a cap of 6 keeps every named anchor and drops the atmosphere.
  maxPointLights: 6,
  // The case batches are merged by CATALOGUE ORDER, so a single batch's bounds
  // span most of the 148 m building — ~200 of 260 have a bounding sphere that
  // contains the camera and can never be culled. Casting from them pushes
  // ~700k triangles through the shadow pass every frame for shadows that are
  // thin sheets of case fronts. The fixture carcases still cast, so cases still
  // sit ON shelves.
  caseBatchShadows: false,
  // The shadow pass re-rendered every frame because shadowMap.autoUpdate was
  // never touched. The key light is static and the store is static; only NPCs
  // move. 10 Hz is imperceptible for contact shadows and removes 5/6 of the
  // shadow passes.
  shadowHz: 10,
  coverCommitsPerFrame: 1,
};

let profile = { ...DESKTOP };

/** Called once at boot, before any world geometry exists. */
export function configureDevice({ mobile = false, maxTextureSize = null } = {}) {
  profile = { ...(mobile ? MOBILE : DESKTOP) };
  profile.maxTextureSize = maxTextureSize || null;
  return { ...profile };
}

export function deviceProfile() { return profile; }
export function isMobile() { return profile.mobile; }
