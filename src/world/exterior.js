// WHAT IS OUTSIDE THE BUILDING.
import { allocCanvas } from './texture-budget.js';
//
// The clerestory openings themselves were already good architecture — real
// reveal, real casing, a stooled sill, four widths on a designed rhythm. What
// was wrong was the VIEW: every one of the 77 openings showed the same picture,
// a dusk gradient with a flat strip of grey rectangles along the bottom. Eight
// seeds shuffled the rectangles; they did not change the kind of view. Looking
// left and looking right showed the same town, at the same horizon height, with
// nothing near, nothing far, and no foreground at all.
//
// TWO IDEAS FIX THAT.
//
// 1. ONE CONTINUOUS PANORAMA PER WALL, NOT ONE PICTURE PER WINDOW.
//    A real building's windows are holes in a wall, and what you see through
//    them is whatever happens to be behind that part of the wall. So each wall
//    gets a single long panorama and every opening shows the SLICE of it at its
//    own position. Adjacent windows then show adjacent parts of one place, the
//    view slides past as you walk the aisle, and the building reads as standing
//    somewhere rather than as 77 postcards.
//
// 2. THREE DEPTH LAYERS INSIDE THE REVEAL.
//    Far (sky and horizon), mid (the subject), near (whatever is right outside
//    the glass). Real planes at real depths, so walking past produces real
//    parallax instead of a sticker sliding with the wall.
//
// The three walls look out on three different places — car park, service yard,
// the town beyond — under ONE evening, with the sunset glow strongest on the
// west elevation and weakest on the north. That is what makes it one building
// on one evening instead of a slideshow.
//
// src/world/textures.js is FROZEN, which is why every canvas in here is new
// rather than an extension of makeSkyPanel().

/**
 * Where the ground line sits in every layer, as a fraction of canvas height.
 *
 * A clerestory is looked at from BELOW — eye level 1.65 m, band 4.3-5.5 m — so
 * the sightline runs UPWARD and the true horizon for a standing shopper is
 * 2.65 m below the sill. Nothing at ground level can be seen through one.
 *
 * This was 0.72, which put a receding tarmac plane across the bottom quarter of
 * every pane with parked cars standing on it — the single thing the geometry
 * makes impossible. The ground line now sits at the very bottom edge and only
 * the TOPS of things rise into view: lamp heads, parapets, fascias, spires,
 * wires. That is what you actually see out of a high window.
 */
export const HORIZON = 0.94;

/** Depths inside the reveal, in metres from the wall plane. */
export const LAYERS = [
  { key: 'far', z: 0.006, parallax: 0.0 },
  { key: 'mid', z: 0.055, parallax: 0.5 },
  { key: 'near', z: 0.100, parallax: 1.0 },
];

/**
 * The three elevations, and what each looks out on.
 *
 * `glow` is how much of the sunset this wall gets: the front of the building
 * faces the road, the LEFT (west) elevation takes the low sun, the BACK (north)
 * gets almost none. One evening, three aspects.
 */
export const WALL_SCENES = {
  left: { scene: 'carpark', glow: 1.0, seed: 20260819 },
  right: { scene: 'serviceyard', glow: 0.45, seed: 771103 },
  back: { scene: 'town', glow: 0.18, seed: 5150827 },
};

// deterministic per-panorama RNG — the exterior must be the same building every
// boot, or a screenshot means nothing
function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Which slice of the wall's panorama an opening at `u` metres along the wall
 * shows, as {offset, repeat} for a THREE texture.
 *
 * PARALLAX BY UV, NOT BY GEOMETRY. Only ~0.11 m of depth is available between
 * the back of the reveal and the glass, so moving the layers apart alone buys
 * very little. Scaling how fast each layer's slice ADVANCES along the wall does
 * the rest: the near layer tracks the wall almost one-for-one, the far layer
 * barely moves, exactly as distance behaves. Walk the aisle and the lamp posts
 * sweep past the skyline.
 */
