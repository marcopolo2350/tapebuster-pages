// THE STORE'S GRAPHIC PROGRAM — one signwriter, five jobs.
import { allocCanvas } from './texture-budget.js';
//
// signage.js decided what a sign IS PHYSICALLY: its family, its board, its
// mounting, its elevation. This file decides what is PRINTED ON IT.
//
// What it replaces: makeHangingSign(text, sub, hue) — one canvas, one layout,
// one relationship between primary and secondary text, serving a department
// header, a directional call-out, a promo card and the checkout sign alike.
// Rendered, three things gave it away:
//
//   1. HUE WAS THE ONLY VARIABLE. hsla(hue,80%,60%,0.22) washed over navy made
//      HORROR purple, ANIME magenta and CHECKOUT olive-black. Twenty-four
//      department signs in one sightline read as a rainbow of unrelated
//      designs, and the tint cost the white type its contrast. A real retail
//      programme is ONE palette; the department is identified by its NAME.
//   2. THE CANVAS WAS A FIXED 560x220 ON BOARDS OF FIVE DIFFERENT ASPECTS, so
//      every face was non-uniformly stretched — up to 20% wider letterforms on
//      the department boards. Here the canvas is derived from the board at a
//      constant PX_PER_M, so a letter is the same shape on every sign.
//   3. THE MATERIAL CACHE KEY WAS (family, hue, text) while the face also
//      prints `sub`. Fifteen of the thirty-nine signs therefore inherited
//      another run's aisle codes: the mid-floor HORROR sign read
//      "AISLES HO-01 · HO-02", which is the front wall pair sixty metres away.
//      faceKey() is now derived from the composed face, so two signs share a
//      texture only when they are genuinely the same printed thing.
//
// THE VOCABULARY, and the reason it is this and not five graphic experiments:
// navy field, gold rules, white display type, cream utility type, one red
// accent reserved for promotional work. Square-cut aluminium panels — no
// rounded corners, no gradients, no glow, no bevels. Uppercase throughout. One
// condensed display cut, squeezed by a family-specific amount and tracked to
// its measure the way a signwriter spaces letters on a board. What differs
// between families is not the typeface: it is POLARITY (promo inverts to gold),
// ALIGNMENT (departments centre, navigation ranges left), DEVICE (code band /
// chevron / code plate / promo band / single rule), and SCALE.
//
// Nothing here reads the sign's `hue`. That is deliberate and it is the single
// biggest visual change in this pass: the colour was decoration that encoded
// nothing a shopper could use, and the store already codes department by the
// gold shelf header the sign hangs over.
//
// compose() is pure, canvas-free and node-importable, and it returns the exact
// numbers paint() draws with — cap heights in METRES, not in pixels of some
// canvas whose relationship to the board is unstated. That is what makes the
// legibility invariants testable: "DOCUMENTARY reads at 0.145 m cap height" is
// a fact about the store, "the font was 56px" is a fact about nothing.
import { BRAND } from '../config.js';
import { familyOf, boardSize } from './signage.js';

/** Canvas resolution of every printed face. One number, so a letter drawn on
 *  the checkout sign and a letter drawn on a department header are the same
 *  physical size for the same cap height. */
export const PX_PER_M = 320;

/** Cap height of the display face as a fraction of its em. Arial Black. */
export const CAP_EM = 0.716;

/**
 * Advance widths (em/1000) for the display cut. A width MODEL rather than a
 * measureText() call, because compose() has to run in node — the tests drive
 * the real composition, not a re-implementation of it. paint() still positions
 * each glyph on the browser's true metrics; only the FIT is predicted here,
 * and cap height — the quantity the legibility tests assert — is exact either
 * way, because condensing scales x and never the cap.
 */
const ADV = {
  ' ': 278, '&': 722, '·': 333, '-': 333, '–': 556, '—': 833, '.': 278, ',': 278,
  "'": 278, '/': 278, ':': 333, '!': 333,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556,
  K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556,
};
const ADV_DEFAULT = 700;

