// Retail lighting: bright and even up front, warmer at checkout, gentle
// falloff toward the back. Real-time lights are few — depth comes from the
// baked carpet AO and the emissive ceiling panels.
import * as THREE from 'three';
import { WORLD } from '../config.js';
import { deviceProfile } from '../systems/device.js';

// Shadow-map budget. The frustum has to cover the whole footprint (the key
// light is static — nothing re-aims it per frame), so the only lever on quality
// is how many texels that frustum is sampled with.
//
// A case stands ~14mm proud of its shelf: once a shadow texel is wider than
// that, the contact shadow smears off the object and the cases stop reading as
// physical. ~16mm/texel is the quality the core store shipped at, so that is the
// target held constant as the building grows — with a texel budget so the map
// cannot grow without bound. Measured on built stores, this holds 15.5-16.3mm on
// BOTH axes from the 19m core through the 55m nine-service building.
const SHADOW_TEXEL = 0.016;      // metres per texel, target
const SHADOW_MAX = 4096;         // per-axis ceiling
const SHADOW_MAX_MOBILE = 2048;  // phones keep the boot-time budget
const SHADOW_FLOOR = 1024;       // sanity floor, never reached at these sizes
// TEXEL BUDGET, not just a per-axis cap. three renders this shadow with
// PCFSoftShadowMap, which means an RGBA8 colour target (packed depth) PLUS a
// depth attachment — about 8 bytes per texel, not the 2 a 16-bit depth-only map
// would cost. 2048 x 4096 is ~64MB, already double the core store's 2048², and
// letting both axes reach 4096 independently would quietly ask for ~256MB. The
// budget is the real limit; the per-axis cap only shapes how it is spent.
const SHADOW_BUDGET = 2048 * 4096;
const SHADOW_PAD = 1.5;          // metres of slack around the room volume
// Sizes are quantised to this, NOT to powers of two. three r170 is WebGL2-only
// and the shadow target is NearestFilter with no mipmaps, so non-power-of-two is
// fine — and pow2 rounding was actively harmful here: with a fixed budget the
// only two pow2 pairs that spend it are 4096x2048 and 2048x4096, which forced a
// 2:1 texel aspect (8.6mm on one axis, 15.3mm on the other) no matter what shape
// the frustum actually was. A 256 step spends the same budget on square texels.
const SHADOW_STEP = 256;
const quant = (n) => Math.max(SHADOW_STEP, Math.round(n / SHADOW_STEP) * SHADOW_STEP);
// Same test main.js uses for atlas scale and NPC count; guarded so the module
// stays importable outside a browser (tests build layouts headlessly).
const coarsePointer = () => typeof matchMedia === 'function'
  && matchMedia('(pointer: coarse)').matches && Math.min(innerWidth, innerHeight) < 860;

const _v = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _lookAt = new THREE.Vector3();
const _inv = new THREE.Matrix4();

/**
 * Size the shadow frustum AND its map to the CURRENT building.
 *
 * WORLD.halfD is derived from the projection now — a nine-service store runs to
 * z = ±27.4 where the boot-time store ended at ±9.5. A fixed frustum silently
 * stopped casting a third of the way down the new aisles, so this is recomputed
 * whenever the shell is rebuilt.
 *
 * THE SUBTLE PART. An orthographic shadow camera's left/right/top/bottom are
 * measured in the LIGHT'S OWN view space, and the key light is tilted in x as
 * well as z. Writing `left = -halfW - 2` therefore does not mean "the store's
 * width" — the light's horizontal axis picks up a component of world z, so the
 * deeper the store gets the more of its width leaks out of the frustum. Measured
 * on the built store, setting the box from world extents contained the room at
 * 19m (100% of the floor) but only 88.7% of it at 55m: the far corners on each
 * side wall projected to |ndc.x| = 1.22, and three clamps outside the map, so
 * those corners took a smeared copy of an edge texel instead of their own
 * shadow. The front-top corners were also behind a hardcoded near = 1.
 *
 * The fix is to stop guessing the basis and measure in it: place the camera
 * exactly the way three's own LightShadow.updateMatrices does, push the eight
 * corners of the room volume through its inverse world matrix, and take the
 * resulting AABB. That is exact for any light direction, and it also stops
 * over-spending — the old box wasted its vertical axis on a 66.8m span that only
 * needed 42.3m, which is where the extra depth resolution comes from.
 */
