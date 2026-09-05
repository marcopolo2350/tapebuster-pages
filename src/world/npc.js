// Sparse store customers + one employee. NPCs use the SAME navigation grids,
// colliders, and escalator profile as the player — they cannot walk through
// shelves, fall off the mezzanine, or teleport between floors.
//
// This file is the BODY: meshes, gait, collision, path following. The decisions
// live in npc-brain.js, which is free of THREE so the whole customer model can
// be simulated headlessly in the test suite. A customer is a thirteen-state
// machine — ENTER, WALK, SLOW, LOOK, APPROACH, BROWSE, HESITATE, REACH,
// INSPECT, TURN, WALK_AWAY, ESCALATOR_RIDE, EXIT — driven by per-person traits
// that are a pure function of that person's seed.
//
// Nothing in here is tied to the hand-authored store: the head-count comes from
// the nav grid's walkable area, and every spawn point, browse target, the door
// and the employee's own post are read off the CURRENT generated layout, so a
// 55 m nine-service building is populated to its back wall.
import * as THREE from 'three';
import { WORLD } from '../config.js';
import { findPathMulti, nearestOpen } from '../systems/pathfind.js';
import { resolveMove } from '../systems/collide.js';
import { escalatorProfile, escalatorLength, facingOf } from './layout.js';
import { Brain, scoreShelf, deptAffinity } from './npc-brain.js';

const NPC_RADIUS = 0.26;

// ---------------------------------------------------------------------------
// POPULATION DENSITY
//
// The building is generated to fit the catalogue, so it is 30.8 m deep for one
// service and 54.8 m deep for nine. A FIXED head-count leaves the big store
// feeling abandoned; a count proportional to the catalogue (or even to the
// footprint) turns a video shop into a crowd simulation. So customers scale
// with the WALKABLE floor the nav grid actually reports — shelving the annex
// adds *removes* walkable floor, so the measure already damps itself — and then
// a sub-linear exponent damps it again and a hard ceiling caps it.
//
// Measured across the generated stores: 813 m² walkable (Netflix) → 7,
// 990 m² (Netflix+Max+Hulu) → 8, 1,274 m² (all nine) → 10. The catalogue grows
// 5.9x and the crowd grows 1.4x. That is the intent.
// ---------------------------------------------------------------------------
const REF_WALKABLE = 800;        // m² — open floor in the smallest stores we generate
const REF_CUSTOMERS = 7;         // desktop head-count at that reference density
const REF_CUSTOMERS_MOBILE = 4;  // phones run fewer figures, same density curve
const DENSITY_EXP = 0.75;        // < 1 — twice the floor is nowhere near twice the people
const MIN_CUSTOMERS = 3;
const MAX_CUSTOMERS = 12;        // hard ceiling. This is a store, not a crowd.
const MAX_CUSTOMERS_MOBILE = 6;

const SPAWN_SNAP = 1.8;          // m — how far a spawn point may slide to find open floor

// Wedge recovery. The generated store has ~560 fixtures and therefore hundreds
// of gondola corners; a walker that drifts off its route line and ends up
// pinned diagonally on one gets exactly zero movement out of the axis-separated
// resolver. See NPC.unwedge.
//
// Turning is rate-limited so a customer pivots at a human speed instead of
// snapping to a new heading; walking speed is then gated by how much of that
// heading has been acquired (see step()).
const TURN_RATE = 3.2;           // rad/s — about a second for a full about-face
const ACCEL = 4.0;               // 1/s — speed easing toward the gated target
const STUCK_GRACE = 0.6;         // s of no progress before we intervene
const STUCK_STEP_FRAC = 0.25;    // "no progress" = less than a quarter of the intended step
const UNWEDGE_SNAP = 1.0;        // m — how far we may slide someone back onto legal floor

// Speed ceilings by state, as a fraction of that person's own walking pace.
// A shopper does not arrive at a shelf at full stride and stop dead.
const CAP = {
  WALK: 1.0,
  SLOW: 0.62,        // further scaled by how much of slowRadius is left
  APPROACH: 0.30,
  WALK_AWAY: 0.55,
  EXIT: 1.0,
  SHUFFLE: 0.28,     // the sidestep along a shelf face
};

// How far a "next bay along" hop may reach. People finish one bay and step to
// the next; they do not cross a video shop between every two titles.
const NEAR_HOP = 9.0;            // m
const SAME_SPOT = 1.2;           // m — closer than this and it is the bay they are already at

// PERSONAL SPACE. Two customers standing in the same place is the single most
// obviously-wrong thing a crowd can do, and it is what happens when everybody
// picks their destination in ignorance of everybody else — observed in the
// rendered store as two shoppers interpenetrating at the checkout queue. So a
// stand point is rejected if somebody is already there OR already on their way
// there, and anyone who ends up boxed in anyway steps aside.
const BODY_GAP = 0.44;           // m — centre separation at which two bodies touch
const PEER_PATIENCE = 4.0;       // s of being blocked by a person before treating it as a wedge
const BOARD_TURN_OK = 0.35;      // rad — close enough to the travel heading to step on
const BOARD_TURN_MAX = 1.6;      // s — hard cap on standing at the landing
const PERSONAL_SPACE = 0.85;     // m — nobody claims a spot this close to another
const CROWDED = 0.62;            // m — close enough that a planted customer shifts along

const YIELD_RANGE = 1.1;         // m — how far ahead another shopper registers
const YIELD_CONE = 0.72;         // cos — roughly ±44° of the walking direction

/** Open floor per level, in m², straight off the generated nav grid. */
export function walkableAreas(nav) {
  return nav.grids.map((g) => {
    let open = 0;
    for (let i = 0; i < g.blocked.length; i++) if (!g.blocked[i]) open++;
    return open * g.cell * g.cell;
  });
}

/** How many customers this building supports. Pure function of the nav grid. */
export function customerCount(nav, { mobile = false } = {}) {
  const area = walkableAreas(nav).reduce((a, b) => a + b, 0);
  const base = mobile ? REF_CUSTOMERS_MOBILE : REF_CUSTOMERS;
  const ceil = mobile ? MAX_CUSTOMERS_MOBILE : MAX_CUSTOMERS;
  const n = Math.round(base * Math.pow(Math.max(0, area) / REF_WALKABLE, DENSITY_EXP));
  return Math.max(Math.min(MIN_CUSTOMERS, ceil), Math.min(ceil, n));
}