const PALETTE = {
  navy: BRAND.navy,
  navyDark: BRAND.navyDark,
  gold: BRAND.gold,
  goldLight: BRAND.goldLight,
  white: '#ffffff',
  cream: BRAND.cream,
  red: BRAND.red,
};

/** Width of a tracked, condensed setting, in ems of cap height. */
function measureCaps(text, squeeze, trackEm) {
  const s = String(text || '');
  if (!s.length) return 0;
  let em = 0;
  for (const ch of s) em += (ADV[ch] ?? ADV_DEFAULT) / 1000;
  return (em * squeeze + Math.max(0, s.length - 1) * trackEm) / CAP_EM;
}

/**
 * Set a line to a measure.
 *
 * The order of concessions is the signwriter's, not the programmer's: hold the
 * condensed cut, size the letters to fill the board, and only when a long word
 * still will not fit tighten the cut further. Returns what was ACTUALLY used.
 */
function setLine(text, { measureM, squeeze, trackEm, minCap, maxCap, fill = 0.9, squeezeMin }) {
  let sq = squeeze;
  const target = measureM * fill;
  let perCap = measureCaps(text, sq, trackEm);
  let capM = perCap > 0 ? Math.min(maxCap, Math.max(minCap, target / perCap)) : maxCap;
  // still over the measure at the smallest size this family allows? tighten the
  // cut, which is what a condensed face is FOR, down to the family's floor.
  if (squeezeMin && capM * perCap > measureM) {
    const need = measureM / (capM * perCap);
    sq = Math.max(squeezeMin, sq * need);
    perCap = measureCaps(text, sq, trackEm);
    capM = Math.min(maxCap, Math.max(minCap, target / perCap));
  }
  return {
    text: String(text || ''),
    capM: Math.round(capM * 10000) / 10000,
    squeeze: Math.round(sq * 1000) / 1000,
    trackEm,
    widthM: Math.round(capM * perCap * 10000) / 10000,
  };
}

/** The aisle code(s) a navigation sign carries, lifted out of its sub-line. */
function codeOf(sub) {
  const hits = String(sub || '').match(/[A-Z]{2}-\d{2}/g);
  return hits ? hits.join(' · ') : '';
}

/** Which way an escalator call-out points, from the glyph the layout gave it. */
function arrowDirOf(text) {
  if (/[↑▲]/.test(text)) return 'up';
  if (/[↓▼]/.test(text)) return 'down';
  return null;
}

