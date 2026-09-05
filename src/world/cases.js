// Physical rental cases. All ~1300 case copies are merged into a handful of
// meshes (one per texture atlas) for performance; picking a case up collapses
// its vertices so the shelf slot genuinely empties, and an individual hi-res
// mesh is spawned for inspection.
import * as THREE from 'three';
import { WORLD } from '../config.js';
import { TILE, makeHiResCover, MAX_ANISO } from './textures.js';

const { caseW, caseH, caseD } = WORLD;

// Bucket size of the slot proximity index, in metres. Two metres is a little
// wider than an aisle, so a query at the shelf face touches a 3x3 or 4x4 block
// of cells and reads a few hundred slots out of ~61,000.
const PROX_CELL = 2;

// Face corner layout: each face = 4 corners (TL, TR, BL, BR from the face's viewer)
// + uv rect mapping. Corners are [x,y,z] in case-local space.
const hw = caseW / 2, hh = caseH / 2, hd = caseD / 2;
const FACES = [
  { // front (+z): viewer right = +x
    n: [0, 0, 1], region: 'front',
    c: [[-hw, hh, hd], [hw, hh, hd], [-hw, -hh, hd], [hw, -hh, hd]],
  },
  { // back (-z): viewer right = -x
    n: [0, 0, -1], region: 'back',
    c: [[hw, hh, -hd], [-hw, hh, -hd], [hw, -hh, -hd], [-hw, -hh, -hd]],
  },
  { // spine (-x): viewer right = +z
    n: [-1, 0, 0], region: 'spine',
    c: [[-hw, hh, -hd], [-hw, hh, hd], [-hw, -hh, -hd], [-hw, -hh, hd]],
  },
  { // opening edge (+x): viewer right = -z
    n: [1, 0, 0], region: 'edge',
    c: [[hw, hh, hd], [hw, hh, -hd], [hw, -hh, hd], [hw, -hh, -hd]],
  },
  { // top (+y)
    n: [0, 1, 0], region: 'edge',
    c: [[-hw, hh, -hd], [hw, hh, -hd], [-hw, hh, hd], [hw, hh, hd]],
  },
  { // bottom (-y)
    n: [0, -1, 0], region: 'edge',
    c: [[-hw, -hh, hd], [hw, -hh, hd], [-hw, -hh, -hd], [hw, -hh, -hd]],
  },
];

function tileUVRects(atlases, titleId) {
  const info = atlases.tiles.get(titleId);
  const sc = atlases.tileW / TILE.w;
  const ox = info.col * atlases.tileW, oy = info.row * atlases.tileH;
  const A = atlases.atlasSize;
  const rect = (r) => ({
    u0: (ox + r.x * sc) / A, u1: (ox + (r.x + r.w) * sc) / A,
    v0: 1 - (oy + (r.y + r.h) * sc) / A, v1: 1 - (oy + r.y * sc) / A,
  });
  return {
    front: rect(TILE.front), back: rect(TILE.back),
    spine: rect(TILE.spine), edge: rect(TILE.edge),
    atlas: info.atlas,
  };
}