// deterministic 0..1 — spawn placement must not depend on Math.random
function hash01(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

const wrapPi = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

/** Where a shopper stands to read a fixture's face, offset along its length. */
function standPoint(f, lateral = 0, gap = 0.75) {
  const dir = facingOf(f.rotY);
  return {
    x: f.x + dir.x * (f.depth / 2 + gap) + dir.z * lateral,
    z: f.z + dir.z * (f.depth / 2 + gap) - dir.x * lateral,
    level: f.level,
    face: { x: f.x, z: f.z },
    dept: f.dept || f.curated || f.section || null,
  };
}

/**
 * Every shelf in the CURRENT layout, per level, ordered front (+z, the doors)
 * → back. Core and annex fixtures are the same kind, so the annex aisles are in
 * here by construction; an even stride down this list reaches the back wall.
 */
function shelvesByLevel(layout) {
  const per = [[], []];
  for (const f of layout.fixtures) {
    if (f.kind === 'shelf' && per[f.level]) per[f.level].push(f);
  }
  for (const list of per) list.sort((a, b) => b.z - a.z || a.x - b.x);
  return per;
}

/**
 * The checkout, read off the generated props rather than transcribed — the
 * counter moves with the front wall, which travels ~12 m between a one-service
 * and a nine-service store.
 */
function checkoutOf(layout) {
  const counter = (layout.props || []).find((p) => p.kind === 'counter');
  if (!counter) return null;
  const dir = facingOf(counter.rotY);          // the side customers queue on
  const lat = { x: dir.z, z: -dir.x };         // along the counter's length
  const at = (along, out) => ({
    x: counter.x + lat.x * along + dir.x * out,
    z: counter.z + lat.z * along + dir.z * out,
  });
  return {
    counter,
    queue: at(-0.2, -1.1),                     // where a shopper waits to pay
    span: Math.max(0.4, counter.w - 1.0),
    staff: { ...at(-0.35, 1.15), yaw: counter.rotY + Math.PI },
    face: { x: counter.x, z: counter.z },
  };
}

/**
 * The doors, DERIVED — the midpoint of the entry gates, stepped one metre into
 * the shop so the point is on walkable floor rather than in the threshold. The
 * front wall moves with the catalogue, so this must never be transcribed; that
 * is the exact class of bug that put the TV signs 41 m past the balcony.
 */
function doorOf(layout, nav) {
  const gates = (layout.props || []).filter((p) => p.kind === 'gate');
  let x, z;
  if (gates.length) {
    x = gates.reduce((a, g) => a + g.x, 0) / gates.length;
    z = gates.reduce((a, g) => a + g.z, 0) / gates.length - 1.0;
  } else if (layout.spawn) {
    x = layout.spawn.x; z = layout.spawn.z;
  } else return null;
  const open = nav ? nearestOpen(nav.grids[0], x, z, 2.5) : null;
  const p = open || { x, z };
  return { x: p.x, z: p.z, level: 0, face: { x: p.x, z: p.z + 4 }, dept: 'exit' };
}

/**
 * Starting browse spots spread through the WHOLE building. Head-count is split
 * between floors by each floor's share of the walkable area, then placed at an
 * even stride down that floor's front-to-back shelf list, so people begin in
 * the annex aisles instead of piling up inside the doors.
 */
function spawnSpots(layout, nav, count) {
  const areas = walkableAreas(nav);
  const total = (areas[0] || 0) + (areas[1] || 0) || 1;
  const shelves = shelvesByLevel(layout);
  let up = shelves[1].length ? Math.max(1, Math.round((count * (areas[1] || 0)) / total)) : 0;
  up = Math.min(up, Math.max(0, count - (shelves[0].length ? 1 : 0)));
  const want = [count - up, up];

  const spots = [];
  for (const level of [0, 1]) {
    const fs = shelves[level];
    const n = Math.min(want[level], fs.length);
    for (let i = 0; i < n; i++) {
      const k = Math.floor(((i + 0.5) / n) * fs.length);
      for (let a = 0; a < fs.length; a++) {
        const f = fs[(k + a) % fs.length];
        const seed = level * 131 + i * 17 + a;
        const p = standPoint(f, (hash01(seed) - 0.5) * Math.max(0.3, f.w - 0.6));
        const open = nearestOpen(nav.grids[level], p.x, p.z, SPAWN_SNAP);
        if (open) { spots.push({ x: open.x, z: open.z, level, face: p.face }); break; }
      }
    }
  }
  return spots;
}

function disposeFigure(group) {
  group.traverse?.((o) => {
    o.geometry?.dispose?.();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { m.map?.dispose?.(); m.dispose?.(); }
    }
  });
}

// INDEPENDENT WARDROBE CHANNELS.
//
// This was seven fixed TUPLES handed out as `PALETTES[i % 7]`. With a dozen
// shoppers that guarantees visible twins — same shirt, same trousers, same
// hair, same skin, walking the same store. Mixing the channels separately turns
// 7 outfits into 8x7x6x6 = 2,016 combinations from the same art budget, and the
// index for each channel is now an avalanche hash of the person's seed rather
// than a stride over i, so no two channels come back into phase.
const SHIRTS = [0x8a4b3c, 0x3d6b52, 0x5b5f8f, 0x9f8a4f, 0x7a3a4a, 0x46707e, 0x6b4f7a, 0x2f4858];
const PANTS  = [0x2e3440, 0x1f2733, 0x3a2f28, 0x2c3a4a, 0x30343c, 0x262a32, 0x203028];
const HAIRS  = [0x2a1c12, 0x101010, 0x5a4632, 0x7a2e1c, 0xd8c090, 0x3c3c44];
const SKINS  = [0xd9a878, 0x8a5a3a, 0xe8c090, 0xc98f66, 0xefd0a8, 0xb0805a];

/** A deterministic but well-mixed wardrobe, keyed off hashed trait channels. */
export function wardrobeFor(traits) {
  return {
    shirt: SHIRTS[traits.shirtIdx % SHIRTS.length],
    pants: PANTS[traits.pantsIdx % PANTS.length],
    hair: HAIRS[traits.hairIdx % HAIRS.length],
    skin: SKINS[traits.skinIdx % SKINS.length],
  };
}

const EMPLOYEE_PALETTE = { shirt: 0x46707e, pants: 0x262a32, hair: 0x3c3c44, skin: 0xb0805a };

// simple painted face so heads read as people, not mannequins
function faceTexture(skinHex) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#' + skinHex.toString(16).padStart(6, '0');
  ctx.fillRect(0, 0, 128, 64);
  // the face lives on one quarter of the sphere wrap (front)
  const fx = 64;
  ctx.fillStyle = 'rgba(30,20,15,0.9)';
  ctx.beginPath(); ctx.ellipse(fx - 9, 27, 2.6, 3.6, 0, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.ellipse(fx + 9, 27, 2.6, 3.6, 0, 0, 7); ctx.fill();
  ctx.strokeStyle = 'rgba(30,20,15,0.65)'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(fx - 13, 21); ctx.lineTo(fx - 5, 20); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(fx + 5, 20); ctx.lineTo(fx + 13, 21); ctx.stroke();
  ctx.strokeStyle = 'rgba(120,50,45,0.8)'; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.arc(fx, 40, 5, 0.25 * Math.PI, 0.75 * Math.PI); ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const HEAD_Y = 1.21;

function buildFigure(palette, { vest = false, cap = false, heightScale = 1, style = 0 } = {}) {
  const g = new THREE.Group();
  const mat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 });
  const skin = mat(palette.skin), shirt = mat(palette.shirt), pants = mat(palette.pants);
  const hairMat = mat(palette.hair);

  // legs with shoes. Toes point along the rig's forward, which is -z.
  const legL = new THREE.Group();
  const thighL = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.46, 0.11), pants);
  thighL.position.y = -0.23;
  const shoeL = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.06, 0.17), mat(0x22201e));
  shoeL.position.set(0, -0.475, -0.03);
  legL.add(thighL, shoeL);
  legL.position.set(-0.075, 0.5, 0);
  const legR = legL.clone(); legR.position.x = 0.075;
  g.add(legL, legR);

  // hips + tapered torso + shoulders
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.14, 0.15), pants);
  hips.position.y = 0.55;
  g.add(hips);
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.115, 0.44, 10), shirt);
  torso.scale.z = 0.62;
  torso.position.y = 0.83;
  g.add(torso);
  // clothing variants: 1 = open jacket, 2 = hoodie. Both sit on the FRONT of
  // the body (-z) and the hood behind the neck (+z) — they were mirrored.
  if (style % 3 === 1) {
    const jm = mat((palette.pants + 0x1a1a1a) & 0xffffff);
    for (const sx of [-1, 1]) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.4, 0.05), jm);
      panel.position.set(sx * 0.105, 0.83, -0.075);
      g.add(panel);
    }
  } else if (style % 3 === 2) {
    const hood = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), shirt);
    hood.scale.set(1.3, 0.7, 0.8);
    hood.position.set(0, 1.06, 0.1);
    g.add(hood);
  }
  if (vest) {
    const v = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.32, 0.2),
      new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.6 }));
    v.position.y = 0.86;
    g.add(v);
  }

  // arms with hands
  const armL = new THREE.Group();
  const sleeveL = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.34, 0.08), shirt);
  sleeveL.position.y = -0.14;
  const handL = new THREE.Mesh(new THREE.SphereGeometry(0.036, 8, 6), skin);
  handL.position.y = -0.34;
  armL.add(sleeveL, handL);
  armL.position.set(-0.20, 1.02, 0);
  const armR = armL.clone(); armR.position.x = 0.20;
  g.add(armL, armR);

  // neck, then EVERYTHING ABOVE IT ON ITS OWN PIVOT.
  //
  // The head used to be a bare mesh whose rotation.y carried the sphere's UV
  // offset (PI/2, so the painted face points down the group's forward -z). The
  // idle animation then ASSIGNED rotation.y directly, wiping that offset out —
  // so the moment a customer stopped walking, their face swung round to the
  // side of their head. A pivot keeps the two concerns apart, and lets the head
  // yaw and pitch (reading along a shelf, looking down at a case) without
  // touching the mesh's UV alignment. YXZ order = turn, then nod.
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.07, 8), skin);
  neck.position.y = 1.095;
  g.add(neck);
  const headPivot = new THREE.Group();
  headPivot.position.y = HEAD_Y;
  headPivot.rotation.order = 'YXZ';
  g.add(headPivot);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.105, 14, 12),
    new THREE.MeshStandardMaterial({ map: faceTexture(palette.skin), roughness: 0.8 }));
  head.rotation.y = Math.PI / 2; // sphere UV center → the group's forward (-z)
  headPivot.add(head);

  // hair variants: 0 short crop · 1 longer w/ back fall · 2 bun · 3 under cap.
  // All parented to the pivot so the hair turns with the head.
  const hairStyle = cap ? 3 : style % 3 === 2 ? 0 : (style % 4);
  if (hairStyle !== 3) {
    const crop = new THREE.Mesh(new THREE.SphereGeometry(0.109, 12, 8), hairMat);
    crop.scale.set(1, 0.7, 1);
    crop.position.set(0, 0.045, 0.015);
    headPivot.add(crop);
    if (hairStyle === 1) {
      const fall = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 0.06), hairMat);
      fall.position.set(0, -0.09, 0.085);
      headPivot.add(fall);
    } else if (hairStyle === 2) {
      const bun = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), hairMat);
      bun.position.set(0, 0.07, 0.1);
      headPivot.add(bun);
    }
  } else {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.065, 12), mat(0x16265c));
    c.position.y = 0.09;
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.02, 0.11), mat(0x16265c));
    brim.position.set(0, 0.065, -0.13);
    headPivot.add(c, brim);
  }

  // a rental case they can hold — IN FRONT of them (forward is -z), which is
  // where a hand actually is. It was at +0.15, i.e. behind the body.
  const held = new THREE.Mesh(new THREE.BoxGeometry(WORLD.caseW, WORLD.caseH, WORLD.caseD), mat(0x1b2c66));
  held.position.set(0.15, 0.70, -0.10);
  held.rotation.x = 0.35;
  held.visible = false;
  g.add(held);

  g.scale.setScalar(heightScale);
  return { group: g, legL, legR, armL, armR, torso, headPivot, head, held };
}

