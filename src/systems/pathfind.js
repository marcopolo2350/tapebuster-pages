// Grid A* pathfinding + exact line-of-sight smoothing, across TWO levels
// connected by escalators. Pure module (Node-testable).
//
// buildNav(layout) → { grids: [ground, mezz], links }
// findPathMulti(nav, from, to) → [{type:'walk', level, points}, {type:'ride', link}, ...]
import { WORLD } from '../config.js';

function buildGrid(bounds, obstacles, specialRects, blockRects, cell = WORLD.cell) {
  const pad = WORLD.obstaclePad;
  const cols = Math.ceil((bounds.maxX - bounds.minX) / cell);
  const rows = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
  const blocked = new Uint8Array(cols * rows);
  const special = new Uint8Array(cols * rows); // ride zones: open, but skipped by generic snapping
  const nearWall = new Uint8Array(cols * rows);

  const worldToCell = (x, z) => ({
    cx: Math.floor((x - bounds.minX) / cell),
    cz: Math.floor((z - bounds.minZ) / cell),
  });
  const cellToWorld = (cx, cz) => ({
    x: bounds.minX + (cx + 0.5) * cell,
    z: bounds.minZ + (cz + 0.5) * cell,
  });
  const idx = (cx, cz) => cz * cols + cx;
  const inBounds = (cx, cz) => cx >= 0 && cz >= 0 && cx < cols && cz < rows;

  const wallCells = Math.ceil(pad / cell);
  for (let cz = 0; cz < rows; cz++) for (let cx = 0; cx < cols; cx++) {
    if (cx < wallCells || cz < wallCells || cx >= cols - wallCells || cz >= rows - wallCells) {
      blocked[idx(cx, cz)] = 1;
    }
  }
  const fillRect = (arr, minX, minZ, maxX, maxZ, inflate = 0) => {
    const min = worldToCell(minX - inflate, minZ - inflate);
    const max = worldToCell(maxX + inflate, maxZ + inflate);
    for (let cz = Math.max(0, min.cz); cz <= Math.min(rows - 1, max.cz); cz++) {
      for (let cx = Math.max(0, min.cx); cx <= Math.min(cols - 1, max.cx); cx++) {
        arr[idx(cx, cz)] = 1;
      }
    }
  };
  for (const o of obstacles) fillRect(blocked, o.x - o.hw, o.z - o.hd, o.x + o.hw, o.z + o.hd, pad);
  for (const r of blockRects || []) fillRect(blocked, r.minX, r.minZ, r.maxX, r.maxZ, r.inflate ?? pad);
  for (const r of specialRects || []) {
    // carve open, then mark special
    const min = worldToCell(r.minX, r.minZ), max = worldToCell(r.maxX, r.maxZ);
    for (let cz = Math.max(1, min.cz); cz <= Math.min(rows - 2, max.cz); cz++) {
      for (let cx = Math.max(1, min.cx); cx <= Math.min(cols - 2, max.cx); cx++) {
        blocked[idx(cx, cz)] = 0;
        special[idx(cx, cz)] = 1;
      }
    }
  }
  for (let cz = 1; cz < rows - 1; cz++) for (let cx = 1; cx < cols - 1; cx++) {
    if (blocked[idx(cx, cz)]) continue;
    outer:
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (blocked[idx(cx + dx, cz + dz)]) { nearWall[idx(cx, cz)] = 1; break outer; }
    }
  }
  return { cols, rows, cell, blocked, special, nearWall, worldToCell, cellToWorld, idx, inBounds, bounds };
}