export class CaseSystem {
  /**
   * @param atlases the atlas PLAN (tiles/cols/rows/tileW/tileH/atlasSize). Only
   *   the layout is needed here — no canvases. Artwork arrives later via
   *   setAtlasTexture() as the streamer draws it.
   * @param textureFor (atlasIdx) => THREE.Texture. The streamer OWNS these; this
   *   class never disposes a map it did not create (see dispose()).
   */
  constructor(scene, layout, catalog, atlases, textureFor = null) {
    this.layout = layout;
    this.atlases = atlases;
    this.byId = new Map(catalog.map(t => [t.id, t]));
    this.meshes = [];
    this.slotInfo = new Map(); // slotId -> { meshIdx, vertStart, savedY: Float32Array|null }
    this.hidden = new Set();
    this.meshByAtlas = new Map();  // atlasIdx -> mesh
    this.bounds = new Map();       // atlasIdx -> {x0,x1,y0,y1,z0,z1}
    // Textures are owned externally when a provider is supplied; when it is not
    // (the eager path) this class builds and therefore owns them.
    this.ownsTextures = !textureFor;

    // Group slots by atlas, and build the two proximity structures side by side.
    const groups = new Map();
    // THE FLAT PROXIMITY INDEX — parallel arrays over SLOTS, not atlases. ~0.7 MB
    // at n ~= 61,000. See nearestAtlasDistance for why the AABBs below are not
    // enough on their own.
    const n = layout.slots.length;
    this._pxz = new Float32Array(n * 2);
    this._patlas = new Uint16Array(n);
    this._pcells = new Map();          // `${level}|${cx}|${cz}` -> Int32Array of slot indices
    const buckets = new Map();         // same key -> number[], converted below
    let si = 0;
    for (const slot of layout.slots) {
      const uv = tileUVRects(atlases, slot.titleId);
      if (!groups.has(uv.atlas)) groups.set(uv.atlas, []);
      groups.get(uv.atlas).push({ slot, uv });
      // Bounding box per atlas, so residency can rank atlases by how close the
      // player is to the cases that actually wear them.
      let b = this.bounds.get(uv.atlas);
      if (!b) this.bounds.set(uv.atlas, b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity });
      if (slot.x < b.x0) b.x0 = slot.x; if (slot.x > b.x1) b.x1 = slot.x;
      if (slot.y < b.y0) b.y0 = slot.y; if (slot.y > b.y1) b.y1 = slot.y;
      if (slot.z < b.z0) b.z0 = slot.z; if (slot.z > b.z1) b.z1 = slot.z;

      this._pxz[si * 2] = slot.x;
      this._pxz[si * 2 + 1] = slot.z;
      this._patlas[si] = uv.atlas;
      const key = `${slot.level | 0}|${Math.floor(slot.x / PROX_CELL)}|${Math.floor(slot.z / PROX_CELL)}`;
      let cell = buckets.get(key);
      if (!cell) buckets.set(key, cell = []);
      cell.push(si);
      si++;
    }
    for (const [key, list] of buckets) this._pcells.set(key, Int32Array.from(list));

    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const v = new THREE.Vector3(), nrm = new THREE.Vector3();