class NPC {
  constructor(scene, layout, nav, plan, spot, index) {
    this.layout = layout;
    this.nav = nav;
    this.plan = plan;                 // { shelves: [[],[]], checkout, door } — live layout
    this.index = index;

    // IDENTITY IS SEEDED. Everything below — pace, patience, taste, wardrobe,
    // height — is a pure function of `index`, so the same store rebuilds the
    // same crowd and a test can assert who somebody is. The previous pass drew
    // all of it from Math.random() in this constructor, which is varied but not
    // reproducible and not assertable.
    this.brain = new Brain(index);
    const T = this.traits = this.brain.traits;

    const fig = buildFigure(wardrobeFor(T), { heightScale: T.height, style: T.style });
    Object.assign(this, fig);

    this.x = spot.x; this.z = spot.z; this.level = spot.level;
    this.yaw = T.yaw0;
    this.vel = 0;
    this.phase = T.phase;
    this.idleT = T.phase;
    this.walking = false;

    this.segments = null; this.walkPoints = null; this.pathIdx = 1;
    this.ride = null;
    this.stuckT = 0; this.skipped = false; this.peerWaitT = 0;
    this.faceAt = spot.face || null;
    this.destDept = null;
    this.destX = null; this.destZ = null; this.destLevel = 0;
    this.micro = null;                // lateral sidestep target while browsing
    this.shuffleT = 1 + this.brain.rng() * 2;
    this.leaving = false;
    this.unwedges = 0;                // recoveries, so QA can tell a nudge from a teleport

    // eased pose channels — nothing about the body ever snaps
    this.headYaw = 0; this.headWant = 0;
    this.headPitch = 0; this.headPitchWant = 0;
    this.reach = 0; this.reachWant = 0;
    this.carry = 0; this.carryWant = 0;
    this.read = 0; this.readWant = 0;
    this.lean = 0; this.leanWant = 0;

    scene.add(this.group);
    this.apply(0);
  }

  get state() { return this.brain.state; }

  levelY() { return this.level ? WORLD.mezzY : 0; }

  // -------------------------------------------------------------------------
  // TARGET SELECTION
  // -------------------------------------------------------------------------

  /**
   * Propose one candidate destination from the CURRENT layout.
   *
   * The old rule picked a shelf uniformly (with a local-radius bias), which is
   * "randomly traversing the store" — the brief rules that out as the primary
   * behaviour. Now every candidate is scored by this person's DEPARTMENT
   * AFFINITY, damped by distance according to their own localBias. Two or three
   * aisles score highly for any given customer, so they have a reason to be
   * where they are, and two customers with different tastes shop different
   * halves of the building.
   */
  proposeTarget(attempt) {
    const b = this.brain, T = this.traits, rng = b.rng;
    let level = this.level;
    if (this.plan.shelves[1 - level]?.length && rng() < T.crossFloorP) level = 1 - level;

    const co = this.plan.checkout;
    if (level === 0 && co && rng() < T.checkoutP) {
      const lat = (rng() - 0.5) * co.span;
      const dir = facingOf(co.counter.rotY);
      return {
        x: co.queue.x + dir.z * lat, z: co.queue.z - dir.x * lat,
        level: 0, face: co.face, dept: 'checkout',
      };
    }

    const shelves = this.plan.shelves[level];
    if (!shelves || !shelves.length) return null;

    // WORK ALONG THE AISLE FIRST.
    //
    // Measured before this existed: the crowd spent 59% of its life in WALK and
    // 14% browsing, because every destination was drawn from the whole
    // building and the building is 55 m deep. Real customers finish one bay and
    // step to the next, and only occasionally cross the shop. So most retargets
    // are a short hop to a NEARBY fixture, chosen among the near ones by the
    // same department affinity — which is how you get somebody working their
    // way along Horror rather than commuting between Horror and Anime.
    if (attempt === 0 && level === this.level && rng() < 0.45 + T.localBias * 0.42) {
      let near = null, nearS = -1;
      for (const f of shelves) {
        const d = Math.hypot(f.x - this.x, f.z - this.z);
        if (d < SAME_SPOT || d > NEAR_HOP) continue;
        const s = deptAffinity(T.seed, f.dept || f.curated || f.section)
          * (1 - d / NEAR_HOP) * (0.5 + rng());
        if (s > nearS) { nearS = s; near = f; }
      }
      if (near) return standPoint(near, (rng() - 0.5) * Math.max(0.3, near.w - 0.6), T.approachGap);
    }

    // Otherwise a trip across the shop. Sample a handful and keep the best-scoring. Cheap — no allocation and no
    // sort over 468 fixtures — and it still expresses the preference. Later
    // attempts widen to a flat draw so an awkward corner of the store can never
    // park somebody permanently.
    let best = null;
    if (attempt < 2) {
      let bestS = -1;
      for (let k = 0; k < 10; k++) {
        const f = shelves[(rng() * shelves.length) | 0];
        const s = scoreShelf(T, f, this.x, this.z, level === this.level, rng());
        if (s > bestS) { bestS = s; best = f; }
      }
    } else {
      best = shelves[(rng() * shelves.length) | 0];
    }
    if (!best) return null;
    // Standing distance is a per-person trait: some people read a shelf from
    // arm's length, some hover over it.
    return standPoint(best, (rng() - 0.5) * Math.max(0.3, best.w - 0.6), T.approachGap);
  }