// Half-width of the shadowed WINDOW when a focus point is supplied. Covering the
// whole building keeps texel size proportional to store depth: one map over a
// 26x31m store is ~13cm/texel and over 26x55m ~27cm, and at that density the
// shadow boundary under the mezzanine slab degenerates into a pale blocky smear
// across the back wall (it read as a stretched logo). A fixed window that
// travels with the player holds texel density CONSTANT at every store size.
// Geometry outside it casts nothing, which is invisible from 20m and six aisles.
const SHADOW_WINDOW = 15;

export function fitShadowToStore(key, focus = null, { low = false } = {}) {
  const s = key.shadow, cam = s.camera;
  const { halfW, halfD, ceilH } = WORLD;
  const fx = focus ? Math.max(-halfW, Math.min(halfW, focus.x)) : 0;
  const fz = focus ? Math.max(-halfD, Math.min(halfD, focus.z)) : 0;
  const xLo = focus ? Math.max(-halfW - SHADOW_PAD, fx - SHADOW_WINDOW) : -halfW - SHADOW_PAD;
  const xHi = focus ? Math.min(halfW + SHADOW_PAD, fx + SHADOW_WINDOW) : halfW + SHADOW_PAD;
  const zLo = focus ? Math.max(-halfD - SHADOW_PAD, fz - SHADOW_WINDOW) : -halfD - SHADOW_PAD;
  const zHi = focus ? Math.min(halfD + SHADOW_PAD, fz + SHADOW_WINDOW) : halfD + SHADOW_PAD;

  // Reproduce three's shadow-camera placement so the basis we measure in is the
  // basis it will actually render with. It re-does this every frame from the
  // same two matrices, so nothing here drifts.
  key.updateMatrixWorld(true);
  key.target.updateMatrixWorld(true);
  _camPos.setFromMatrixPosition(key.matrixWorld);
  _lookAt.setFromMatrixPosition(key.target.matrixWorld);
  cam.position.copy(_camPos);
  cam.lookAt(_lookAt);
  cam.updateMatrixWorld(true);
  _inv.copy(cam.matrixWorld).invert();

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let near = Infinity, far = -Infinity;
  for (const x of [xLo, xHi]) {
    for (const y of [-SHADOW_PAD, ceilH + SHADOW_PAD]) {
      for (const z of [zLo, zHi]) {
        _v.set(x, y, z).applyMatrix4(_inv);
        minX = Math.min(minX, _v.x); maxX = Math.max(maxX, _v.x);
        minY = Math.min(minY, _v.y); maxY = Math.max(maxY, _v.y);
        // View space looks down -z, so distance from the light plane is -z.
        // The storefront corners sit BEHIND the light, which is why near has to
        // be free to go negative — an orthographic projection handles that, a
        // hardcoded near = 1 clipped them.
        near = Math.min(near, -_v.z); far = Math.max(far, -_v.z);
      }
    }
  }
  cam.left = minX; cam.right = maxX;
  cam.bottom = minY; cam.top = maxY;
  cam.near = near; cam.far = far;
  cam.updateProjectionMatrix();

  // Resolution: pick ONE texel size for both axes — the target, or the coarsest
  // the budget forces — and give each axis the texels its span needs at that
  // size. Square texels mean the contact shadow under a case is the same width
  // whichever way the case faces, and no part of the budget is spent
  // over-resolving the short axis.
  // `low` is the user-facing SMOOTH quality setting: same budget a phone gets,
  // chosen by a person whose machine is struggling rather than sniffed.
  const mobile = low || coarsePointer();
  const cap = mobile ? SHADOW_MAX_MOBILE : SHADOW_MAX;
  const budget = mobile ? SHADOW_MAX_MOBILE * SHADOW_MAX_MOBILE : SHADOW_BUDGET;
  const spanX = maxX - minX, spanY = maxY - minY;
  const texel = Math.max(SHADOW_TEXEL, Math.sqrt((spanX * spanY) / budget));
  const fit = (span) => Math.min(cap, Math.max(SHADOW_FLOOR, quant(span / texel)));
  let nx = fit(spanX), ny = fit(spanY);
  // Rounding up to the step can nudge the pair back over; give the step back to
  // whichever axis is finer, which keeps the texel square-ish as it settles.
  while (nx * ny > budget && (nx > SHADOW_FLOOR || ny > SHADOW_FLOOR)) {
    if ((spanX / nx <= spanY / ny && nx > SHADOW_FLOOR) || ny <= SHADOW_FLOOR) nx -= SHADOW_STEP;
    else ny -= SHADOW_STEP;
  }
  if (s.mapSize.x !== nx || s.mapSize.y !== ny) {
    s.mapSize.set(nx, ny);
    // three allocates the render target lazily from mapSize; an already-allocated
    // one has to be released or the resize is silently ignored.
    if (s.map) { s.map.dispose(); s.map = null; }
  }
  s.needsUpdate = true;
}