// 36 m is exactly 9 window pitches, so the near layer — the loudest one, black
// silhouettes at alpha 0.94 — repeated identically every 9th opening down a
// 36-opening elevation. 37 puts the three periods at 9.25 / 13.4 / 24.3
// openings, none of which closes inside a wall or re-syncs with the others.
export const PANO_METRES = 37;

/**
 * @param uDir +1 if the pane's local +x runs the same way along the wall as u,
 *   -1 if it runs against it. DERIVED per wall by the caller, never assumed:
 *   the left elevation is placed at rotation +PI/2 and the right at -PI/2, which
 *   send local +x to world -z and +z respectively, so an identical UV bake on
 *   both walls runs the panorama BACKWARDS on one of them. That is this
 *   project's recurring defect — one wall's convention transcribed onto a
 *   population — and it was found for the tenth time here.
 */
export function sliceFor(u, wallLen, paneW, layer, uDir = 1) {
  // how fast this layer's slice ADVANCES along the wall, by depth
  const rate = 1 - 0.62 * (1 - layer.parallax);      // far 0.38, mid 0.69, near 1.0
  // THE PANORAMA TILES; IT DOES NOT SPAN THE WALL.
  //
  // Mapping one 2048 px canvas across a 148 m elevation gives each 2.6 m
  // opening 34 px of image stretched over the whole pane — measured, that is
  // what made the first attempt a blurry gradient with the occasional smear.
  // A 36 m period gives an opening ~150 px, which is real detail, and the three
  // layers advance at 0.38 / 0.69 / 1.0 so their repeats never coincide: the
  // near rank of lamp posts comes round every 36 m of wall, the skyline behind
  // it every 95 m, and the combination does not visibly cycle over 148 m.
  // RATE BELONGS TO THE ADVANCE, NOT TO THE SCALE.
  //
  // `repeat` was also multiplied by `rate`, and the two cancelled: the advance
  // measured in PANE WIDTHS came out at pitch/paneW = 1.5385 for all three
  // layers, identical to four decimal places. The layers scrolled as one rigid
  // stack and there was no parallax at all — the one thing this module exists
  // to provide. The only surviving effect of `rate` was that the FAR layer
  // showed 0.99 m of world across a pane where the near layer showed 2.60 m,
  // drawing the distance 2.63x LARGER than the foreground and inverting aerial
  // perspective.
  //
  // Every layer is now drawn at one metres-per-texel, and only the advance
  // differs: 0.58 / 1.06 / 1.54 pane-widths per 4 m pitch. The far layer
  // overlaps its neighbour, so a distant spire persists across three openings
  // at shifted positions; the near layer advances 1:1 with the wall, so its
  // image joins across the pier.
  const repeat = paneW / PANO_METRES;
  const centre = 0.5 + ((u * uDir) / PANO_METRES) * rate;
  return { repeat, offset: centre - repeat / 2 };
}

// ---------------------------------------------------------------------------
// PANORAMA PAINTING
//
// Every canvas is drawn at a fixed aspect and then sliced by UV, so the width
// of the opening no longer stretches the image — the old code mapped one
// 256x128 texture across a type C pane (0.68x) and a type B pane (1.34x), a
// 1.97x horizontal stretch between the narrowest and widest openings on the
// same elevation.
// ---------------------------------------------------------------------------

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [
  Math.round(lerp(c1[0], c2[0], t)), Math.round(lerp(c1[1], c2[1], t)), Math.round(lerp(c1[2], c2[2], t)),
];
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// The three panorama layers per wall were 9 x 2048x256 = 24.0 MiB, the second
// largest static texture block in the scene and identical on a phone.
function canvas(w, h) {
  return allocCanvas(w, h, 'pano');
}

/**
 * FAR: the sky, the horizon haze, and whatever is far enough away to be flat.
 * Opaque — this is the backdrop everything else sits in front of.
 */