export function buildNav(layout) {
  const { bounds, well } = layout;
  const escs = layout.escalators;

  // Ground: TWO boarding lanes (up + down-exit) carved as single cell-aligned
  // columns between the corridor rails. The rails' own cells stay blocked, so
  // routing can never plan a line through a physical rail (§28/§42).
  // Derived from each escalator's OWN board pad — centreline AND z. Deriving the
  // x while leaving the z hardcoded (as this first did) gave the rear bank a
  // boarding lane 35m from where it actually boards, carving open cells through
  // the middle of the sales floor.
  const lane = (e, from, to) => {
    const s = e.zSign ?? 1;
    const a = e.boardZ - s * from, b = e.boardZ + s * to;
    return { minX: e.x - 0.1, maxX: e.x + 0.1, minZ: Math.min(a, b), maxZ: Math.max(a, b) };
  };
  const lanes = escs.map(e => lane(e, 0.58, 1.05));
  const ground = buildGrid(bounds, layout.obstacles[0], lanes, []);

  // Mezzanine: everything forward of the slab edge is void; the well is a hole.
  const mezzBlocks = [
    { minX: bounds.minX, minZ: layout.mezz.maxZ, maxX: bounds.maxX, maxZ: bounds.maxZ, inflate: 0.28 },
    // ...and everything BEHIND it too: the balcony no longer runs to the back
    // wall, so the deep end of the store has no floor at mezzanine height. Left
    // out, routing would happily plan a path across thin air to the far wall.
    { minX: bounds.minX, minZ: bounds.minZ, maxX: bounds.maxX, maxZ: layout.mezz.minZ, inflate: 0.28 },
    ...(layout.wells || [well]).map(w => (
      { minX: w.minX, minZ: w.minZ, maxX: w.maxX, maxZ: w.maxZ, inflate: 0.26 })),
  ];
  // Same, off each escalator's own exit comb rather than the front bank's.
  const landingLanes = escs.map((e) => {
    const s = e.zSign ?? 1;
    const a = e.exitZ - s * 1.0, b = e.exitZ + s * 0.30;
    return { minX: e.x - 0.1, maxX: e.x + 0.1, minZ: Math.min(a, b), maxZ: Math.max(a, b) };
  });
  const mezz = buildGrid(bounds, layout.obstacles[1], landingLanes, mezzBlocks);

  const links = layout.navLinks.map(l => ({
    ...l,
    escalator: escs.find(e => e.id === l.esc),
  }));
  // Routing (grids) and physical collision (colliders) are separate systems:
  // the grid plans with extra clearance; the colliders are authoritative for
  // where the body can actually be.
  return { grids: [ground, mezz], links, escalators: escs, colliders: layout.colliders };
}

export function isOpen(grid, x, z) {
  const { cx, cz } = grid.worldToCell(x, z);
  return grid.inBounds(cx, cz) && !grid.blocked[grid.idx(cx, cz)];
}
export function isSpecial(grid, x, z) {
  const { cx, cz } = grid.worldToCell(x, z);
  return grid.inBounds(cx, cz) && !!grid.special[grid.idx(cx, cz)];
}

export function nearestOpen(grid, x, z, maxR = 3.0, allowSpecial = false) {
  const usable = (cx, cz) => !grid.blocked[grid.idx(cx, cz)] && (allowSpecial || !grid.special[grid.idx(cx, cz)]);
  {
    const { cx, cz } = grid.worldToCell(x, z);
    if (grid.inBounds(cx, cz) && usable(cx, cz)) return { x, z };
  }
  const start = grid.worldToCell(x, z);
  const maxCells = Math.ceil(maxR / grid.cell);
  for (let r = 1; r <= maxCells; r++) {
    let best = null, bestD = Infinity;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const cx = start.cx + dx, cz = start.cz + dz;
      if (!grid.inBounds(cx, cz) || !usable(cx, cz)) continue;
      const w = grid.cellToWorld(cx, cz);
      const d = (w.x - x) ** 2 + (w.z - z) ** 2;
      if (d < bestD) { bestD = d; best = w; }
    }
    if (best) return best;
  }
  return null;
}

// Exact line-of-sight: DDA supercover — visits EVERY cell the segment crosses.
export function lineOfSight(grid, x0, z0, x1, z1) {
  const { cell, bounds } = grid;
  let { cx, cz } = grid.worldToCell(x0, z0);
  const end = grid.worldToCell(x1, z1);
  if (!grid.inBounds(cx, cz) || grid.blocked[grid.idx(cx, cz)]) return false;
  const dx = x1 - x0, dz = z1 - z0;
  const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  let tMaxX = dx !== 0 ? ((bounds.minX + (cx + (stepX > 0 ? 1 : 0)) * cell) - x0) / dx : Infinity;
  let tMaxZ = dz !== 0 ? ((bounds.minZ + (cz + (stepZ > 0 ? 1 : 0)) * cell) - z0) / dz : Infinity;
  const tDeltaX = dx !== 0 ? Math.abs(cell / dx) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(cell / dz) : Infinity;
  let guard = 0;
  while (!(cx === end.cx && cz === end.cz)) {
    if (++guard > 4000) return false;
    if (Math.abs(tMaxX - tMaxZ) < 1e-9) {
      if (!grid.inBounds(cx + stepX, cz) || grid.blocked[grid.idx(cx + stepX, cz)]) return false;
      if (!grid.inBounds(cx, cz + stepZ) || grid.blocked[grid.idx(cx, cz + stepZ)]) return false;
      tMaxX += tDeltaX; tMaxZ += tDeltaZ; cx += stepX; cz += stepZ;
    } else if (tMaxX < tMaxZ) {
      tMaxX += tDeltaX; cx += stepX;
    } else {
      tMaxZ += tDeltaZ; cz += stepZ;
    }
    if (!grid.inBounds(cx, cz) || grid.blocked[grid.idx(cx, cz)]) return false;
  }
  return true;
}