/** Metres per shadow texel on each axis, for QA. */
export function shadowTexelSize(key) {
  const s = key.shadow;
  return {
    x: (s.camera.right - s.camera.left) / s.mapSize.x,
    z: (s.camera.top - s.camera.bottom) / s.mapSize.y,
    mapSize: [s.mapSize.x, s.mapSize.y],
  };
}

export function buildLighting(scene) {
  const hemi = new THREE.HemisphereLight(0xf3f5ff, 0x2c3766, 1.5);
  scene.add(hemi);

  // main fill from the front-top (entrance feels brightest).
  // This is the ONLY shadow caster: one tight orthographic frustum over the
  // whole footprint costs a single extra pass, where per-point-light shadows
  // would cost six cube renders and buy almost nothing in a room lit this
  // evenly. Everything else contributes light but not shadow.
  const key = new THREE.DirectionalLight(0xfff3dd, 1.1);
  key.position.set(3, 12, 14);
  key.castShadow = true;
  key.target.position.set(0, 0, -1);
  scene.add(key.target);
  const s = key.shadow;
  s.mapSize.set(2048, 2048);
  // Cases sit ~14mm proud of a shelf, so the bias has to be small enough not to
  // detach the contact shadow that makes them read as physical objects.
  s.bias = -0.00035;
  s.normalBias = 0.018;
  fitShadowToStore(key);
  scene.add(key);

  // cool bounce from the back so rear aisles don't go muddy.
  // NOTE ON EVENNESS: hemisphere and directional light are distance-invariant,
  // so the general illumination of the sales floor is flat whatever the depth —
  // the ambient rig does NOT need to grow. What made a long store read dark at
  // the back was the FITTINGS and the ACCENTS being clustered at the front, and
  // that is what planCeilingFittings() and placeAccentLights() fix.
  const back = new THREE.DirectionalLight(0xdfe6ff, 0.45);
  back.position.set(-4, 10, -12);
  scene.add(back);

  // faint cold spill through the storefront glass
  const night = new THREE.DirectionalLight(0x8fa3ff, 0.18);
  night.position.set(0, 3, 20);
  scene.add(night);

  scene.background = new THREE.Color(0x05070f);
  return { hemi, key, back, night };
}

// ===========================================================================
// ACCENT POOLS
//
// These used to be seven PointLights at literal coordinates authored against
// the 19m store: the "checkout" pool sat at z 7.2 while the counter now tracks
// the front wall and stands at z 25.1 in a nine-service store, the endcap pools
// lit an aisle the annex had long since rebuilt, and the mezzanine fill hung
// over open floor. Every one of them is now read off layout.
//
// BUDGET. Point lights are the expensive kind — each one is a term in every
// lit material's shader — so the count is bounded, not proportional:
//
//     anchors : 2 + 2/well  (checkout, Binge Zone, boarding + graze per bank)
//     accents : clamp(round(litArea / AREA_PER_ACCENT), 2, 10)
//     ceiling : ACCENT_MAX + anchors = 18 from this file at three wells
//
// store.js adds exactly one more of its own — the glow inside the popcorn
// hopper, which is a prop light rather than an architectural one — so the
// three-well shipped store runs 19 real-time point lights (measured in the
// session-F browser lifecycle audit; the old "15 ever" figure predated the
// second and third escalator banks).
//
// litArea is ground footprint + mezzanine footprint, so a store that doubles in
// depth gains ~4 accents, not ~150. Everything else on the ceiling is emissive
// geometry, which costs nothing per material.
// ===========================================================================
const AREA_PER_ACCENT = 260;   // m² of sales floor per roving accent pool
const ACCENT_MIN = 2, ACCENT_MAX = 10;