  /**
   * Choose the next place to exist. Retries, because in a deep store a given
   * shelf face can be unreachable and one failed draw should not park a
   * customer for another three seconds.
   *
   * `budget` caps how many A* searches the WHOLE crowd may run this frame. The
   * grid is ~16,000 cells per level in a nine-service store, so an unbounded
   * retry loop can stack a dozen searches onto one frame — measured as a 31 ms
   * hitch. Deferring to the next frame costs nobody anything: these people are
   * standing at a shelf either way. Returns true / 'defer' / false.
   */
  pickTarget(budget) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const target = this.proposeTarget(attempt);
      if (!target) continue;
      const got = this.routeTo(target, budget);
      if (got) return got;
    }
    return false;
  }

  /**
   * Is somebody already standing at (x,z), or already walking there? Checked
   * BEFORE any A* is spent, so crowding costs nothing.
   */
  taken(x, z, level) {
    const crowd = this.plan.crowd;
    if (!crowd) return false;
    for (const o of crowd) {
      if (o === this) continue;
      if (o.level === level && Math.hypot(o.x - x, o.z - z) < PERSONAL_SPACE) return true;
      if (o.destLevel === level && o.destX != null
        && Math.hypot(o.destX - x, o.destZ - z) < PERSONAL_SPACE) return true;
    }
    return false;
  }

  /** Plan a route to one specific destination. Same budget rules as above. */
  routeTo(target, budget) {
    // cheap rejection first — never spend budget on an unreachable spot
    const open = nearestOpen(this.nav.grids[target.level], target.x, target.z, 1.6);
    if (!open) return false;
    // ...nor on a spot somebody else has already claimed. The doors are the one
    // place everyone shares, so leaving is never blocked by a queue.
    if (target.dept !== 'exit' && this.taken(open.x, open.z, target.level)) return false;
    if (budget.left <= 0) return 'defer';
    budget.left--;
    const segs = findPathMulti(this.nav,
      { x: this.x, z: this.z, level: this.level },
      { x: open.x, z: open.z, level: target.level });
    if (!segs) return false;
    this.segments = segs;
    this.faceAt = target.face || null;
    this.destDept = target.dept ?? null;
    this.destX = open.x; this.destZ = open.z; this.destLevel = target.level;
    this.nextSegment();
    return true;
  }

  /** Route to the doors. Used when a customer has seen enough for one visit. */
  routeToDoor(budget) {
    const d = this.plan.door;
    if (!d) return false;
    return this.routeTo(d, budget);
  }

  // -------------------------------------------------------------------------
  // PATH PLUMBING
  // -------------------------------------------------------------------------

  nextSegment() {
    this.walkPoints = null;
    this.stuckT = 0; this.skipped = false;
    if (!this.segments || this.segments.length === 0) {
      this.segments = null;
      return 'done';
    }
    const seg = this.segments.shift();
    if (seg.type === 'walk') {
      this.walkPoints = seg.points;
      this.pathIdx = 1;
      return 'walk';
    }
    const esc = seg.link.escalator;
    const total = escalatorLength(esc);
    const up = seg.link.toLevel > seg.link.fromLevel;
    this.ride = { esc, link: seg.link, s: up ? 0 : total, dir: up ? 1 : -1, total };
    return 'ride';
  }

  /** Distance left on the current leg, through its remaining waypoints. */
  remaining() {
    const pts = this.walkPoints;
    if (!pts) return 0;
    const i0 = Math.min(this.pathIdx, pts.length - 1);
    let d = Math.hypot(pts[i0].x - this.x, pts[i0].z - this.z);
    for (let i = i0; i < pts.length - 1; i++) {
      d += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    }
    return d;
  }

  /** True when this is the final leg — nothing queued behind it. */
  onLastLeg() { return !this.segments || this.segments.length === 0; }

  /**
   * Free a walker that has stopped making progress.
   *
   * Routing and collision are deliberately separate systems: the grid plans
   * with 0.36 m of clearance, the colliders are authoritative for where a body
   * may actually be. A walker heading for a waypoint from slightly off the
   * route line can therefore graze a gondola corner, where the axis-separated
   * resolver returns *exactly* zero movement. Measured before this existed: a
   * customer pinned on the corner of SF-10 for 217 s of a 300 s run, legs still
   * animating.
   *
   * Two escalating nudges, cheapest first:
   *   1. give up on the waypoint we are grazing past and aim at the next one —
   *      no teleport, usually enough;
   *   2. still pinned: slide to the nearest cell the grid calls open (tens of
   *      centimetres — the ring search always finds the near side first, so
   *      this cannot hop a fixture) and pivot onto a fresh destination.
   *
   * Recovery lands in TURN, never mid-stride: the person visibly stops, turns,
   * and sets off again.
   */
  unwedge() {
    this.stuckT = 0; this.peerWaitT = 0;
    const pts = this.walkPoints;
    if (pts && !this.skipped && this.pathIdx < pts.length - 1) {
      this.skipped = true;
      this.pathIdx++;
      return;
    }
    this.skipped = false;
    this.unwedges++;
    const open = nearestOpen(this.nav.grids[this.level], this.x, this.z, UNWEDGE_SNAP);
    if (open) { this.x = open.x; this.z = open.z; }
    this.segments = null;
    this.walkPoints = null;
    this.micro = null;
    this.vel = 0;
    this.walking = false;
    this.brain.go('TURN', 0.25 + this.brain.rng() * 0.4);
  }

  // -------------------------------------------------------------------------
  // LOCOMOTION
  // -------------------------------------------------------------------------

  /**
   * One frame of forward-only locomotion toward (tx,tz).
   *
   * TURN FIRST, THEN WALK — and walk along the way we are FACING. An earlier
   * version translated instantly along the desired direction while yaw lerped
   * toward it separately; on any sharp change of heading the body kept its old
   * facing for a few tenths of a second while the position moved the other way,
   * which is precisely the "customers walking backwards" defect. Deriving the
   * step from `yaw` makes velocity direction and facing direction the SAME
   * vector by construction, so backward locomotion is not merely unlikely, it
   * is unrepresentable. EVERY translation in this file — including the browsing
   * sidestep — goes through here, which is why there is no sliding either.
   */
  step(dt, tx, tz, cap) {
    const T = this.traits;
    const dx = tx - this.x, dz = tz - this.z;
    const targetYaw = Math.atan2(-dx, -dz);
    const dyaw = wrapPi(targetYaw - this.yaw);
    const turn = Math.sign(dyaw) * Math.min(Math.abs(dyaw), T.turnRate * dt);
    this.yaw += turn;
    // Head leads the turn slightly — people look where they are about to go.
    this.headWant = Math.max(-0.5, Math.min(0.5, wrapPi(targetYaw - this.yaw) * 0.6));

    // How much of the desired heading we have actually acquired. cos() falls to
    // zero at 90° off, so a customer rounding an endcap slows into the turn and
    // accelerates out of it the way a person does, and one who has to double
    // back pivots on the spot instead of moonwalking.
    const align = Math.max(0, Math.cos(wrapPi(targetYaw - this.yaw)));

    // Ease speed rather than snapping to it — a real shopper does not go from
    // standing to walking pace in one frame.
    const want = T.speed * cap * align;
    this.vel += (want - this.vel) * Math.min(1, ACCEL * dt);
    const s = this.vel * dt;

    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const fromX = this.x, fromZ = this.z;
    const res = resolveMove(this.nav.colliders[this.level], this.x, this.z,
      fx * s, fz * s, NPC_RADIUS);

    // PEOPLE ARE SOLID TO EACH OTHER TOO.
    //
    // The colliders describe the building, not the crowd, so two customers on
    // crossing routes walked straight through one another — measured at 0.015 m
    // centre separation in a 300 s run, and seen in the rendered store as two
    // shoppers interpenetrating at the checkout. Rather than adding a dozen
    // boxes to the collider list every frame, the step is simply SHORTENED
    // until it no longer lands on somebody. Shortening can only ever reduce
    // travel along the facing, so the forward-only invariant is untouched — and
    // because the yield rule is asymmetric, the other one keeps walking and the
    // pair unpicks itself instead of standing nose to nose.
    if (!this.peerBlocked(fromX, fromZ) && this.peerBlocked(res.x, res.z)) {
      let px = fromX, pz = fromZ;
      for (const k of [0.5, 0.25]) {
        const tx = fromX + (res.x - fromX) * k, tz = fromZ + (res.z - fromZ) * k;
        if (!this.peerBlocked(tx, tz)) { px = tx; pz = tz; break; }
      }
      this.x = px; this.z = pz;
    } else {
      this.x = res.x; this.z = res.z;
    }
    this.walking = this.vel > 0.05;

    // Progress watchdog — see unwedge(). Sliding along a shelf still counts as
    // progress; being pinned on a corner does not. Turning on the spot is NOT
    // being stuck, so this only runs once we are committed to walking —
    // otherwise every about-face would trip it.
    let stuck = false;
    if (align > 0.5 && s > 1e-4) {
      if (Math.hypot(this.x - fromX, this.z - fromZ) < s * STUCK_STEP_FRAC) {
        this.stuckT += dt;
        if (this.stuckT > STUCK_GRACE) {
          // A PERSON IN THE WAY IS NOT A WEDGE. Sliding out from behind someone
          // who is simply walking across your route is a visible pop for no
          // reason — wait for them instead, and only fall back to the recovery
          // slide if the blockage outlasts any plausible passer-by.
          if (this.peerBlocked(fromX + fx * BODY_GAP, fromZ + fz * BODY_GAP)
            && this.peerWaitT < PEER_PATIENCE) {
            this.peerWaitT += this.stuckT;
            this.stuckT = 0;
          } else stuck = true;
        }
      } else { this.stuckT = 0; this.skipped = false; this.peerWaitT = 0; }
    }
    return { align, stuck, dist: Math.hypot(tx - this.x, tz - this.z) };
  }

  /**
   * Would standing at (x,z) put this person inside another customer? Riders are
   * exempt: they are on the machine, in its own lane.
   */
  peerBlocked(x, z) {
    const crowd = this.plan.crowd;
    if (!crowd) return false;
    for (const o of crowd) {
      if (o === this || o.level !== this.level || o.ride) continue;
      const dx = o.x - x, dz = o.z - z;
      if (dx * dx + dz * dz < BODY_GAP * BODY_GAP) return true;
    }
    return false;
  }

  /** Rotate toward a point without translating at all. */
  faceToward(px, pz, dt, rate = 1) {
    const targetYaw = Math.atan2(-(px - this.x), -(pz - this.z));
    const dyaw = wrapPi(targetYaw - this.yaw);
    this.yaw += Math.sign(dyaw) * Math.min(Math.abs(dyaw), this.traits.turnRate * rate * dt);
    return Math.abs(wrapPi(targetYaw - this.yaw));
  }

  /**
   * How much of their pace this customer gives up for whoever is in the way.
   *
   * The player gets a full stop at close range (they are the one thing in the
   * store that can back a shopper into a corner). Other shoppers get a slow-
   * down, and only in one direction: the HIGHER-indexed of any pair yields. An
   * asymmetric rule cannot deadlock — the person with priority keeps walking,
   * the crossing clears itself, and neither of them stands still waiting for
   * the other to move first.
   */
  yieldFactor(player, peers) {
    if (player && player.level === this.level
      && Math.hypot(player.x - this.x, player.z - this.z) < 0.75) return 0;
    if (!peers) return 1;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    let f = 1;
    for (const o of peers) {
      if (o === this || o.level !== this.level || o.index > this.index) continue;
      const dx = o.x - this.x, dz = o.z - this.z;
      const d = Math.hypot(dx, dz);
      if (d > YIELD_RANGE || d < 1e-4) continue;
      if ((dx / d) * fx + (dz / d) * fz < YIELD_CONE) continue;
      f = Math.min(f, 0.15 + 0.7 * (d / YIELD_RANGE));
    }
    return f;
  }

  // -------------------------------------------------------------------------
  // THE STATE MACHINE
  // -------------------------------------------------------------------------

  update(dt, player, budget = { left: 1 }, peers = null) {
    const b = this.brain;
    this.idleT += dt;
    // Stride cadence follows the speed ACTUALLY achieved this frame, not the
    // NPC's nominal top speed. With a fixed cadence a customer easing into a
    // turn keeps striding at full rate while barely translating, which reads as
    // skating; tying it to this.vel keeps the feet and the floor agreeing.
    this.phase += dt * Math.max(0.2, this.vel) * this.traits.cadence;

    if (b.state === 'ESCALATOR_RIDE') { this.rideStep(dt); this.easePose(dt); this.apply(dt); return; }
    this.groupY = this.levelY();

    switch (b.state) {
      case 'ENTER': this.sEnter(dt, budget); break;
      case 'TURN': this.sTurn(dt, budget); break;
      case 'WALK': case 'SLOW': case 'APPROACH': case 'WALK_AWAY': case 'EXIT':
        this.sTravel(dt, player, budget, peers); break;
      case 'LOOK': this.sLook(dt); break;
      case 'BROWSE': this.sBrowse(dt, player); break;
      case 'HESITATE': this.sHesitate(dt); break;
      case 'REACH': this.sReach(dt); break;
      case 'INSPECT': this.sInspect(dt); break;
      default: b.go('WALK');
    }
    this.easePose(dt);
    this.apply(dt);
  }

  /** Standing just inside the doors, taking the shop in, before setting off. */
  sEnter(dt, budget) {
    const b = this.brain;
    this.decelerate(dt);
    this.headWant = Math.sin(this.idleT * 0.55) * this.traits.headSweep * 1.3;
    if (!b.tick(dt)) return;
    const got = this.pickTarget(budget);
    if (got === true) b.go(this.needsPivot() ? 'TURN' : 'WALK', 0.5);
    else b.t = got === 'defer' ? 0.05 : 0.5 + b.rng();
  }

  /** True when setting off means turning more than a quarter-circle first. */
  needsPivot() {
    const pts = this.walkPoints;
    if (!pts || pts.length < 2) return false;
    const wp = pts[Math.min(this.pathIdx, pts.length - 1)];
    return Math.abs(wrapPi(Math.atan2(-(wp.x - this.x), -(wp.z - this.z)) - this.yaw)) > 1.0;
  }

  /**
   * Pivot in place, THEN walk. The speed gate in step() already makes
   * moonwalking unrepresentable; this is the visible half of the same rule — a
   * customer who has to double back plants, turns, and only then sets off,
   * instead of carving a wide arc through the aisle.
   */
  sTurn(dt, budget) {
    const b = this.brain;
    this.decelerate(dt);
    if (!this.walkPoints) {
      const got = this.leaving ? this.routeToDoor(budget) : this.pickTarget(budget);
      if (got !== true) { b.t = Math.max(b.t - dt, 0.1); return; }
    }
    const pts = this.walkPoints;
    const wp = pts[Math.min(this.pathIdx, pts.length - 1)];
    const off = this.faceToward(wp.x, wp.z, dt);
    b.t -= dt;
    if (off < 0.35 || b.t <= 0) b.go(this.leaving ? 'EXIT' : 'WALK');
  }

  /**
   * The travelling states. One path follower, five speed regimes, and the
   * transitions that make an arrival look like an arrival: full pace → shedding
   * speed inside slowRadius → (sometimes) a stop to look → the last metre at a
   * shuffle → browsing.
   */
  sTravel(dt, player, budget, peers) {
    const b = this.brain, T = this.traits, st = b.state;

    if (!this.walkPoints) {
      this.decelerate(dt);
      const got = (st === 'EXIT' || this.leaving) ? this.routeToDoor(budget) : this.pickTarget(budget);
      if (got !== true && st === 'EXIT') { this.leaving = false; b.go('TURN', 0.4); }
      return;
    }

    // WALK_AWAY is a timed regime, not a destination: they peel off the fixture
    // at browse pace and pick their stride back up once clear of it.
    if (st === 'WALK_AWAY' && b.tick(dt)) {
      b.go(this.leaving ? 'EXIT' : 'WALK');
      return;
    }

    const pts = this.walkPoints;
    const last = pts[pts.length - 1];
    let wp = pts[this.pathIdx] || last;
    const isFinal = this.pathIdx >= pts.length - 1;
    if (Math.hypot(wp.x - this.x, wp.z - this.z) < (isFinal ? 0.12 : 0.3)) {
      if (isFinal) { this.arrive(budget); return; }
      this.pathIdx++;
      wp = pts[this.pathIdx] || last;
    }

    let cap = CAP[st] ?? 1;
    if (st === 'SLOW') {
      // taper the last stretch rather than dropping to a fixed crawl
      cap *= 0.45 + 0.55 * Math.min(1, this.remaining() / Math.max(0.4, T.slowRadius));
    }
    cap *= this.yieldFactor(player, peers);
    if (cap <= 0.001) { this.decelerate(dt); return; }

    const r = this.step(dt, wp.x, wp.z, cap);
    if (r.stuck) { this.unwedge(); return; }

    // Approaching the end of the FINAL leg is what triggers the arrival ritual.
    if (st === 'WALK' && this.onLastLeg() && this.remaining() < T.slowRadius) b.go('SLOW');
    else if (st === 'SLOW' && this.remaining() < T.approachGap + 0.55) {
      if (b.wantsLook()) b.go('LOOK', b.lookTime());
      else b.go('APPROACH');
    }
  }

  /** Reached the end of a leg. Either there is more route, or we are there. */
  arrive(budget) {
    const b = this.brain;
    if (!this.onLastLeg()) {
      const kind = this.nextSegment();
      if (kind === 'ride') b.go('ESCALATOR_RIDE');
      else if (kind === 'walk' && b.state !== 'WALK') b.go('WALK');
      return;
    }
    this.walkPoints = null;
    this.vel = 0; this.walking = false;
    if (b.state === 'EXIT' || this.destDept === 'exit') {
      // At the doors. Keyed off the DESTINATION rather than the state, because
      // a customer who rode down from the mezzanine to leave arrives on the
      // walk leg after the ride and is therefore in WALK, not EXIT.
      // They turn round and start a fresh visit — same body, new errands. NO
      // TELEPORT: the walk out and the walk back in are continuous, which is
      // why EXIT loops back to ENTER rather than respawning anybody.
      this.destDept = null;
      this.leaving = false;
      this.carryWant = 0;
      // ...AND THE THING THEY WERE LOOKING AT. Every other scrap of the old
      // visit is cleared here; faceAt was not, so a customer who turned round
      // at the doors spent the whole ENTER beat facing back OUT through them —
      // standing in the entrance, staring at the street they just left.
      // Surfaced by the romance endcap: adding a fixture shifted the crowd's
      // timing enough to put someone in that state during the NPC sim, and
      // "every destination is a real place" caught them facing a doorway that
      // is not a shelf. The stale target was always there; nothing had stood
      // in exactly the wrong place at exactly the wrong moment before.
      this.faceAt = null;
      b.resetVisit();
      b.go('ENTER', b.enterTime());
      return;
    }
    b.visits++;
    // Ritualise the arrival even on a very short hop, so nobody ever snaps from
    // walking to standing at a shelf.
    if (b.state === 'WALK' || b.state === 'WALK_AWAY') b.go('SLOW');
    if (b.state === 'SLOW' || b.state === 'LOOK') b.go('APPROACH');
    b.go('BROWSE', b.browseTime());
    this.shuffleT = 0.8 + b.rng() * 1.8;
  }

  /** Stopped a metre or two short, reading the shelf before committing to it. */
  sLook(dt) {
    const b = this.brain;
    this.decelerate(dt);
    if (this.faceAt) this.faceToward(this.faceAt.x, this.faceAt.z, dt, 0.8);
    this.headWant = Math.sin(this.idleT * 0.9 + this.traits.phase) * this.traits.headSweep;
    if (!b.tick(dt)) return;
    if (this.walkPoints) b.go('APPROACH');
    else b.go('WALK_AWAY', 0.8 + b.rng());
  }

  /**
   * At the shelf. This is the behaviour the brief calls the most important one,
   * so it is not a stop: they square up to the face, read along it with their
   * head, and every so often take a small SIDESTEP to the next section.
   *
   * The sidestep goes through step() like every other translation, which means
   * they turn to face along the shelf, walk, and turn back — a person shuffling
   * down an aisle. It is emphatically NOT a lateral slide while facing forward,
   * which is the cheap version and looks like it.
   */
  sBrowse(dt, player) {
    const b = this.brain, T = this.traits;
    if (this.micro) {
      const r = this.step(dt, this.micro.x, this.micro.z, CAP.SHUFFLE * this.yieldFactor(player, null));
      if (r.stuck || r.dist < 0.10) { this.micro = null; this.stuckT = 0; }
    } else {
      this.decelerate(dt);
      if (this.faceAt) this.faceToward(this.faceAt.x, this.faceAt.z, dt, 0.7);
      this.headWant = Math.sin(this.idleT * (0.5 + T.swayRate) + T.phase) * T.headSweep;
      this.shuffleT -= dt;
      if (this.shuffleT <= 0) {
        this.shuffleT = 1.4 + b.rng() * 2.4;
        const crowder = this.crowdedBy();
        // Being stood on takes priority over idle browsing movement, and the
        // step goes through the same forward-only walker, so making room reads
        // as a person shifting down the bay rather than a lateral slide.
        if (crowder) this.stepAsideFrom(crowder);
        else if (b.wantsShuffle()) this.startShuffle();
      }
    }
    if (!b.tick(dt)) return;
    this.micro = null;
    const next = b.afterBrowse();
    if (next === 'HESITATE') b.go('HESITATE', b.hesitateTime());
    else if (next === 'REACH') { b.go('REACH', b.reachTime()); this.reachWant = 1; }
    else this.leaveShelf();
  }

  /**
   * Whoever is standing too close. Only LOWER indices count, so exactly one of
   * any pair moves — a symmetric rule has both of them stepping aside into each
   * other for ever.
   */
  crowdedBy() {
    const crowd = this.plan.crowd;
    if (!crowd) return null;
    for (const o of crowd) {
      if (o === this || o.index > this.index || o.level !== this.level) continue;
      if (Math.hypot(o.x - this.x, o.z - this.z) < CROWDED) return o;
    }
    return null;
  }

  /** Shift along the shelf away from somebody who has crowded in. */
  stepAsideFrom(o) {
    const away = { x: this.x - o.x, z: this.z - o.z };
    const m = Math.hypot(away.x, away.z) || 1;
    const tx = this.x + (away.x / m) * 0.55, tz = this.z + (away.z / m) * 0.55;
    const open = nearestOpen(this.nav.grids[this.level], tx, tz, 0.35);
    if (open) { this.micro = { x: open.x, z: open.z }; this.destX = open.x; this.destZ = open.z; }
  }

  /** Set a small target one section along the shelf face, if the floor allows. */
  startShuffle() {
    if (!this.faceAt) return;
    const b = this.brain, T = this.traits;
    const dx = this.faceAt.x - this.x, dz = this.faceAt.z - this.z;
    const d = Math.hypot(dx, dz) || 1;
    // perpendicular to the line of sight = along the shelf
    const sx = -dz / d, sz = dx / d;
    const amt = (b.rng() < 0.5 ? -1 : 1) * T.lateral * (0.6 + b.rng() * 0.8);
    const tx = this.x + sx * amt, tz = this.z + sz * amt;
    const open = nearestOpen(this.nav.grids[this.level], tx, tz, 0.3);
    if (open) this.micro = { x: open.x, z: open.z };
  }

  /** The torn beat before committing. No translation — a weight shift and a look. */
  sHesitate(dt) {
    const b = this.brain, T = this.traits;
    this.decelerate(dt);
    if (this.faceAt) this.faceToward(this.faceAt.x, this.faceAt.z, dt, 0.5);
    this.headWant = Math.sin(this.idleT * 1.7 + T.phase) * T.headSweep * 0.45;
    this.headPitchWant = 0.10;
    this.leanWant = 0.04;
    if (!b.tick(dt)) return;
    this.leanWant = 0;
    this.headPitchWant = 0;
    const next = b.afterHesitate();
    if (next === 'REACH') { b.go('REACH', b.reachTime()); this.reachWant = 1; }
    else if (next === 'BROWSE') b.go('BROWSE', b.browseTime());
    else this.leaveShelf();
  }

  /** Arm to the shelf. The torso leans in with it. */
  sReach(dt) {
    const b = this.brain;
    this.decelerate(dt);
    if (this.faceAt) this.faceToward(this.faceAt.x, this.faceAt.z, dt, 0.9);
    this.reachWant = 1;
    this.leanWant = 0.16;
    this.headWant = 0;
    this.headPitchWant = -0.12;
    if (!b.tick(dt)) return;
    this.reachWant = 0;
    this.leanWant = 0;
    this.carryWant = 1;
    b.go('INSPECT', b.inspectTime());
  }

  /** Case in hand, head down, reading the back of it. */
  sInspect(dt) {
    const b = this.brain, T = this.traits;
    this.decelerate(dt);
    this.carryWant = 1;
    this.readWant = 1;
    this.headPitchWant = 0.30;
    this.headWant = Math.sin(this.idleT * 1.1 + T.phase) * 0.09;
    if (!b.tick(dt)) return;
    this.headPitchWant = 0;
    this.readWant = 0;
    if (b.afterInspect() === 'BROWSE') b.go('BROWSE', b.browseTime());
    else this.leaveShelf();
  }

  /** Peel off the fixture. Some people take the case with them; most don't. */
  leaveShelf() {
    const b = this.brain;
    this.micro = null;
    this.destX = null; this.destZ = null;
    this.carryWant = this.carryWant > 0.5 && b.keepsCase() ? 1 : 0;
    this.reachWant = 0;
    this.readWant = 0;
    this.headPitchWant = 0;
    this.faceAt = null;
    this.leaving = b.wantsExit();
    b.go('WALK_AWAY', 0.8 + b.rng() * 1.0);
  }

  /** Shed speed without moving — used by every planted state. */
  decelerate(dt) {
    this.vel += (0 - this.vel) * Math.min(1, ACCEL * 1.6 * dt);
    if (this.vel < 0.02) this.vel = 0;
    this.walking = false;
  }

  // -------------------------------------------------------------------------
  // ESCALATOR
  // -------------------------------------------------------------------------

  rideStep(dt) {
    const r = this.ride;
    if (!r) { this.brain.go('WALK'); return; }
    // YOU TURN AT THE LANDING, THEN YOU STEP ON.
    //
    // Observed in the rendered store: a rider boarded the central up bank at a
    // facing dot of -0.911 — i.e. backwards — and then spun 180° while the
    // machine carried them, because the approach direction and the climb
    // direction disagree for that bank. Holding position at the landing until
    // the heading is acquired turns that into somebody walking up to the
    // escalator, turning, and getting on. The timeout means a bank whose
    // geometry makes the heading unreachable still cannot stall a rider.
    {
      const at = escalatorProfile(r.esc, Math.max(0, Math.min(r.s, r.total)));
      const nose = escalatorProfile(r.esc, Math.max(0, Math.min(r.s + r.dir * 0.3, r.total)));
      const ax = nose.x - at.x, az = nose.z - at.z;
      r.boardT = (r.boardT ?? 0) + dt;
      if (Math.hypot(ax, az) > 1e-6 && r.boardT < BOARD_TURN_MAX) {
        const want = Math.atan2(-ax, -az);
        const d = wrapPi(want - this.yaw);
        if (Math.abs(d) > BOARD_TURN_OK) {
          this.yaw += Math.sign(d) * Math.min(Math.abs(d), TURN_RATE * dt);
          this.x = at.x; this.z = at.z; this.groupY = at.y;
          this.vel = 0; this.walking = false;
          return;
        }
      }
    }
    r.s += r.dir * WORLD.escSpeed * dt;
    const p = escalatorProfile(r.esc, Math.max(0, Math.min(r.s, r.total)));
    this.x = p.x; this.z = p.z;
    this.groupY = p.y;
    this.vel = 0; this.walking = false;      // they are being carried, not walking
    this.headWant *= 0.9;
    // FACE THE WAY THE MACHINE IS ACTUALLY CARRYING YOU.
    //
    // This was `r.dir > 0 ? 0 : Math.PI`, which hardcodes the FRONT banks'
    // orientation: they climb toward -z, so riding up meant facing yaw 0. The
    // rear bank climbs toward +z (zSign -1), so every rider on it was spun to
    // face backwards down the escalator for the whole ride — riding up while
    // looking down at the steps behind them. Sampling the profile slightly
    // ahead derives the heading from the ride itself, so all six banks are
    // right and no bank has to be special-cased.
    const ahead = escalatorProfile(r.esc, Math.max(0, Math.min(r.s + r.dir * 0.3, r.total)));
    const ax = ahead.x - p.x, az = ahead.z - p.z;
    if (Math.hypot(ax, az) > 1e-6) {
      const want = Math.atan2(-ax, -az);
      const d = wrapPi(want - this.yaw);
      // Rate-limited so stepping on is a turn, not a snap.
      this.yaw += Math.sign(d) * Math.min(Math.abs(d), TURN_RATE * dt);
    }
    const done = r.dir > 0 ? r.s >= r.total : r.s <= 0;
    if (done) {
      this.level = r.link.toLevel;
      this.x = r.link.to.x; this.z = r.link.to.z;
      this.ride = null;
      const kind = this.nextSegment();
      // Whoever rode down on their way out is still on their way out.
      this.brain.go(this.leaving ? 'EXIT' : kind === 'walk' ? 'WALK' : 'WALK_AWAY', 0.8);
    }
  }

  // -------------------------------------------------------------------------
  // POSE
  // -------------------------------------------------------------------------

  /** Every pose channel is eased, so nothing about the body ever snaps. */
  easePose(dt) {
    const k = (cur, want, rate) => cur + (want - cur) * Math.min(1, rate * dt);
    this.headYaw = k(this.headYaw, this.headWant, 5.5);
    this.headPitch = k(this.headPitch, this.headPitchWant, 4.5);
    this.reach = k(this.reach, this.reachWant, 5.0);
    this.carry = k(this.carry, this.carryWant, 6.0);
    this.read = k(this.read, this.readWant, 5.0);
    this.lean = k(this.lean, this.leanWant, 5.0);
  }

  apply(dt) {
    const T = this.traits;
    this.group.position.set(this.x, this.groupY ?? this.levelY(), this.z);
    this.group.rotation.y = this.yaw;

    // Swing amplitude scales with how fast they are ACTUALLY going, so a
    // customer slowing to a shelf takes visibly shorter steps rather than
    // marching in place, and a stopped one does not stride at all.
    const gait = Math.min(1, this.vel / Math.max(0.001, T.speed));
    if (this.walking && gait > 0.05) {
      const s = Math.sin(this.phase);
      this.legL.rotation.x = s * 0.5 * gait;
      this.legR.rotation.x = -s * 0.5 * gait;
      const swing = 0.35 * (1 - this.carry * 0.7);
      this.armL.rotation.x = -s * swing * gait;
      this.armR.rotation.x = s * swing * gait;
      this.group.position.y += Math.abs(s) * 0.02 * gait;
    } else {
      this.legL.rotation.x = this.legR.rotation.x = 0;
      const sway = Math.sin(this.idleT * T.swayRate + T.phase) * 0.05;
      this.armL.rotation.x = sway;
      this.armR.rotation.x = -sway;
      // a standing person shifts their weight; it is tiny, and it is the
      // difference between a customer and a statue
      this.group.position.y += Math.sin(this.idleT * T.swayRate * 0.8 + T.phase) * 0.004;
    }

    // ARM OVERRIDES. A +x rotation swings the hand FORWARD, because the rig
    // faces -z. The reach used to be a flat 1.75 rad — a horizontal arm, which
    // read as a mannequin rather than somebody taking a case off a shelf — and
    // it now comes with a small inward roll and a deeper lean.
    // 0.95 rad put both arms straight out in front like a tray; 0.78 reads as
    // holding something at waist height and looking down at it, which is what
    // the head pitch is already doing.
    const armA = Math.max(this.carry * 0.30, this.read * 0.78);
    if (this.reach > 0.01) {
      this.armR.rotation.x = this.reach * 1.35;
      this.armR.rotation.z = -this.reach * 0.22;
    } else {
      this.armR.rotation.z = 0;
      if (armA > 0.01) this.armR.rotation.x = Math.max(this.armR.rotation.x, armA);
    }
    // the second hand only joins when they are actually reading the back
    if (this.read > 0.01) this.armL.rotation.x = Math.max(this.armL.rotation.x, this.read * 0.78);

    this.torso.rotation.x = this.lean;
    this.headPivot.rotation.y = this.headYaw;
    this.headPivot.rotation.x = this.headPitch;

    // THE CASE GOES WHERE THE HAND IS.
    //
    // It used to be positioned from an interpolation keyed off head pitch, so
    // while a customer read the back of a case the case hung ~0.24 m above the
    // hand holding it. Deriving it from the same arm angle the pose uses keeps
    // it in the hand at every point of the carry→read blend.
    const handY = 1.02 - 0.38 * Math.cos(armA);
    const handZ = -0.38 * Math.sin(armA);
    this.held.visible = this.carry > 0.06 || this.read > 0.06;
    this.held.position.set(0.20 - 0.16 * this.read, handY + 0.03, handZ - 0.04);
    this.held.rotation.set(0.20 + 0.95 * this.read, 0.14 * this.read, 0);
  }
}