export function makeFarLayer(wall, w = 2048, h = 256) {
  const cfg = WALL_SCENES[wall];
  const r = rng(cfg.seed);
  const c = canvas(w, h);
  const ctx = c.getContext('2d');

  // One evening, three aspects. The zenith is the same on every wall; only the
  // horizon warms, by how much of the sunset this elevation faces.
  const zenith = [24, 28, 62];
  const band = mix([44, 46, 92], [150, 96, 84], cfg.glow);
  const horizon = mix([92, 98, 132], [244, 168, 96], cfg.glow);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, rgb(zenith));
  g.addColorStop(0.42, rgb(band));
  g.addColorStop(0.80, rgb(horizon));
  g.addColorStop(1, rgb(mix(horizon, [40, 44, 66], 0.55)));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // stars, thinning toward the glow
  for (let i = 0; i < 340; i++) {
    const x = r() * w, y = r() * h * 0.5;
    const a = (1 - y / (h * 0.5)) * 0.55 * (1 - cfg.glow * 0.55) * r();
    if (a <= 0.02) continue;
    ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
    ctx.fillRect(x, y, 1.2, 1.2);
  }

  // far horizon: hills on the town elevation, flat plant on the others
  const hy = h * HORIZON;
  ctx.fillStyle = rgb(mix(horizon, [30, 32, 54], 0.72), 0.85);
  ctx.beginPath();
  ctx.moveTo(0, h);
  if (wall === 'back') {
    // INTEGER harmonics of the canvas width, so the ridge line meets itself
    // where the panorama tiles and there is no seam down the elevation.
    for (let x = 0; x <= w; x += 16) {
      const k = (x / w) * Math.PI * 2;
      const y = hy - 16 - Math.sin(k * 3) * 9 - Math.sin(k * 7 + 1.1) * 6;
      ctx.lineTo(x, y);
    }
  } else {
    for (let x = 0; x <= w; x += 64) ctx.lineTo(x, hy - 2 - (r() < 0.5 ? 0 : 3));
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();

  // No ground plane: see HORIZON. What sits below the far silhouette is the
  // haze the distance dissolves into, not tarmac.
  return c;
}

/** A lit window grid on a distant block. */
function litWindows(ctx, x, y, bw, bh, r, warm) {
  const cw = 3, ch = 4, gap = 3;
  for (let wy = y + 4; wy < y + bh - 4; wy += ch + gap) {
    for (let wx = x + 3; wx < x + bw - 4; wx += cw + gap) {
      if (r() > (warm ? 0.42 : 0.24)) continue;
      const a = 0.35 + r() * 0.5;
      ctx.fillStyle = `rgba(255,${208 + Math.floor(r() * 40)},${140 + Math.floor(r() * 60)},${a.toFixed(2)})`;
      ctx.fillRect(wx, wy, cw, ch);
    }
  }
}

/**
 * MID: the subject of the view. Transparent background — the far layer shows
 * through — and a DIFFERENT KIND OF PLACE on each elevation.
 */