export function findPath(grid, fromX, fromZ, toX, toZ, allowSpecialTarget = false) {
  const from = nearestOpen(grid, fromX, fromZ, 2.0, true);
  const to = nearestOpen(grid, toX, toZ, 2.5, allowSpecialTarget);
  if (!from || !to) return null;

  const s = grid.worldToCell(from.x, from.z);
  const g = grid.worldToCell(to.x, to.z);
  const { cols, rows, blocked, nearWall, idx } = grid;
  const N = cols * rows;
  const gScore = new Float32Array(N).fill(Infinity);
  const parent = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);

  const heap = [];
  const push = (f, i) => {
    heap.push([f, i]);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p][0] <= heap[c][0]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]]; c = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1, r = l + 1;
        let m = p;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === p) break;
        [heap[p], heap[m]] = [heap[m], heap[p]]; p = m;
      }
    }
    return top;
  };

  const h = (cx, cz) => {
    const dx = Math.abs(cx - g.cx), dz = Math.abs(cz - g.cz);
    return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz);
  };
  const si = idx(s.cx, s.cz), gi = idx(g.cx, g.cz);
  gScore[si] = 0;
  push(h(s.cx, s.cz), si);

  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

  let found = false;
  while (heap.length) {
    const [, ci] = pop();
    if (closed[ci]) continue;
    closed[ci] = 1;
    if (ci === gi) { found = true; break; }
    const cx = ci % cols, cz = (ci / cols) | 0;
    for (const [dx, dz, cost] of DIRS) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
      const ni = idx(nx, nz);
      if (blocked[ni] || closed[ni]) continue;
      if (dx && dz && (blocked[idx(cx + dx, cz)] || blocked[idx(cx, cz + dz)])) continue;
      const tentative = gScore[ci] + cost + (nearWall[ni] ? 0.45 : 0);
      if (tentative < gScore[ni]) {
        gScore[ni] = tentative;
        parent[ni] = ci;
        push(tentative + h(nx, nz), ni);
      }
    }
  }
  if (!found) return null;

  const cells = [];
  for (let ci = gi; ci !== -1; ci = parent[ci]) cells.push(ci);
  cells.reverse();
  let pts = cells.map(ci => grid.cellToWorld(ci % cols, (ci / cols) | 0));
  pts[0] = { x: from.x, z: from.z };
  pts[pts.length - 1] = { x: to.x, z: to.z };

  const smooth = [pts[0]];
  let anchor = 0;
  for (let i = 2; i < pts.length; i++) {
    if (!lineOfSight(grid, pts[anchor].x, pts[anchor].z, pts[i].x, pts[i].z)) {
      anchor = i - 1;
      smooth.push(pts[anchor]);
    }
  }
  smooth.push(pts[pts.length - 1]);
  return smooth;
}

// Cross-level routing. from/to: {x, z, level}. Returns segment list or null.
export function findPathMulti(nav, from, to) {
  if (from.level === to.level) {
    const pts = findPath(nav.grids[from.level], from.x, from.z, to.x, to.z);
    return pts ? [{ type: 'walk', level: from.level, points: pts }] : null;
  }
  // THERE IS MORE THAN ONE ESCALATOR BANK. Taking the first matching link sent
  // everyone to the west bank, so a shopper on the east side of the balcony
  // walked the full width of the building to get down — which is the whole
  // reason the second bank exists.
  //
  // Candidates are ordered by straight-line detour (how far out of your way the
  // bank is) and the first that actually routes wins. Ordering rather than
  // scoring every option keeps this at one pair of searches in the common case:
  // this runs per title, and the reachability suite calls it tens of thousands
  // of times.
  const candidates = nav.links
    .filter(l => l.fromLevel === from.level && l.toLevel === to.level)
    .map(l => ({
      l,
      cost: Math.hypot(l.from.x - from.x, l.from.z - from.z)
        + Math.hypot(to.x - l.to.x, to.z - l.to.z),
    }))
    .sort((a, b) => a.cost - b.cost);
  if (!candidates.length) return null;

  for (const { l: link } of candidates) {
    const leg1 = findPath(nav.grids[from.level], from.x, from.z, link.from.x, link.from.z, true);
    if (!leg1) continue;
    const leg2 = findPath(nav.grids[to.level], link.to.x, link.to.z, to.x, to.z);
    if (!leg2) continue;
    return [
      { type: 'walk', level: from.level, points: leg1 },
      { type: 'ride', link },
      { type: 'walk', level: to.level, points: leg2 },
    ];
  }
  return null;
}

export function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return d;
}
export function segmentsLength(segments) {
  let d = 0;
  for (const s of segments) {
    if (s.type === 'walk') d += pathLength(s.points);
    else d += 8; // nominal escalator length
  }
  return d;
}