/** How many roving accents this building earns, and how they split by level. */
export function accentBudget(layout) {
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const w = maxX - minX;
  const area0 = w * (maxZ - minZ);
  // the balcony's rear edge is layout.mezz.minZ (= mezzBackZ), not the
  // building's back wall — the slab stopped reaching the wall when
  // setMezzDepth sized it, and pricing accents off phantom floor skewed the
  // ground/mezz split by a light
  const mezzBack = layout.mezz ? layout.mezz.minZ : minZ;
  const area1 = w * Math.max(0, WORLD.mezzFrontZ - mezzBack);
  const n = Math.min(ACCENT_MAX, Math.max(ACCENT_MIN, Math.round((area0 + area1) / AREA_PER_ACCENT)));
  const mezz = Math.max(1, Math.min(n - 1, Math.round((n * area1) / (area0 + area1))));
  return { total: n, ground: n - mezz, mezz, area0, area1 };
}

/**
 * Hang the accent pools on furniture that actually exists.
 *
 * Called by buildStore(), because the shell — and therefore every position in
 * here — is rebuilt whenever the projection resizes the building. Adds straight
 * to the scene so main.js's shell diff owns their lifetime.
 */
export function placeAccentLights(scene, layout) {
  const { mezzY, slabT, mezzFrontZ } = WORLD;
  const underSlabY = mezzY - slabT - 0.02;
  const lights = [];
  // Pools are added in scene-importance order — counter, escalator landings,
  // lounge, then roving accents — so the device cap drops atmosphere first and
  // never a named anchor. accentBudget() still reports the UNCAPPED intent, so
  // the build report keeps meaning what it always meant.
  const maxLights = deviceProfile().maxPointLights;
  let placed = 0;
  const add = (color, intensity, dist, decay, x, y, z) => {
    if (placed >= maxLights) return null;
    placed++;
    const l = new THREE.PointLight(color, intensity, dist, decay);
    l.position.set(x, y, z);
    scene.add(l);
    lights.push(l);
    return l;
  };
  // A ground-floor pool behind the mezzanine edge has only 3.06m of headroom,
  // so it hangs from the slab, not from the 6.3m ceiling.
  const groundY = (z) => (z < mezzFrontZ ? underSlabY - 0.3 : 2.9);
  const prop = (kind) => layout.props.find(p => p.kind === kind);

  // --- anchor 1: warm pool over the checkout counter, wherever it ended up
  const counter = prop('counter');
  if (counter) add(0xffd9a0, 14, 9, 1.9, counter.x, 2.9, counter.z + 0.2);

  // --- anchors 2 & 3: escalator landing + a grazing light so the west cladding
  // face reads navy rather than a black wedge. Both read the escalator's own
  // geometry — the escalator does not move when the store grows, but neither
  // does it have to be transcribed here to stay put.
  // One boarding pool per BANK, not one averaged across all of them — averaging
  // two banks on opposite sides of the store would light the empty middle.
  const escs = layout.escalators || [];
  const wells = layout.wells || (layout.well ? [layout.well] : []);
  for (const w of wells) {
    const mine = escs.filter(e => e.x > w.minX && e.x < w.maxX);
    if (!mine.length) continue;
    const cx = mine.reduce((s, e) => s + e.x, 0) / mine.length;
    add(0xfff0cf, 7, 6, 2.0, cx, 3.1, mine[0].boardZ - 0.3);
    add(0xf2f5ff, 9, 9, 1.8, cx, 2.4, (w.minZ + mine[0].boardZ) / 2);
  }

  // --- anchor 4: the Binge Zone lounge on the mezzanine
  const binge = prop('bingezone');
  if (binge) add(0xffd9a0, 10, 7, 1.9, binge.x, mezzY + 2.4, binge.z);

  // --- roving accents over real endcaps, spread down each level
  const budget = accentBudget(layout);
  for (const level of [0, 1]) {
    const want = level ? budget.mezz : budget.ground;
    // Endcaps: the free-standing runs a shopper walks PAST, so anything hugging
    // a perimeter wall is out — a pool 17cm off the wall lights masonry, not an
    // aisle. (Several core units are styled 'gondola' but stand against the side
    // wall, which is why position decides this and not style alone.)
    const byWalk = (a, b) => b.z - a.z || a.x - b.x;
    const interior = layout.fixtures
      .filter(f => f.kind === 'shelf' && f.level === level && Math.abs(f.x) < WORLD.halfW - 1.6)
      .sort(byWalk);
    let ends = interior.filter(f => f.style === 'gondola' || f.style === 'endcap');
    // Too small a pool and evenly-spaced picks land on top of each other — the
    // mezzanine only has one interior gondola pair. Widen rather than stack.
    if (ends.length < want * 2) ends = interior;
    if (ends.length < want * 2) {
      ends = layout.fixtures.filter(f => f.kind === 'shelf' && f.level === level).sort(byWalk);
    }
    if (!ends.length) continue;
    for (let i = 0; i < Math.min(want, ends.length); i++) {
      const f = ends[Math.floor(((i + 0.5) * ends.length) / want)];
      const y = level ? mezzY + 2.5 : groundY(f.z);
      add(0xfff0cf, level ? 10 : 8, level ? 9 : 7, 2.0, f.x, y, f.z);
    }
  }
  return lights;
}

