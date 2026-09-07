// Analytic player collision: circle (capsule footprint) vs categorized AABBs.
// Movement resolves flush against real surfaces with natural sliding — no grid
// quantization, no invisible padding. Pure module (Node-testable).
//
// The player's Y is always prescribed (floor level or escalator profile), so
// vertical collision (floors/ceiling) is enforced by construction; this module
// owns the horizontal world.
export const PLAYER_RADIUS = 0.30;
export const PLAYER_HEIGHT = 1.75;
const EPS = 0.001;

function circleHitsBox(x, z, r, b) {
  const cx = Math.max(b.minX, Math.min(x, b.maxX));
  const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
  const dx = x - cx, dz = z - cz;
  return dx * dx + dz * dz < r * r;
}

export function overlaps(colliders, x, z, r = PLAYER_RADIUS, exemptKinds = null) {
  for (const b of colliders) {
    if (exemptKinds && exemptKinds.has(b.kind)) continue;
    if (circleHitsBox(x, z, r, b)) return b;
  }
  return null;
}

// Move the circle by (dx, dz) with substepped, axis-separated resolution.
// Blocked axes snap flush to the surface (small realistic clearance), the
// free axis keeps sliding. If the start position is already overlapping
// (hostile start), motion is allowed whenever it reduces penetration depth.
export function resolveMove(colliders, x, z, dx, dz, r = PLAYER_RADIUS, exemptKinds = null) {
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-9) return { x, z, hit: null };
  const steps = Math.max(1, Math.ceil(dist / 0.08));
  const sx = dx / steps, sz = dz / steps;
  let hit = null;

  const depth = (px, pz) => {
    let d = 0;
    for (const b of colliders) {
      if (exemptKinds && exemptKinds.has(b.kind)) continue;
      if (!circleHitsBox(px, pz, r, b)) continue;
      const pen = Math.min(px + r - b.minX, b.maxX + r - px, pz + r - b.minZ, b.maxZ + r - pz);
      d = Math.max(d, pen);
    }
    return d;
  };
  const startStuck = depth(x, z) > 0;

  for (let i = 0; i < steps; i++) {
    // X axis
    let nx = x + sx;
    let bx = overlaps(colliders, nx, z, r, exemptKinds);
    if (!bx) {
      x = nx;
    } else if (startStuck && depth(nx, z) <= depth(x, z) + EPS) {
      x = nx; // escaping a hostile start
    } else {
      // snap flush against the blocking face
      const snapped = sx > 0 ? bx.minX - r - EPS : bx.maxX + r + EPS;
      if ((sx > 0 && snapped > x) || (sx < 0 && snapped < x)) {
        if (!overlaps(colliders, snapped, z, r, exemptKinds)) x = snapped;
      }
      hit = bx;
    }
    // Z axis
    let nz = z + sz;
    let bz = overlaps(colliders, x, nz, r, exemptKinds);
    if (!bz) {
      z = nz;
    } else if (startStuck && depth(x, nz) <= depth(x, z) + EPS) {
      z = nz;
    } else {
      const snapped = sz > 0 ? bz.minZ - r - EPS : bz.maxZ + r + EPS;
      if ((sz > 0 && snapped > z) || (sz < 0 && snapped < z)) {
        if (!overlaps(colliders, x, snapped, r, exemptKinds)) z = snapped;
      }
      hit = bz;
    }
  }
  return { x, z, hit };
}

// Push a stuck circle out of whatever it overlaps (used for recovery only).
export function pushOut(colliders, x, z, r = PLAYER_RADIUS, maxIter = 8) {
  for (let i = 0; i < maxIter; i++) {
    const b = overlaps(colliders, x, z, r);
    if (!b) return { x, z, free: true };
    const pens = [
      [x + r - b.minX, -1, 0], [b.maxX + r - x, 1, 0],
      [z + r - b.minZ, 0, -1], [b.maxZ + r - z, 0, 1],
    ].sort((a, c) => a[0] - c[0])[0];
    x += pens[1] * (pens[0] + EPS);
    z += pens[2] * (pens[0] + EPS);
  }
  return { x, z, free: !overlaps(colliders, x, z, r) };
}
