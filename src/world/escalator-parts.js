// ESCALATOR TRIM — the parts that make a blue wedge read as a machine.
//
// Pure geometry maths and canvas generators, no THREE and no scene graph, so
// every path in here can be asserted headlessly. `mezzanine.js` assembles the
// meshes; this file decides where the metal goes.
//
// Everything works in the HAND-DRAWN side elevation that mezzanine.js already
// uses for the cladding: z runs along the machine with the boarding newel at
// z = +2.30 and the top newel at z = -6.10, and y is height above the lower
// floor. mezzanine.js's Z() then re-expresses that against each bank's own
// board pad and mirrors it for the rear bank, so nothing here is ever
// front-bank specific.
//
// src/world/textures.js is FROZEN, which is why the two canvas generators at
// the bottom live here rather than alongside the store's other textures.

/**
 * Where the cladding's rounded newel corners actually are.
 *
 * The side cladding is an extruded polygon whose corners are filleted by
 * roundedProfile(pts, NEWEL_R). The two big fillets — radius 0.46 at the
 * boarding newel and at the top newel — ARE the visible round ends of the
 * machine, and the handrail has to wrap those exact arcs or it floats off in
 * mid-air. Rather than transcribe the arc centres, derive them from the same
 * corner points and radii the cladding is built from: a fillet's centre sits
 * one radius in along both edges meeting at the corner.
 *
 * Corner 1 of the profile is [2.30, deckH] with edges running down (+z side)
 * and left (-z), so its centre is inset by -z and -y.
 * Corner 4 is [-6.10, rise + deckH] with edges running right (+z) and down,
 * so its centre is inset by +z and -y.
 */
export function newelArcs(deckH, rise, newelR) {
  const rb = newelR[1], rt = newelR[4];
  return {
    bottom: { z: 2.30 - rb, y: deckH - rb, r: rb },
    top: { z: -6.10 + rt, y: rise + deckH - rt, r: rt },
  };
}

const DEG = Math.PI / 180;

/** Sample an arc of `r` about (cz,cy) from a° to b°, inclusive, every `step`°. */
function arc(cz, cy, r, a, b, step = 12) {
  const out = [];
  const n = Math.max(1, Math.ceil(Math.abs(b - a) / step));
  for (let i = 0; i <= n; i++) {
    const t = (a + (b - a) * (i / n)) * DEG;
    out.push([cz + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return out;
}

/**
 * The path a handrail (or the deck board under it) follows, as [z,y] pairs.
 *
 * THE DEFECT THIS REPLACES: the handrail was eight hand-placed points whose
 * return curves were an approximation of the newel — [2.38, 0.92] sits 0.19 m
 * OUTSIDE a fillet of radius 0.46 centred at (1.84, 0.56), and the run ended at
 * [2.02, 0.62] without ever re-entering the cladding. Rendered, that is a bare
 * black hook projecting from the end of the machine and stopping in mid-air,
 * which is the single most obviously-wrong detail on the escalator.
 *
 * Here the return is the newel fillet itself, offset outward by `off`, swept
 * past the bottom of the arc and then driven INWARD past the cladding surface
 * so the rail visibly disappears into the newel the way a real one does.
 *
 * @param off  how far outside the cladding this band rides (rail ~0.105, deck ~0.02)
 * @param wrap how far round the newel end the band sweeps, in degrees below the deck
 */
export function handrailPath(deckH, rise, newelR, { off = 0.105, wrap = 165, tuck = 0.17 } = {}) {
  const { bottom, top } = newelArcs(deckH, rise, newelR);
  const rb = bottom.r + off, rt = top.r + off;

  // Bottom newel: start tucked inside the cladding, sweep round the end, and
  // come out level with the deck.
  const bStart = 90 - wrap;
  const bArc = arc(bottom.z, bottom.y, rb, bStart, 90);
  const bTuck = tuckPoint(bottom, rb, bStart, tuck);

  // Top newel: leave the deck, sweep round and tuck in on the far side.
  const tEnd = 90 + wrap;
  const tArc = arc(top.z, top.y, rt, 90, tEnd);
  const tTuck = tuckPoint(top, rt, tEnd, tuck);

  return [
    bTuck,
    ...bArc,
    [1.10, deckH + off],                 // horizontal deck over the boarding flat
    [-4.90, rise + deckH + off],         // up the incline
    ...tArc,
    tTuck,
  ];
}

/** One point driven radially inward from an arc end, to bury the band's tail. */
function tuckPoint(c, r, deg, tuck) {
  const t = deg * DEG;
  const rr = r - tuck;
  return [c.z + rr * Math.cos(t), c.y + rr * Math.sin(t)];
}

/**
 * Where the handrail crosses the cladding surface — the point that needs an
 * entry guard, because a bare tube passing through a panel reads as clipping.
 */
export function handrailEntries(deckH, rise, newelR, { off = 0.105, wrap = 165 } = {}) {
  const { bottom, top } = newelArcs(deckH, rise, newelR);
  const at = (c, deg) => {
    const t = deg * DEG;
    return { z: c.z + c.r * Math.cos(t), y: c.y + c.r * Math.sin(t), angle: t };
  };
  return [at(bottom, 90 - wrap), at(top, 90 + wrap)];
}

/**
 * Comb teeth for one landing plate.
 *
 * A comb plate without teeth is a flat tab beside a grooved tread, and the eye
 * reads the join as a gap rather than a mesh. Teeth are the cheapest detail
 * that fixes it: they are only seen at the two moments a shopper is closest to
 * the machine — stepping on and stepping off.
 *
 * Returns tooth CENTRE offsets across the machine's width, in metres, so the
 * caller can merge them into one geometry rather than making N meshes.
 */
export function combTeeth(width, { pitch = 0.036, ratio = 0.55 } = {}) {
  const span = width - 0.12;
  const n = Math.max(4, Math.floor(span / pitch));
  const w = pitch * ratio;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ x: -span / 2 + pitch * (i + 0.5), w });
  }
  return out;
}

