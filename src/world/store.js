// Builds the physical store: architecture, fixtures, decor.
// Heavy use of geometry merging — the whole environment is a few dozen draw calls.
import * as THREE from 'three';
import { mergeGeometries } from '../../vendor/BufferGeometryUtils.js';
import { LAYERS, WALL_SCENES, sliceFor, makeWallPanorama } from './exterior.js';
import { WORLD, BRAND, CLERESTORY, clerestoryAllowedAt } from '../config.js';
import { planPosterSpots, ceilingYAt, SIGN, frontWallFaceZ } from './layout.js';
import { familyOf, specFor, boardSize, centreY, hangerOffsets } from './signage.js';
import { paintSign, faceKey } from './signage-art.js';
import {
  makeCarpet, makeCeiling, makeWall, makeDeptHeader,
  makeLogoSign, makeNightBackdrop, makeSnackShelf, makeReturnBinFace,
  makeCounterFront, makeOpenNeon, makePoster, makePopcornSign,
} from './textures.js';

import { placeAccentLights } from './lighting.js';

const T = (canvas, opts = {}) => {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = opts.aniso ?? 4;
  if (opts.wrap) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  return t;
};

// ===========================================================================
// CEILING PLAN — fitting DENSITY is the constant, not the fitting COUNT.
//
// The troffer grid used to be a literal list of six z values. That was a
// correct plan for the 19m-deep hand-authored store and a bug for every store
// the projection generates: a nine-service building runs z ∈ [-27.4, 27.4] and
// had ceiling fittings over the first 15m of it. Everything below is spaced off
// layout.bounds instead, so the last aisle of a 55m store is lit exactly like
// the first.
//
// These are geometry, not lights: each troffer is a merged housing box plus an
// unlit bright quad, and the ceiling plane itself carries the emissive map.
// Growing the grid costs triangles (about 12 per fitting) and zero draw calls
// or shader light slots.
// ===========================================================================
const TROFFER = {
  pitchX: 3.5,    // nominal spacing across the store
  pitchZ: 3.0,    // nominal spacing down the store
  inset: 2.4,     // keep fittings clear of the perimeter walls
  slabGap: 1.4,   // first under-slab row this far behind the mezzanine edge
};

/**
 * Evenly spaced centres spanning [min, max] inclusive at ~pitch, so the run is
 * symmetric and always ends on the inset rather than wherever the pitch landed.
 */
function evenSpan(min, max, pitch) {
  const span = max - min;
  if (span <= pitch * 0.5) return [(min + max) / 2];
  const n = Math.max(1, Math.round(span / pitch));
  const out = [];
  for (let i = 0; i <= n; i++) out.push(min + (span * i) / n);
  return out;
}

/**
 * Every ceiling fitting in the building, derived from the floor plan.
 * Returns [{x, z, y, under}] — `under` marks the low rows hung from the
 * mezzanine slab, which is a different ceiling at a different height.
 */
export function planCeilingFittings(layout) {
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const { ceilH, mezzY, slabT, mezzFrontZ } = WORLD;
  const underSlabY = mezzY - slabT - 0.02;
  const wells = layout.wells || (layout.well ? [layout.well] : []);
  const xs = evenSpan(minX + TROFFER.inset, maxX - TROFFER.inset, TROFFER.pitchX);
  const out = [];

  // High ceiling: the whole footprint, front zone through to the back wall.
  // (Above the mezzanine this is the mezzanine's own ceiling — same slab of sky.)
  for (const z of evenSpan(minZ + TROFFER.inset, maxZ - TROFFER.inset, TROFFER.pitchZ)) {
    for (const x of xs) out.push({ x, z, y: ceilH, under: false });
  }

  // Low ceiling: the ground floor UNDER the mezzanine slab — and ONLY under it.
  //
  // These hang FROM the slab, so they exist exactly where the slab does:
  // z ∈ [mezzBackZ, mezzFrontZ]. This used to run from the back wall forward,
  // which was harmless while the balcony ran the full depth of the building. Now
  // that it is sized by its own aisles, everything behind it is double-height
  // open floor — and the fittings hung there had nothing above them. They floated
  // in mid-air over the deep aisles, and from the balcony you looked straight
  // down onto their backs.
  const zsUnder = evenSpan(
    Math.max(minZ, WORLD.mezzBackZ) + TROFFER.slabGap,
    mezzFrontZ - TROFFER.slabGap,
    TROFFER.pitchZ,
  );
  for (const z of zsUnder) {
    for (const x of xs) {
      // Skip every well, not just the first — an under-slab troffer hung over an
      // opening floats in mid-air above the sales floor.
      if (wells.some(w => x > w.minX && x < w.maxX && z > w.minZ && z < w.maxZ)) continue;
      out.push({ x, z, y: underSlabY + 0.02, under: true });
    }
  }
  return out;
}

// WALL ART LIVES IN layout.js. It is pure geometry over the floor plan — no
// three.js, no DOM — and it has to stay clear of CLERESTORY, of the fixtures and
// of the balcony's own extent, which is exactly the bookkeeping layout.js
// already owns and unit-tests. Re-exported here for the consumers that have
// always asked store.js for it.
export { planPosterSpots };