    for (const [atlasIdx, list] of groups) {
      const nSlots = list.length;
      const pos = new Float32Array(nSlots * 24 * 3);
      const norm = new Float32Array(nSlots * 24 * 3);
      const uvArr = new Float32Array(nSlots * 24 * 2);
      const index = new Uint32Array(nSlots * 36);
      const slotList = [];

      list.forEach(({ slot, uv }, si) => {
        // orientation
        if (slot.lay) {
          e.set(-Math.PI / 2 + slot.tilt, slot.rotY, 0, 'YXZ');
        } else {
          e.set(0, slot.rotY, 0, 'YXZ');
        }
        q.setFromEuler(e);
        m4.compose(new THREE.Vector3(slot.x, slot.y, slot.z), q, new THREE.Vector3(1, 1, 1));

        const vBase = si * 24;
        FACES.forEach((f, fi) => {
          const r = uv[f.region];
          const uvCorners = [[r.u0, r.v1], [r.u1, r.v1], [r.u0, r.v0], [r.u1, r.v0]];
          for (let ci = 0; ci < 4; ci++) {
            const vi = vBase + fi * 4 + ci;
            v.set(f.c[ci][0], f.c[ci][1], f.c[ci][2]).applyMatrix4(m4);
            pos[vi * 3] = v.x; pos[vi * 3 + 1] = v.y; pos[vi * 3 + 2] = v.z;
            nrm.set(f.n[0], f.n[1], f.n[2]).applyQuaternion(q);
            norm[vi * 3] = nrm.x; norm[vi * 3 + 1] = nrm.y; norm[vi * 3 + 2] = nrm.z;
            uvArr[vi * 2] = uvCorners[ci][0]; uvArr[vi * 2 + 1] = uvCorners[ci][1];
          }
          const o = vBase + fi * 4, ii = (si * 6 + fi) * 6;
          index[ii] = o; index[ii + 1] = o + 2; index[ii + 2] = o + 1;
          index[ii + 3] = o + 1; index[ii + 4] = o + 2; index[ii + 5] = o + 3;
        });
        slotList.push(slot.id);
        this.slotInfo.set(slot.id, { meshIdx: this.meshes.length, vertStart: vBase, savedY: null });
      });

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
      geo.setIndex(new THREE.BufferAttribute(index, 1));

      let tex;
      if (textureFor) {
        tex = textureFor(atlasIdx);
      } else {
        tex = new THREE.CanvasTexture(atlases.canvases[atlasIdx]);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
      }
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.42, metalness: 0.02 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.slotList = slotList;
      mesh.userData.isCaseBatch = true;
      mesh.userData.atlasIdx = atlasIdx;
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      this.meshes.push(mesh);
      this.meshByAtlas.set(atlasIdx, mesh);
    }
  }

  /**
   * Swap the artwork on one atlas's batch. Geometry is untouched: the tile grid
   * is 7x12 at every scale, so the baked UVs address the same tile whether the
   * texture is 256px or 2048px. This is the whole residency mechanism.
   */
  setAtlasTexture(atlasIdx, tex) {
    const mesh = this.meshByAtlas.get(atlasIdx);
    if (!mesh || !tex || mesh.material.map === tex) return;
    mesh.material.map = tex;
    mesh.material.needsUpdate = true;
  }

  /**
   * Whether this atlas's batch is currently rendered at all. applyShelfStock
   * culls a batch whose every slot is empty; an invisible batch samples no
   * texture, so the cover streamer has nothing to draw for it. The streamer
   * re-asks every pump, which is what makes a restock (service change, ALL
   * mode) resume streaming with no other coordination.
   */
  atlasVisible(atlasIdx) {
    const mesh = this.meshByAtlas.get(atlasIdx);
    return !mesh || mesh.visible;
  }

  /**
   * Distance from a point to the ATLAS BOUNDING BOX (box test). Fine for coarse
   * far-field ordering; useless up close — see nearestAtlasDistance.
   */
  atlasDistance(atlasIdx, p) {
    const b = this.bounds.get(atlasIdx);
    if (!b) return Infinity;
    const dx = Math.max(b.x0 - p.x, 0, p.x - b.x1);
    const dy = Math.max(b.y0 - p.y, 0, p.y - b.y1);
    const dz = Math.max(b.z0 - p.z, 0, p.z - b.z1);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Distance from the player to the nearest ACTUAL CASE wearing each atlas,
   * within `radius`, filling `out` (a Float32Array of at least plan.count) with
   * Infinity for every atlas that has no case inside it.
   *
   * WHY THIS EXISTS AND atlasDistance DOES NOT SUFFICE. The AABB spans every
   * slot wearing the atlas, and ~230 titles keep a curated copy at the front of
   * store while their department copy sits at the back. That smears the boxes
   * across the whole building: measured on the real 20,000-title layout the
   * median atlas box is 46.9 m deep and the worst is 145.2 m, and from a
   * standing position at a shelf 62-107 of the 260 atlases report the IDENTICAL
   * minimum distance. A sort on that value has no tiebreak, so "nearest atlas"
   * was effectively arbitrary and the near-field tiers were fed noise. The same
   * three positions give 24-26 atlases inside 2 m and 31-46 inside 6 m here.
   *
   * XZ ONLY, DELIBERATELY. Slot y spans 0.44..5.18 m across both floors, so a
   * 3D distance would rank the shelf at eye level ahead of the one at your
   * knees on the same fixture and starve top and bottom shelves of resolution.
   * The mezzanine is separated by the LEVEL filter instead, which is exact —
   * the two floors never share a proximity cell.
   */
  nearestAtlasDistance(p, radius, out) {
    out.fill(Infinity);
    const level = p.level | 0;
    const r2 = radius * radius;
    const cx0 = Math.floor((p.x - radius) / PROX_CELL), cx1 = Math.floor((p.x + radius) / PROX_CELL);
    const cz0 = Math.floor((p.z - radius) / PROX_CELL), cz1 = Math.floor((p.z + radius) / PROX_CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const cell = this._pcells.get(`${level}|${cx}|${cz}`);
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const s = cell[i];
          const dx = this._pxz[s * 2] - p.x, dz = this._pxz[s * 2 + 1] - p.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > r2) continue;
          const a = this._patlas[s];
          const d = Math.sqrt(d2);
          if (d < out[a]) out[a] = d;
        }
      }
    }
    return out;
  }

  // Map a raycast intersection on a batch mesh to a slot id.
  slotFromIntersect(intersect) {
    const list = intersect.object.userData.slotList;
    if (!list) return null;
    const si = Math.floor(intersect.faceIndex / 12);
    return list[si] || null;
  }

  isHidden(slotId) { return this.hidden.has(slotId); }

  hideSlot(slotId) {
    const info = this.slotInfo.get(slotId);
    if (!info || this.hidden.has(slotId)) return;
    const mesh = this.meshes[info.meshIdx];
    const attr = mesh.geometry.attributes.position;
    const saved = new Float32Array(24);
    for (let i = 0; i < 24; i++) {
      saved[i] = attr.array[(info.vertStart + i) * 3 + 1];
      attr.array[(info.vertStart + i) * 3 + 1] = -100;
    }
    info.savedY = saved;
    attr.needsUpdate = true;
    this.hidden.add(slotId);
  }

  showSlot(slotId) {
    const info = this.slotInfo.get(slotId);
    if (!info || !info.savedY) return;
    const mesh = this.meshes[info.meshIdx];
    const attr = mesh.geometry.attributes.position;
    for (let i = 0; i < 24; i++) {
      attr.array[(info.vertStart + i) * 3 + 1] = info.savedY[i];
    }
    info.savedY = null;
    attr.needsUpdate = true;
    this.hidden.delete(slotId);
  }

  // Individual hi-res mesh for inspection (caller must dispose via disposeInspectMesh)
  makeInspectMesh(title, opts = {}) {
    const canvas = makeHiResCover(title, opts);
    const scale = canvas.width / TILE.w;
    const A = { w: canvas.width, h: canvas.height };
    const rect = (r) => ({
      u0: (r.x * scale) / A.w, u1: ((r.x + r.w) * scale) / A.w,
      v0: 1 - ((r.y + r.h) * scale) / A.h, v1: 1 - (r.y * scale) / A.h,
    });
    const uv = { front: rect(TILE.front), back: rect(TILE.back), spine: rect(TILE.spine), edge: rect(TILE.edge) };

    const pos = new Float32Array(24 * 3), norm = new Float32Array(24 * 3), uvArr = new Float32Array(24 * 2);
    const index = new Uint16Array(36);
    FACES.forEach((f, fi) => {
      const r = uv[f.region];
      const uvCorners = [[r.u0, r.v1], [r.u1, r.v1], [r.u0, r.v0], [r.u1, r.v0]];
      for (let ci = 0; ci < 4; ci++) {
        const vi = fi * 4 + ci;
        pos[vi * 3] = f.c[ci][0]; pos[vi * 3 + 1] = f.c[ci][1]; pos[vi * 3 + 2] = f.c[ci][2];
        norm[vi * 3] = f.n[0]; norm[vi * 3 + 1] = f.n[1]; norm[vi * 3 + 2] = f.n[2];
        uvArr[vi * 2] = uvCorners[ci][0]; uvArr[vi * 2 + 1] = uvCorners[ci][1];
      }
      const o = fi * 4, ii = fi * 6;
      index[ii] = o; index[ii + 1] = o + 2; index[ii + 2] = o + 1;
      index[ii + 3] = o + 1; index[ii + 4] = o + 2; index[ii + 5] = o + 3;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    // Same figure as every shelf case. This mesh is held at arm's length and
    // viewed near-normal, so it needs anisotropy least of anything in the store
    // — it was nonetheless asking for 8 while the shelves asked for 4.
    tex.anisotropy = MAX_ANISO;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.38, metalness: 0.02 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.isInspectCase = true;
    return mesh;
  }

  disposeInspectMesh(mesh) {
    // EVERY STEP GUARDED, AND THE MAP CLEARED AFTER DISPOSAL. This ran
    // `mesh.material.map.dispose()` unguarded on the put-back path, so a
    // material whose map had already gone threw a TypeError out of the tween's
    // onDone — which is not a place that recovers: the case is mid-return, the
    // slot is still hidden, and the store is left holding a corpse. Clearing
    // the reference also makes a second dispose a no-op rather than a
    // double-free on a texture the renderer may still be reading.
    if (!mesh) return;
    mesh.geometry?.dispose?.();
    const map = mesh.material?.map;
    if (map) { map.dispose(); mesh.material.map = null; }
    mesh.material?.dispose?.();
  }

  // full teardown for RESTOCK: the world keeps its architecture, the cases go
  dispose(scene) {
    for (const mesh of this.meshes) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      // Only dispose the map when this class created it. Under streaming the
      // textures are shared (many meshes start on the SAME placeholder) and
      // owned by the CoverStreamer — disposing them here would free a texture
      // still bound to other batches, and free it repeatedly.
      if (this.ownsTextures) mesh.material.map?.dispose();
      mesh.material.dispose();
    }
    this.meshes = [];
    this.meshByAtlas.clear();
    this.bounds.clear();
    this._pcells.clear();
    this.slotInfo.clear();
    this.hidden.clear();
  }
}