/**
 * The three straight runs that make up one side of the machine — boarding
 * flat, incline, top flat — as {z, y, len, rot} in hand-drawn space.
 *
 * The skirt panel, the deck trim and anything else that has to hug the step
 * band all follow this same broken line, so they are generated from one
 * description instead of three separately-tuned sets of magic numbers.
 */
export function runSegments(deckH, rise, { yOff = 0 } = {}) {
  // Bounded by the COMB PLATES, not by the machine's outer newels. The runs
  // exist to flank the moving step band, and the step band starts and stops at
  // the combs — a skirt drawn out to the newel stands 0.6 m proud of the
  // landing as a black tab beside the comb, which is what it did.
  //
  // ESC_Z re-expressed in this file's hand-drawn frame (subtract boardZ 5.10,
  // add 1.90): lowComb 1.25, inclineStart 0.95, inclineEnd -4.77, topComb -5.25.
  const flatA = { z0: 1.25, z1: 0.95, y0: 0, y1: 0 };
  const inc = { z0: 0.95, z1: -4.77, y0: 0, y1: rise };
  const flatB = { z0: -4.77, z1: -5.25, y0: rise, y1: rise };
  return [flatA, inc, flatB].map((s) => {
    const dz = s.z1 - s.z0, dy = s.y1 - s.y0;
    return {
      z: (s.z0 + s.z1) / 2,
      y: (s.y0 + s.y1) / 2 + yOff,
      len: Math.hypot(dz, dy),
      rot: Math.atan2(dy, -dz),   // -z is "forward up the machine"
    };
  });
}

// ---------------------------------------------------------------------------
// CANVAS GENERATORS
//
// textures.js is frozen, so these live here. Both are tiny and generated once
// per store, then shared by every bank.
// ---------------------------------------------------------------------------

/**
 * A soft contact shadow. Without one the machine's newel sits on the carpet
 * with no darkening at all and reads as pasted on rather than standing on the
 * floor — the same trick every prop in the store needs and this one lacked.
 */
export function makeContactShadow(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  // Elliptical falloff along the machine, softer across it.
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.30)');
  g.addColorStop(0.78, 'rgba(0,0,0,0.09)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/**
 * Brushed stainless for the deck board — the bright horizontal band that caps
 * a real balustrade. The escalator was a single flat navy mass from newel to
 * newel with one thin gold line across six metres of side elevation; this is
 * what gives it a second tonal band, and it is the cheapest way to stop the
 * machine reading as a painted ramp.
 */
export function makeBrushedMetal(w = 256, h = 32) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#6f757f');
  g.addColorStop(0.35, '#c3cad4');
  g.addColorStop(0.62, '#9aa2ad');
  g.addColorStop(1, '#5c626b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // lengthwise brushing
  ctx.globalAlpha = 0.16;
  for (let i = 0; i < w * 1.5; i++) {
    const y = Math.random() * h;
    ctx.strokeStyle = Math.random() < 0.5 ? '#ffffff' : '#3d434b';
    ctx.beginPath();
    ctx.moveTo(Math.random() * w, y);
    ctx.lineTo(Math.random() * w, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return c;
}