export class NPCSystem {
  /**
   * opts: { mobile } — the head-count is DERIVED from the generated nav grid.
   * A number is still accepted as an explicit override for QA/benchmarks.
   */
  constructor(scene, layout, nav, opts = {}) {
    const o = typeof opts === 'number' ? { count: opts } : opts;
    this.scene = scene;
    this.mobile = !!o.mobile;
    this.fixedCount = typeof o.count === 'number' ? o.count : null;
    this.npcs = [];
    this.plan = {
      shelves: shelvesByLevel(layout),
      checkout: checkoutOf(layout),
      door: doorOf(layout, nav),
      crowd: this.npcs,          // live array — everyone can see everyone else
    };
    this.employee = buildFigure(EMPLOYEE_PALETTE, { vest: true, cap: true, heightScale: 1.0 });
    scene.add(this.employee.group);
    this.empPhase = 0;
    this.postEmployee(layout);
    this.populate(layout, nav);
  }

  targetCount(nav) {
    return this.fixedCount ?? customerCount(nav, { mobile: this.mobile });
  }

  /** Stand the employee at whatever the generator says is the counter. */
  postEmployee(layout) {
    const co = this.plan.checkout;
    const p = co ? co.staff : { x: 8.45, z: 8.15, yaw: Math.PI };
    this.empPos = { x: p.x, z: p.z };
    this.employee.group.position.set(p.x, 0, p.z);
    this.employee.group.rotation.y = p.yaw;
  }