/**
 * Decide what casts and what receives, once, by walking the finished scene.
 *
 * Doing it here rather than at every construction site keeps store.js,
 * mezzanine.js, cases.js and npc.js free of shadow bookkeeping — and means a
 * newly added prop is grounded by default instead of floating until someone
 * remembers to flag it.
 *
 * The rules: anything with real thickness casts; anything a shadow could fall
 * on receives; light sources and glass do neither. MeshBasicMaterial is
 * unlit by definition, so those are skipped entirely.
 */
export function enableShadows(root, { mobile = false } = {}) {
  let casters = 0, receivers = 0, skippedEmissive = 0, shell = 0, caseBatchesSkipped = 0;
  // `mobile` used to be accepted and echoed back in the stats object without
  // changing a single thing. It decides policy now.
  const skipCaseBatches = mobile && !deviceProfile().caseBatchShadows;

  // GOTCHA: MeshStandardMaterial.emissiveIntensity defaults to 1 even when
  // .emissive is pure black, so "intensity > 0" flags every material in the
  // scene as a light fitting. Actual emission is colour x intensity.
  const emits = (m) => {
    if (!m.emissive) return false;
    const i = m.emissiveIntensity ?? 1;
    return i > 0 && (m.emissive.r + m.emissive.g + m.emissive.b) * i > 0.12;
  };

  root.updateMatrixWorld(true);
  const bb = new THREE.Box3();

  root.traverse((o) => {
    if (!o.isMesh || !o.material || !o.geometry) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.every(m => m.isMeshBasicMaterial)) return;   // unlit: no shadow role

    if (mats.some(emits)) { o.receiveShadow = false; skippedEmissive++; return; }
    if (mats.some(m => m.transparent && m.opacity < 0.7)) { o.receiveShadow = true; receivers++; return; }

    // Classify by SHAPE, not by name — nothing in this scene is named, and a
    // geometric test stays correct for props added later. The building shell
    // (floor slabs, walls, ceilings) is large and thin: it catches shadows but
    // casting from it only costs fill rate and self-shadow artefacts.
    bb.setFromObject(o);
    const sx = bb.max.x - bb.min.x, sy = bb.max.y - bb.min.y, sz = bb.max.z - bb.min.z;
    const isShell = Math.max(sx, sz) > 8 && Math.min(sx, sy, sz) < 0.4;

    // THE CASE BATCHES ARE THE SHADOW PASS'S WHOLE COST ON A PHONE.
    //
    // They are merged by catalogue order, so one batch's bounds span most of
    // the building and ~200 of 260 can never be frustum-culled. Casting from
    // them pushed ~700k triangles through the shadow map EVERY FRAME to render
    // shadows of thin sheets of case fronts. The fixture carcases keep casting,
    // so cases still visibly sit ON shelves. Desktop is unchanged.
    if (!skipCaseBatches || !o.userData.isCaseBatch) {
      if (!isShell) { o.castShadow = true; casters++; } else shell++;
    } else { o.castShadow = false; caseBatchesSkipped++; }
    o.receiveShadow = true; receivers++;
  });
  return { casters, receivers, shellSurfaces: shell, skippedEmissive, caseBatchesSkipped, mobile };
}