export function buildStore(scene, layout, catalog, curation) {
  const { halfW, halfD, ceilH } = WORLD;
  const raycastTargets = [];
  const byId = new Map(catalog.map(t => [t.id, t]));

  // Merge buckets: material key -> array of transformed geometries
  const buckets = new Map();
  const MATS = {
    navyLam: new THREE.MeshStandardMaterial({ color: 0x1b2c66, roughness: 0.55, metalness: 0.05 }),
    navyDark: new THREE.MeshStandardMaterial({ color: 0x101c44, roughness: 0.6 }),
    goldTrim: new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.42, metalness: 0.25 }),
    board: new THREE.MeshStandardMaterial({ color: 0xe7e6e0, roughness: 0.62 }),
    kick: new THREE.MeshStandardMaterial({ color: 0x11151f, roughness: 0.8 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x8d939e, roughness: 0.45, metalness: 0.6 }),
    counterTop: new THREE.MeshStandardMaterial({ color: 0xd9d5c9, roughness: 0.35 }),
    darkPlastic: new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.5 }),
    redBody: new THREE.MeshStandardMaterial({ color: 0xb8271f, roughness: 0.45, emissive: 0x300906, emissiveIntensity: 1 }),
    white: new THREE.MeshStandardMaterial({ color: 0xf0efe8, roughness: 0.6 }),
  };
  const box = (matKey, w, h, d, x, y, z, rotY = 0, rotX = 0, rotZ = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rotX, rotY, rotZ, 'YXZ'));
    m.setPosition(x, y, z);
    g.applyMatrix4(m);
    if (!buckets.has(matKey)) buckets.set(matKey, []);
    buckets.get(matKey).push(g);
  };

  // ---------------------------------------------------------------- floor
  const carpetTex = T(makeCarpet(layout.bounds, layout.obstacles[0]), { aniso: 8 });
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(halfW * 2, halfD * 2),
    new THREE.MeshStandardMaterial({ map: carpetTex, roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.userData.walkable = true;
  floor.userData.level = 0;
  scene.add(floor);
  raycastTargets.push(floor);

  // ---------------------------------------------------------------- ceiling
  // One high ceiling at 6.3m over the whole volume (double-height front,
  // normal height above the mezzanine). The ground area UNDER the mezzanine
  // gets its ceiling from the slab underside (built in mezzanine.js).
  // The tile pattern is drawn once over a seamless 9.76m patch (16 x 8 whole
  // 2x4ft tiles) and repeated, rather than rendering one canvas the size of the
  // building — the old call cost ~50k canvas ops and a 0.7m-pixel texture on a
  // nine-service store, for a grid that is identical everywhere.
  const CEIL_PATCH = 0.61 * 16;
  const ceilTex = T(makeCeiling(CEIL_PATCH, CEIL_PATCH), { wrap: true });
  ceilTex.repeat.set((halfW * 2) / CEIL_PATCH, (halfD * 2) / CEIL_PATCH);
  const ceil = new THREE.Mesh(
    new THREE.PlaneGeometry(halfW * 2, halfD * 2),
    new THREE.MeshStandardMaterial({
      map: ceilTex, roughness: 0.9,
      emissive: 0xffffff, emissiveMap: ceilTex, emissiveIntensity: 0.52,
    })
  );
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = ceilH;
  scene.add(ceil);

  // Fluorescent troffers: high grid over the whole footprint + low grid under
  // the mezzanine slab. Both grids are spaced off layout.bounds, so a 55m store
  // is lit to the same fittings-per-square-metre as the 19m core.
  const panelGeos = [];
  const underSlabY = WORLD.mezzY - WORLD.slabT - 0.02;
  const troffers = planCeilingFittings(layout);
  // One slightly haunted tube, hung from the slab in the deepest west corner —
  // picked from the plan rather than matched against literal coordinates, which
  // stopped selecting anything the moment the grid started moving.
  const under = troffers.filter(t => t.under);
  const flickerAt = under.length
    ? under.reduce((best, t) => {
      const score = (b) => b.z * 4 + Math.abs(b.x - (layout.bounds.minX + 5.9));
      return score(t) < score(best) ? t : best;
    })
    : null;
  let flickerPanel = null;
  for (const t of troffers) {
    box('metal', 0.64, 0.07, 1.24, t.x, t.y - 0.035, t.z);
    const pg = new THREE.PlaneGeometry(0.56, 1.16);
    const pm = new THREE.Matrix4().makeRotationX(Math.PI / 2);
    pm.setPosition(t.x, t.y - 0.072, t.z);
    pg.applyMatrix4(pm);
    if (t === flickerAt) {
      flickerPanel = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ color: 0xf2f5ff }));
      scene.add(flickerPanel);
    } else {
      panelGeos.push(pg);
    }
  }
  const panels = new THREE.Mesh(mergeGeometries(panelGeos), new THREE.MeshBasicMaterial({ color: 0xf4f7ff }));
  scene.add(panels);

  // ---------------------------------------------------------------- walls
  const wallH = ceilH;
  const mkWallMesh = (wM, seed) => new THREE.Mesh(
    new THREE.PlaneGeometry(wM, wallH),
    new THREE.MeshStandardMaterial({ map: T(makeWall(wM, wallH, { seed })), roughness: 0.85 })
  );
  const backWall = mkWallMesh(halfW * 2, 'back');
  backWall.position.set(0, wallH / 2, -halfD);
  scene.add(backWall);
  const leftWall = mkWallMesh(halfD * 2, 'left');
  leftWall.rotation.y = Math.PI / 2;
  leftWall.position.set(-halfW, wallH / 2, 0);
  scene.add(leftWall);
  const rightWall = mkWallMesh(halfD * 2, 'right');
  rightWall.rotation.y = -Math.PI / 2;
  rightWall.position.set(halfW, wallH / 2, 0);
  scene.add(rightWall);
  raycastTargets.push(backWall, leftWall, rightWall);

  // ---- clerestory glazing
  //
  // The shell used to be windowless apart from the storefront, so once you were
  // past the entrance the building had no outside at all — and from the balcony,
  // which sits at 3.3m, you looked out over an unbroken wall.
  //
  // The band sits at 4.3-5.5m. On the GROUND floor that is genuinely above
  // everything: the tallest wall unit is 2.28m tall and its cap board adds
  // another 0.05, for a world top of 2.33.
  //
  // ON THE MEZZANINE the band is level with the shelving: level-1 fixtures stand
  // on the balcony at 3.30, so a 2.28m wall unit tops out at 5.63 with its cap
  // — inside the 4.30-5.50 glazing. 80 of the 94 level-1 fixtures reach into
  // that band by height.
  //
  // This comment used to go on to say CT-01 (x 12.83, z -4.6) physically
  // interpenetrated the right-wall window, and that it was NOT FIXED. Both
  // halves are now stale and were checked before being deleted: CT-01 is a
  // 0.725m fixture whose top is 4.075, below the sill, and the closest tall
  // level-1 fixture to any glazed wall is TD-13 at 1.76m of clearance. The
  // mezzanine pour moved underneath the old note. tests/layout.test.mjs now
  // pins that clearance so it cannot drift back.
  //
  // Frosted and softly self-lit rather
  // than clear — it is night outside, and a clear pane would just be a black
  // rectangle. Glass is the only thing here that is NOT a raycast target: these
  // are scenery, and clicking a window should do nothing.
  {
    // One authority for the band — CLERESTORY in config.js. Anything that has to
    // stay OUT of the windows (the wall art, above all) reads the same numbers.
    const { sillY, headY, paneW, pitch, reveal: REVEAL } = CLERESTORY;
    const H = headY - sillY, cy = (sillY + headY) / 2;

    // Cross-section, inner face outward:  casing -> reveal liner -> mullions ->
    // glass -> night beyond. Each is a real surface at a real depth, which is
    // what makes the opening read as built into the wall instead of stuck on it.
    // (the exterior is now built per window type below — see skyMats)
    // Glazing proper: nearly clear, very smooth, and NOT emissive. It reads as
    // glass because it throws a sharp specular of the store's own fittings across
    // a bright exterior — the previous version glowed, which is what made it look
    // like a lit panel rather than a pane.
    const glassMat2 = new THREE.MeshStandardMaterial({
      color: 0xeaf2fa, roughness: 0.03, metalness: 0.35,
      transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false,
    });
    const revealMat = new THREE.MeshStandardMaterial({ color: 0xd9dae0, roughness: 0.9 });
    const casingMat = new THREE.MeshStandardMaterial({ color: 0xeceef2, roughness: 0.75 });
    const sillMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd4, roughness: 0.6, metalness: 0.15 });
    const mullMat = new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.45, metalness: 0.45 });

    // Built once in LOCAL space and instanced, so every window on the building is
    // identical — the brief's "consistent spacing, consistent elevation, clean
    // alignment".
    //
    // LOCAL z = 0 IS THE WALL PLANE, AND THE ASSEMBLY GROWS INTO THE ROOM (+z).
    // The first attempt built the reveal going outward instead, which put the sky
    // panel behind an opaque wall plane — the walls are single planes with no
    // thickness and nothing to cut a hole in, so the exterior was simply occluded
    // and every opening rendered as an empty white frame. Growing inward gives the
    // same read (sky at the back of a deep box) and is what actually draws.
    // A WINDOW VOCABULARY, NOT ONE PREFAB REPEATED.
    //
    // Every opening used to be `unit.clone()` of a single group, so a 148 m
    // elevation was the same window stamped ~80 times with the same star field
    // behind it. That is the strongest possible tell that a building was
    // generated rather than designed. These types keep ONE design language —
    // identical sill height, head height, reveal depth, casing profile and
    // materials — and vary only what a real architect would vary: the width of
    // the opening and how many lights it is divided into.
    //
    //   A  standard clerestory, centre mullion + transom     (the primary)
    //   B  wider bay, two lights, no centre mullion          (breathing room)
    //   C  narrow bay, single light                          (between structure)
    //   D  paired opening, heavy centre post                 (rhythm accent)
    const TYPES = {
      A: { w: paneW, lights: 2, post: 0.055 },
      B: { w: paneW * 1.34, lights: 2, post: 0.0 },
      C: { w: paneW * 0.68, lights: 1, post: 0.0 },
      D: { w: paneW * 1.18, lights: 2, post: 0.11 },
    };

    // ONE PANORAMA PER WALL, NOT ONE PICTURE PER WINDOW — see exterior.js.
    //
    // This was eight makeSkyPanel materials cycled as `skyIdx = i + phase`.
    // Eight seeds of one generator is not eight views: every opening on the
    // building showed a dusk gradient with a flat strip of grey rectangles at
    // the same horizon height, and the same strip appeared on walls facing
    // opposite directions. Now each elevation looks out on a different PLACE
    // (car park / service yard / the town), each opening shows the slice of
    // that place behind it, and three depth layers give it parallax.
    const panos = {};
    for (const wall of Object.keys(WALL_SCENES)) {
      const cv = makeWallPanorama(wall, 2048, 256);
      panos[wall] = {};
      for (const L of LAYERS) {
        const tex = T(cv[L.key], { aniso: 4 });
        tex.wrapS = THREE.RepeatWrapping;
        panos[wall][L.key] = tex;
      }
    }
    const layerMats = {};
    for (const wall of Object.keys(panos)) {
      layerMats[wall] = {};
      for (const L of LAYERS) {
        layerMats[wall][L.key] = new THREE.MeshBasicMaterial({
          map: panos[wall][L.key],
          transparent: L.key !== 'far',
          depthWrite: L.key === 'far',
        });
      }
    }

    const makeUnit = (t) => {
      const g = new THREE.Group();
      const W = t.w;
      const put = (mesh, px, py, pz) => { mesh.position.set(px, py, pz); g.add(mesh); };
      const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);

      // (the world beyond is built per WALL, below — one continuous panorama
      // sliced by each opening's position, so adjacent windows show adjacent
      // parts of one place instead of 77 independent postcards)
      // reveal liner: the four returns that make the glass read as set back
      put(box(W + 0.04, 0.04, REVEAL, revealMat), 0, H / 2, REVEAL / 2);
      put(box(W + 0.04, 0.04, REVEAL, revealMat), 0, -H / 2, REVEAL / 2);
      put(box(0.04, H, REVEAL, revealMat), -W / 2, 0, REVEAL / 2);
      put(box(0.04, H, REVEAL, revealMat), W / 2, 0, REVEAL / 2);
      // glazing, set back inside the reveal
      const gz = REVEAL * 0.42;
      put(new THREE.Mesh(new THREE.PlaneGeometry(W, H), glassMat2), 0, 0, gz);
      // vertical division — the one thing that actually distinguishes the types
      if (t.post > 0) put(box(t.post, H, 0.05, mullMat), 0, 0, gz + 0.02);
      else if (t.lights > 1) {
        for (let i = 1; i < t.lights; i++) {
          put(box(0.045, H, 0.05, mullMat), -W / 2 + (W * i) / t.lights, 0, gz + 0.02);
        }
      }
      // transom in the upper third — common to every type, which is what keeps
      // the elevation reading as one building
      put(box(W, 0.05, 0.05, mullMat), 0, H / 2 - H / 3, gz + 0.02);
      // perimeter frame in the plane of the glass
      put(box(W, 0.07, 0.06, mullMat), 0, H / 2 - 0.035, gz + 0.02);
      put(box(W, 0.07, 0.06, mullMat), 0, -H / 2 + 0.035, gz + 0.02);
      put(box(0.07, H, 0.06, mullMat), -W / 2 + 0.035, 0, gz + 0.02);
      put(box(0.07, H, 0.06, mullMat), W / 2 - 0.035, 0, gz + 0.02);
      // casing at the room-side mouth of the reveal — a shallow architrave
      put(box(W + 0.30, 0.15, 0.05, casingMat), 0, H / 2 + 0.075, REVEAL - 0.02);
      put(box(W + 0.30, 0.15, 0.05, casingMat), 0, -H / 2 - 0.075, REVEAL - 0.02);
      put(box(0.15, H + 0.30, 0.05, casingMat), -W / 2 - 0.075, 0, REVEAL - 0.02);
      put(box(0.15, H + 0.30, 0.05, casingMat), W / 2 + 0.075, 0, REVEAL - 0.02);
      // stooled sill projecting into the room — from the floor you read its
      // underside long before you can see any glass. SAME height on every type.
      put(box(W + 0.34, 0.06, 0.22, sillMat), 0, -H / 2 - 0.14, REVEAL - 0.05);
      return g;
    };

    // The rhythm. A deliberate, repeating-but-long phrase rather than random
    // noise: architecture varies to a plan, and a random width per opening would
    // look like damage rather than design.
    const RHYTHM = ['A', 'A', 'B', 'A', 'C', 'B', 'A', 'D', 'A', 'C', 'B', 'A'];

    const addBand = (len, place, phase, wall) => {
      const n = Math.max(1, Math.floor((len - 4.0) / pitch));
      const span = (n - 1) * pitch;
      const geos = { far: [], mid: [], near: [] };

      // WHICH WAY DOES THE PANORAMA RUN ON THIS WALL?
      //
      // The left elevation is placed at rotation +PI/2 and the right at -PI/2,
      // which send a pane's local +x to world -z and +z respectively — so an
      // identical UV bake runs the view BACKWARDS on one of them. Rather than
      // transcribe a sign per wall (this project's recurring defect, found for
      // the tenth time exactly here), ask the placement itself: step a probe one
      // metre along u and see which way its own +x points.
      const p0 = new THREE.Object3D(), p1 = new THREE.Object3D();
      place(p0, 0, cy); place(p1, 1, cy);
      const uHat = new THREE.Vector3().subVectors(p1.position, p0.position).normalize();
      const xHat = new THREE.Vector3(1, 0, 0).applyEuler(p0.rotation);
      const uDir = Math.sign(uHat.dot(xHat)) || 1;
      // MERGED, AND ONLY WHERE MERCHANDISING ALLOWS (window repair directive
      // §1/§10). Two changes in one loop:
      //  * a pane whose along-wall interval falls where the mezzanine puts
      //    shelves at band height is simply NOT BUILT — clerestoryAllowedAt
      //    is the same authority layout.js consults, so a bay is never
      //    clamped for a window that does not exist;
      //  * the units that DO exist no longer ship as ~17 meshes each. 77
      //    units used to mean 1,219 meshes — the largest single non-shelf
      //    block of the frame's draw calls. Each unit's parts now merge into
      //    one geometry bucket per MATERIAL per wall: same architecture,
      //    a handful of draw calls per elevation.
      const unitBuckets = new Map();     // material -> geometries
      let unitsBuilt = 0;
      for (let i = 0; i < n; i++) {
        const u = n === 1 ? 0 : -span / 2 + i * pitch;
        const key = RHYTHM[(i + phase) % RHYTHM.length];
        const t = TYPES[key];
        if (!clerestoryAllowedAt(wall, u - t.w / 2 - 0.17, u + t.w / 2 + 0.17)) continue;
        unitsBuilt++;
        const win = makeUnit(t);
        place(win, u, cy);
        win.updateMatrixWorld(true);
        win.traverse((c) => {
          if (!c.isMesh) return;
          const g = c.geometry.applyMatrix4(c.matrixWorld);
          if (!unitBuckets.has(c.material)) unitBuckets.set(c.material, []);
          unitBuckets.get(c.material).push(g);
        });

        // The view through THIS opening: the slice of the wall's panorama that
        // lies behind it, at three depths. UVs are baked per opening so every
        // window on a wall shares one material per layer and the whole
        // elevation merges into three meshes — cheaper than the 77 separate
        // sky planes this replaces, not more expensive.
        for (const L of LAYERS) {
          const g = new THREE.PlaneGeometry(t.w, H);
          const sl = sliceFor(u, len, t.w, L, uDir);
          const uv = g.attributes.uv;
          for (let k = 0; k < uv.count; k++) uv.setX(k, sl.offset + uv.getX(k) * sl.repeat);
          uv.needsUpdate = true;
          g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(
            win.matrix, new THREE.Matrix4().makeTranslation(0, 0, L.z)));
          geos[L.key].push(g);
        }
      }
      for (const [mat, gs] of unitBuckets) {
        const merged = new THREE.Mesh(mergeGeometries(gs), mat);
        merged.userData.windowMerged = wall;
        merged.userData.windowUnits = unitsBuilt;
        scene.add(merged);
        for (const g of gs) g.dispose();
      }
      LAYERS.forEach((L, li) => {
        if (!geos[L.key].length) return;
        const m = new THREE.Mesh(mergeGeometries(geos[L.key]), layerMats[wall][L.key]);
        // BEHIND THE GLASS. renderOrder was li (0,1,2), which put the mid and
        // near layers AFTER the transparent pane in the sort — the world was
        // being composited over the window rather than seen through it.
        m.renderOrder = li - 4;             // far, then mid, then near, all before the glass
        m.userData.exteriorLayer = L.key;
        m.userData.wall = wall;
        scene.add(m);
      });
    };
    // Placed ON each wall plane, rotated so local +z points INTO the building.
    // Each wall starts at a different phase so the two side elevations are not
    // mirror images of one another.
    addBand(halfD * 2, (g, u, y) => { g.position.set(-halfW, y, u); g.rotation.y = Math.PI / 2; }, 0, 'left');
    addBand(halfD * 2, (g, u, y) => { g.position.set(halfW, y, u); g.rotation.y = -Math.PI / 2; }, 5, 'right');
    addBand(halfW * 2, (g, u, y) => { g.position.set(u, y, -halfD); }, 9, 'back');
  }

  // Front wall: glass storefront (x -12..-2), doors (-1.6..1.6), solid right side
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0xbfd8ff, transparent: true, opacity: 0.13, roughness: 0.08, metalness: 0.1,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const frameMat = MATS.darkPlastic;
  // storefront: stem wall, ~2.7m glass, solid header up to the high ceiling
  const glassTop = 3.15;
  box('navyLam', 10.4, 0.45, 0.18, -7.0, 0.225, halfD - 0.09);
  box('white', 10.4, wallH - glassTop, 0.18, -7.0, (wallH + glassTop) / 2, halfD - 0.09);
  box('white', 11.2, wallH, 0.18, 7.4, wallH / 2, halfD - 0.09);
  // brand band on right solid section
  box('navyLam', 11.2, 0.5, 0.02, 7.4, 2.62 - 0.05, halfD - 0.19);
  const glassGeos = [];
  for (let i = 0; i < 5; i++) {
    const gx = -11.7 + i * 2.02 + 1.0;
    const g = new THREE.PlaneGeometry(1.94, glassTop - 0.45);
    const m = new THREE.Matrix4();
    m.setPosition(gx, 0.45 + (glassTop - 0.45) / 2, halfD - 0.06);
    g.applyMatrix4(m);
    glassGeos.push(g);
    box('darkPlastic', 0.09, glassTop, 0.16, gx - 1.01, glassTop / 2, halfD - 0.08);
  }
  box('darkPlastic', 0.09, glassTop, 0.16, -1.66, glassTop / 2, halfD - 0.08);
  const storefrontGlass = new THREE.Mesh(mergeGeometries(glassGeos), glassMat);
  scene.add(storefrontGlass);

  // doors: two glass leaves + push bars, header over the doors
  for (const s of [-1, 1]) {
    const dx = s * 0.78;
    box('darkPlastic', 0.07, 2.55, 0.14, dx - s * 0.72, 1.275, halfD - 0.08);
    box('darkPlastic', 1.5, 0.1, 0.12, dx, 2.5, halfD - 0.08);
    box('darkPlastic', 1.5, 0.12, 0.12, dx, 0.09, halfD - 0.08);
    box('metal', 1.28, 0.05, 0.05, dx, 1.02, halfD - 0.16);
    const dg = new THREE.Mesh(new THREE.PlaneGeometry(1.42, 2.3), glassMat);
    dg.position.set(dx, 1.32, halfD - 0.07);
    scene.add(dg);
  }
  box('white', 3.2, wallH - 2.55, 0.18, 0, (wallH + 2.55) / 2, halfD - 0.09);

  // big TAPEBUSTER sign over the entrance (inside)
  const logo = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 1.06),
    new THREE.MeshBasicMaterial({ map: T(makeLogoSign()), transparent: true })
  );
  logo.position.set(0, 2.72, frontWallFaceZ());
  logo.rotation.y = Math.PI;
  scene.add(logo);
  // an even bigger one high on the front wall — the money shot from the mezzanine
  const heroLogo = new THREE.Mesh(
    new THREE.PlaneGeometry(5.6, 1.75),
    new THREE.MeshBasicMaterial({ map: T(makeLogoSign()), transparent: true })
  );
  heroLogo.position.set(0, 4.85, frontWallFaceZ());
  heroLogo.rotation.y = Math.PI;
  scene.add(heroLogo);

  // neon OPEN sign in the window (faces outward, glow leaks inward — decorative)
  const neon = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.45),
    new THREE.MeshBasicMaterial({ map: T(makeOpenNeon()), transparent: true, side: THREE.DoubleSide })
  );
  neon.position.set(-2.8, 2.1, halfD - 0.12);
  scene.add(neon);

  // night parking lot outside
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(44, 13),
    new THREE.MeshBasicMaterial({ map: T(makeNightBackdrop()) })
  );
  backdrop.position.set(0, 3.4, halfD + 7.5);
  backdrop.rotation.y = Math.PI;
  scene.add(backdrop);

  // ---------------------------------------------------------------- shelving fixtures
  const headerTexCache = new Map();
  const headerFor = (label, hue) => {
    if (!headerTexCache.has(label)) {
      headerTexCache.set(label, new THREE.MeshBasicMaterial({ map: T(makeDeptHeader(label, hue)) }));
    }
    return headerTexCache.get(label);
  };
  // HEADERS ARE MERGED PER LABEL, NOT ADDED ONE PER FIXTURE.
  //
  // Measured (scripts/qa/scene-census.mjs): 560 shelf fixtures each added their
  // own two-triangle header Mesh straight to the scene, which was 560 of the
  // 1,025 worst-case draw calls on mobile — more than half the frame's draw
  // calls to draw 1,120 triangles. The material was already cached per label
  // (30 unique labels), so the geometry is the only thing that was per-fixture.
  //
  // Merging costs frustum granularity: one merged run spans a whole department
  // instead of one bay. That trade is strongly positive here because the draw
  // call, not the triangle, is the cost — 30 always-submitted batches of ~37
  // triangles beat 560 individually-culled batches of 2.
  const headerRuns = new Map();

  for (const f of layout.fixtures) {
    if (f.kind === 'shelf') {
      const H = f.height, W = f.w, D = f.depth;
      const rot = f.rotY;
      const local = (lx, ly, lz) => {
        const c = Math.cos(rot), s = Math.sin(rot);
        return { x: f.x + lx * c + lz * s, y: f.baseY + ly, z: f.z - lx * s + lz * c };
      };
      // back panel, sides, kick, top
      let p = local(0, H / 2, -D / 2 + 0.012);
      box('navyLam', W, H, 0.024, p.x, p.y, p.z, rot);
      for (const sx of [-1, 1]) {
        p = local(sx * (W / 2 - 0.012), H / 2, 0);
        box('navyLam', 0.024, H, D, p.x, p.y, p.z, rot);
      }
      p = local(0, 0.09, 0.02);
      box('kick', W, 0.18, D - 0.04, p.x, p.y, p.z, rot);
      p = local(0, H + 0.025, 0);
      box('navyLam', W + 0.05, 0.05, D + 0.05, p.x, p.y, p.z, rot);
      // shelf boards
      for (const ry of f.rows) {
        p = local(0, ry - 0.014, 0.01);
        box('board', W - 0.05, 0.028, D - 0.06, p.x, p.y, p.z, rot);
      }
      // gold trim strip on each board front edge
      for (const ry of f.rows) {
        p = local(0, ry - 0.014, D / 2 - 0.02);
        box('goldTrim', W - 0.05, 0.03, 0.012, p.x, p.y, p.z, rot);
      }
      // header band — baked into this label's merge run (see headerRuns above)
      const hg = new THREE.PlaneGeometry(W + 0.02, 0.24);
      p = local(0, H - 0.13, D / 2 + 0.005);
      hg.rotateY(rot);
      hg.translate(p.x, p.y, p.z);
      let run = headerRuns.get(f.label);
      if (!run) { run = { mat: headerFor(f.label, 48), geos: [] }; headerRuns.set(f.label, run); }
      run.geos.push(hg);
    } else if (f.kind === 'table') {
      box('navyLam', f.w, 0.06, f.depth, f.x, f.height - 0.03, f.z);
      box('navyDark', f.w - 0.2, f.height - 0.06, f.depth - 0.2, f.x, (f.height - 0.06) / 2, f.z);
      box('goldTrim', f.w + 0.04, 0.022, f.depth + 0.04, f.x, f.height - 0.052, f.z);
      // tent sign
      const tent = new THREE.Mesh(
        new THREE.PlaneGeometry(0.5, 0.18),
        new THREE.MeshBasicMaterial({ map: T(makeDeptHeader('FAMILY NIGHT', 140)) })
      );
      tent.position.set(f.x, f.height + 0.1, f.z + 0.1);
      tent.rotation.x = -0.25;
      scene.add(tent);
      raycastTargets.push(tent);
    } else if (f.kind === 'bin') {
      const tub = new THREE.Mesh(
        new THREE.CylinderGeometry(0.56, 0.5, 0.7, 24, 1, true),
        new THREE.MeshStandardMaterial({ color: 0x1b2c66, roughness: 0.55, side: THREE.DoubleSide })
      );
      tub.position.set(f.x, 0.35, f.z);
      scene.add(tub);
      raycastTargets.push(tub);
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(0.565, 0.565, 0.16, 24, 1, true),
        new THREE.MeshBasicMaterial({ map: T(makeDeptHeader('WEEKEND MARATHON · 3 FOR 2', 48)) })
      );
      band.position.set(f.x, 0.52, f.z);
      scene.add(band);
      // dark interior floor of tub
      const lid = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20),
        new THREE.MeshStandardMaterial({ color: 0x0c1020, roughness: 0.9 }));
      lid.rotation.x = -Math.PI / 2;
      lid.position.set(f.x, 0.5, f.z);
      scene.add(lid);
    }
  }

  // Flush the per-label header runs: 560 meshes collapse to one per label.
  for (const [label, run] of headerRuns) {
    const merged = new THREE.Mesh(mergeGeometries(run.geos), run.mat);
    merged.name = `shelf-headers:${label}`;
    scene.add(merged);
    raycastTargets.push(merged);
    for (const g of run.geos) g.dispose();   // sources are consumed by the merge
  }

  // ---------------------------------------------------------------- signage
  //
  // See signage.js. The board was two coincident planes — a zero-thickness
  // sheet — in an unlit MeshBasicMaterial, hung on two 8 mm rods that ran up to
  // 3.42 m and then intersected the ceiling tile with no canopy, no plate and
  // no fixing. Rendered, that is the whole "developer artifact" read: a support
  // that terminates at nothing.
  //
  // Now every sign is a fabricated panel with a real edge, in a material that
  // takes the store's light, carried by hardware that starts at the board and
  // finishes at the structure above it.
  {
    // Sign hardware: PAINTED steel, not chrome. At metalness 0.65 with no
    // environment map in the scene a metal surface has almost no diffuse term,
    // so every rod, clevis and canopy rendered as a black wire against the
    // white ceiling tile — the hanger read as a scratch on the image rather
    // than as a component. Dropped to a satin finish so it picks up the room.
    const hwMat = new THREE.MeshStandardMaterial({ color: 0x9aa0aa, roughness: 0.46, metalness: 0.22 });
    const faceMats = new Map();
    const edgeMats = new Map();
    // EVERY PIECE OF HANGER IN THE STORE IS ONE MESH.
    //
    // Part 1 added rod + clevis + collar + canopy per hanger and scene.add()ed
    // each of them: 38 suspended signs x 2 hangers x 4 components plus the
    // checkout's two spacers is 306 separate objects in a file whose opening
    // line is "heavy use of geometry merging — the whole environment is a few
    // dozen draw calls". They all share one material, so they are one mesh.
    const hwGeos = [];
    const hwPart = (geo, x, y, z, rotY = 0, rotX = 0, rotZ = 0) => {
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, rotZ)),
        new THREE.Vector3(1, 1, 1));
      geo.applyMatrix4(m);
      hwGeos.push(geo);
    };
    for (const s of layout.signs) {
      const fam = familyOf(s);
      const spec = specFor(s);
      const { w: bw, h: bh, depth } = boardSize(s);
      const localCeil = ceilingYAt(s.z, s.level);
      const signY = centreY(s, localCeil, s.level ? WORLD.mezzY : 0);

      // ONE MATERIAL PER PRINTED FACE, and the key is the FACE — not
      // (family, hue, text), which is what it used to be while the face also
      // prints the aisle codes. Fifteen of the thirty-nine signs shared a
      // texture with a sign that named different aisles, so the mid-floor
      // HORROR header advertised "AISLES HO-01 · HO-02" — the front wall pair,
      // sixty metres away. faceKey() is derived from the composed face, so two
      // signs share a texture exactly when they are the same printed thing.
      const key = faceKey(s);
      if (!faceMats.has(key)) {
        // painted ONCE and used for both the diffuse and the emissive slot;
        // the old code called the generator twice per material
        const face = T(paintSign(s));
        faceMats.set(key, new THREE.MeshStandardMaterial({
          map: face,
          roughness: spec.face.roughness,
          metalness: spec.face.metalness,
          emissive: new THREE.Color(0xffffff),
          emissiveMap: face,
          emissiveIntensity: spec.face.emissive,
        }));
      }
      if (!edgeMats.has(spec.edge)) {
        edgeMats.set(spec.edge, new THREE.MeshStandardMaterial({ color: spec.edge, roughness: 0.55 }));
      }
      const faceMat = faceMats.get(key), edgeMat = edgeMats.get(spec.edge);

      // THE BOARD IS AN OBJECT, NOT A DECAL. A box carries the printed face on
      // both broad sides and its own colour on the four edges, so the sign has
      // a visible thickness from every oblique angle.
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(bw, bh, depth),
        [edgeMat, edgeMat, edgeMat, edgeMat, faceMat, faceMat]
      );
      body.position.set(s.x, signY, s.z);
      body.rotation.y = s.rotY;
      body.userData.signFor = s.text;
      body.userData.signFamily = fam;
      body.userData.signLevel = s.level || 0;
      scene.add(body);
      raycastTargets.push(body);

      const cos = Math.cos(s.rotY), sin = Math.sin(s.rotY);
      const at = (off) => ({ x: s.x + cos * off, z: s.z - sin * off });

      if (spec.mount === 'suspended') {
        const rodTop = signY + bh / 2;
        const rodLen = Math.max(SIGN.minRod, localCeil - rodTop);
        for (const off of hangerOffsets(s)) {
          const p = at(off);
          // the hanger itself
          hwPart(new THREE.CylinderGeometry(spec.rodR, spec.rodR, rodLen, 8),
            p.x, rodTop + rodLen / 2, p.z);
          // CLEVIS at the board: the rod is bolted to something.
          hwPart(new THREE.BoxGeometry(spec.rodR * 4.5, 0.055, depth * 0.8),
            p.x, rodTop + 0.022, p.z, s.rotY);
          // CANOPY at the slab: a plate that visibly meets the ceiling, with a
          // short collar so the rod enters something rather than a surface.
          hwPart(new THREE.CylinderGeometry(spec.rodR * 7, spec.rodR * 7, 0.016, 12),
            p.x, localCeil - 0.008, p.z);
          hwPart(new THREE.CylinderGeometry(spec.rodR * 2.6, spec.rodR * 3.4, 0.05, 10),
            p.x, localCeil - 0.041, p.z);
        }
      } else {
        // FIXED: carried on short spacers off the structure behind it. The
        // checkout sign stands in front of the front bulkhead, so rods would be
        // hardware for its own sake.
        for (const off of [-bw * 0.32, bw * 0.32]) {
          const p = at(off);
          hwPart(new THREE.CylinderGeometry(0.016, 0.016, spec.standoff, 8),
            p.x + sin * (depth / 2 + spec.standoff / 2), signY,
            p.z + cos * (depth / 2 + spec.standoff / 2),
            0, Math.PI / 2, -s.rotY);
        }
      }
    }
    if (hwGeos.length) {
      const hw = new THREE.Mesh(mergeGeometries(hwGeos, false), hwMat);
      hw.name = 'signHardware';
      hw.castShadow = false;
      scene.add(hw);
      for (const g of hwGeos) g.dispose();
    }
  }

  // ---------------------------------------------------------------- checkout + props
  for (const p of layout.props) {
    if (p.kind === 'counter') {
      box('counterTop', p.w + 0.08, 0.045, p.d + 0.08, p.x, p.h, p.z);
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(p.w, p.h - 0.02, p.d),
        [MATS.navyLam, MATS.navyLam, MATS.navyLam, MATS.navyLam,
          new THREE.MeshStandardMaterial({ map: T(makeCounterFront(p.w)), roughness: 0.5 }),
          MATS.navyLam]
      );
      // front face toward store interior (-z)… BoxGeometry face order: +x,-x,+y,-y,+z,-z
      body.position.set(p.x, (p.h - 0.02) / 2, p.z);
      body.rotation.y = Math.PI; // logo faces -z (store interior)
      body.userData.checkout = true;
      scene.add(body);
      raycastTargets.push(body);
      // register
      box('darkPlastic', 0.42, 0.16, 0.34, p.x - 0.85, p.h + 0.1, p.z);
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.22),
        new THREE.MeshBasicMaterial({ color: 0x9fd8a0 }));
      screen.position.set(p.x - 0.85, p.h + 0.34, p.z + 0.02);
      screen.rotation.x = -0.25; screen.rotation.y = Math.PI;
      scene.add(screen);
      box('darkPlastic', 0.34, 0.3, 0.05, p.x - 0.85, p.h + 0.32, p.z + 0.06);
      // little membership card stand
      box('goldTrim', 0.16, 0.1, 0.05, p.x + 0.7, p.h + 0.07, p.z, 0.3);
    } else if (p.kind === 'backcounter') {
      box('navyLam', p.w, p.h, p.d, p.x, p.h / 2, p.z);
      box('counterTop', p.w + 0.05, 0.04, p.d + 0.05, p.x, p.h + 0.02, p.z);
      // stacks of returned cases (simple colored boxes)
      const rrng = (n) => Math.abs(Math.sin(n * 999)) % 1;
      for (let i = 0; i < 7; i++) {
        const st = Math.floor(rrng(i) * 3) + 2;
        for (let k = 0; k < st; k++) {
          box(k % 2 ? 'navyDark' : 'darkPlastic', WORLD.caseH, WORLD.caseD, WORLD.caseW,
            p.x - p.w / 2 + 0.25 + i * 0.34, p.h + 0.06 + k * 0.032, p.z, rrng(i * 7 + k) * 0.5);
        }
      }
      const wallLogo = new THREE.Mesh(
        new THREE.PlaneGeometry(2.2, 0.7),
        new THREE.MeshBasicMaterial({ map: T(makeLogoSign()), transparent: true })
      );
      wallLogo.position.set(p.x, 2.1, frontWallFaceZ());
      wallLogo.rotation.y = Math.PI;
      scene.add(wallLogo);
    } else if (p.kind === 'returnbin') {
      const bin = new THREE.Mesh(
        new THREE.BoxGeometry(p.w, p.h, p.d),
        [MATS.navyLam, MATS.navyLam, MATS.navyLam, MATS.navyLam,
          new THREE.MeshStandardMaterial({ map: T(makeReturnBinFace()), roughness: 0.5 }),
          MATS.navyLam]
      );
      bin.position.set(p.x, p.h / 2, p.z);
      bin.rotation.y = Math.PI;
      bin.userData.returnBin = true;
      scene.add(bin);
      raycastTargets.push(bin);
      // slot
      box('kick', p.w * 0.7, 0.05, 0.2, p.x, p.h - 0.09, p.z - p.d / 2 + 0.09);
    } else if (p.kind === 'snackrack') {
      const rot = p.rotY;
      box('navyLam', p.w, p.h, 0.06, p.x, p.h / 2, p.z - 0.22, rot);
      for (const sx of [-1, 1]) box('navyLam', 0.05, p.h, p.d, p.x + sx * (p.w / 2), p.h / 2, p.z, rot);
      [0.4, 0.85, 1.3].forEach((sy, i) => {
        box('board', p.w - 0.08, 0.03, p.d - 0.1, p.x, sy, p.z, rot);
        const shelfTex = new THREE.Mesh(
          new THREE.PlaneGeometry(p.w - 0.1, 0.34),
          new THREE.MeshBasicMaterial({ map: T(makeSnackShelf(i)), transparent: true })
        );
        shelfTex.position.set(p.x, sy + 0.19, p.z + (p.d / 2 - 0.12) * Math.cos(rot));
        shelfTex.rotation.y = rot + Math.PI;
        scene.add(shelfTex);
        raycastTargets.push(shelfTex);
      });
      const snackHeader = new THREE.Mesh(
        new THREE.PlaneGeometry(p.w, 0.22),
        new THREE.MeshBasicMaterial({ map: T(makeDeptHeader('SNACKS', 48)) })
      );
      snackHeader.position.set(p.x, p.h + 0.06, p.z);
      snackHeader.rotation.y = rot + Math.PI;
      scene.add(snackHeader);
    } else if (p.kind === 'popcorn') {
      // a proper concession popper: red base with POPCORN decal, glass hopper
      // full of individual kernels, warm lamp glow, striped POPCORN canopy
      box('redBody', p.w, 0.95, p.d, p.x, 0.475, p.z);
      const decal = new THREE.Mesh(
        new THREE.PlaneGeometry(p.w - 0.12, 0.24),
        new THREE.MeshBasicMaterial({ map: T(makePopcornSign(384, 96)), transparent: true })
      );
      decal.position.set(p.x, 0.62, p.z - p.d / 2 - 0.005);
      decal.rotation.y = Math.PI;
      scene.add(decal);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(p.w - 0.06, 0.6, p.d - 0.06), glassMat);
      glass.position.set(p.x, 1.27, p.z);
      scene.add(glass);
      // kernels: an instanced mound of irregular puffs in butter/cream shades
      const kernelGeo = new THREE.IcosahedronGeometry(0.028, 0);
      const kernelMat = new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true });
      const kernels = new THREE.InstancedMesh(kernelGeo, kernelMat, 90);
      const km = new THREE.Matrix4(), kq = new THREE.Quaternion(), ke = new THREE.Euler();
      const kcol = new THREE.Color();
      const krng = (i) => Math.abs(Math.sin(i * 127.1) * 43758.5453) % 1;
      for (let i = 0; i < 90; i++) {
        const a = krng(i) * Math.PI * 2, rr = Math.sqrt(krng(i + 90)) * (p.w / 2 - 0.09);
        const kx = p.x + Math.cos(a) * rr, kz = p.z + Math.sin(a) * rr;
        const mound = Math.max(0, 0.16 * (1 - (rr / (p.w / 2 - 0.08)) ** 2));
        const ky = 1.0 + mound + krng(i + 180) * 0.05;
        ke.set(krng(i + 270) * 3, krng(i + 33) * 3, 0);
        kq.setFromEuler(ke);
        const s = 0.8 + krng(i + 44) * 0.7;
        km.compose(new THREE.Vector3(kx, ky, kz), kq, new THREE.Vector3(s, s * 0.85, s));
        kernels.setMatrixAt(i, km);
        kernels.setColorAt(i, kcol.setHSL(0.11 + krng(i + 55) * 0.03, 0.55, 0.78 + krng(i + 66) * 0.12));
      }
      scene.add(kernels);
      // warm lamp inside the hopper
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.1),
        new THREE.MeshBasicMaterial({ color: 0xffd27a }));
      lamp.position.set(p.x, 1.5, p.z);
      scene.add(lamp);
      const glow = new THREE.PointLight(0xffbf68, 3.5, 2.2, 2.0);
      glow.position.set(p.x, 1.35, p.z);
      scene.add(glow);
      // striped canopy with POPCORN lettering, all four sides readable
      box('redBody', p.w + 0.08, 0.05, p.d + 0.08, p.x, 1.60, p.z);
      const canopyTex = T(makePopcornSign());
      for (const [dx, dz, ry] of [[0, -(p.d / 2 + 0.05), Math.PI], [0, p.d / 2 + 0.05, 0],
        [-(p.w / 2 + 0.05), 0, -Math.PI / 2], [p.w / 2 + 0.05, 0, Math.PI / 2]]) {
        const side = new THREE.Mesh(
          new THREE.PlaneGeometry(p.w + 0.1, 0.2),
          new THREE.MeshBasicMaterial({ map: canopyTex })
        );
        side.position.set(p.x + dx, 1.72, p.z + dz);
        side.rotation.y = ry;
        scene.add(side);
      }
      box('redBody', p.w + 0.12, 0.04, p.d + 0.12, p.x, 1.83, p.z);
    } else if (p.kind === 'standee') {
      const pick = (curation.staffPicks || [])[p.poster] || catalog[p.poster].id;
      const title = byId.get(pick) || catalog[0];
      const art = new THREE.Mesh(
        new THREE.PlaneGeometry(0.7, 1.5),
        new THREE.MeshStandardMaterial({ map: T(makePoster(title, 280, 600)), roughness: 0.7 })
      );
      art.position.set(p.x, 0.82, p.z);
      art.rotation.y = p.rotY;
      art.userData.titleId = title.id;
      scene.add(art);
      raycastTargets.push(art);
      box('kick', 0.6, 0.05, 0.3, p.x, 0.025, p.z, p.rotY);
      const brace = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.2, 0.04), MATS.kick);
      brace.position.set(p.x, 0.6, p.z);
      brace.rotation.y = p.rotY;
      brace.translateZ(-0.16);
      brace.rotation.x = 0.22;
      scene.add(brace);
    }
  }

  // security gates by the entrance
  for (const gx of [-1.85, 1.85]) {
    box('metal', 0.08, 1.05, 0.4, gx, 0.525, halfD - 0.75);
    box('darkPlastic', 0.1, 0.12, 0.44, gx, 1.1, halfD - 0.75);
  }

  // ---------------------------------------------------------------- wall art
  const posterSpots = planPosterSpots(layout);
  const posterIds = [...(curation.criticallyAcclaimed || []), ...(curation.staffPicks || [])];
  posterSpots.forEach((spot, i) => {
    const t = byId.get(posterIds[(i * 3 + 2) % Math.max(posterIds.length, 1)]);
    if (!t) return;
    const sc = spot.scale ?? 1;
    const art = new THREE.Mesh(
      new THREE.PlaneGeometry(0.82 * sc, 1.2 * sc),
      new THREE.MeshStandardMaterial({ map: T(makePoster(t, 300, 440)), roughness: 0.75 })
    );
    art.position.set(spot.x, spot.y ?? 1.85, spot.z);
    art.rotation.y = spot.rotY;
    art.userData.titleId = t.id;
    scene.add(art);
    raycastTargets.push(art);
    // frame — 1.28 * sc tall, which is the extent planPosterSpots() keeps under
    // CLERESTORY.underside. NOT FIXED (pre-existing, its own dimension): the
    // 0.03-thick frame is pushed 0.018 along -local z, which for the side walls
    // (rotY = ±π/2) maps to -x, so side-wall frames sit at |x| 12.973..13.003 —
    // 3mm through the x = 13 wall plane.
    const fr = new THREE.Mesh(new THREE.BoxGeometry(0.9 * sc, 1.28 * sc, 0.03), MATS.goldTrim);
    fr.position.copy(art.position);
    fr.rotation.copy(art.rotation);
    fr.translateZ(-0.018);
    scene.add(fr);
  });

  // TELEVISION lettering on the store's back wall, above the clerestory head.
  //
  // ONLY when the balcony actually reaches that wall. At 5.4 x 0.9 hung at
  // mezzY + 2.55 this spanned y 5.40..6.30 and x ±2.70 — straight across the
  // centre back-wall pane (head at 5.50), with the window's head casing
  // rendering in front of it, on a wall the balcony ends 40m short of in any
  // generated store. It is signage for the TV floor, so it belongs only where
  // the TV floor ends.
  //
  // Sized and raised to sit in the strip BETWEEN the head casing and the
  // ceiling: 3.6 x 0.50 at y 5.97 spans 5.72..6.22 — 0.07 above the casing top
  // (headY 5.50 + 0.075 + 0.075 = 5.65) and 0.08 under the 6.3 ceiling. It is a
  // tight strip; the casing also projects to -halfD + 0.28, standing 0.24m in
  // front of the sign at -halfD + 0.04, so it reads as recessed behind the
  // window trim rather than flush with it.
  if (WORLD.mezzBackZ <= -halfD + 0.5) {
    // ...and printed by the SAME programme as the other thirty-nine, at this
    // panel's own 3.6 x 0.50 aspect, rather than by the old generator on a
    // 560x220 canvas that would stretch the letters half again as wide.
    const tvFace = T(paintSign(
      { text: 'TELEVISION', sub: 'COMPLETE SERIES · ALL SEASONS' },
      { family: 'department', board: { w: 3.6, h: 0.50 } }
    ));
    const tvSign = new THREE.Mesh(
      new THREE.PlaneGeometry(3.6, 0.50),
      new THREE.MeshStandardMaterial({
        map: tvFace, roughness: 0.62, metalness: 0,
        emissive: new THREE.Color(0xffffff), emissiveMap: tvFace, emissiveIntensity: 0.10,
      })
    );
    tvSign.position.set(0, 5.97, -halfD + 0.04);
    scene.add(tvSign);
  }

  // ---------------------------------------------------------------- accent lighting
  // Real-time accents live here rather than in buildLighting() because they are
  // anchored to FURNITURE, and the furniture moves every time the projection
  // resizes the building. buildLighting() runs once at boot; the shell is
  // rebuilt on every restock, and main.js disposes and re-adds whatever these
  // two files put in the scene, so the pools travel with the fixtures they lie
  // on instead of staying behind at the old coordinates.
  const accents = placeAccentLights(scene, layout);

  // ---------------------------------------------------------------- flush merged buckets
  for (const [matKey, geos] of buckets) {
    const merged = mergeGeometries(geos, false);
    const mesh = new THREE.Mesh(merged, MATS[matKey]);
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
    raycastTargets.push(mesh);
  }

  return {
    raycastTargets, flickerPanel, floor,
    // measurable build report — QA reads this instead of eyeballing the ceiling
    fittings: { total: troffers.length, high: troffers.length - under.length, under: under.length },
    posters: posterSpots.length,
    accentLights: accents.length,
  };
}