  /** Grow or trim the crowd to the density the current building supports. */
  populate(layout, nav) {
    const want = this.targetCount(nav);
    while (this.npcs.length > want) {
      const n = this.npcs.pop();
      this.scene.remove?.(n.group);
      disposeFigure(n.group);
    }
    if (this.npcs.length >= want) return;
    // Re-derive the whole spread for `want` people and take the tail: the
    // stride placement is a function of the head-count, so the newcomers land
    // in the gaps rather than on top of whoever is already here.
    const spots = spawnSpots(layout, nav, want);
    for (let i = this.npcs.length; i < want && i < spots.length; i++) {
      this.npcs.push(new NPC(this.scene, layout, nav, this.plan, spots[i], i));
    }
  }

  // RESTOCK: the building itself may have grown or shrunk, so re-read the plan,
  // move the employee to the counter's new position, resize the crowd to the
  // new floor area, and rescue anyone the new shelving now overlaps.
  rewire(layout, nav) {
    this.plan.shelves = shelvesByLevel(layout);
    this.plan.checkout = checkoutOf(layout);
    this.plan.door = doorOf(layout, nav);
    this.postEmployee(layout);
    for (const n of this.npcs) {
      n.layout = layout;
      n.nav = nav;
      n.plan = this.plan;
      n.stuckT = 0; n.skipped = false;
      // Any queued walk was planned against the OLD floor plan. Riders keep
      // their ride — the escalator and its well are fixed architecture, so they
      // still land exactly where they always did — but the leg waiting on the
      // other side is stale, so drop it and let them choose again on stepping
      // off. Without this a rider walks the new mezzanine on an old route and
      // grinds into a gondola that was not there when it was planned.
      n.segments = null;
      if (!n.ride) {
        n.walkPoints = null;
        n.micro = null;
        n.faceAt = null;
        n.leaving = false;
        n.vel = 0; n.walking = false;
        // A restock is a new building, not a transition inside the old one —
        // everyone restarts at ENTER rather than stepping there illegally.
        n.brain.state = 'ENTER';
        n.brain.t = 0.4 + n.brain.rng() * 2.5;
        // A deeper store moves the walls; a shallower one can leave someone
        // standing inside a brand-new gondola, or outside the shell entirely.
        const grid = nav.grids[n.level];
        const open = nearestOpen(grid, n.x, n.z, 2.4);
        if (open) { n.x = open.x; n.z = open.z; } else {
          const spare = spawnSpots(layout, nav, this.targetCount(nav));
          const s = spare[Math.floor(n.brain.rng() * spare.length)] || layout.spawn;
          n.x = s.x; n.z = s.z; n.level = s.level ?? 0;
        }
        n.apply(0);
      }
    }
    this.populate(layout, nav);
  }