export function makeMidLayer(wall, w = 2048, h = 256) {
  const cfg = WALL_SCENES[wall];
  const r = rng(cfg.seed ^ 0x9e37);
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  const hy = h * HORIZON;

  if (cfg.scene === 'carpark') {
    // A retail car park: the far shed with its sign, ranks of lamp standards,
    // parked cars, a trolley bay. Everything sits ON the ground line.
    // DISCRETE BUILDINGS WITH SKY BETWEEN THEM. A continuous band across the
    // whole panorama reads as a stripe once a 2.6 m opening samples only ~150 px
    // of it — which is exactly how the first attempt looked through the glass.
    for (let x = 40; x < w; x += 210 + r() * 210) {
      const sw = 70 + r() * 130;
      const sh = 40 + r() * 44;
      ctx.fillStyle = 'rgba(30,32,48,0.97)';
      ctx.fillRect(x, hy - sh, sw, sh);
      ctx.fillStyle = 'rgba(52,55,76,0.95)';               // parapet catching the glow
      ctx.fillRect(x, hy - sh, sw, 3);
      ctx.fillStyle = 'rgba(30,32,48,0.97)';
      if (r() < 0.5) {                                     // a lit fascia sign
        ctx.fillStyle = `rgba(${200 + r() * 55 | 0},${90 + r() * 60 | 0},60,0.75)`;
        ctx.fillRect(x + 10, hy - sh + 9, sw - 20, 7);
      }
    }
    // (parked cars used to be drawn along the ground line here. A 61 mm-tall car
    // at world y 4.64, seen on a 17-45 degree UPWARD sightline, cannot be in
    // shot — removed rather than shrunk.)
    // lamp standards — the rhythm of a car park, and the thing that will
    // parallax hardest against the shed behind it
    for (let x = 90; x < w; x += 210) {
      ctx.fillStyle = 'rgba(22,24,34,0.98)';
      ctx.fillRect(x, hy - 150, 4, 150);
      ctx.fillRect(x - 13, hy - 155, 31, 6);
      const lg = ctx.createRadialGradient(x + 2, hy - 152, 1, x + 2, hy - 152, 46);
      lg.addColorStop(0, 'rgba(255,238,196,0.95)');
      lg.addColorStop(0.3, 'rgba(255,218,158,0.34)');
      lg.addColorStop(1, 'rgba(255,210,150,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(x - 48, hy - 200, 100, 100);
    }
  } else if (cfg.scene === 'serviceyard') {
    // The back of the neighbouring units: roller shutters, a skip, stacked
    // pallets, a security flood on a pole. Lower, closer, meaner than the
    // car park — a different KIND of place, not the same place reseeded.
    ctx.fillStyle = 'rgba(34,35,48,0.97)';
    ctx.fillRect(0, hy - 86, w, 86);
    for (let x = 0; x < w; x += 128) {                     // roller shutters
      ctx.fillStyle = 'rgba(48,50,64,0.95)';
      ctx.fillRect(x + 14, hy - 62, 74, 62);
      ctx.strokeStyle = 'rgba(22,23,32,0.55)';
      ctx.lineWidth = 1;
      for (let y = hy - 58; y < hy; y += 6) {
        ctx.beginPath(); ctx.moveTo(x + 14, y); ctx.lineTo(x + 88, y); ctx.stroke();
      }
      if (r() < 0.35) {                                    // a door light left on
        ctx.fillStyle = 'rgba(255,226,170,0.42)';
        ctx.fillRect(x + 96, hy - 44, 7, 7);
      }
    }
    // (skips and pallets stood on the ground and are below the sightline too)
    for (let x = 150; x < w; x += 330) {                   // security floods
      ctx.fillStyle = 'rgba(22,24,34,0.98)';
      ctx.fillRect(x, hy - 122, 4, 122);
      ctx.fillRect(x - 9, hy - 128, 20, 7);
      const lg = ctx.createRadialGradient(x + 1, hy - 125, 1, x + 1, hy - 125, 40);
      lg.addColorStop(0, 'rgba(214,238,255,0.85)');
      lg.addColorStop(1, 'rgba(190,220,255,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(x - 42, hy - 166, 86, 86);
    }
  } else {
    // The town: blocks of different heights with lit windows, a spire, a water
    // tower, a road of tail-lights along the bottom.
    let x = 0;
    while (x < w) {
      const bw = 26 + r() * 66;
      const bh = 46 + r() * 132;
      ctx.fillStyle = `rgba(${22 + r() * 12 | 0},${24 + r() * 12 | 0},${38 + r() * 14 | 0},0.97)`;
      ctx.fillRect(x, hy - bh, bw, bh);
      litWindows(ctx, x, hy - bh, bw, bh, r, false);
      if (r() < 0.10) {                                    // aircraft warning light
        ctx.fillStyle = 'rgba(255,70,70,0.9)';
        ctx.fillRect(x + bw / 2 - 1, hy - bh - 4, 2, 3);
      }
      x += bw + 4 + r() * 10;
    }
    for (let k = 0; k < 3; k++) {                          // landmarks
      const lx = 200 + k * 680 + r() * 180;
      if (k % 2 === 0) {                                   // spire
        ctx.fillStyle = 'rgba(20,22,34,0.98)';
        ctx.fillRect(lx, hy - 168, 18, 168);
        ctx.beginPath();
        ctx.moveTo(lx - 4, hy - 168); ctx.lineTo(lx + 9, hy - 214); ctx.lineTo(lx + 22, hy - 168);
        ctx.closePath(); ctx.fill();
      } else {                                             // water tower
        ctx.fillStyle = 'rgba(20,22,34,0.98)';
        ctx.fillRect(lx + 8, hy - 140, 5, 140);
        ctx.fillRect(lx + 30, hy - 140, 5, 140);
        ctx.fillRect(lx, hy - 180, 44, 34);
      }
    }
    // (the road of tail-lights ran along the ground line and is below the
    // sightline — the town now reads by its lit windows and its landmarks)
  }
  return c;
}

/**
 * NEAR: what is just outside the glass. Sparse and high-contrast on purpose —
 * only ~0.11 m of real depth is available inside the reveal, so the near layer
 * has to earn its distance by being big, dark and fast rather than by being
 * physically far forward.
 */
export function makeNearLayer(wall, w = 2048, h = 256) {
  const cfg = WALL_SCENES[wall];
  const r = rng(cfg.seed ^ 0x51ed);
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  const dark = 'rgba(10,11,18,0.94)';

  if (cfg.scene === 'carpark') {
    // the near rank of lamp standards, close enough to be cut off by the head
    for (let x = 120; x < w; x += 520) {
      ctx.fillStyle = dark;
      ctx.fillRect(x, 0, 9, h);
      ctx.fillRect(x - 26, 8, 60, 9);
      const lg = ctx.createRadialGradient(x + 4, 14, 2, x + 4, 14, 60);
      lg.addColorStop(0, 'rgba(255,236,190,0.55)');
      lg.addColorStop(1, 'rgba(255,220,170,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(x - 56, 0, 120, 120);
    }
    for (let x = 340; x < w; x += 1040) {                  // a young car-park tree
      ctx.fillStyle = 'rgba(14,20,18,0.9)';
      ctx.fillRect(x, h * 0.45, 5, h * 0.55);
      for (let k = 0; k < 22; k++) {
        const bx = x - 30 + r() * 66, by = h * 0.42 + r() * 46;
        ctx.fillRect(bx, by, 3 + r() * 8, 2 + r() * 3);
      }
    }
  } else if (cfg.scene === 'serviceyard') {
    // chain-link, and a downpipe every few bays
    ctx.strokeStyle = 'rgba(120,126,140,0.30)';
    ctx.lineWidth = 1;
    for (let x = -h; x < w; x += 14) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + h, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + h, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let x = 60; x < w; x += 300) {
      ctx.fillStyle = 'rgba(96,102,116,0.55)';
      ctx.fillRect(x, 0, 4, h);                            // fence post
    }
    for (let x = 220; x < w; x += 880) {
      ctx.fillStyle = dark;
      ctx.fillRect(x, 0, 8, h);                            // downpipe
      ctx.fillRect(x - 4, h * 0.62, 16, 6);                // bracket
    }
  } else {
    // bare branches and a run of telephone wire across the town
    ctx.strokeStyle = 'rgba(12,14,22,0.75)';
    for (let k = 0; k < 3; k++) {
      ctx.lineWidth = 1.6 - k * 0.4;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 32) {
        const y = 34 + k * 15 + Math.sin(x / 260 + k) * 10;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    for (let x = 180; x < w; x += 940) {                   // a bare tree crown
      ctx.strokeStyle = 'rgba(10,12,18,0.92)';
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + 4, h * 0.3); ctx.stroke();
      for (let k = 0; k < 14; k++) {
        ctx.lineWidth = 1 + r() * 1.6;
        const y0 = h * (0.3 + r() * 0.4);
        ctx.beginPath();
        ctx.moveTo(x + 4, y0);
        ctx.lineTo(x + 4 + (r() - 0.5) * 90, y0 - r() * 60);
        ctx.stroke();
      }
    }
  }
  return c;
}

/** All three layers for one wall, in draw order. */
export function makeWallPanorama(wall, w = 2048, h = 256) {
  return {
    far: makeFarLayer(wall, w, h),
    mid: makeMidLayer(wall, w, h),
    near: makeNearLayer(wall, w, h),
  };
}