/** The words, with the direction glyph removed — the chevron says that now. */
function stripArrows(text) {
  return String(text || '').replace(/[↑↓▲▼]/g, '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// THE FIVE COMPOSITIONS
// ---------------------------------------------------------------------------

function composeDepartment(sign, board) {
  // The primary navigational anchor, and the one that has to win against a
  // gold shelf header two metres below it. Full-bleed navy, a gold rule across
  // the top, and the aisle codes in a gold BAND along the bottom — a field of
  // their own, because gold-on-navy at 6 cm was unreadable from the aisle and
  // navy-on-gold at the same size is not.
  const ruleH = 0.045, bandH = 0.215;
  const pad = 0.065;
  const nameRegion = { top: ruleH + 0.02, bottom: 1 - bandH - 0.02 };
  const primary = setLine(sign.text, {
    measureM: board.w - pad * 2,
    squeeze: 0.82, trackEm: 0.06,
    minCap: 0.145, maxCap: 0.215, fill: 0.90, squeezeMin: 0.68,
  });
  const secondary = setLine(sign.sub, {
    measureM: board.w - pad * 2,
    squeeze: 0.90, trackEm: 0.14,
    minCap: 0.040, maxCap: 0.056, fill: 0.80, squeezeMin: 0.78,
  });
  return {
    tier: 1,
    field: PALETTE.navy,
    primary: { ...primary, ink: PALETTE.white, align: 'centre', italic: false, region: nameRegion },
    secondary: { ...secondary, ink: PALETTE.navy, align: 'centre', treatment: 'band' },
    device: { kind: 'code-band', bandH, bandField: PALETTE.gold },
    rules: [{ at: 'top', hFrac: ruleH, colour: PALETTE.gold }],
    arrow: null,
    pad,
  };
}

function composeEscalator(sign, board) {
  // Directional first. The old face put a text-glyph arrow at the end of the
  // words at the same weight as the words, so from the approach you had to
  // READ the sign to learn which way it went. Here a third of the board is a
  // gold panel carrying a drawn chevron nearly half the height of the sign:
  // the direction is legible before the destination is.
  const dir = arrowDirOf(sign.text) || 'up';
  const blockW = 0.26, pad = 0.055;
  const textLeft = blockW + 0.045;
  const measure = board.w * (1 - textLeft) - pad;
  const primary = setLine(stripArrows(sign.text), {
    measureM: measure,
    squeeze: 0.86, trackEm: 0.05,
    minCap: 0.135, maxCap: 0.178, fill: 0.90, squeezeMin: 0.72,
  });
  const level = dir === 'up' ? 'MEZZANINE · LEVEL 2' : 'GROUND FLOOR · LEVEL 1';
  const secondary = setLine(level, {
    measureM: measure,
    squeeze: 0.92, trackEm: 0.16,
    minCap: 0.044, maxCap: 0.058, fill: 0.86, squeezeMin: 0.80,
  });
  return {
    tier: 2,
    field: PALETTE.navy,
    primary: { ...primary, ink: PALETTE.white, align: 'left', italic: false, region: { top: 0.14, bottom: 0.63 } },
    secondary: { ...secondary, ink: PALETTE.goldLight, align: 'left', treatment: 'rule' },
    device: { kind: 'chevron-block', blockW, blockField: PALETTE.gold },
    rules: [{ at: 'inline', hFrac: 0.012, colour: PALETTE.gold }],
    arrow: { dir, hFrac: 0.44, wFrac: 0.155, ink: PALETTE.navy },
    textLeft,
    pad,
  };
}

function composeWayfinding(sign, board) {
  // Aisle marking, not a department header. Ranged LEFT off a gold code plate,
  // on one line, under a hairline: the information structure of a shelf-edge
  // ticket rather than a banner, and set materially smaller so it cannot be
  // mistaken for the department it sits beneath.
  const pad = 0.055;
  const code = codeOf(sign.sub) || String(sign.sub || '').slice(0, 8);
  const codeSet = setLine(code, {
    measureM: board.w * 0.34,
    squeeze: 0.94, trackEm: 0.10,
    minCap: 0.036, maxCap: 0.048, fill: 0.9, squeezeMin: 0.86,
  });
  const plateW = codeSet.widthM + 0.085;
  const measure = board.w - pad * 2 - plateW - 0.075;
  const primary = setLine(sign.text, {
    measureM: measure,
    squeeze: 0.90, trackEm: 0.04,
    minCap: 0.082, maxCap: 0.118, fill: 0.94, squeezeMin: 0.70,
  });
  return {
    tier: 3,
    field: PALETTE.navy,
    primary: { ...primary, ink: PALETTE.white, align: 'left', italic: false, region: { top: 0.16, bottom: 0.70 } },
    secondary: { ...codeSet, ink: PALETTE.navy, align: 'centre', treatment: 'plate' },
    device: { kind: 'code-plate', plateW, plateH: 0.42, plateField: PALETTE.gold },
    rules: [{ at: 'under', hFrac: 0.022, colour: PALETTE.gold }],
    arrow: null,
    pad,
  };
}

function composePromotional(sign, board) {
  // The only inverted card in the store: gold field, navy italic — the cut of
  // the TapeBuster mark itself, so a promo reads as house advertising rather
  // than architecture. Ranged left with a navy footer band and a single red
  // rule, and its secondary copy is set proportionally LARGER than a
  // department's, because a promo actually has something to say.
  const pad = 0.06, bandH = 0.26, borderH = 0.028;
  const primary = setLine(sign.text, {
    measureM: board.w - pad * 2,
    squeeze: 0.88, trackEm: 0.03,
    minCap: 0.100, maxCap: 0.145, fill: 0.92, squeezeMin: 0.70,
  });
  const secondary = setLine(sign.sub, {
    measureM: board.w - pad * 2,
    squeeze: 0.92, trackEm: 0.13,
    minCap: 0.040, maxCap: 0.052, fill: 0.84, squeezeMin: 0.80,
  });
  return {
    tier: 4,
    field: PALETTE.gold,
    primary: { ...primary, ink: PALETTE.navy, align: 'left', italic: true, region: { top: borderH + 0.06, bottom: 1 - bandH - 0.05 } },
    secondary: { ...secondary, ink: PALETTE.goldLight, align: 'left', treatment: 'footer' },
    device: { kind: 'promo-band', bandH, bandField: PALETTE.navy, accent: PALETTE.red, borderH },
    rules: [{ at: 'accent', hFrac: 0.030, colour: PALETTE.red }],
    arrow: null,
    pad,
  };
}

function composeService(sign, board) {
  // Functional building signage. Everything the other four do to be noticed,
  // this one declines: no band, no plate, no chevron, no condensed cut. Wide
  // letters, wide tracking, centred, one gold rule. It should look like it was
  // installed by the shopfitter, not printed by the marketing department.
  const pad = 0.10;
  const primary = setLine(sign.text, {
    measureM: board.w - pad * 2,
    squeeze: 0.97, trackEm: 0.14,
    minCap: 0.112, maxCap: 0.145, fill: 0.86, squeezeMin: 0.84,
  });
  const secondary = setLine(sign.sub, {
    measureM: board.w - pad * 2,
    squeeze: 0.96, trackEm: 0.22,
    minCap: 0.034, maxCap: 0.044, fill: 0.76, squeezeMin: 0.88,
  });
  return {
    tier: 5,
    field: PALETTE.navy,
    primary: { ...primary, ink: PALETTE.white, align: 'centre', italic: false, region: { top: 0.13, bottom: 0.60 } },
    secondary: { ...secondary, ink: PALETTE.cream, align: 'centre', treatment: 'plain' },
    device: { kind: 'single-rule', ruleY: 0.655, ruleH: 0.026, ruleW: 0.62, ruleColour: PALETTE.gold },
    rules: [{ at: 'under-primary', hFrac: 0.026, colour: PALETTE.gold }],
    arrow: null,
    pad,
  };
}

const COMPOSERS = {
  department: composeDepartment,
  escalator: composeEscalator,
  wayfinding: composeWayfinding,
  promotional: composePromotional,
  service: composeService,
};

/**
 * The printed face of a sign, as numbers. Pure — no canvas, no THREE — so the
 * tests drive the same composition the renderer draws rather than a copy of it.
 */
export function compose(sign, opts = {}) {
  const family = opts.family || familyOf(sign);
  const board = opts.board || boardSize(sign);
  const spec = COMPOSERS[family](sign, board);
  return {
    family,
    board: { w: board.w, h: board.h },
    canvas: { w: Math.round(board.w * PX_PER_M), h: Math.round(board.h * PX_PER_M) },
    ...spec,
  };
}

/**
 * Identity of a printed face. Two signs share one texture only when everything
 * that ends up ON the face is identical — which (text, hue, family) was not,
 * and fifteen signs carried another run's aisle codes because of it.
 */
export function faceKey(sign, opts) {
  const c = compose(sign, opts);
  return [
    c.family, c.canvas.w, c.canvas.h,
    c.primary.text, c.primary.capM, c.primary.squeeze, c.primary.align, c.primary.italic ? 'i' : 'r',
    c.secondary.text, c.secondary.capM, c.secondary.treatment,
    c.device.kind, c.arrow ? c.arrow.dir : '-',
  ].join('|');
}

/** A composition's shape, ignoring the words — for "are these two families
 *  actually the same design?". */
export function compositionSignature(sign) {
  const c = compose(sign);
  return [
    c.field, c.primary.ink, c.primary.align, c.primary.italic ? 'italic' : 'roman',
    c.primary.squeeze.toFixed(2), c.primary.trackEm.toFixed(3),
    c.secondary.treatment, c.secondary.ink,
    c.device.kind, c.arrow ? 'arrow' : 'no-arrow',
  ].join('|');
}

// ---------------------------------------------------------------------------
// PAINTING
// ---------------------------------------------------------------------------

// 35 unique sign faces at PX_PER_M = 320 were 20.6 MiB. Signs carry TEXT, so
// the 'sign' class is scaled gently (0.7 linear) rather than halved.
function canvasOf(w, h) {
  return allocCanvas(w, h, 'sign');
}

/**
 * Draw a line glyph by glyph, so tracking and the condensed cut are real rather
 * than a CSS property that may or may not exist. Positions use the browser's
 * true advances; the family's squeeze and the composed cap height are applied
 * exactly as composed.
 */
function drawLine(ctx, line, { x, y, maxW, align }) {
  const { text, capM, squeeze, trackEm, italic, ink } = line;
  if (!text) return 0;
  const fontPx = (capM * PX_PER_M) / CAP_EM;
  const trackPx = trackEm * fontPx;
  ctx.font = `${italic ? 'italic ' : ''}900 ${fontPx}px 'Arial Black','Arial',sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const chars = [...text];
  const adv = chars.map((ch) => ctx.measureText(ch).width * squeeze);
  let total = adv.reduce((a, b) => a + b, 0) + trackPx * Math.max(0, chars.length - 1);
  // the model predicted the fit; if the real face runs wide, hold the measure
  let extra = 1;
  if (maxW && total > maxW) { extra = maxW / total; total = maxW; }
  let cx = align === 'centre' ? x - total / 2 : x;
  ctx.fillStyle = ink;
  for (let i = 0; i < chars.length; i++) {
    ctx.save();
    ctx.translate(cx, y);
    ctx.scale(squeeze * extra, 1);
    ctx.fillText(chars[i], 0, 0);
    ctx.restore();
    cx += adv[i] * extra + trackPx * extra;
  }
  return total;
}

/** Baseline that puts a cap of this height centred in [top,bottom] of the board. */
function baselineIn(c, region, capM) {
  const top = region.top * c.canvas.h, bot = region.bottom * c.canvas.h;
  const capPx = capM * PX_PER_M;
  return (top + bot) / 2 + capPx / 2;
}

/** A solid directional chevron — drawn geometry, not a text glyph. */
function drawChevron(ctx, cx, cy, w, h, dir, ink) {
  const s = dir === 'up' ? -1 : 1;
  const headH = h * 0.52, shaftW = w * 0.36, shaftH = h - headH;
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * h / 2);                       // point
  ctx.lineTo(cx - w / 2, cy + s * (h / 2 - headH));
  ctx.lineTo(cx - shaftW / 2, cy + s * (h / 2 - headH));
  ctx.lineTo(cx - shaftW / 2, cy - s * h / 2);
  ctx.lineTo(cx + shaftW / 2, cy - s * h / 2);
  ctx.lineTo(cx + shaftW / 2, cy + s * (h / 2 - headH));
  ctx.lineTo(cx + w / 2, cy + s * (h / 2 - headH));
  ctx.closePath();
  ctx.fill();
  void shaftH;
}

/** The printed face of a sign, as a canvas. */
export function paintSign(sign, opts) {
  const c = compose(sign, opts);
  const W = c.canvas.w, H = c.canvas.h;
  const cv = canvasOf(W, H);
  const ctx = cv.getContext('2d');
  const padPx = (c.pad || 0.06) * PX_PER_M;

  ctx.fillStyle = c.field;
  ctx.fillRect(0, 0, W, H);

  if (c.device.kind === 'code-band') {
    // gold rule along the top, gold code band along the bottom
    const rule = c.rules[0];
    ctx.fillStyle = rule.colour;
    ctx.fillRect(0, 0, W, rule.hFrac * H);
    const bandTop = H * (1 - c.device.bandH);
    ctx.fillStyle = c.device.bandField;
    ctx.fillRect(0, bandTop, W, H - bandTop);
    // a hairline of the field colour inside the band's top edge: the panel is
    // fabricated in two pieces and the joint reads
    ctx.fillStyle = c.field;
    ctx.fillRect(0, bandTop, W, Math.max(2, H * 0.012));
    drawLine(ctx, c.primary, {
      x: W / 2, y: baselineIn(c, c.primary.region, c.primary.capM),
      maxW: W - padPx * 2, align: 'centre',
    });
    drawLine(ctx, c.secondary, {
      x: W / 2, y: bandTop + (H - bandTop) / 2 + (c.secondary.capM * PX_PER_M) / 2,
      maxW: W - padPx * 2, align: 'centre',
    });
  } else if (c.device.kind === 'chevron-block') {
    const bw = c.device.blockW * W;
    ctx.fillStyle = c.device.blockField;
    ctx.fillRect(0, 0, bw, H);
    drawChevron(ctx, bw / 2, H / 2, c.arrow.wFrac * W, c.arrow.hFrac * H, c.arrow.dir, c.arrow.ink);
    const tx = c.textLeft * W;
    drawLine(ctx, c.primary, {
      x: tx, y: baselineIn(c, c.primary.region, c.primary.capM),
      maxW: W - tx - padPx, align: 'left',
    });
    const ruleY = H * 0.685;
    ctx.fillStyle = c.rules[0].colour;
    ctx.fillRect(tx, ruleY, W - tx - padPx, Math.max(2, c.rules[0].hFrac * H));
    drawLine(ctx, c.secondary, {
      x: tx, y: ruleY + H * 0.055 + (c.secondary.capM * PX_PER_M),
      maxW: W - tx - padPx, align: 'left',
    });
  } else if (c.device.kind === 'code-plate') {
    const plateW = c.device.plateW * PX_PER_M;
    const plateH = c.device.plateH * H;
    const plateY = (H - plateH) / 2;
    ctx.fillStyle = c.device.plateField;
    ctx.fillRect(padPx, plateY, plateW, plateH);
    drawLine(ctx, c.secondary, {
      x: padPx + plateW / 2, y: plateY + plateH / 2 + (c.secondary.capM * PX_PER_M) / 2,
      maxW: plateW * 0.9, align: 'centre',
    });
    const tx = padPx + plateW + 0.075 * PX_PER_M;
    drawLine(ctx, c.primary, {
      x: tx, y: baselineIn(c, c.primary.region, c.primary.capM),
      maxW: W - tx - padPx, align: 'left',
    });
    ctx.fillStyle = c.rules[0].colour;
    ctx.fillRect(tx, H * 0.775, W - tx - padPx, Math.max(2, c.rules[0].hFrac * H));
  } else if (c.device.kind === 'promo-band') {
    ctx.fillStyle = c.device.bandField;
    ctx.fillRect(0, 0, W, H);                       // navy border...
    ctx.fillStyle = c.field;                        // ...gold card inside it
    const b = c.device.borderH * H;
    ctx.fillRect(b, b, W - b * 2, H - b * 2);
    const bandTop = H * (1 - c.device.bandH);
    ctx.fillStyle = c.device.bandField;
    ctx.fillRect(0, bandTop, W, H - bandTop);
    ctx.fillStyle = c.device.accent;                // one red rule, and only one
    ctx.fillRect(0, bandTop - c.rules[0].hFrac * H, W, c.rules[0].hFrac * H);
    drawLine(ctx, c.primary, {
      x: padPx, y: baselineIn(c, c.primary.region, c.primary.capM),
      maxW: W - padPx * 2, align: 'left',
    });
    drawLine(ctx, c.secondary, {
      x: padPx, y: bandTop + (H - bandTop) / 2 + (c.secondary.capM * PX_PER_M) / 2,
      maxW: W - padPx * 2, align: 'left',
    });
  } else {
    // single-rule: service
    drawLine(ctx, c.primary, {
      x: W / 2, y: baselineIn(c, c.primary.region, c.primary.capM),
      maxW: W - padPx * 2, align: 'centre',
    });
    const rw = c.device.ruleW * W;
    ctx.fillStyle = c.device.ruleColour;
    ctx.fillRect((W - rw) / 2, c.device.ruleY * H, rw, Math.max(2, c.device.ruleH * H));
    drawLine(ctx, c.secondary, {
      x: W / 2, y: H * 0.90, maxW: W - padPx * 2, align: 'centre',
    });
  }
  return cv;
}
