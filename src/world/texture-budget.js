import { configureDevice, deviceProfile } from '../systems/device.js';
// TEXTURE BUDGET — one authority for how big a generated texture is allowed
// to be, and the only place that knows the device profile.
//
// WHY THIS EXISTS (measured, scripts/qa/scene-census.mjs):
//
//   The cover streamer was metered to the byte — 68 MiB of base atlases on a
//   phone, a bounded tile cache, upload permits, hysteresis, pooling. Next to
//   it sat the STATIC texture set, which had no budget of any kind:
//
//     134.4 MiB across 183 textures on mobile
//     134.6 MiB across 189 textures on desktop     <- no mobile profile AT ALL
//
//   i.e. the un-budgeted half was bigger than the budgeted half, and a phone
//   paid exactly what a desktop paid. The heaviest producers were
//   makePoster (25.2 MiB), the exterior panorama (24.0), signage-art (20.6),
//   makeWall (16.5) and makeDeptHeader (14.6).
//
//   makeWall was also a correctness hazard, not just a size one: its canvas is
//   `wallMetres * 40` px wide, so the 148 m store produced a 5920 x 252
//   texture. MAX_TEXTURE_SIZE is 4096 on A9/A10 iPhones — that upload fails
//   outright. Nothing in src/ clamped a texture to the device limit; the only
//   clamp in the codebase was CARPET_MAX_AXIS, local to makeCarpet.
//
// WHAT THIS DOES
//
//   allocCanvas(w, h, cls) returns a canvas that may be PHYSICALLY SMALLER
//   than requested, with its 2D context pre-scaled so every painter keeps
//   drawing in the coordinate space it already uses. No painter changes.
//   Verified safe: nothing in src/world/ calls setTransform/resetTransform,
//   so the base transform cannot be clobbered, and the one putImageData
//   painter (drawStatic) reads canvas.width directly and is below the scaling
//   threshold anyway.
//
// WHAT IT MUST NOT DO
//
//   Resolution is the only thing that degrades. Nothing here may change
//   catalogue membership, store correctness, navigation, title identity,
//   availability semantics or merchandising — it never sees any of them.

// Below this, scaling buys nothing and risks breaking painters that address
// device pixels directly (NPC faces at 128x64, chips at 64x16, the 72x54 CRT).
const SCALE_FLOOR_AXIS = 256;

// Per-class mobile linear scale. Area cost is the SQUARE of these.
// Text-bearing classes are treated gently; large flat surfaces are not.
const MOBILE_SCALE = {
  wall: 0.5,     // walls, carpet, ceiling — flat, low detail, seen at range
  pano: 0.5,     // exterior panorama layers behind glass
  poster: 0.5,   // wall posters and standees
  sign: 0.7,     // signage, department headers, fascia, logos — carries TEXT
  prop: 1.0,     // small props; already tiny
  default: 0.7,
};

// The device policy lives in systems/device.js — one authority, not two.
// This module only turns that policy into pixel dimensions.
const profile = {
  get mobile() { return deviceProfile().mobile; },
  get maxAxis() {
    const d = deviceProfile();
    return d.maxTextureSize ? Math.min(d.maxAxisPolicy, d.maxTextureSize) : d.maxAxisPolicy;
  },
};

const stats = { canvases: 0, requestedBytes: 0, actualBytes: 0, clamped: 0, scaled: 0 };

/**
 * Called once at boot, before any world building.
 * @param {object} o
 * @param {boolean} o.mobile      phone profile
 * @param {number|null} o.maxTextureSize  renderer.capabilities.maxTextureSize
 */
export function configureTextureBudget(opts = {}) {
  configureDevice(opts);
  return textureBudgetProfile();
}

export function textureBudgetProfile() {
  return { mobile: profile.mobile, maxAxis: profile.maxAxis };
}

export function textureBudgetStats() {
  return {
    ...stats,
    requestedMiB: +(stats.requestedBytes / 1048576).toFixed(1),
    actualMiB: +(stats.actualBytes / 1048576).toFixed(1),
    savedMiB: +((stats.requestedBytes - stats.actualBytes) / 1048576).toFixed(1),
  };
}

export function resetTextureBudgetStats() {
  stats.canvases = 0; stats.requestedBytes = 0; stats.actualBytes = 0;
  stats.clamped = 0; stats.scaled = 0;
}

/** The linear factor applied to a request of this size and class. */
export function scaleFor(w, h, cls = 'default') {
  const major = Math.max(w, h);
  let k = 1;
  if (major > SCALE_FLOOR_AXIS && profile.mobile) {
    k = MOBILE_SCALE[cls] ?? MOBILE_SCALE.default;
  }
  // The hard clamp is unconditional and applies on DESKTOP too: a 5920 px
  // wall is out of spec on plenty of hardware, not only phones.
  if (major * k > profile.maxAxis) k = profile.maxAxis / major;
  return k;
}

/**
 * Allocate a drawing canvas under the budget.
 * The returned canvas may be smaller than requested; its 2D context is
 * pre-scaled so painters address the ORIGINAL coordinate space unchanged.
 */
export function allocCanvas(w, h, cls = 'default') {
  const rw = Math.max(1, Math.round(w)), rh = Math.max(1, Math.round(h));
  const k = scaleFor(rw, rh, cls);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(rw * k));
  c.height = Math.max(1, Math.round(rh * k));
  // THE SIZE A PAINTER MUST ADDRESS, which is NOT c.width once the context is
  // pre-scaled. A painter that reads back c.width to lay itself out would
  // under-paint by exactly the scale factor and mis-centre anything it
  // centred. Any painter that needs its own dimensions reads these.
  c.logicalWidth = rw;
  c.logicalHeight = rh;

  stats.canvases++;
  stats.requestedBytes += rw * rh * 4;
  stats.actualBytes += c.width * c.height * 4;
  if (k !== 1) {
    stats.scaled++;
    if (Math.max(rw, rh) > profile.maxAxis) stats.clamped++;
    // Pre-scale the 2D context ONCE. getContext('2d') returns the same object
    // on every call for a real canvas, so the identity check makes this
    // idempotent; the scale is the base transform every painter inherits.
    const get = c.getContext.bind(c);
    let scaled = null;
    c.getContext = (type, opts) => {
      const g = get(type, opts);
      if (type === '2d' && g && scaled !== g) { scaled = g; g.scale(k, k); }
      return g;
    };
    c.__tbScale = k;
  }
  return c;
}