  update(dt, player) {
    // One route search per frame for the whole crowd — see NPC.pickTarget.
    // Retargets happen every few seconds each, so this is never a bottleneck.
    const budget = { left: 1 };
    for (const n of this.npcs) n.update(dt, player, budget, this.npcs);
    // employee: idle sway + politely watches you when you're near the counter
    this.empPhase += dt;
    const e = this.employee;
    const ep = this.empPos;
    e.group.position.y = Math.sin(this.empPhase * 0.9) * 0.012;
    if (player && player.level === 0) {
      const d = Math.hypot(player.x - ep.x, player.z - ep.z);
      if (d < 6) {
        const targetYaw = Math.atan2(-(player.x - ep.x), -(player.z - ep.z));
        const dyaw = wrapPi(targetYaw - e.group.rotation.y);
        e.group.rotation.y += dyaw * Math.min(1, 2.5 * dt);
      }
    }
    e.armL.rotation.x = Math.sin(this.empPhase * 0.7) * 0.06;
    e.headPivot.rotation.y = Math.sin(this.empPhase * 0.31) * 0.22;
  }

  /** Per-person snapshot for QA — who everyone is, and what they are doing. */
  sample() {
    return this.npcs.map((n) => ({
      i: n.index, state: n.brain.state, prev: n.brain.prev,
      x: +n.x.toFixed(2), z: +n.z.toFixed(2), level: n.level,
      yaw: +n.yaw.toFixed(3), vel: +n.vel.toFixed(3), walking: n.walking,
      riding: !!n.ride, dept: n.destDept, visits: n.brain.visits,
      illegal: n.brain.illegal, transitions: n.brain.transitions, unwedges: n.unwedges,
      speed: +n.traits.speed.toFixed(3), height: +n.traits.height.toFixed(3),
      turnRate: +n.traits.turnRate.toFixed(3), patience: +n.traits.patience.toFixed(3),
      carry: +n.carry.toFixed(2), reach: +n.reach.toFixed(2),
    }));
  }
}
