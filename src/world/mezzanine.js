// The TV mezzanine: slab with escalator well, perimeter railing, the moving
// up/down escalator pair, and the Binge Zone lounge. One continuous scene —
// you can always see the movie floor from up here.
import * as THREE from 'three';
import { mergeGeometries } from '../../vendor/BufferGeometryUtils.js';
import { WORLD, BRAND } from '../config.js';
import { escalatorProfile, escalatorLength } from './layout.js';
import {
  handrailPath, combTeeth, runSegments, makeContactShadow, makeBrushedMetal,
} from './escalator-parts.js';
import { makeCarpet, makeCeiling, makeFascia, makeStepTread, makeHandrailStripe, drawStatic, makeDeptHeader } from './textures.js';

const T = (canvas, opts = {}) => {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = opts.aniso ?? 4;
  if (opts.wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
};

/**
 * Closed profile with ROUNDED CORNERS, per-vertex radius.
 *
 * The escalator balustrades are one extruded side-elevation, and every corner of
 * it used to be a hard mitre — which is why the newels (the end pieces you stand
 * next to) read as flat cardboard wedges. A real newel is a nose: the balustrade
 * turns over in a tight arc and the handrail loops around it. Rounding the two
 * outer top corners hard and easing the rest gives that read from the same
 * eight points, with no new geometry to keep in sync.
 *
 * `pts` are [u, y] in profile space; `radii` is parallel to it.
 */
function roundedProfile(pts, radii) {
  const shape = new THREE.Shape();
  const n = pts.length;
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const at = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n], v = pts[i], q = pts[(i + 1) % n];
    // Never eat more than half of either neighbouring edge, or adjacent arcs
    // cross and the shape self-intersects.
    const r = Math.min(radii[i] ?? 0, dist(v, p) * 0.5, dist(v, q) * 0.5);
    at.push({
      v,
      from: r > 1e-4 ? lerp(v, p, r / dist(v, p)) : v,
      to: r > 1e-4 ? lerp(v, q, r / dist(v, q)) : v,
      r,
    });
  }
  shape.moveTo(at[0].to[0], at[0].to[1]);
  for (let i = 1; i <= n; i++) {
    const c = at[i % n];
    shape.lineTo(c.from[0], c.from[1]);
    if (c.r > 1e-4) shape.quadraticCurveTo(c.v[0], c.v[1], c.to[0], c.to[1]);
  }
  shape.closePath();
  return shape;
}

// Corner radii for the balustrade silhouette, indexed to its eight points:
// the two OUTER TOP corners are the newel noses and get the big arcs; the deck
// and incline breaks are eased; the underbelly meets floor and slab square.
const NEWEL_R = [0.12, 0.46, 0.34, 0.34, 0.46, 0.12, 0.05, 0.05];
// A shallow bevel on the extrusion catches the key light along every edge, so a
// 7cm plate stops looking like paper.
const CLAD_BEVEL = { bevelEnabled: true, bevelThickness: 0.014, bevelSize: 0.014, bevelSegments: 2 };
// balustrade panel thickness — the fillers have to know it to find the cladding
const SIDE_T = 0.07;

export function buildMezzanine(scene, layout) {
  // mezzBackZ, NOT -halfD: the balcony is sized by its own aisles and stops well
  // short of the back wall, leaving the deep end of the movie floor open to the
  // full ceiling height (see setMezzDepth).
  const { mezzY, slabT, mezzFrontZ, mezzBackZ, halfW } = WORLD;
  const halfD = -mezzBackZ;   // slab extent only — the shell is still WORLD.halfD
  const wells = layout.wells || [layout.well];
  const well = wells[0];
  const raycastTargets = [];
  const floorMeshes = [];
  const updaters = [];

  const MATS = {
    navy: new THREE.MeshStandardMaterial({ color: 0x1b2c66, roughness: 0.55 }),
    // escalator flanks sit side-on to the key light — a touch of self-glow keeps
    // them reading as navy panels instead of black voids
    // Self-glow was 1.2, which lit the flanks so evenly that the machine read
    // as one flat sheet of bright plastic from newel to newel. Now that a
    // brushed deck board caps the balustrade there is a real highlight to carry
    // the form, so the glow only has to stop the flanks going black.
    balustrade: new THREE.MeshStandardMaterial({ color: 0x2a3d85, roughness: 0.48, emissive: 0x1d2c6b, emissiveIntensity: 0.55 }),
    navyDark: new THREE.MeshStandardMaterial({ color: 0x101c44, roughness: 0.6 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x9aa1ac, roughness: 0.35, metalness: 0.7 }),
    darkMetal: new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.5, metalness: 0.4 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.42, metalness: 0.25 }),
    black: new THREE.MeshStandardMaterial({ color: 0x17181c, roughness: 0.6 }),
    glass: new THREE.MeshStandardMaterial({
      color: 0xbfd8ff, transparent: true, opacity: 0.18, roughness: 0.1,
      side: THREE.DoubleSide, depthWrite: false,
    }),
    burgundy: new THREE.MeshStandardMaterial({ color: 0x5e2430, roughness: 0.8 }),
    // brushed stainless capping — see escalator-parts.makeBrushedMetal
    deckBoard: new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.7 }),
    skirt: new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.38, metalness: 0.55 }),
  };
  MATS.deckBoard.map = T(makeBrushedMetal(), { wrap: true });
  MATS.deckBoard.map.repeat.set(14, 1);

  // One contact-shadow texture, shared by every bank.
  const shadowTex = T(makeContactShadow());
  const shadowMat = new THREE.MeshBasicMaterial({
    map: shadowTex, transparent: true, depthWrite: false, opacity: 0.9,
  });

  // ------------------------------------------------------------- slab
  // Three boxes around the escalator well; top = mezz carpet, bottom = tiles.
  const mezzBounds = { minX: -halfW, maxX: halfW, minZ: -halfD, maxZ: mezzFrontZ };
  const carpetCanvas = makeCarpet(mezzBounds, layout.obstacles[1], {
    seed: 77, base: '#2a2a5e', entrance: false,
    speckles: ['#353573', '#1e1e48', '#414189', '#312f6e', '#191938', '#6a3d8455'],
  });
  const tileTex = T(makeCeiling(halfW * 2, halfD - Math.abs(mezzFrontZ)));
  const fasciaTex = T(makeFascia(), { wrap: true });
  // fasciaTex itself is never bound to a material — only .clone()d — so it was
  // unreachable by main.js's disposeTree and leaked one canvas per shell build.
  // The clones differ ONLY in repeat.x, and there are a handful of distinct
  // values across 7 slab boxes, so 14 separate GPU uploads of one 717x45 image
  // become one per distinct repeat. The original is now one of them.
  const fasciaByRepeat = new Map();
  const fasciaFor = (repeatX) => {
    const key = Math.max(1, Math.round(repeatX));
    let t = fasciaByRepeat.get(key);
    if (!t) {
      t = fasciaByRepeat.size === 0 ? fasciaTex : fasciaTex.clone();
      t.repeat.set(key, 1);
      t.needsUpdate = true;
      fasciaByRepeat.set(key, t);
    }
    return t;
  };

  const cropCarpet = (minX, maxX, minZ, maxZ) => {
    const px = carpetCanvas.width / (mezzBounds.maxX - mezzBounds.minX);
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round((maxX - minX) * px));
    c.height = Math.max(2, Math.round((maxZ - minZ) * px));
    c.getContext('2d').drawImage(carpetCanvas,
      (minX - mezzBounds.minX) * px, (minZ - mezzBounds.minZ) * px,
      c.width, c.height, 0, 0, c.width, c.height);
    return T(c, { aniso: 8 });
  };

  // SLAB = the balcony rectangle MINUS every well, computed per x-band.
  //
  // This used to emit full-depth columns between wells plus one short strip
  // behind each, which is only correct while every well sits on the FRONT edge.
  // The rear bank's well sits on the BACK edge, and under the old scheme its
  // x-band was removed for the whole depth — a 2.9 m wide, 25.7 m long slot down
  // the middle of the balcony. Subtracting intervals per band is general: it
  // reproduces the old boxes exactly for front-edge wells and handles a well at
  // any z, which is what lets the rear machine have a real opening.
  const xs = [...new Set([-halfW, halfW, ...wells.flatMap(w => [w.minX, w.maxX])])]
    .filter(x => x >= -halfW && x <= halfW)
    .sort((a, b) => a - b);
  // `sorted` is the FRONT-edge wells only. The front railing, the well-wall
  // fillers and the deck trim below are all hung off mezzFrontZ and would draw
  // front-edge furniture around the rear opening if handed every well; the rear
  // bank has its own block further down. The SLAB above deliberately uses the
  // full `wells` set — that is the whole point of the rear opening.
  const sorted = [...wells]
    .filter(w => Math.abs(w.maxZ - mezzFrontZ) < 1e-6)
    .sort((a, b) => a.minX - b.minX);

  const slabBoxes = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[i], x1 = xs[i + 1];
    if (x1 - x0 <= 0.02) continue;
    const mid = (x0 + x1) / 2;
    const cuts = wells
      .filter(w => mid > w.minX && mid < w.maxX)
      .map(w => [Math.max(w.minZ, -halfD), Math.min(w.maxZ, mezzFrontZ)])
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
    let z = -halfD;
    for (const [a, b] of cuts) {
      if (a - z > 0.02) slabBoxes.push({ minX: x0, maxX: x1, minZ: z, maxZ: a });
      z = Math.max(z, b);
    }
    if (mezzFrontZ - z > 0.02) slabBoxes.push({ minX: x0, maxX: x1, minZ: z, maxZ: mezzFrontZ });
  }
  for (const b of slabBoxes) {
    const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
    const carpetMat = new THREE.MeshStandardMaterial({ map: cropCarpet(b.minX, b.maxX, b.minZ, b.maxZ), roughness: 0.95 });
    const fMat = new THREE.MeshStandardMaterial({ map: fasciaFor(w / 3.4), roughness: 0.5 });
    const ceilMat = new THREE.MeshStandardMaterial({
      map: tileTex, roughness: 0.9,
      emissive: 0xffffff, emissiveMap: tileTex, emissiveIntensity: 0.5,
    });
    const sideMat = new THREE.MeshStandardMaterial({ map: fasciaFor(d / 3.4), roughness: 0.5 });
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, slabT, d),
      [sideMat, sideMat, carpetMat, ceilMat, fMat, fMat]
    );
    mesh.position.set((b.minX + b.maxX) / 2, mezzY - slabT / 2, (b.minZ + b.maxZ) / 2);
    mesh.userData.walkable = true;
    mesh.userData.level = 1;
    scene.add(mesh);
    raycastTargets.push(mesh);
    floorMeshes.push(mesh);
  }

  // ------------------------------------------------------------- railing
  const postGeos = [];
  const railGeos = [];
  const panelGeos = [];
  const addRailRun = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(2, Math.round(len / 1.15) + 1);
    const ang = Math.atan2(x1 - x0, z1 - z0);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const g = new THREE.CylinderGeometry(0.026, 0.026, 1.04, 8);
      g.translate(x0 + (x1 - x0) * t, mezzY + 0.52, z0 + (z1 - z0) * t);
      postGeos.push(g);
    }
    const rail = new THREE.BoxGeometry(0.09, 0.06, len + 0.1);
    rail.rotateY(ang);
    rail.translate((x0 + x1) / 2, mezzY + 1.06, (z0 + z1) / 2);
    railGeos.push(rail);
    const mid = new THREE.BoxGeometry(0.04, 0.03, len);
    mid.rotateY(ang);
    mid.translate((x0 + x1) / 2, mezzY + 0.16, (z0 + z1) / 2);
    railGeos.push(mid);
    const panel = new THREE.PlaneGeometry(len, 0.78);
    panel.rotateY(ang + Math.PI / 2);
    panel.translate((x0 + x1) / 2, mezzY + 0.60, (z0 + z1) / 2);
    panelGeos.push(panel);
  };
  // Front edge, broken by each well, plus the returns down both sides of every
  // well opening — mirrors the collider runs in layout.buildColliders().
  const fz = mezzFrontZ - 0.06;
  const railEdges = [-halfW + 0.15, ...sorted.flatMap(w => [w.minX - 0.02, w.maxX + 0.02]), halfW - 0.15];
  for (let i = 0; i < railEdges.length; i += 2) {
    if (railEdges[i + 1] - railEdges[i] > 0.05) addRailRun(railEdges[i], fz, railEdges[i + 1], fz);
  }
  for (const w of sorted) {
    addRailRun(w.minX - 0.02, fz, w.minX - 0.02, w.minZ + 0.05);
    addRailRun(w.maxX + 0.02, fz, w.maxX + 0.02, w.minZ + 0.05);
  }
  // REAR BALCONY EDGE — the whole point of shortening the mezzanine. This run
  // is the promenade you walk to look down over the length of the movie floor,
  // so it gets the same posts/handrail/glass as the front and its own returns
  // into the side walls.
  // Only when the balcony actually ends in mid-air — a small store's mezzanine
  // still reaches the back wall, and railing against masonry is just clutter.
  if (mezzBackZ > -WORLD.halfD + 0.5) {
    const bz = mezzBackZ + 0.06;
    // Two runs, parted by the rear escalator's opening.
    const gap = layout.rearGap;
    const spans = gap
      ? [[-halfW + 0.15, gap.minX], [gap.maxX, halfW - 0.15]]
      : [[-halfW + 0.15, halfW - 0.15]];
    for (const [a, b] of spans) if (b - a > 0.05) addRailRun(a, bz, b, bz);
    addRailRun(-halfW + 0.15, bz, -halfW + 0.15, bz + 0.5);
    addRailRun(halfW - 0.15, bz, halfW - 0.15, bz + 0.5);
    // Returns down each side of the opening, so the edge is guarded right up to
    // the comb plate.
    if (gap) {
      addRailRun(gap.minX, bz, gap.minX, bz + 0.9);
      addRailRun(gap.maxX, bz, gap.maxX, bz + 0.9);
    }
  }
  const posts = new THREE.Mesh(mergeGeometries(postGeos), MATS.navyDark);
  const rails = new THREE.Mesh(mergeGeometries(railGeos), MATS.gold);
  const panels = new THREE.Mesh(mergeGeometries(panelGeos), MATS.glass);
  scene.add(posts, rails, panels);
  raycastTargets.push(posts, rails);

  // ------------------------------------------------------------- escalators
  const treadTex = T(makeStepTread());
  const railStripe = T(makeHandrailStripe(), { wrap: true });

  for (const esc of layout.escalators) {
    const total = escalatorLength(esc);
    // MAGNITUDES, not signed differences: the rear bank climbs toward +z, so its
    // raw inclineStart-inclineEnd is negative and would flip the incline angle.
    const run = Math.abs(esc.inclineStartZ - esc.inclineEndZ);
    const inclineLen = Math.hypot(run, esc.rise);
    const angle = Math.atan2(esc.rise, run);
    const down = esc.dir === 'down';

    // The side-elevation profiles below were drawn by hand in world z for the
    // FRONT banks (which board at z=1.9). Z() re-expresses them relative to this
    // escalator's own board pad and mirrors them when it climbs the other way,
    // so one hand-drawn machine serves every bank.
    const sgn = esc.zSign ?? 1;
    const Z = (z) => esc.boardZ + sgn * (z - 1.9);

    // --- side cladding: ONE closed architectural side-elevation profile —
    // boarding newel → deck → incline → top newel, over a solid underbelly
    // that sits on the floor at the bottom and meets the mezzanine slab at
    // the well edge. No floating truss, no box intersecting the floor.
    const deckH = 1.02;
    const profilePts = [
      [2.30, 0], [2.30, deckH], [1.10, deckH],
      [-4.90, esc.rise + deckH], [-6.10, esc.rise + deckH],
      [-6.10, esc.rise], [-5.35, esc.rise],
      [0.55, 0],
    ].map(([z, y]) => [Z(z), y]);
    // Mirroring reverses the polygon's winding, which would extrude the cladding
    // inside-out; walking the points backwards restores it.
    if (sgn < 0) profilePts.reverse();
    const makeCladding = (thickness) => {
      // Radii follow the points, so a reversed (mirrored) profile needs its radii
      // reversed with it or the big newel arcs land on the underbelly.
      const radii = sgn < 0 ? [...NEWEL_R].reverse() : NEWEL_R;
      const shape = roundedProfile(profilePts.map(([z, y]) => [-z, y]), radii);
      const g = new THREE.ExtrudeGeometry(shape, {
        depth: thickness - CLAD_BEVEL.bevelThickness * 2, curveSegments: 8, ...CLAD_BEVEL,
      });
      g.rotateY(Math.PI / 2); // extrusion depth now runs along world +x
      return g;
    };
    for (const side of [-1, 1]) {
      const panel = new THREE.Mesh(makeCladding(SIDE_T), MATS.balustrade);
      panel.position.x = esc.x + side * esc.width / 2 - (side < 0 ? SIDE_T : 0);
      scene.add(panel);
      raycastTargets.push(panel);
    }

    // --- deck board + moving handrail.
    //
    // The rail used to be eight hand-placed points whose return curves only
    // approximated the newel: [2.38, 0.92] sits 0.19 m outside the radius-0.46
    // fillet the cladding is actually built from, and the run terminated at
    // [2.02, 0.62] without re-entering the panel. Rendered, that is a bare
    // black hook projecting off the end of the machine and stopping in mid-air.
    // handrailPath() derives the return from the SAME corner points and radii
    // roundedProfile() fillets, so the rail wraps the newel it can see and
    // tucks inside it. The deck board is the brushed capping a real balustrade
    // carries under its handrail — the second tonal band that stops six metres
    // of side elevation reading as one sheet of painted blue.
    // wrap 132 deg puts the belt into the newel at ~0.21 m above the landing,
    // which is where a real one enters; sweeping further left a long open loop
    // standing proud of the cladding.
    const railPts = handrailPath(deckH, esc.rise, NEWEL_R, { off: 0.095, wrap: 132, tuck: 0.20 });
    const deckPts = handrailPath(deckH, esc.rise, NEWEL_R, { off: 0.010, wrap: 142, tuck: 0.12 });
    for (const side of [-1, 1]) {
      const hx = esc.x + side * (esc.width / 2 + SIDE_T / 2);
      const toCurve = (pts) => new THREE.CatmullRomCurve3(
        pts.map(([z, y]) => new THREE.Vector3(hx, y, Z(z))), false, 'catmullrom', 0.02);

      // Wider than the belt so the metal shows either side of it, and coarsely
      // tessellated: this is a 6 m band seen from 1-3 m, not a hero asset.
      const deck = new THREE.Mesh(
        new THREE.TubeGeometry(toCurve(deckPts), 84, 0.102, 6, false), MATS.deckBoard);
      scene.add(deck);
      raycastTargets.push(deck);

      const curve = toCurve(railPts);
      const hrMat = new THREE.MeshStandardMaterial({ map: railStripe.clone(), roughness: 0.5 });
      hrMat.map.repeat.set(Math.max(8, Math.round(curve.getLength() / 0.5)), 1);
      hrMat.map.needsUpdate = true;
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 96, 0.05, 8, false), hrMat);
      scene.add(tube);
      raycastTargets.push(tube);
      // Units check: repeat = length/0.5, so one UV unit is 0.5 m of rail and an
      // offset step of escSpeed*dt/0.5 advances the stripe exactly escSpeed*dt
      // metres — the belt and the steps stay in lockstep on every bank.
      updaters.push((dt) => {
        hrMat.map.offset.x += (down ? 1 : -1) * WORLD.escSpeed * dt / 0.5;
      });

      // Entry guards: a bare tube passing through a panel reads as clipping, so
      // collar the two points where the belt disappears into the newels.
      for (const seg of [railPts.slice(0, 2), railPts.slice(-2)]) {
        const g = new THREE.Mesh(
          new THREE.TubeGeometry(toCurve(seg), 4, 0.078, 6, false), MATS.black);
        scene.add(g);
      }
    }

    // --- comb/landing plates (safety yellow edge) + the teeth that mesh into
    // the tread grooves. A comb plate without teeth is just a flat tab beside a
    // grooved tread and the eye reads the join as a gap; the teeth are only
    // ever seen at the two moments a shopper is closest to the machine, which
    // is exactly why their absence was obvious.
    const toothGeos = [];
    for (const [cz, cy, low] of [
      [esc.lowCombZ + sgn * 0.1, 0.015, true],
      [esc.topCombZ - sgn * 0.1, esc.rise + 0.015, false],
    ]) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(esc.width - 0.1, 0.03, 0.5), MATS.metal);
      plate.position.set(esc.x, cy, cz);
      scene.add(plate);
      const edge = new THREE.Mesh(new THREE.BoxGeometry(esc.width - 0.1, 0.032, 0.06),
        new THREE.MeshStandardMaterial({ color: 0xe8c832, roughness: 0.5 }));
      edge.position.set(esc.x, cy + 0.002, cz + sgn * (cy > 1 ? 0.25 : -0.25));
      scene.add(edge);
      // Toward the step band: at the LOW comb the steps lie in the travel-up
      // direction (-sgn); at the TOP comb they lie back down the machine
      // (+sgn). Derived, so the rear bank's teeth point the right way too.
      const dir = (low ? -1 : 1) * sgn;
      for (const t of combTeeth(esc.width)) {
        const g = new THREE.BoxGeometry(t.w, 0.020, 0.075);
        g.translate(esc.x + t.x, cy - 0.007, cz + dir * 0.285);
        toothGeos.push(g);
      }
    }
    const teeth = new THREE.Mesh(mergeGeometries(toothGeos), MATS.metal);
    scene.add(teeth);

    // --- skirt panels: the dark band between the moving step band and the
    // fixed balustrade. The steps are 0.84 wide inside a 1.06 machine, so
    // without this there is a 0.11 m slot each side looking straight through to
    // the inside of the cladding — visible from the moment you step on.
    for (const side of [-1, 1]) {
      for (const r of runSegments(deckH, esc.rise, { yOff: 0.16 })) {
        const g = new THREE.BoxGeometry(0.085, 0.40, r.len);
        g.rotateX(r.rot * sgn);
        g.translate(esc.x + side * 0.475, r.y, Z(r.z));
        scene.add(new THREE.Mesh(g, MATS.skirt));
      }
    }

    // --- contact shadow. The newel sat on the carpet with no darkening at all,
    // which is what made a three-tonne machine look pasted onto the floor.
    {
      const zA = Z(2.6), zB = Z(-2.2);
      const sh = new THREE.Mesh(
        new THREE.PlaneGeometry(esc.width + 1.5, Math.abs(zA - zB)), shadowMat);
      sh.rotation.x = -Math.PI / 2;
      sh.position.set(esc.x, 0.013, (zA + zB) / 2);
      sh.renderOrder = 2;
      scene.add(sh);
    }

    // --- moving steps (instanced): grooved tread on top, dark metal body
    // THE STEP LOOP MUST TILE.
    //
    // nSteps was ceil(total/0.4)+2 = 24 boxes at a fixed 0.4 m pitch, which is
    // 9.60 m of step laid onto an 8.6337 m loop: 0.97 m wraps back over the
    // start, and measured across the whole ride that is FOUR pairs of
    // permanently interpenetrating steps riding every one of the six machines.
    // Solving for the pitch instead of assuming it divides the loop exactly —
    // 22 steps of 0.3924 m here — so the wrap is seamless by construction and
    // the tread stays within 8 mm of a real 0.40 m one.
    const nSteps = Math.max(4, Math.round(total / 0.4));
    const pitch = total / nSteps;
    // 0.4 m of step BODY hangs 0.41 m below its own tread, which is deeper than
    // the truss it rides inside: the boxes protruded through the cladding
    // underbelly as a visible staircase silhouette under the machine. 0.22 m
    // still covers the 0.196 m each step rises over the incline, so the risers
    // stay continuous, and nothing pokes out underneath.
    const stepGeo = new THREE.BoxGeometry(esc.stepW, 0.22, pitch + 0.006);
    const stepBody = new THREE.MeshStandardMaterial({ color: 0x33363d, roughness: 0.55, metalness: 0.35 });
    const stepMat = [stepBody, stepBody,
      new THREE.MeshStandardMaterial({ map: treadTex, roughness: 0.6, metalness: 0.2 }),
      stepBody, stepBody, stepBody];
    const steps = new THREE.InstancedMesh(stepGeo, stepMat, nSteps);
    steps.userData.escalator = esc.id;
    scene.add(steps);
    raycastTargets.push(steps);
    const m4 = new THREE.Matrix4();
    let phase = 0;
    const layStep = () => {
      for (let i = 0; i < nSteps; i++) {
        let s = (i * pitch + phase) % total;
        if (s < 0) s += total;
        const p = escalatorProfile(esc, s);
        m4.makeTranslation(p.x, p.y - 0.12, p.z);   // tread top stays at p.y - 0.01
        steps.setMatrixAt(i, m4);
      }
      steps.instanceMatrix.needsUpdate = true;
    };
    layStep();
    updaters.push((dt) => {
      phase += (down ? -1 : 1) * WORLD.escSpeed * dt;
      layStep();
    });
  }

  // --- bank cladding: solid fillers from the outer balustrades to the well
  // walls, so the escalator pair reads as ONE machine installed in the
  // building (no slit gaps into the void)
  {
    const rise = WORLD.mezzY, deckH = 1.02;
    const pts = [
      [2.30, 0], [2.30, deckH], [1.10, deckH],
      [-4.90, rise + deckH], [-6.10, rise + deckH],
      [-6.10, rise], [-5.35, rise],
      [0.55, 0],
    ];
    const filler = (x0, thickness, boardZ = 1.9, sgn = 1) => {
      // Same silhouette as the balustrade it abuts — a square filler against a
      // rounded newel would leave a visible step at the join — and mirrored for
      // a bank that climbs the other way, exactly as makeCladding does.
      const zpts = pts.map(([z, y]) => [-(boardZ + sgn * (z - 1.9)), y]);
      const radii = sgn < 0 ? [...NEWEL_R].reverse() : NEWEL_R;
      if (sgn < 0) zpts.reverse();
      const shape = roundedProfile(zpts, radii);
      const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, curveSegments: 8, bevelEnabled: false });
      g.rotateY(Math.PI / 2);
      const m = new THREE.Mesh(g, MATS.navyDark);
      m.position.x = x0;
      scene.add(m);
      raycastTargets.push(m);
    };
    // THE GAP IS NOT THE SAME ON BOTH SIDES, AND NOT THE SAME ON EVERY BANK.
    //
    // The opening runs 0.80 m past the UP track and 0.90 m past the DOWN track
    // (see wellFor), so the two fillers are 0.20 and 0.30 — but WHICH side gets
    // which depends on where the up deck sits. Transcribed as `filler(w.minX,
    // 0.20); filler(w.maxX - 0.30, 0.30)` that is right for the west bank and
    // reversed for the other two: measured, the east and rear banks were left
    // with a 0.10 m slit running the machine's whole 8.4 m silhouette straight
    // down into the void, while the over-wide filler at the other end swallowed
    // the outer balustrade panel and z-fought along its bevel. And `sorted` is
    // front-edge wells only, so the rear bank had no fillers at all.
    //
    // Measuring the gap off the machines that actually stand in the well makes
    // all three banks right without knowing which is which.
    for (const w of (layout.wells || sorted)) {
      const mine = layout.escalators.filter((e) => e.x > w.minX && e.x < w.maxX);
      if (!mine.length) continue;
      const cladMin = Math.min(...mine.map((e) => e.x - e.width / 2)) - SIDE_T;
      const cladMax = Math.max(...mine.map((e) => e.x + e.width / 2)) + SIDE_T;
      const bz = mine[0].boardZ, sg = mine[0].zSign ?? 1;
      if (cladMin - w.minX > 0.01) filler(w.minX, cladMin - w.minX, bz, sg);
      if (w.maxX - cladMax > 0.01) filler(cladMax, w.maxX - cladMax, bz, sg);
    }

    // gold deck line along the bank's outer faces — breaks up the cladding
    // mass exactly where a real escalator carries its stainless deck trim
    const rise2 = WORLD.mezzY;
    // Offsets are relative to the bank's own board pad and mirrored by its climb
    // direction, so the rear bank gets the same deck trim as the front ones.
    const stripe = (x, boardZ = 1.9, sgn = 1) => {
      const segs = [
        { rel: -0.20, cy: deckH - 0.09, len: 1.3, rot: 0 },
        { rel: -3.80, cy: deckH - 0.09 + rise2 / 2, len: Math.hypot(6.0, rise2), rot: Math.atan2(rise2, 6.0) },
        { rel: -7.40, cy: deckH - 0.09 + rise2, len: 1.3, rot: 0 },
      ];
      for (const s of segs) {
        const g = new THREE.BoxGeometry(0.015, 0.07, s.len);
        g.rotateX(s.rot * sgn); // the deck rises toward -z on a front bank, +z on the rear
        g.translate(x, s.cy, boardZ + sgn * s.rel);
        const m = new THREE.Mesh(g, MATS.gold);
        scene.add(m);
      }
    };
    // gold trim around each well opening on the slab surface
    const trim = (w, d, x, z) => {
      const t = new THREE.Mesh(new THREE.BoxGeometry(w, 0.015, d), MATS.gold);
      t.position.set(x, WORLD.mezzY + 0.008, z);
      scene.add(t);
    };
    for (const w of sorted) {
      stripe(w.minX - 0.005);
      stripe(w.maxX + 0.005);
      trim(0.06, w.maxZ - w.minZ, w.minX - 0.03, (w.minZ + w.maxZ) / 2);
      trim(0.06, w.maxZ - w.minZ, w.maxX + 0.03, (w.minZ + w.maxZ) / 2);
      trim(w.maxX - w.minX + 0.12, 0.06, (w.minX + w.maxX) / 2, w.minZ - 0.03);
    }

    // The REAR bank now has a real well like the front banks — it used to have
    // only a railing gap, which is why it climbed through solid slab. layout.rearGap
    // and its well are the SAME rectangle, so the stripes and threshold line below
    // still mark the edge you actually step over; they now also trim a genuine
    // opening rather than decorating a seam.
    const rear = layout.escalators.filter(e => e.edge === 'rear');
    const gap = layout.rearGap;
    if (rear.length && gap) {
      const b = rear[0];
      stripe(gap.minX - 0.005, b.boardZ, b.zSign);
      stripe(gap.maxX + 0.005, b.boardZ, b.zSign);
      // Derived from the gap, like the front wells above — the literal 2.4 was
      // transcribed against a 2.15 m opening, so the far cross-trim lay 25 cm
      // out on the slab and the side trims overran the corner.
      const gapLen = gap.maxZ - gap.minZ;
      trim(0.06, gapLen + 0.12, gap.minX - 0.03, (gap.minZ + gap.maxZ) / 2);
      trim(0.06, gapLen + 0.12, gap.maxX + 0.03, (gap.minZ + gap.maxZ) / 2);
      trim(gap.maxX - gap.minX + 0.12, 0.06, (gap.minX + gap.maxX) / 2, gap.maxZ + 0.03);
    }
  }

  // Direction arrows on the balustrade ends — one pair PER BANK, so each side
  // labels its own ride. Without this the east bank would be unmarked and you
  // could not tell which of its two tracks goes up.
  for (const e of layout.escalators) {
    const up = e.dir === 'up';
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(1.05, 0.2),
      new THREE.MeshBasicMaterial({
        map: T(makeDeptHeader(up ? '▲ TV & SERIES' : '▼ MOVIES', up ? 260 : 48)),
      })
    );
    // Up signs face the shopper approaching from the sales floor; down signs sit
    // at the mezzanine landing, facing back along the balcony.
    // Placed off each escalator's OWN comb plates and turned to face whoever is
    // walking toward it, so the rear bank (which climbs the other way) reads
    // right instead of showing its back.
    const s = e.zSign ?? 1;
    if (up) sign.position.set(e.x, 1.32, e.boardZ + s * 0.52);
    else sign.position.set(e.x, WORLD.mezzY + 1.32, e.exitZ - s * 0.43);
    if ((up && s < 0) || (!up && s > 0)) sign.rotation.y = Math.PI;
    scene.add(sign);
  }

  // ------------------------------------------------------------- Binge Zone
  const bz = layout.props.find(p => p.kind === 'bingezone');
  if (bz) {
    const g = new THREE.Group();
    g.position.set(bz.x, mezzY, bz.z);
    g.rotation.y = bz.rotY;
    // rug
    const rug = new THREE.Mesh(new THREE.CircleGeometry(1.25, 24),
      new THREE.MeshStandardMaterial({ color: 0x46285a, roughness: 0.95 }));
    rug.rotation.x = -Math.PI / 2; rug.position.y = 0.012;
    g.add(rug);
    // two armchairs
    for (const sx of [-0.75, 0.75]) {
      const ch = new THREE.Group();
      ch.position.set(sx, 0, 0.35);
      ch.rotation.y = -sx * 0.5 + Math.PI;
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.36, 0.6), MATS.burgundy);
      seat.position.y = 0.18; ch.add(seat);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.55, 0.16), MATS.burgundy);
      back.position.set(0, 0.55, 0.24); ch.add(back);
      for (const ax of [-0.28, 0.28]) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.24, 0.58), MATS.navyDark);
        arm.position.set(ax, 0.44, 0); ch.add(arm);
      }
      g.add(ch);
    }
    // CRT TV on a stand, playing static
    const stand = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.5, 0.5), MATS.navyDark);
    stand.position.set(0, 0.25, -0.55);
    g.add(stand);
    const crt = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.5, 0.52), MATS.black);
    crt.position.set(0, 0.76, -0.55);
    g.add(crt);
    const staticCanvas = document.createElement('canvas');
    staticCanvas.width = 72; staticCanvas.height = 54;
    drawStatic(staticCanvas);
    const staticTex = new THREE.CanvasTexture(staticCanvas);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.38),
      new THREE.MeshBasicMaterial({ map: staticTex }));
    screen.position.set(0, 0.78, -0.28);
    g.add(screen);
    let staticT = 0;
    updaters.push((dt) => {
      staticT += dt;
      if (staticT > 0.12) {
        staticT = 0;
        drawStatic(staticCanvas);
        staticTex.needsUpdate = true;
      }
    });
    // VHS stack on the stand
    for (let i = 0; i < 3; i++) {
      const tape = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.035, 0.12), i % 2 ? MATS.navy : MATS.black);
      tape.position.set(0.18, 0.52 + i * 0.037, -0.45);
      tape.rotation.y = 0.2 + i * 0.25;
      g.add(tape);
    }
    scene.add(g);
    raycastTargets.push(g);
  }

  return {
    raycastTargets, floorMeshes,
    update: (dt) => { for (const u of updaters) u(dt); },
  };
}
