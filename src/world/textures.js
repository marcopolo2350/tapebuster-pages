// Procedural texture factory — every visual asset in TapeBuster is generated
// here on canvas: cover art, signage, carpet, walls, night backdrop, snacks.
// No copyrighted artwork, no downloads, fully deterministic per title id.
import { BRAND } from '../config.js';
import { allocCanvas } from './texture-budget.js';
import { isMobile } from '../systems/device.js';

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Static-scene canvases go through the texture budget (see texture-budget.js):
// this set was 134 MiB with no ceiling and no mobile profile. The COVER path
// below (createAtlasCanvas / drawAtlasTiles / makeHiResCover / makeThumb) does
// NOT — atlas UVs are computed from exact tile pixel sizes, and the streamer
// already meters itself to the byte.
function cv(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function hsl(h, s, l, a = 1) { return `hsla(${h},${s}%,${l}%,${a})`; }

function speckle(ctx, x, y, w, h, n, rng, colors, maxR = 1.4) {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[(rng() * colors.length) | 0];
    const r = 0.4 + rng() * maxR;
    ctx.beginPath();
    ctx.arc(x + rng() * w, y + rng() * h, r, 0, 7);
    ctx.fill();
  }
}

function fitFont(ctx, text, maxW, startPx, family, weight = '900') {
  let px = startPx;
  for (; px > 5; px--) {
    ctx.font = `${weight} ${px}px ${family}`;
    if (ctx.measureText(text).width <= maxW) break;
  }
  return px;
}

// Split a title into 1-3 balanced lines.
function titleLines(title) {
  const words = title.toUpperCase().split(/\s+/);
  if (words.length === 1) return [words[0]];
  if (words.length === 2) return words.join(' ').length <= 12 ? [words.join(' ')] : words;
  const total = words.join(' ').length;
  if (total <= 14) return [words.join(' ')];
  // order-preserving split at the most balanced break point
  let best = 1, bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const l = words.slice(0, i).join(' ').length;
    const r = words.slice(i).join(' ').length;
    if (Math.abs(l - r) < bestDiff) { bestDiff = Math.abs(l - r); best = i; }
  }
  const out = [words.slice(0, best).join(' '), words.slice(best).join(' ')];
  if (out.some(l => l.length > 16) && words.length >= 3) {
    const third = Math.ceil(words.length / 3);
    return [words.slice(0, third).join(' '), words.slice(third, third * 2).join(' '), words.slice(third * 2).join(' ')].filter(Boolean);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Genre palettes + motifs
// ---------------------------------------------------------------------------
// Motif pools are DELIBERATELY WIDE. They used to hold three each, and with the
// pick being a single rng draw a big department turned into a wall of clones —
// Drama had ['spot','horizonsun','window'], so one shelf of drama showed the
// same beige window over and over. Every genre now draws from six or more, and
// the composition varies independently on top (see styleFor.layout).
const GENRE_STYLE = {
  Horror:      { hue: 355, motifs: ['jagged', 'moon', 'drip', 'smoke', 'spot', 'blinds', 'castle'] },
  'Sci-Fi':    { hue: 215, motifs: ['starfield', 'gridhorizon', 'planet', 'rays', 'speedlines', 'skyline', 'circles'] },
  Action:      { hue: 22,  motifs: ['burst', 'diagonals', 'skyline', 'speedlines', 'smoke', 'spot', 'tilt'] },
  Thriller:    { hue: 192, motifs: ['blinds', 'skyline', 'spot', 'smoke', 'diagonals', 'moon', 'window'] },
  Crime:       { hue: 205, motifs: ['skyline', 'blinds', 'spot', 'smoke', 'diagonals', 'moon'] },
  Mystery:     { hue: 250, motifs: ['spot', 'blinds', 'moon', 'window', 'smoke', 'circles', 'rays'] },
  Drama:       { hue: 210, motifs: ['spot', 'horizonsun', 'window', 'blinds', 'circles', 'hills', 'skyline', 'clean', 'rays'] },
  Comedy:      { hue: 48,  motifs: ['confetti', 'tilt', 'burst', 'circles', 'balloons', 'rays', 'hills'] },
  Romance:     { hue: 340, motifs: ['circles', 'horizonsun', 'confetti', 'rays', 'bigsun', 'window', 'hills'] },
  Family:      { hue: 140, motifs: ['hills', 'balloons', 'horizonsun', 'circles', 'confetti', 'bigsun', 'castle'] },
  Animation:   { hue: 150, motifs: ['hills', 'balloons', 'confetti', 'circles', 'bigsun', 'rays', 'tilt'] },
  Anime:       { hue: 320, motifs: ['bigsun', 'speedlines', 'hills', 'rays', 'circles', 'gridhorizon', 'confetti'] },
  Fantasy:     { hue: 268, motifs: ['castle', 'starfield', 'moon', 'hills', 'rays', 'bigsun', 'circles'] },
  Adventure:   { hue: 130, motifs: ['horizonsun', 'hills', 'diagonals', 'desert', 'bigsun', 'castle', 'skyline'] },
  Western:     { hue: 32,  motifs: ['desert', 'horizonsun', 'diagonals', 'bigsun', 'hills', 'smoke'] },
  War:         { hue: 78,  motifs: ['smoke', 'diagonals', 'skyline', 'jagged', 'spot', 'burst'] },
  Documentary: { hue: 212, motifs: ['clean', 'window', 'horizonsun', 'circles', 'hills', 'skyline', 'blinds'] },
  Musical:     { hue: 300, motifs: ['rays', 'burst', 'confetti', 'circles', 'balloons', 'spot', 'tilt'] },
  Fear:        { hue: 0,   motifs: ['jagged', 'drip', 'smoke', 'moon'] },
};

// How the type is arranged. This is the other half of the fix: the motif was
// only ever the BACKGROUND, and every one of the 15,000 covers laid its type out
// identically — credit across the top, title bottom-centre, year bottom-left.
// Same picture, different words. Real shelves do not look like that.
const COVER_LAYOUTS = ['bottom', 'top', 'band', 'hero', 'corner'];

function styleFor(t, rng) {
  const g = GENRE_STYLE[t.genres[0]] || { hue: 210, motifs: ['clean'] };
  // bright genres drift further so a shelf of comedies isn't a wall of one color
  const bright = ['Comedy', 'Family', 'Animation', 'Anime', 'Romance', 'Musical', 'Adventure'].includes(t.genres[0]);
  const hue = (g.hue + (rng() - 0.5) * (bright ? 85 : 26) + 360) % 360;
  const moody = ['Horror', 'Thriller', 'Crime', 'Mystery', 'War', 'Sci-Fi', 'Fantasy'].includes(t.genres[0]);
  const retro = t.year < 1980;
  // A LIGHT ground for some covers. Everything used to be a dark-to-mid gradient,
  // which is most of why a shelf read as one texture; a paper-white or poster-ink
  // cover every few titles breaks the run without inventing new artwork.
  const light = !moody && !retro && rng() < 0.34;
  return {
    hue,
    // Second, independent draw: the accent drives duotone washes and type colour,
    // so two covers sharing a motif still differ.
    accent: (hue + 120 + rng() * 120) % 360,
    motif: g.motifs[(rng() * g.motifs.length) | 0],
    layout: COVER_LAYOUTS[(rng() * COVER_LAYOUTS.length) | 0],
    dark: moody,
    light,
    retro,
    // Serif on a slab-typographic cover reads as prestige rather than as a typo.
    serif: retro || rng() < 0.22,
  };
}

const MOTIFS = {
  starfield(ctx, x, y, w, h, rng, st) {
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.25 + rng() * 0.75})`;
      ctx.fillRect(x + rng() * w, y + rng() * h * 0.8, rng() < 0.12 ? 2 : 1, rng() < 0.12 ? 2 : 1);
    }
    const px = x + w * (0.25 + rng() * 0.5), py = y + h * (0.2 + rng() * 0.25), pr = w * (0.18 + rng() * 0.2);
    const gr = ctx.createRadialGradient(px - pr * 0.4, py - pr * 0.4, pr * 0.1, px, py, pr);
    gr.addColorStop(0, hsl(st.hue, 70, 62)); gr.addColorStop(1, hsl(st.hue, 80, 22));
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(px, py, pr, 0, 7); ctx.fill();
  },
  planet(ctx, x, y, w, h, rng, st) {
    MOTIFS.starfield(ctx, x, y, w, h, rng, st);
    ctx.strokeStyle = hsl((st.hue + 140) % 360, 80, 60, 0.9);
    ctx.lineWidth = Math.max(1.5, w * 0.012);
    ctx.beginPath(); ctx.ellipse(x + w / 2, y + h * 0.32, w * 0.34, h * 0.07, -0.3, 0, 7); ctx.stroke();
  },
  gridhorizon(ctx, x, y, w, h, rng, st) {
    MOTIFS.starfield(ctx, x, y, w, h * 0.6, rng, st);
    const hy = y + h * 0.62;
    ctx.strokeStyle = hsl((st.hue + 90) % 360, 90, 60, 0.8);
    ctx.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      const t = i / 7;
      ctx.beginPath(); ctx.moveTo(x, hy + t * t * (h * 0.38)); ctx.lineTo(x + w, hy + t * t * (h * 0.38)); ctx.stroke();
    }
    for (let i = -6; i <= 6; i++) {
      ctx.beginPath(); ctx.moveTo(x + w / 2 + i * w * 0.09, hy); ctx.lineTo(x + w / 2 + i * w * 0.32, y + h); ctx.stroke();
    }
  },
  jagged(ctx, x, y, w, h, rng, st) {
    ctx.fillStyle = 'rgba(4,2,6,0.88)';
    ctx.beginPath(); ctx.moveTo(x, y + h);
    let px = x;
    while (px < x + w) {
      px += w * (0.06 + rng() * 0.12);
      ctx.lineTo(px, y + h * (0.35 + rng() * 0.5));
    }
    ctx.lineTo(x + w, y + h); ctx.closePath(); ctx.fill();
    ctx.fillStyle = hsl(st.hue, 85, 55, 0.9);
    const mx = x + w * (0.3 + rng() * 0.4), my = y + h * (0.2 + rng() * 0.15);
    ctx.beginPath(); ctx.arc(mx, my, w * 0.13, 0, 7); ctx.fill();
  },
  moon(ctx, x, y, w, h, rng, st) {
    const mx = x + w * (0.3 + rng() * 0.4), my = y + h * (0.18 + rng() * 0.2), r = w * (0.16 + rng() * 0.1);
    const gr = ctx.createRadialGradient(mx, my, r * 0.2, mx, my, r * 2.4);
    gr.addColorStop(0, 'rgba(255,250,230,0.95)'); gr.addColorStop(0.35, 'rgba(255,250,230,0.25)'); gr.addColorStop(1, 'rgba(255,250,230,0)');
    ctx.fillStyle = gr; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#0a0a12';
    for (let i = 0; i < 5; i++) {
      const bx = x + rng() * w;
      ctx.fillRect(bx, y + h * (0.55 + rng() * 0.3), 2 + rng() * 5, h);
    }
  },
  drip(ctx, x, y, w, h, rng, st) {
    ctx.fillStyle = hsl(st.hue, 80, 34, 0.95);
    ctx.fillRect(x, y, w, h * 0.16);
    for (let px = x; px < x + w; px += 4 + rng() * 10) {
      const len = h * (0.05 + rng() * 0.32);
      ctx.fillRect(px, y + h * 0.14, 2 + rng() * 3, len);
      ctx.beginPath(); ctx.arc(px + 2, y + h * 0.14 + len, 2 + rng() * 2, 0, 7); ctx.fill();
    }
  },
  burst(ctx, x, y, w, h, rng, st) {
    const cx = x + w / 2, cyy = y + h * 0.44;
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + rng() * 0.1;
      ctx.strokeStyle = hsl((st.hue + rng() * 40) % 360, 90, 55 + rng() * 20, 0.75);
      ctx.lineWidth = 2 + rng() * 4;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * w * 0.1, cyy + Math.sin(a) * w * 0.1);
      ctx.lineTo(cx + Math.cos(a) * w * 0.75, cyy + Math.sin(a) * w * 0.75); ctx.stroke();
    }
  },
  diagonals(ctx, x, y, w, h, rng, st) {
    for (let i = -4; i < 10; i++) {
      ctx.fillStyle = i % 2 ? hsl(st.hue, 85, 48, 0.85) : 'rgba(10,8,10,0.8)';
      ctx.save(); ctx.translate(x + i * w * 0.16, y); ctx.rotate(0.5);
      ctx.fillRect(0, -h * 0.3, w * 0.09, h * 1.8); ctx.restore();
    }
  },
  skyline(ctx, x, y, w, h, rng, st) {
    const base = y + h * 0.78;
    ctx.fillStyle = 'rgba(6,8,14,0.92)';
    let px = x;
    while (px < x + w) {
      const bw = w * (0.06 + rng() * 0.1), bh = h * (0.15 + rng() * 0.35);
      ctx.fillRect(px, base - bh, bw, bh + h * 0.25);
      px += bw + 1;
    }
    ctx.fillStyle = hsl(45, 90, 65, 0.9);
    for (let i = 0; i < 40; i++) ctx.fillRect(x + rng() * w, base - rng() * h * 0.3, 1.5, 1.5);
  },
  blinds(ctx, x, y, w, h, rng, st) {
    for (let i = 0; i < 9; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.5 + (i % 2) * 0.2})`;
      ctx.fillRect(x, y + (i / 9) * h, w, h * 0.055);
    }
    const gr = ctx.createLinearGradient(x, y, x + w, y + h);
    gr.addColorStop(0, hsl(st.hue, 60, 50, 0)); gr.addColorStop(1, hsl(st.hue, 80, 30, 0.5));
    ctx.fillStyle = gr; ctx.fillRect(x, y, w, h);
  },
  spot(ctx, x, y, w, h, rng, st) {
    const sx = x + w * (0.3 + rng() * 0.4);
    const gr = ctx.createRadialGradient(sx, y + h * 0.35, w * 0.05, sx, y + h * 0.35, w * 0.8);
    gr.addColorStop(0, 'rgba(255,244,214,0.85)'); gr.addColorStop(1, 'rgba(255,244,214,0)');
    ctx.fillStyle = gr; ctx.fillRect(x, y, w, h);
    // backlit figure
    ctx.fillStyle = 'rgba(8,8,14,0.9)';
    const fx = sx, fy = y + h * 0.62;
    ctx.beginPath(); ctx.arc(fx, fy - h * 0.09, w * 0.075, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(fx, fy + h * 0.13, w * 0.15, h * 0.16, 0, Math.PI, 0); ctx.fill();
    ctx.fillRect(fx - w * 0.15, fy + h * 0.12, w * 0.3, h * 0.35);
  },
  window(ctx, x, y, w, h, rng, st) {
    ctx.fillStyle = hsl(st.hue, 30, 20, 0.75);
    ctx.fillRect(x + w * 0.18, y + h * 0.12, w * 0.64, h * 0.5);
    ctx.fillStyle = hsl(45, 80, 75, 0.9);
    ctx.fillRect(x + w * 0.22, y + h * 0.16, w * 0.56, h * 0.42);
    ctx.strokeStyle = 'rgba(10,10,16,0.9)'; ctx.lineWidth = Math.max(2, w * 0.02);
    ctx.strokeRect(x + w * 0.22, y + h * 0.16, w * 0.56, h * 0.42);
    ctx.beginPath(); ctx.moveTo(x + w * 0.5, y + h * 0.16); ctx.lineTo(x + w * 0.5, y + h * 0.58); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + w * 0.22, y + h * 0.37); ctx.lineTo(x + w * 0.78, y + h * 0.37); ctx.stroke();
  },
  confetti(ctx, x, y, w, h, rng, st) {
    for (let i = 0; i < 70; i++) {
      ctx.fillStyle = hsl((st.hue + rng() * 160) % 360, 85, 55 + rng() * 25, 0.9);
      ctx.save();
      ctx.translate(x + rng() * w, y + rng() * h);
      ctx.rotate(rng() * 3);
      const s = 2 + rng() * 6;
      rng() < 0.5 ? ctx.fillRect(-s / 2, -s / 2, s, s * 0.5) : (ctx.beginPath(), ctx.arc(0, 0, s * 0.4, 0, 7), ctx.fill());
      ctx.restore();
    }
  },
  tilt(ctx, x, y, w, h, rng, st) {
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = hsl((st.hue + i * 30) % 360, 88, 58, 0.85);
      ctx.save(); ctx.translate(x + w * (0.2 + rng() * 0.6), y + h * (0.15 + rng() * 0.55));
      ctx.rotate((rng() - 0.5) * 1.2);
      ctx.fillRect(-w * 0.2, -h * 0.05, w * 0.4, h * 0.1); ctx.restore();
    }
  },
  circles(ctx, x, y, w, h, rng, st) {
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = hsl((st.hue + i * 18) % 360, 70, 60 + i * 8, 0.55);
      ctx.beginPath();
      ctx.arc(x + w * (0.3 + i * 0.2), y + h * (0.3 + (i % 2) * 0.15), w * (0.2 + rng() * 0.12), 0, 7);
      ctx.fill();
    }
  },
  hills(ctx, x, y, w, h, rng, st) {
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = hsl((st.hue + i * 24) % 360, 60, 62 - i * 10, 0.95);
      ctx.beginPath();
      ctx.ellipse(x + w * (0.2 + i * 0.3), y + h * (0.85 + i * 0.04), w * 0.55, h * 0.28, 0, Math.PI, 0);
      ctx.fill();
    }
    ctx.fillStyle = hsl(48, 95, 72, 0.95);
    ctx.beginPath(); ctx.arc(x + w * 0.75, y + h * 0.2, w * 0.12, 0, 7); ctx.fill();
  },
  balloons(ctx, x, y, w, h, rng, st) {
    for (let i = 0; i < 6; i++) {
      const bx = x + rng() * w, by = y + h * (0.1 + rng() * 0.45), r = w * (0.05 + rng() * 0.05);
      ctx.strokeStyle = 'rgba(40,40,50,0.5)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bx, by + r); ctx.quadraticCurveTo(bx + 5, by + r + h * 0.1, bx, by + r + h * 0.2); ctx.stroke();
      ctx.fillStyle = hsl((st.hue + rng() * 140) % 360, 85, 62, 0.95);
      ctx.beginPath(); ctx.ellipse(bx, by, r * 0.85, r, 0, 0, 7); ctx.fill();
    }
  },
  bigsun(ctx, x, y, w, h, rng, st) {
    const gr = ctx.createLinearGradient(x, y, x, y + h);
    gr.addColorStop(0, hsl(200, 80, 72)); gr.addColorStop(0.6, hsl((st.hue + 20) % 360, 70, 70));
    ctx.fillStyle = gr; ctx.fillRect(x, y, w, h * 0.75);
    ctx.fillStyle = hsl(8, 85, 62, 0.95);
    ctx.beginPath(); ctx.arc(x + w / 2, y + h * 0.4, w * 0.24, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (let i = 0; i < 3; i++) {
      const cxx = x + rng() * w, cyy = y + h * (0.1 + rng() * 0.25);
      ctx.beginPath();
      ctx.ellipse(cxx, cyy, w * 0.14, h * 0.045, 0, 0, 7);
      ctx.ellipse(cxx + w * 0.08, cyy - h * 0.02, w * 0.1, h * 0.04, 0, 0, 7);
      ctx.fill();
    }
  },
  speedlines(ctx, x, y, w, h, rng, st) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    for (let i = 0; i < 26; i++) {
      const a = rng() * Math.PI * 2;
      ctx.lineWidth = 0.5 + rng() * 2;
      ctx.beginPath();
      ctx.moveTo(x + w / 2 + Math.cos(a) * w * 0.16, y + h * 0.45 + Math.sin(a) * w * 0.16);
      ctx.lineTo(x + w / 2 + Math.cos(a) * w, y + h * 0.45 + Math.sin(a) * w);
      ctx.stroke();
    }
  },
  castle(ctx, x, y, w, h, rng, st) {
    MOTIFS.starfield(ctx, x, y, w, h * 0.7, rng, st);
    ctx.fillStyle = 'rgba(10,6,18,0.92)';
    const base = y + h * 0.85;
    ctx.fillRect(x + w * 0.25, base - h * 0.3, w * 0.5, h * 0.35);
    ctx.fillRect(x + w * 0.18, base - h * 0.42, w * 0.12, h * 0.5);
    ctx.fillRect(x + w * 0.7, base - h * 0.42, w * 0.12, h * 0.5);
    ctx.beginPath(); ctx.moveTo(x + w * 0.24, base - h * 0.42); ctx.lineTo(x + w * 0.24, base - h * 0.52); ctx.lineTo(x + w * 0.18, base - h * 0.42); ctx.fill();
    ctx.fillStyle = hsl(48, 90, 70, 0.9);
    ctx.fillRect(x + w * 0.47, base - h * 0.2, w * 0.06, h * 0.09);
  },
  desert(ctx, x, y, w, h, rng, st) {
    const gr = ctx.createLinearGradient(x, y, x, y + h);
    gr.addColorStop(0, hsl(28, 90, 62)); gr.addColorStop(0.55, hsl(14, 80, 48)); gr.addColorStop(1, hsl(28, 60, 30));
    ctx.fillStyle = gr; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = hsl(45, 95, 80, 0.95);
    ctx.beginPath(); ctx.arc(x + w * 0.5, y + h * 0.42, w * 0.2, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(30,10,8,0.9)';
    ctx.fillRect(x, y + h * 0.72, w, h * 0.28);
    // cactus
    const cx2 = x + w * (0.2 + rng() * 0.5);
    ctx.fillRect(cx2, y + h * 0.5, w * 0.045, h * 0.26);
    ctx.fillRect(cx2 - w * 0.07, y + h * 0.56, w * 0.16, h * 0.035);
    ctx.fillRect(cx2 - w * 0.07, y + h * 0.5, w * 0.045, h * 0.08);
    ctx.fillRect(cx2 + w * 0.07, y + h * 0.53, w * 0.045, h * 0.06);
  },
  smoke(ctx, x, y, w, h, rng, st) {
    for (let i = 0; i < 12; i++) {
      ctx.fillStyle = `rgba(60,62,58,${0.1 + rng() * 0.2})`;
      ctx.beginPath();
      ctx.arc(x + rng() * w, y + rng() * h * 0.7, w * (0.1 + rng() * 0.2), 0, 7);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(14,14,10,0.9)';
    ctx.fillRect(x, y + h * 0.8, w, h * 0.2);
  },
  rays(ctx, x, y, w, h, rng, st) {
    for (let i = 0; i < 16; i++) {
      ctx.fillStyle = i % 2 ? hsl(st.hue, 80, 55, 0.7) : hsl(48, 90, 62, 0.7);
      ctx.beginPath();
      ctx.moveTo(x + w / 2, y + h * 0.5);
      const a0 = (i / 16) * Math.PI * 2, a1 = ((i + 0.6) / 16) * Math.PI * 2;
      ctx.lineTo(x + w / 2 + Math.cos(a0) * w, y + h * 0.5 + Math.sin(a0) * w);
      ctx.lineTo(x + w / 2 + Math.cos(a1) * w, y + h * 0.5 + Math.sin(a1) * w);
      ctx.fill();
    }
  },
  horizonsun(ctx, x, y, w, h, rng, st) {
    const gr = ctx.createLinearGradient(x, y, x, y + h);
    gr.addColorStop(0, hsl((st.hue + 190) % 360, 60, 30));
    gr.addColorStop(0.62, hsl(30, 85, 55)); gr.addColorStop(1, hsl(45, 90, 45));
    ctx.fillStyle = gr; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = hsl(45, 100, 78, 0.95);
    ctx.beginPath(); ctx.arc(x + w / 2, y + h * 0.6, w * 0.17, 0, Math.PI, true); ctx.fill();
    ctx.fillStyle = 'rgba(10,8,16,0.85)';
    ctx.fillRect(x, y + h * 0.6, w, h * 0.4);
  },
  clean(ctx, x, y, w, h, rng, st) {
    ctx.fillStyle = hsl(st.hue, 45, 42, 0.5);
    ctx.fillRect(x, y + h * 0.3, w, h * 0.02);
    ctx.beginPath();
    ctx.arc(x + w * 0.5, y + h * 0.42, w * 0.2, 0, 7);
    ctx.strokeStyle = hsl(st.hue, 60, 65, 0.9); ctx.lineWidth = Math.max(2, w * 0.02); ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + w * 0.5, y + h * 0.42, w * 0.09, 0, 7);
    ctx.fillStyle = hsl(st.hue, 60, 65, 0.7); ctx.fill();
  },
};

// ---------------------------------------------------------------------------
// Cover art — front / spine / back drawn into any rect
// ---------------------------------------------------------------------------
/**
 * THE HONEST SLEEVE — what a case wears when no real cover art exists for it.
 *
 * This is NOT a poster and does not pretend to be one. There is no invented
 * imagery, no photographic motif, no fabricated composition: just the shop's own
 * stationery carrying facts we actually hold — the real title, year, certificate,
 * runtime and department. Rental stores genuinely did this for budget and library
 * stock, so it reads as a video store rather than as a missing asset.
 *
 * The distinction matters more than it looks. A generated "poster" for a real
 * film asserts something false about that film. A printed sleeve asserts only
 * "this is the case for this title", which is true.
 */
export function drawPlainSleeve(ctx, x, y, w, h, t) {
  const S = h / 152;
  const pad = 7 * S;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();

  // house stock: flat navy board, subtle vertical shading so it is not dead flat
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, '#1b2a5e'); g.addColorStop(1, '#131d42');
  ctx.fillStyle = g; ctx.fillRect(x, y, w, h);

  // gold rule top and bottom — the chain's own livery
  ctx.fillStyle = BRAND.gold;
  ctx.fillRect(x, y + 13 * S, w, 1.6 * S);
  ctx.fillRect(x, y + h - 30 * S, w, 1.6 * S);

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.62)';
  ctx.font = `800 ${4.6 * S}px Arial`;
  ctx.fillText('TAPEBUSTER', x + w / 2, y + 9.5 * S, w - pad * 2);

  // the title, given the room it deserves — this is the one thing on the sleeve
  // that is unambiguously true and it is set as the hero
  const lines = titleLines(t.title);
  let px = 0;
  for (const l of lines) {
    const f = fitFont(ctx, l, w - pad * 2, Math.round((lines.length > 2 ? 13 : 17) * S), 'Georgia,serif', '700');
    px = px ? Math.min(px, f) : f;
  }
  const lh = px * 1.12;
  let ty = y + h / 2 - (lines.length * lh) / 2 + px;
  ctx.font = `700 ${px}px Georgia,serif`;
  ctx.fillStyle = '#f2f0e6';
  for (const l of lines) { ctx.fillText(l, x + w / 2, ty); ty += lh; }

  // facts we hold, stated plainly
  ctx.fillStyle = BRAND.gold;
  ctx.font = `800 ${5 * S}px Arial`;
  const dept = (t.dept || '').toUpperCase().replace('NEWRELEASES', 'NEW RELEASE');
  ctx.fillText(dept, x + w / 2, y + h - 20 * S, w - pad * 2);

  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.font = `600 ${4.2 * S}px Arial`;
  const bits = [t.year, t.rating || null,
    t.type === 'series' ? (t.seasons ? `${t.seasons} SEASON${t.seasons === 1 ? '' : 'S'}` : 'SERIES')
      : (t.runtime ? `${t.runtime} MIN` : null)].filter(Boolean);
  ctx.fillText(bits.join('  ·  '), x + w / 2, y + h - 12 * S, w - pad * 2);

  // says what it is, so nobody mistakes the sleeve for artwork
  ctx.fillStyle = 'rgba(255,255,255,0.34)';
  ctx.font = `600 ${2.9 * S}px Arial`;
  ctx.fillText('NO COVER ART ON FILE', x + w / 2, y + h - 4.5 * S, w - pad * 2);

  ctx.restore();
}

export function drawCoverFront(ctx, x, y, w, h, t, opts = {}) {
  const rng = mulberry32(hashStr(t.id));
  const st = styleFor(t, rng);
  const S = h / 152; // scale relative to base tile

  // background
  const gr = ctx.createLinearGradient(x, y, x, y + h);
  if (st.retro) {
    gr.addColorStop(0, hsl(42, 42, 88)); gr.addColorStop(1, hsl(38, 45, 74));
  } else if (st.dark) {
    gr.addColorStop(0, hsl(st.hue, 55, 16)); gr.addColorStop(1, hsl((st.hue + 24) % 360, 60, 7));
  } else if (st.light) {
    // Poster stock rather than a lit gradient — a flat, near-white ground with
    // the accent only at the foot.
    gr.addColorStop(0, hsl(st.hue, 26, 93)); gr.addColorStop(1, hsl(st.accent, 40, 78));
  } else {
    // Duotone: the far end of the ramp swings to the accent instead of drifting
    // 30 degrees, so mid-tone covers stop converging on the same blue.
    gr.addColorStop(0, hsl(st.hue, 62, 60)); gr.addColorStop(1, hsl(st.accent, 58, 32));
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = gr; ctx.fillRect(x, y, w, h);

  // motif
  (MOTIFS[st.motif] || MOTIFS.clean)(ctx, x, y, w, h, rng, st);

  // retro overlay: aged paper + border
  if (st.retro) {
    ctx.fillStyle = 'rgba(120,90,40,0.12)'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(60,40,16,0.65)'; ctx.lineWidth = 2 * S;
    ctx.strokeRect(x + 3 * S, y + 3 * S, w - 6 * S, h - 6 * S);
  }

  // typography
  const pad = 6 * S;
  const isSeries = t.type === 'series';
  const lines = titleLines(t.title);
  // LAYOUT. `hero` and `band` want short titles, so anything long falls back to
  // the classic bottom stack rather than being crushed to 5px.
  let layout = st.layout;
  if ((layout === 'hero' || layout === 'band') && lines.length > 2) layout = 'bottom';
  const topTitle = layout === 'top';
  ctx.textBaseline = 'alphabetic';
  const family = st.serif ? 'Georgia,serif' : `'Arial Black','Arial',sans-serif`;
  const inkOnLight = st.retro ? '#2f1d08' : hsl(st.accent, 65, 22);
  const ink = st.light ? inkOnLight : (st.dark ? '#f4efe0' : '#ffffff');

  // small header: director / "the complete series"
  ctx.textAlign = 'center';
  ctx.fillStyle = st.light ? 'rgba(30,26,20,0.72)'
    : (st.dark ? 'rgba(240,238,230,0.85)' : (st.retro ? 'rgba(50,32,10,0.9)' : 'rgba(255,255,255,0.92)'));
  ctx.font = `700 ${Math.max(4, 5.4 * S)}px Arial`;
  const dir = String(t.director || '').split(',')[0].trim();
  const header = isSeries ? 'THE COMPLETE SERIES' : (dir ? `A ${dir.toUpperCase()} FILM` : 'TAPEBUSTER HOME VIDEO');
  // The header is dropped where the title itself occupies the top, and pulled to
  // the left margin on `corner` so it sits with the rest of the ranged type.
  if (!topTitle) {
    if (layout === 'corner') {
      ctx.textAlign = 'left';
      ctx.fillText(header, x + pad, y + 10 * S, w - pad * 2);
    } else {
      ctx.fillText(header, x + w / 2, y + 10 * S, w - pad * 2);
    }
  }

  // title block
  const maxPx = layout === 'hero' ? 27 : (lines.length > 2 ? 15 : 19);
  const ranged = layout === 'corner';
  let fontPx = 0;
  for (const l of lines) {
    const f = fitFont(ctx, l, w - pad * 2, Math.round(maxPx * S), family);
    fontPx = fontPx ? Math.min(fontPx, f) : f;
  }
  const lineH = fontPx * 1.04;
  const blockH = lines.length * lineH;
  const baseY = {
    top: y + 16 * S + fontPx,
    hero: y + h * 0.46 - blockH / 2 + fontPx,
    band: y + h * 0.60 - blockH / 2 + fontPx,
    corner: y + h * 0.74 - blockH,
    bottom: y + h * 0.82 - blockH,
  }[layout];

  // `band` prints the title out of a solid slab of accent, which reads as a
  // different cover entirely even when the motif behind it repeats.
  if (layout === 'band') {
    ctx.fillStyle = st.light ? hsl(st.accent, 62, 42) : 'rgba(0,0,0,0.62)';
    ctx.fillRect(x, baseY - fontPx - 3 * S, w, blockH + 7 * S);
  }
  ctx.textAlign = ranged ? 'left' : 'center';
  const tx = ranged ? x + pad : x + w / 2;
  ctx.font = `900 ${fontPx}px ${family}`;
  lines.forEach((l, i) => {
    const ty = baseY + i * lineH;
    // No drop shadow on a light ground — it just muddies the ink.
    if (!st.light || layout === 'band') {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillText(l, tx + 1.2 * S, ty + 1.2 * S);
    }
    ctx.fillStyle = layout === 'band' ? '#ffffff' : ink;
    ctx.fillText(l, tx, ty);
  });
  // A rule under ranged-left type, the way a real sleeve sets it off.
  if (ranged) {
    ctx.fillStyle = st.light ? hsl(st.accent, 62, 42) : 'rgba(255,255,255,0.75)';
    ctx.fillRect(x + pad, baseY + 2.5 * S, Math.min(w - pad * 2, 34 * S), 1.2 * S);
  }
  ctx.textAlign = 'center';

  // series chip
  if (isSeries && t.seasons) {
    const chipW = 44 * S, chipH = 9 * S;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(x + w / 2 - chipW / 2, y + h * 0.84, chipW, chipH);
    ctx.fillStyle = '#ffd23d';
    ctx.font = `800 ${5.4 * S}px Arial`;
    const chip = t.episodes ? `${t.seasons} SEASONS · ${t.episodes} EPS` : `${t.seasons} SEASONS`;
    ctx.fillText(chip, x + w / 2, y + h * 0.84 + chipH * 0.75);
  }

  // credits micro-block
  if (!opts.minimal) {
    ctx.fillStyle = st.dark || !st.retro ? 'rgba(255,255,255,0.5)' : 'rgba(40,28,10,0.55)';
    ctx.font = `500 ${2.6 * S}px Arial`;
    const credits = (t.cast || []).join(' · ').toUpperCase();
    ctx.fillText(credits, x + w / 2, y + h - 7.5 * S, w - pad * 2);
    ctx.font = `500 ${2.2 * S}px Arial`;
    ctx.fillText('TAPEBUSTER HOME VIDEO PRESENTS IN ASSOCIATION WITH VERY REAL PICTURES', x + w / 2, y + h - 4 * S, w - pad * 2);
  }

  // year + rating chips
  ctx.font = `800 ${5 * S}px Arial`;
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillStyle = st.retro ? 'rgba(50,32,10,0.85)' : 'rgba(255,255,255,0.9)';
  ctx.fillText(String(t.year), x + pad * 0.7, y + h - (opts.minimal ? 4 : 11.5) * S);
  ctx.textAlign = 'right';
  ctx.strokeStyle = st.retro ? 'rgba(50,32,10,0.85)' : 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 0.8 * S;
  // Certificates come from a real source or not at all — a title with none
  // simply shows no rating box rather than a fabricated "NR".
  const certLabel = t.rating || '';
  const rw = ctx.measureText(certLabel).width + 3 * S;
  if (certLabel) ctx.strokeRect(x + w - pad * 0.7 - rw, y + h - (opts.minimal ? 4 : 11.5) * S - 5.4 * S, rw, 7 * S);
  if (certLabel) ctx.fillText(certLabel, x + w - pad, y + h - (opts.minimal ? 4 : 11.5) * S);
  ctx.textAlign = 'center';

  // grain + vignette + wear
  speckle(ctx, x, y, w, h, Math.round(70 * S), rng, ['rgba(255,255,255,0.05)', 'rgba(0,0,0,0.07)'], 0.9);
  const vg = ctx.createRadialGradient(x + w / 2, y + h / 2, w * 0.35, x + w / 2, y + h / 2, w * 1.05);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.fillStyle = vg; ctx.fillRect(x, y, w, h);

  // Rental sticker (some copies). Dropped low-right rather than top-right: at the
  // top it landed straight through the director credit on every cover that had
  // one, which is what made the header read as damaged rather than as a sticker.
  // Skipped entirely where the title itself is up there.
  if (rng() < 0.4 && layout !== 'corner') {
    // Parked in whatever band this layout leaves empty. Top-right is never safe:
    // that is where the director credit sits on every layout except `top`, and
    // where the title sits on `top` itself.
    const stickerTop = { top: 0.55, hero: 0.16, band: 0.26, bottom: 0.30 }[layout] ?? 0.30;
    ctx.save();
    ctx.translate(x + w * 0.82, y + h * stickerTop); ctx.rotate(-0.12);
    ctx.fillStyle = BRAND.gold;
    ctx.beginPath(); ctx.ellipse(0, 0, 13 * S, 6.5 * S, 0, 0, 7); ctx.fill();
    ctx.fillStyle = BRAND.navy;
    ctx.font = `900 ${3.4 * S}px Arial`;
    ctx.fillText('TAPEBUSTER', 0, 0.5 * S);
    ctx.font = `700 ${2.4 * S}px Arial`;
    ctx.fillText('RENTAL', 0, 3.6 * S);
    ctx.restore();
  }
  ctx.restore();
}

export function drawCoverSpine(ctx, x, y, w, h, t) {
  const rng = mulberry32(hashStr(t.id) ^ 0x9e37);
  const st = styleFor(t, mulberry32(hashStr(t.id)));
  const S = h / 152;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  const gr = ctx.createLinearGradient(x, y, x + w, y);
  const l = st.dark ? 12 : 30;
  gr.addColorStop(0, hsl(st.hue, 60, l)); gr.addColorStop(0.5, hsl(st.hue, 62, l + 12)); gr.addColorStop(1, hsl(st.hue, 60, l - 3));
  ctx.fillStyle = gr; ctx.fillRect(x, y, w, h);
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const label = t.title.toUpperCase();
  const px = fitFont(ctx, label, h - 26 * S, Math.round(7.5 * S), `'Arial Narrow','Arial',sans-serif`, '800');
  ctx.font = `800 ${px}px 'Arial Narrow','Arial',sans-serif`;
  ctx.fillStyle = st.dark ? '#efeadb' : '#ffffff';
  ctx.fillText(label, 4 * S, 0.5);
  ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `700 ${3.2 * S}px Arial`;
  ctx.textAlign = 'center';
  ctx.fillText(String(t.year), x + w / 2, y + h - 3.5 * S);
  ctx.fillStyle = BRAND.gold;
  ctx.fillRect(x + w * 0.2, y + 2.5 * S, w * 0.6, 2.6 * S);
  ctx.restore();
}

export function drawCoverBack(ctx, x, y, w, h, t, opts = {}) {
  const rng = mulberry32(hashStr(t.id) ^ 0x51ed);
  const st = styleFor(t, mulberry32(hashStr(t.id)));
  const S = h / 152;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  const gr = ctx.createLinearGradient(x, y, x, y + h);
  gr.addColorStop(0, hsl(st.hue, 45, st.dark ? 10 : 22)); gr.addColorStop(1, hsl(st.hue, 40, st.dark ? 6 : 14));
  ctx.fillStyle = gr; ctx.fillRect(x, y, w, h);

  // THE STILL. When a real landscape backdrop for THIS title has been loaded
  // (opts.backdrop, the inspect path), it fills the strip a rental case keeps
  // for stills — verified TMDB imagery, cover-cropped, never stretched. The
  // generated motif strip below remains the fallback and the atlas treatment:
  // an honest design, never a fabricated photo.
  if (opts.backdrop && opts.backdrop.width > 1) {
    const bx0 = x + 6 * S, by0 = y + 6 * S, bw0 = w - 12 * S, bh0 = 26 * S;
    const img = opts.backdrop;
    const scale = Math.max(bw0 / img.width, bh0 / img.height);
    const sw0 = bw0 / scale, sh0 = bh0 / scale;
    ctx.drawImage(img, (img.width - sw0) / 2, (img.height - sh0) / 2, sw0, sh0, bx0, by0, bw0, bh0);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 0.8 * S;
    ctx.strokeRect(bx0, by0, bw0, bh0);
  } else {
    // "stills" strip
    const stills = 3, sw = (w - 16 * S) / stills;
    for (let i = 0; i < stills; i++) {
      const sx = x + 6 * S + i * (sw + 2 * S), sy = y + 6 * S, sh = 22 * S;
      ctx.fillStyle = hsl((st.hue + i * 40) % 360, 50, 30);
      ctx.fillRect(sx, sy, sw, sh);
      const mk = Object.keys(MOTIFS);
      MOTIFS[mk[(hashStr(t.id + i) % mk.length)]](ctx, sx, sy, sw, sh, rng, st);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 0.8 * S;
      ctx.strokeRect(sx, sy, sw, sh);
    }
  }

  // synopsis
  ctx.fillStyle = 'rgba(244,239,230,0.92)';
  const synFont = Math.max(3, 4.6 * S);
  ctx.font = `500 ${synFont}px Arial`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const words = (t.synopsis || '').split(' ');
  let line = '', ty = y + 33 * S;
  const maxW = w - 12 * S;
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxW) {
      ctx.fillText(line, x + 6 * S, ty); ty += synFont * 1.25; line = word;
      if (ty > y + h - 42 * S) { line += '…'; break; }
    } else line = test;
  }
  if (line) ctx.fillText(line, x + 6 * S, ty);

  // meta block
  ctx.font = `700 ${4 * S}px Arial`;
  ctx.fillStyle = BRAND.goldLight;
  const meta = t.type === 'movie'
    ? [t.runtime ? `${t.runtime} MIN` : null, t.genres.join(' / ').toUpperCase(), t.year].filter(Boolean).join(' · ')
    : [t.seasons ? `${t.seasons} SEASONS` : null, t.episodes ? `${t.episodes} EPISODES` : null,
       t.episodeRuntime ? `${t.episodeRuntime} MIN EPS` : null].filter(Boolean).join(' · ');
  ctx.fillText(meta, x + 6 * S, y + h - 36 * S);
  ctx.fillStyle = 'rgba(244,239,230,0.75)';
  ctx.font = `500 ${3.6 * S}px Arial`;
  const credit = t.type === 'movie' ? t.director : t.creators;
  if (credit) {
    const who = `${t.type === 'movie' ? 'DIRECTED BY' : 'CREATED BY'} ${String(credit).toUpperCase()}`;
    ctx.fillText(who, x + 6 * S, y + h - 30 * S, w - 12 * S);
  }

  // barcode + rating
  const bx = x + 6 * S, by = y + h - 22 * S, bw = 34 * S, bh = 14 * S;
  ctx.fillStyle = '#f4efe6'; ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = '#101010';
  let cx2 = bx + 2 * S;
  const brng = mulberry32(hashStr(t.id) ^ 0xbead);
  while (cx2 < bx + bw - 2 * S) {
    const lw = (0.6 + brng() * 1.6) * S;
    ctx.fillRect(cx2, by + 1.5 * S, lw, bh - 5 * S);
    cx2 += lw + (0.6 + brng() * 1.4) * S;
  }
  ctx.font = `500 ${2.6 * S}px Arial`;
  ctx.textAlign = 'center';
  ctx.fillText(String(100000 + (hashStr(t.id) % 899999)), bx + bw / 2, by + bh - 3 * S);
  // The certification box exists only when a certification exists — the audit
  // measured a rating on 5-18% of titles, and a box printing a coerced null
  // would be exactly the fabricated-content this back must never carry.
  if (t.rating) {
    ctx.strokeStyle = 'rgba(244,239,230,0.9)'; ctx.lineWidth = S;
    ctx.font = `900 ${6 * S}px Arial`;
    ctx.fillStyle = 'rgba(244,239,230,0.9)';
    ctx.strokeRect(x + w - 22 * S, by, 16 * S, bh);
    ctx.fillText(t.rating, x + w - 14 * S, by + bh - 4 * S);
  }

  ctx.textAlign = 'right';
  ctx.font = `800 ${3.4 * S}px Arial`;
  ctx.fillStyle = BRAND.gold;
  ctx.fillText('TAPEBUSTER VIDEO', x + w - 6 * S, y + 1.5 * S);
  ctx.restore();
}

// Tile layout inside an atlas cell (base 288×168).
//
// GUTTERS ARE LOAD-BEARING, AND THEY ARE SIZED FOR THE SMALLEST BASE SCALE, NOT
// THE LARGEST. Mipmapping is on and the baked UVs run right up to each sub-rect's
// edge, so whatever separates two sub-rects has to survive being halved several
// times. The old 256-wide cell left 2px between spine and back — fine at full
// resolution, but the base residency tier draws small, where 2px becomes HALF A
// PIXEL and the spine visibly averaged into the back cover on every distant case.
//
// The cell was widened from 256 to 288 rather than shrinking any region: every
// sub-rect keeps its exact size, so no cover's proportions change anywhere in
// the game. The 32 extra pixels buy 10px HORIZONTAL gutters.
//
// THE HEIGHT WAS THEN RAISED 160 → 168 FOR THE SAME REASON ON THE OTHER AXIS.
// The vertical margins were 4px top and 4px bottom, so two vertically adjacent
// covers were separated by 8px — which at the old 0.1875 base scale is 1.5
// texels, under two, so mip level 1 already bled each cover into the one above
// it. 8px margins give a 16px combined vertical gutter, now wider than the
// horizontal 10px, and the grid is unchanged: floor(2048/168) = 12 rows, still
// 7×11 = 77 tiles per atlas at every scale.
//
// THE FIGURES THAT MATTER, at the surviving base scales (see BASE_SCALES). A
// "gutter" is what separates two covers; between cells that is this cell's
// margin plus the next cell's, which is why the vertical figure is doubled:
//   between regions, horizontal   10px → 2.50 texels at 0.25, 1.25 at 0.125
//   between rows, vertical      8+8px → 4.00 texels at 0.25, 2.00 at 0.125
//   between columns          9+6=15px → 3.75 texels at 0.25, 1.88 at 0.125
//   smallest single margin (left, 6px) → 1.50 texels at 0.25, 0.75 at 0.125
// 0.125 is therefore the hard floor: one step coarser puts the top and bottom
// margins under a texel. tests/covers.test.mjs asserts both axes.
//
// Cost is 7 columns per atlas instead of 8, and 11 rows instead of 12 (77 tiles
// vs 96), i.e. ~25% more
// atlases. Cheap against a visible artifact on every case in the building.
// HEIGHT 176 IS CHOSEN SO EVERY BASE SCALE HAS A WHOLE TILE PITCH.
// drawAtlasTiles blits at `col * tileW, row * tileH` with no rounding, so a
// fractional pitch resamples every tile in the atlas. At h=168 the middle rung
// 0.1875 gives 31.5px and had to be dropped from BASE_SCALES, which cost the
// base tier a full step of resolution (13.5 texels across a cover instead of
// 20.3) and pushed the 6-16m band BELOW where it was before the LOD work — the
// blur moved rather than went away. 176 = 16 x 11 divides cleanly by 4, 8 and
// 16, so 0.25/0.1875/0.125 all land on whole pixels, and the vertical gutter
// grows to 12px = 1.5 texels at the floor scale (it was exactly 1.0).
// Cost: 11 rows per atlas instead of 12, so 77 tiles per atlas and 260 atlases
// at STORE_CAPACITY instead of 239.
export const TILE = {
  w: 288, h: 176,
  front: { x: 6, y: 12, w: 108, h: 152 },   // 6..114
  spine: { x: 124, y: 12, w: 20, h: 152 },  // 124..144
  back: { x: 154, y: 12, w: 108, h: 152 },  // 154..262
  edge: { x: 272, y: 12, w: 7, h: 152 },    // 272..279, 9px to the cell edge
};

// ---------------------------------------------------------------------------
// ANISOTROPIC FILTERING, DECIDED ONCE FOR EVERY COVER SURFACE
//
// A shelf of cases is the worst case for a mipped texture: the faces are seen at
// a grazing angle down an aisle, so the isotropic mip selector picks a level
// sized for the SHORT axis and the long axis goes to mush. That is a large part
// of "the covers look blurry until you pick one up" — the inspect mesh, which
// needs it least, was asking for 8 while every case on every shelf asked for 4.
//
// It lives HERE rather than in covers.js because cases.js needs it too and must
// not gain a module edge onto the residency layer. main.js calls the setter once
// with the renderer's real capability; the default is what applies if it never
// does. Capped at 8 by the caller — past that the sampling cost climbs while the
// visible return on a 2:3 poster is nil.
export let MAX_ANISO = 4;
export function setMaxAnisotropy(n) {
  MAX_ANISO = Math.max(1, Math.floor(Number(n) || 1));
}

// ---------------------------------------------------------------------------
// REAL COVER ARTWORK
//
// 18,431 of the 20,000 stocked titles have their genuine poster on disk, fetched
// once at build time (scripts/ingest/05-artwork.mjs) and served from /artwork.
// The identity map is one file per title named for the title's own id, so a case
// can only ever resolve to its own artwork — there is no second index that could
// drift, and no way for title A to be handed title B's image.
//
// Only the FRONT carries the poster. The spine and back stay generated, because
// that is what a rental case actually is: the distributor's art on the face, the
// shop's own printing everywhere else.
let ART_IDS = null;                       // titleId -> tmdb image id
const artImages = new Map();              // titleId -> HTMLImageElement | 'missing'

// titleId -> 1 for posters shipped IN the deployment (build-pages writes it).
// Absent in dev, where the full local collection exists — then local-first.
let ART_LOCAL = null;

export function setArtworkManifest(m) { ART_IDS = m?.ids || null; ART_LOCAL = m?.local || null; }
export function hasArtwork(id) { return !!(ART_IDS && ART_IDS[id]); }

/**
 * Merge a LATER manifest over whatever is already loaded, and report which
 * titles just gained artwork.
 *
 * This exists for the boot split: the small boot-critical manifest is applied
 * first (setArtworkManifest), the full one downloads alongside worldgen and
 * lands here. The return value is the redraw list — every id that had no
 * image before and has one now — so covers.rescanArtwork can re-queue any
 * atlas that was already blitted with a printed sleeve where a real poster
 * now exists. Merging the same manifest twice returns [] and changes nothing.
 */
export function mergeArtworkManifest(m) {
  if (!m?.ids) return [];
  if (!ART_IDS) { setArtworkManifest(m); return Object.keys(m.ids); }
  const gained = [];
  for (const [id, hash] of Object.entries(m.ids)) {
    if (!ART_IDS[id]) { ART_IDS[id] = hash; gained.push(id); }
  }
  if (m.local) {
    ART_LOCAL = ART_LOCAL || {};
    for (const id of Object.keys(m.local)) ART_LOCAL[id] = 1;
  }
  return gained;
}

/**
 * Release fetched poster Images so their memory can go (iPhone crash repair).
 * artImages held every Image ELEMENT ever fetched, forever — thousands of
 * decoded/compressed posters by the time the base drain finishes, none of it
 * counted by the covers ledger, and exactly the kind of unbounded residency
 * that gets a Safari tab jetsam-killed. Deleting the entry returns the id to
 * the not-fetched state, so a later mid/detail promotion simply refetches
 * (browser HTTP cache makes that near-free); 'missing' verdicts are kept —
 * a failed poster must not retry on every release/promote cycle.
 */
/**
 * The TRANSIENT artwork workload — what is being decoded right now and what
 * is still held. Resident caches were already measurable; this is the other
 * half, and it is the half that spikes: one atlas job decodes perAtlas
 * posters (77 at w342 ~= 51 MiB) and holds them until that atlas commits.
 * Cheap: two integers, no allocation.
 */
// A claim that was released while its fetch was still outstanding. The decode
// that eventually lands must be dropped rather than inserted, and the claim
// cleared so the title can be requested again if it is ever needed.
const ABANDONED = 'abandoned';

// CUMULATIVE ARTWORK METRICS — the totals, not the residency.
//
// Every previous investigation measured what was RESIDENT and found it bounded,
// then concluded the app was safe. The real device kept dying anyway. Steady
// state and throughput are different properties: a system can hold 24 posters
// at a time and still push tens of gigabytes of decoded pixels through the
// browser in a session, and on iOS the decoded-image cache is charged to the
// tab and is not visible to JS.
//
// So these only ever go UP. They are what tells us, after a kill, how much work
// the browser had actually been asked to do.
//
// NOTE ON WHAT WE CANNOT FREE: the decode path is `new Image()`, an
// HTMLImageElement. releaseArtwork() calls `v.close?.()` — but only ImageBitmap
// has close(), so on this path it is a silent no-op. Dropping our reference is
// all we do; when WebKit actually frees the decoded bitmap is its decision.
// `evictable` counts the decodes we have let go of but cannot prove are gone.
const artMetrics = {
  fetchStarted: 0, fetchOk: 0, fetchFailed: 0, fetchRetried: 0, fetchCdn: 0,
  decodes: 0, decodedPixels: 0, decodedBytes: 0,
  adopted: 0, abandonedOnArrival: 0,
  released: 0, evictable: 0,
  peakHeld: 0, peakInFlight: 0,
};

// THE NUMBER THAT ACTUALLY DISCRIMINATES.
//
// `released` and `evictable` are structurally equal — every decode on this path
// is an HTMLImageElement, which has no close(), so every release increments
// both. That equality says nothing about memory; it is a property of the type.
//
// fetches-vs-UNIQUE is the informative pair. 15,047 fetches for ~15,000 distinct
// titles means the store simply has a lot of posters. 15,047 fetches for ~7,000
// distinct titles means we are decoding the same poster twice, which is a defect
// with a fix. Nothing in the telemetry could tell those apart until now.
//
// Bounded by the stocked set (20,000 ids), so this cannot itself grow without
// limit — it is the same id strings the catalogue already holds.
const everFetched = new Set();

export function artworkMetrics() {
  const uniq = everFetched.size;
  return {
    ...artMetrics,
    decodedMiB: +(artMetrics.decodedBytes / 1048576).toFixed(1),
    uniqueTitles: uniq,
    // >1 means the same poster is being decoded more than once.
    refetchRatio: uniq ? +(artMetrics.fetchStarted / uniq).toFixed(2) : 0,
  };
}

export function artworkStats() {
  let held = 0;
  for (const v of artImages.values()) if (v && v !== 'missing' && v !== ABANDONED) held++;
  if (held > artMetrics.peakHeld) artMetrics.peakHeld = held;
  if (imgInFlight > artMetrics.peakInFlight) artMetrics.peakInFlight = imgInFlight;
  return { inFlight: imgInFlight, held, claimed: artImages.size };
}

export function releaseArtwork(titles) {
  for (const t of titles) {
    const v = artImages.get(t.id);
    // RELEASING AN IN-FLIGHT TITLE MUST CANCEL IT, NOT IGNORE IT.
    //
    // 'missing' is the claim written before the fetch starts, so there is no
    // decode to close yet and this used to simply skip. But the in-flight
    // onload then ran `artImages.set(t.id, img)` unconditionally — inserting a
    // decoded poster AFTER the only code that would ever free it had already
    // run. Measured (scripts/qa/tmp/resurrect.mjs): release 50 titles whose
    // fetches are outstanding, let them land, and 24 of them — the whole
    // IMG_CONCURRENCY window, 16.1 MiB — are resident with nothing left to
    // release them.
    //
    // covers.js releases a whole atlas range every time it starts a new job,
    // and it switches atlases constantly, INCLUDING while the player stands
    // perfectly still. That made this an unbounded idle allocation path.
    if (v === 'missing') { artImages.set(t.id, ABANDONED); continue; }
    if (v && v !== ABANDONED) {
      // close() exists on ImageBitmap, NOT on HTMLImageElement, which is what
      // this path actually produces — so this is a no-op here and the decoded
      // bitmap's lifetime belongs to WebKit. Counted separately for exactly
      // that reason: `released` is what we dropped, `evictable` is what we
      // dropped WITHOUT being able to free it.
      if (typeof v.close === 'function') v.close();
      else artMetrics.evictable++;
      artMetrics.released++;
      artImages.delete(t.id);
    }
  }
}

/** Decoded poster for a title, or null. Never throws, never blocks. */
export function artworkFor(id) {
  const v = artImages.get(id);
  return v && v !== 'missing' && v !== ABANDONED ? v : null;
}

// ---------------------------------------------------------------------------
// THE SINGLE ARTWORK AUTHORITY
//
// Every visible representation of a title — shelf case, wall poster, standee,
// inspector close-up, UI thumbnail — resolves through here and nowhere else.
//
// This exists because the same bug was found twice by eye and a third time by
// audit: the cases were migrated to real artwork while wall posters, standees
// and UI thumbnails kept calling the generated-poster path. A display could
// advertise one image while the case beside it showed another, for the same
// film. Components must not decide this for themselves.
//
// Resolution is a pure function of the CANONICAL TITLE ID. It does not consult
// the projection, the seed, STORE_CAPACITY, the selected services, the provider
// mode, restock state, or which kind of display is asking.
export const ARTWORK = { REAL: 'real', PENDING: 'pending', NONE: 'none' };

export function resolveArtwork(titleId) {
  // No manifest at all = the artwork pass has never been run. Only in that case
  // is the generated treatment allowed, so the app still works before ingestion.
  if (!ART_IDS) return { state: ARTWORK.NONE, image: null, imageId: null, ingested: false };
  const imageId = ART_IDS[titleId] || null;
  if (!imageId) return { state: ARTWORK.NONE, image: null, imageId: null, ingested: true };
  const img = artworkFor(titleId);
  return img
    ? { state: ARTWORK.REAL, image: img, imageId, ingested: true }
    // Art exists but has not decoded yet. The sleeve stands in — NEVER a
    // generated poster, which would assert something false about a film we
    // actually hold the real artwork for.
    : { state: ARTWORK.PENDING, image: null, imageId, ingested: true };
}

/**
 * Paint a title into a rect through the authority. COVER-FIT, never stretched:
 * posters are 2:3 and the targets are not, so the overflow is cropped and the
 * remainder centred. One implementation, so no consumer can crop differently.
 */
export function paintArtwork(ctx, x, y, w, h, t) {
  const r = resolveArtwork(t.id);
  if (r.state === ARTWORK.REAL) {
    const img = r.image;
    const ar = img.width / img.height, fr = w / h;
    let sw = img.width, sh = img.height, sx = 0, sy = 0;
    if (ar > fr) { sw = img.height * fr; sx = (img.width - sw) / 2; }
    else { sh = img.width / fr; sy = (img.height - sh) / 2; }
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  } else if (r.ingested) {
    drawPlainSleeve(ctx, x, y, w, h, t);
  } else {
    drawCoverFront(ctx, x, y, w, h, t);
  }
  return r.state;
}

/**
 * Load the posters a set of titles needs. Resolves when every one has either
 * decoded or failed, so an atlas is only ever drawn once its art is settled —
 * that is what keeps a tile from being drawn twice and flickering.
 */
// GLOBAL IMAGE-LOAD SEMAPHORE. Every atlas fires its ~77 poster loads at
// once, and with the pump, the prefetch and the CDN fallback overlapping,
// Chrome's per-renderer connection pool floods (live console:
// ERR_INSUFFICIENT_RESOURCES) — requests then fail before they start and
// titles settle to sleeves for want of a queue. 24 titles in flight keeps
// the pump fully fed (it draws one atlas at a time) while the browser never
// sees a burst it refuses.
let imgInFlight = 0;
const imgWaiters = [];
const IMG_CONCURRENCY = 24;
const imgAcquire = () => imgInFlight < IMG_CONCURRENCY
  ? (imgInFlight++, Promise.resolve())
  : new Promise(r => imgWaiters.push(r));
const imgRelease = () => {
  const w = imgWaiters.shift();
  if (w) w(); else imgInFlight--;
};

// DIAGNOSTIC ONLY (?art=off). Stops all poster FETCH and DECODE while leaving
// atlas drawing and texture upload untouched — printed sleeves are drawn
// instead. Paired with ?drain=off (which stops hydration entirely) this
// separates "network + decode" from "canvas drawing + GL upload", which no
// single switch can do. Not a product feature; it exists to isolate a crash.
let ARTWORK_DISABLED = false;
export function setArtworkEnabled(on) { ARTWORK_DISABLED = !on; }

export function loadArtwork(titles) {
  if (ARTWORK_DISABLED) return null;
  const pending = [];
  for (const t of titles) {
    if (!hasArtwork(t.id) || artImages.has(t.id)) continue;
    artImages.set(t.id, 'missing');       // claim it so we load each one once
    pending.push(new Promise((resolve) => {
      // A FAILED LOAD RETRIES, THEN FALLS BACK TO THE SOURCE CDN, BEFORE IT
      // SETTLES. Two separate defects live in this chain's history:
      //  * GitHub Pages 503s bursts of poster requests (measured live: ~45 a
      //    boot) — the local retries with jitter ride that out;
      //  * the deployed repo can only carry ~18k of the 74,538 posters under
      //    the Pages size limit, so every OTHER title wore a printed sleeve
      //    ("the cover art isn't all there"). The manifest already maps every
      //    title to its TMDB image id, so the miss now fetches the real
      //    poster from TMDB's image CDN (attributed in Settings) — the
      //    ENTIRE catalogue gets real cover art with zero repo payload.
      //    crossOrigin is load-bearing: without it the CDN image taints the
      //    atlas canvas and the WebGL texture upload throws.
      // The atlas stays parked until the outcome is final either way, so the
      // draw-once guarantee is untouched.
      const cdnId = ART_IDS?.[t.id];
      // Route directly: a title the deployment did not ship 404s locally by
      // construction, and burning the 503-retry backoff on a deterministic
      // 404 would add seconds per poster across ~56k titles. When the
      // build's `local` map is present it decides the first stop; in dev
      // (no map, full collection on disk) everything stays local-first.
      const localFirst = ART_LOCAL ? !!ART_LOCAL[t.id] : true;
      const settle = () => { imgRelease(); resolve(); };
      const attempt = (triesLeft, cdn) => {
        artMetrics.fetchStarted++;
        everFetched.add(t.id);
        if (cdn) artMetrics.fetchCdn++;
        const img = new Image();
        if (cdn) img.crossOrigin = 'anonymous';
        img.onload = () => {
          // naturalWidth/Height are the REAL decoded dimensions, so this is
          // measured rather than inferred from the rendition we asked for.
          const px = (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0);
          artMetrics.fetchOk++;
          artMetrics.decodes++;
          artMetrics.decodedPixels += px;
          artMetrics.decodedBytes += px * 4;
          // Only adopt the decode if this title is still claimed by THIS fetch.
          // If it was released while in flight the claim reads ABANDONED, and
          // storing the image here would leak it permanently — see
          // releaseArtwork. Dropping the claim instead lets it be re-requested
          // if the streamer ever comes back to this atlas.
          if (artImages.get(t.id) === ABANDONED) { artImages.delete(t.id); artMetrics.abandonedOnArrival++; }
          else { artImages.set(t.id, img); artMetrics.adopted++; }
          settle();
        };
        img.onerror = () => {
          if (triesLeft > 0) { artMetrics.fetchRetried++; setTimeout(() => attempt(triesLeft - 1, cdn), cdn ? 1200 : 2000 + Math.random() * 2000); }
          else if (!cdn && cdnId) attempt(1, true);
          else {
            // stays 'missing' -> printed sleeve; but an ABANDONED claim must be
            // cleared or the title could never be fetched again.
            artMetrics.fetchFailed++;
            if (artImages.get(t.id) === ABANDONED) artImages.delete(t.id);
            settle();
          }
        };
        // RELATIVE on purpose: GitHub Pages serves the store under
        // /<repo>/, where a root-absolute /artwork/... resolves to the account
        // domain root and 404s every poster. Relative resolves against the page
        // URL, which is correct at the domain root (dev server) and under a
        // repository path (production) alike.
        img.src = cdn
          ? `https://image.tmdb.org/t/p/w342/${cdnId}.jpg`
          : `artwork/${t.id}.jpg`;
      };
      imgAcquire().then(() => attempt(2, !localFirst && !!cdnId));
    }));
  }
  return pending.length ? Promise.all(pending) : null;
}

// ---------------------------------------------------------------------------
// BACKDROPS — the landscape still on the reverse of a HELD case.
//
// Loaded lazily from backdrops.json (never on the boot path; qa:boot asserts
// that), resolved to TMDB's image CDN at w780. Only the INSPECT path uses
// them: a shelved case never shows its back, so the atlases keep the cheap
// generated treatment and no atlas ever redraws for a backdrop. The image
// cache is tiny and bounded — a shopper holds one case at a time.
// ---------------------------------------------------------------------------
let BACKDROP_IDS = null;
const backdropImages = new Map();          // titleId -> HTMLImageElement
const BACKDROP_CACHE_MAX = 6;

// THE INDEX IS FETCHED ON FIRST PICK-UP, NOT AT BOOT.
//
// It is 2.64 MB gzipped — as heavy as the full poster manifest — and it
// answers exactly one question: what goes on the back of a case the shopper
// is HOLDING. Fetching it during worldgen would have it racing the poster
// manifest for bandwidth on the connections that can least afford it, to
// serve a face nobody has looked at yet. A shopper who never picks up a case
// never pays for it at all.
let backdropsPromise = null;
let BACKDROP_URL = 'src/data/artwork/backdrops.json';

export function setBackdrops(m) { BACKDROP_IDS = m?.ids || null; }
export function setBackdropSource(url) { BACKDROP_URL = url; }
export function hasBackdrop(id) { return !!(BACKDROP_IDS && BACKDROP_IDS[id]); }

function ensureBackdropIndex() {
  if (BACKDROP_IDS) return Promise.resolve();
  if (!backdropsPromise) {
    backdropsPromise = fetch(BACKDROP_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b?.ids) {
          BACKDROP_IDS = b.ids;
          console.info(`case backs: ${Object.keys(b.ids).length.toLocaleString()} landscape stills`);
        }
      })
      .catch(() => { /* the generated back is the designed fallback */ });
  }
  return backdropsPromise;
}

/** Resolve the landscape still for one title, or null when none is recorded. */
export async function loadBackdropImage(t) {
  await ensureBackdropIndex();
  const imageId = BACKDROP_IDS?.[t.id];
  if (!imageId) return null;
  const hit = backdropImages.get(t.id);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const img = new Image();
    // crossOrigin is load-bearing, exactly as it is for CDN posters: without
    // it the drawn canvas is tainted and the CanvasTexture upload fails.
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      backdropImages.set(t.id, img);
      // FIFO bound: Map iteration order is insertion order. A phone keeps two
      // — the shopper holds one case at a time, and a decoded still is over a
      // megabyte apiece.
      while (backdropImages.size > (isMobile() ? 2 : BACKDROP_CACHE_MAX)) {
        backdropImages.delete(backdropImages.keys().next().value);
      }
      resolve(img);
    };
    img.onerror = () => resolve(null);       // sleeve treatment, not a failure
    // w500 on a phone: the still occupies a strip of the case back, so w780
    // buys nothing there and costs 1.37 MB decoded against 0.56 MB.
    img.src = `https://image.tmdb.org/t/p/${isMobile() ? 'w500' : 'w780'}/${imageId}.jpg`;
  });
}

export function drawCoverTile(ctx, ox, oy, t, scale = 1, opts = {}) {
  const s = (r) => ({ x: ox + r.x * scale, y: oy + r.y * scale, w: r.w * scale, h: r.h * scale });
  const f = s(TILE.front), sp = s(TILE.spine), b = s(TILE.back), e = s(TILE.edge);
  paintArtwork(ctx, f.x, f.y, f.w, f.h, t);
  drawCoverSpine(ctx, sp.x, sp.y, sp.w, sp.h, t);
  drawCoverBack(ctx, b.x, b.y, b.w, b.h, t, opts);
  // page/edge strip: pale plastic
  const gr = ctx.createLinearGradient(e.x, 0, e.x + e.w, 0);
  gr.addColorStop(0, '#cfcdc6'); gr.addColorStop(0.5, '#efece4'); gr.addColorStop(1, '#b8b6ae');
  ctx.fillStyle = gr; ctx.fillRect(e.x, e.y, e.w, e.h);
}

// ---------------------------------------------------------------------------
// COVER ATLASES: PLANNING IS SEPARATE FROM DRAWING
//
// The atlas LAYOUT (which title lands in which atlas, at which col/row) is pure
// arithmetic over the catalog order and costs nothing. DRAWING those tiles is
// what costs 2.5 GB and minutes of blocked main thread at 15,000 titles.
//
// Splitting them is what makes streaming possible: the layout is computed up
// front so case geometry can bake its UVs immediately and the store is walkable,
// while the pixels arrive later, atlas by atlas, nearest first.
//
// THE SCALE INVARIANT that the whole streaming design rests on: atlasSize is
// ALWAYS 2048 * scale, so the tile grid is 7x12 at every scale and the
// normalized UVs are bit-identical across resolutions. A mesh can therefore be
// handed a 256px, 512px or 2048px version of the same atlas index and its baked
// UVs stay correct. Eviction lowers RESOLUTION; it never blanks a case, and it
// can never point a case at another title's tile.
// ---------------------------------------------------------------------------

/**
 * Bounded by BYTES, not entry count — a detail tile is 164 kB and a base tile
 * 10 kB, so counting entries would let the cache run 16x its intended size
 * depending on which tier happened to fill it. Insertion-ordered eviction (Map
 * iteration order) is enough: this exists to make restock and detail-tier
 * re-entry cheap, and both rebuild in plan order.
 *
 * The cache this replaces was keyed by title id alone and never evicted at all
 * — at 15,000 titles a further 2.4 GB of JS heap that no GPU-side residency
 * scheme would have touched.
 */
export class TileCache {
  constructor(maxBytes = 48 * 1024 * 1024) { this.max = maxBytes; this.bytes = 0; this.m = new Map(); }
  get(k) { return this.m.get(k); }
  set(k, v, bytes) {
    if (this.m.has(k)) return;
    this.m.set(k, v);
    this.bytes += bytes;
    while (this.bytes > this.max && this.m.size > 1) {
      const it = this.m.entries().next();
      if (it.done) break;
      const [ek, ev] = it.value;
      this.m.delete(ek);
      this.bytes -= (ev.width * ev.height * 4);
    }
  }
  /**
   * Forget one tile, byte accounting included.
   *
   * The cache is WRITE-ONCE by design (set() refuses overwrites), which made
   * it a trap the late-merge redraw walked straight into: a title drawn as a
   * printed sleeve before the full manifest arrived had its SLEEVE cached, and
   * the redraw that was supposed to show the newly-merged poster blitted the
   * cached sleeve back instead — a full redraw cycle, correct counters, zero
   * changed pixels, and the same poisoning baked into every context-loss
   * recovery. A title whose artwork state changes must have its stale tiles
   * dropped, and this is the only way to drop one.
   */
  drop(k) {
    const v = this.m.get(k);
    if (!v) return false;
    this.m.delete(k);
    this.bytes -= (v.width * v.height * 4);
    return true;
  }
  clear() { this.m.clear(); this.bytes = 0; }
}

// Candidate base-tier resolutions, sharpest first. Each keeps the 7x12 tile grid
// (atlasSize = 2048*scale, so the ratio to tileW is invariant), which is the
// property that lets any of them stand in for any other.
//
// 0.1875 WAS REMOVED, AND 0.125 IS NOW A HARD FLOOR.
//
// 0.1875 cannot survive TILE.h = 168: 168 * 0.1875 = 31.5, a HALF-TEXEL tile
// height, so every row after the first would start mid-texel and the whole grid
// would sample half a pixel off — at the one scale that was, until this change,
// the scale actually in use. It has no replacement between 0.25 and 0.125
// because none exists that keeps both 288*s and 168*s whole.
//
// 0.125 is the floor from below. It puts the tile at a whole 36x21 and leaves
// 1.5 texels of margin above and below each cover and 1.25 texels between
// neighbouring regions — the tightest anything may be with mipmapping on. One
// step coarser drops those under a texel and mip level 1 starts bleeding each
// cover into its neighbour. tests/covers.test.mjs asserts exactly this on both
// axes, so an entry added below 0.125 fails the suite rather than the eye. (The
// sub-rect ORIGINS are still fractional — front.x = 6 is 0.75 texels at 0.125 —
// and always were; only the tile pitch has to be whole.)
export const BASE_SCALES = [0.25, 0.1875, 0.125];

/**
 * THE DETAIL TIER IS CONSTANT WITH CAPACITY; THE BASE TIER IS NOT. It covers
 * every atlas, so its cost grows linearly with how many titles the store carries
 * — at 50,000 titles that is 596 atlases, which at scale 0.25 would be 625 MB
 * and would quietly become the new binding limit.
 *
 * So the base tier's RESOLUTION is chosen to fit a byte budget rather than being
 * a fixed constant. A bigger store trades base sharpness — only ever seen at
 * distance, because anything near the player is on the detail tier — for staying
 * inside the budget. That turns capacity into a knob rather than a cliff.
 */
export function chooseBaseScale(atlasCount, budgetBytes, allowed = BASE_SCALES) {
  for (const s of allowed) {
    const size = Math.round(2048 * s);
    if (atlasCount * size * size * 4 <= budgetBytes) return s;
  }
  return allowed[allowed.length - 1];
}

/** Pure, instant: where every title's tile lives. No canvases are allocated. */
export function planCoverAtlases(catalog, scale = 1) {
  const tileW = TILE.w * scale, tileH = TILE.h * scale;
  const atlasSize = Math.round(2048 * scale);
  const cols = Math.floor(atlasSize / tileW), rows = Math.floor(atlasSize / tileH);
  const perAtlas = cols * rows;
  const tiles = new Map();
  catalog.forEach((t, i) => {
    const local = i % perAtlas;
    tiles.set(t.id, { atlas: Math.floor(i / perAtlas), col: local % cols, row: Math.floor(local / cols) });
  });
  return {
    tiles, cols, rows, tileW, tileH, atlasSize, perAtlas, scale,
    count: Math.max(1, Math.ceil(catalog.length / perAtlas)),
  };
}

/** A blank atlas canvas at the given scale, ready to be filled tile by tile. */
export function createAtlasCanvas(scale) {
  const size = Math.round(2048 * scale);
  const canvas = cv(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#15151c'; ctx.fillRect(0, 0, size, size);
  return canvas;
}

/**
 * Draw a RANGE of one atlas's tiles into an existing canvas, and return how many
 * were drawn. Resumable at tile granularity, which is what lets the streamer
 * honour a per-frame millisecond budget instead of blocking for a whole atlas:
 * a 2048px atlas is 96 tile draws, and 96 of those in one go is a visible hitch.
 *
 * `scale` may differ from the plan's scale — the grid is identical at every
 * scale, so this is how one atlas index is rendered at base or detail
 * resolution from the same plan.
 */
export function drawAtlasTiles(catalog, plan, atlasIdx, scale, canvas, fromLocal, maxTiles, tileCache = null) {
  const tileW = TILE.w * scale, tileH = TILE.h * scale;
  const ctx = canvas.getContext('2d');
  const start = atlasIdx * plan.perAtlas;
  const total = Math.min(catalog.length - start, plan.perAtlas);
  const end = Math.min(total, fromLocal + maxTiles);
  for (let local = fromLocal; local < end; local++) {
    const t = catalog[start + local];
    const col = local % plan.cols, row = Math.floor(local / plan.cols);
    if (tileCache) {
      // Keyed by SCALE as well as id — a 512px tile blitted into a 2048px atlas
      // would be a quarter-size cover marooned in the corner of its slot.
      const key = `${scale}|${t.id}`;
      let tileCv = tileCache.get(key);
      if (!tileCv) {
        tileCv = cv(tileW, tileH);
        drawCoverTile(tileCv.getContext('2d'), 0, 0, t, scale);
        tileCache.set(key, tileCv, tileW * tileH * 4);
      }
      ctx.drawImage(tileCv, col * tileW, row * tileH);
    } else {
      drawCoverTile(ctx, col * tileW, row * tileH, t, scale);
    }
  }
  return Math.max(0, end - fromLocal);
}

/** Tiles in one atlas of a plan (the last atlas is usually short). */
export function atlasTileCount(catalog, plan, atlasIdx) {
  return Math.min(catalog.length - atlasIdx * plan.perAtlas, plan.perAtlas);
}

/** Draw ONE atlas of a plan in full. */
export function drawCoverAtlas(catalog, plan, atlasIdx, scale = plan.scale, tileCache = null) {
  const canvas = createAtlasCanvas(scale);
  drawAtlasTiles(catalog, plan, atlasIdx, scale, canvas, 0, plan.perAtlas, tileCache);
  return canvas;
}

/**
 * A blank case tile — what a shelf shows while its atlas is still being drawn.
 * Deliberately a plausible unlabelled case (dark board, pale page edge) rather
 * than a magenta "missing texture", so a case in flight reads as stock waiting
 * to be faced out. Every atlas is eventually drawn, so this is always transient.
 */
export function makeCasePlaceholder(scale = 0.125) {
  const tileW = TILE.w * scale, tileH = TILE.h * scale;
  const size = Math.round(2048 * scale);
  const c = cv(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#15151c'; ctx.fillRect(0, 0, size, size);
  const cols = Math.floor(size / tileW), rows = Math.floor(size / tileH);
  const sc = (r) => ({ x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale });
  const f = sc(TILE.front), sp = sc(TILE.spine), b = sc(TILE.back), e = sc(TILE.edge);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const ox = col * tileW, oy = row * tileH;
      ctx.fillStyle = '#232334';
      ctx.fillRect(ox + f.x, oy + f.y, f.w, f.h);
      ctx.fillRect(ox + b.x, oy + b.y, b.w, b.h);
      ctx.fillStyle = '#1b1b28';
      ctx.fillRect(ox + sp.x, oy + sp.y, sp.w, sp.h);
      ctx.fillStyle = '#dedbd3';
      ctx.fillRect(ox + e.x, oy + e.y, e.w, e.h);
    }
  }
  return c;
}

// Build every atlas eagerly. Retained for tests and any caller that genuinely
// wants the whole set in one go; the running store streams instead (covers.js).
// tileCache (Map "scale|id" → offscreen tile canvas) makes RESTOCK cheap.
export function buildCoverAtlases(catalog, scale = 1, onProgress = null, tileCache = null) {
  const plan = planCoverAtlases(catalog, scale);
  const canvases = [];
  for (let a = 0; a < plan.count; a++) {
    canvases[a] = drawCoverAtlas(catalog, plan, a, scale, tileCache);
    if (onProgress) onProgress(Math.min(catalog.length, (a + 1) * plan.perAtlas), catalog.length);
  }
  return { canvases, ...plan };
}

// Inspector close-up. Goes through drawCoverTile, which paints its front via the
// authority — so the case you pick up shows the same artwork as the case on the
// shelf, the wall poster and the search thumbnail.
/**
 * The hi-res cover for a HELD case.
 *
 * THIS WAS THE ONE TEXTURE CLASS IN THE STORE OUTSIDE THE DEVICE BUDGET.
 * Every other surface goes through texture-budget.js, which exists precisely
 * to keep a phone under the memory ceiling that gets a tab jetsam-killed.
 * This one hardcoded scale 4 — a 1152x704 canvas, ~3.2 MB, ~4.3 MB once the
 * driver allocates mips — on every device, and since the case back began
 * swapping in a real backdrop there are briefly TWO of them per pick-up.
 * Picking titles up and putting them back was therefore the heaviest thing a
 * phone could be asked to do, repeatedly.
 *
 * Scale 2 is 576x352: a quarter of the memory, and still well above what a
 * case held at arm's length resolves to on a phone screen (the front region
 * alone lands at 216x304 device pixels). Desktop keeps 4 and is untouched.
 */
export function makeHiResCover(t, opts = {}) {
  const scale = isMobile() ? 2 : 4;
  const c = cv(TILE.w * scale, TILE.h * scale);
  drawCoverTile(c.getContext('2d'), 0, 0, t, scale, opts);
  return c;
}

// UI thumbnails draw the cover DIRECTLY rather than blitting it back out of an
// atlas canvas. Two reasons, both structural:
//
//   1. RESIDENCY INDEPENDENCE. Once atlases stream in and out by proximity, the
//      atlas holding an arbitrary search result may be at low resolution or, on
//      a future scheme, not resident at all. A thumbnail must not depend on
//      where the player happens to be standing.
//   2. It is SHARPER. Blitting downsampled a 64x40 base-tier tile into a 92px
//      thumb; drawing at the requested size renders at native resolution.
//
// Still deterministic per title id — drawCoverFront is a pure function of the
// title — so the same title always produces the same thumbnail.
//
// The `tiles` LOOKUP IS KEPT AND IS NOT ABOUT PIXELS. A title absent from the
// plan is in BACK-STOCK, and returning null is how the UI knows to say so
// (ui.js thumb() → NO_THUMB → "IN BACK-STOCK — we'll bring it out for you").
// Only the plan is consulted, never a canvas, so the answer does not change
// with where the player is standing.
export function makeThumb(atlases, t, size = 92) {
  if (!t || !atlases?.tiles?.has(t.id)) return null;
  const f = TILE.front;
  const c = cv(Math.round(size * (f.w / f.h)), size);
  // Through the SAME authority as the shelf case. The audit found this still
  // drawing generated art after the cases had migrated — so a search result
  // showed one image and the case on the shelf showed another, for one film.
  paintArtwork(c.getContext('2d'), 0, 0, c.width, c.height, t);
  return c.toDataURL();
}

/**
 * Wall poster / standee art. Prefers the title's REAL poster, exactly as the
 * shelf cases do — the walls were still printing generated art after the cases
 * had switched over, so a display advertised one thing and the case beside it
 * showed another. Same title, same artwork, wherever it appears.
 *
 * Wall posters are a natural 2:3, so the real image needs no crop here.
 */
export function makePoster(t, w = 340, h = 500) {
  const c = allocCanvas(w, h, 'poster');
  const ctx = c.getContext('2d');
  paintArtwork(ctx, 0, 0, w, h, t);
  return c;
}

/** Posters are built at shell-build time, so their art must be resident first. */
export function preloadPosterArt(titles) { return loadArtwork(titles); }

// ---------------------------------------------------------------------------
// Environment textures
// ---------------------------------------------------------------------------
// Carpet cost control. The floor is a per-building bake — it carries the AO
// under every fixture and the entrance mat, so it cannot simply be a repeating
// swatch — but a nine-service store is 26 x 54.8m, 2.9x the floor the original
// 48px/m canvas was written for. Two bounds keep it affordable:
//
//   CARPET_MAX_AXIS  no canvas axis exceeds 2048 texels, so the resolution
//                    drops (48 -> ~37 px/m at 55m) instead of the texture
//                    growing to 13MB. 37px/m is a 27mm texel on a surface only
//                    ever seen at a grazing angle from 1.62m up.
//   CARPET_TILE_M    the speckle field — the only O(area) part, ~100k canvas
//                    arcs on a big store — is drawn ONCE into a seamless 6.4m
//                    swatch and repeated with createPattern. Cost is now
//                    constant: ~2.5k arcs whatever the building measures.
//
// Everything that must stay unique to the building (obstacle AO, wall vignette,
// traffic wear, entrance gradient and mat) is still drawn per store, in world
// metres, at O(obstacles).
const CARPET_MAX_AXIS = 2048;
const CARPET_TILE_M = 6.4;

export function makeCarpet(bounds, obstacles, opts = {}, px = 48) {
  const wM = bounds.maxX - bounds.minX, hM = bounds.maxZ - bounds.minZ;
  // Deterministic: same bounds => same px => same canvas.
  px = Math.max(12, Math.min(px, Math.floor(CARPET_MAX_AXIS / Math.max(wM, hM))));
  const w = Math.round(wM * px);
  const h = Math.round(hM * px);
  const c = allocCanvas(w, h, 'wall');
  const ctx = c.getContext('2d');
  const rng = mulberry32(opts.seed ?? 42);
  const grain = px / 48;   // keep speck SIZE physical, not pixel-fixed

  // --- seamless speckle swatch (classic rental carpet), drawn once
  const tp = Math.max(2, Math.round(CARPET_TILE_M * px));
  const tile = cv(tp, tp);
  const tctx = tile.getContext('2d');
  tctx.fillStyle = opts.base ?? '#252f63';
  tctx.fillRect(0, 0, tp, tp);
  // Specks near an edge are redrawn on the opposite side so the swatch tiles
  // without a visible seam grid.
  const wrapSpeckle = (n, colors, maxR) => {
    for (let i = 0; i < n; i++) {
      tctx.fillStyle = colors[(rng() * colors.length) | 0];
      const r = (0.4 + rng() * maxR) * grain;
      const sx = rng() * tp, sy = rng() * tp;
      for (const dx of [-tp, 0, tp]) for (const dy of [-tp, 0, tp]) {
        if (sx + dx < -r || sx + dx > tp + r || sy + dy < -r || sy + dy > tp + r) continue;
        tctx.beginPath(); tctx.arc(sx + dx, sy + dy, r, 0, 7); tctx.fill();
      }
    }
  };
  const density = tp * tp / (grain * grain);
  wrapSpeckle(Math.round(density / 40), opts.speckles ?? ['#2d3a7d', '#1c2450', '#39469a', '#2a3670', '#141a3c'], 2.2);
  wrapSpeckle(Math.round(density / 200), ['#e0b53455', '#c2453f44', '#3fae7a33'], 1.6);

  ctx.fillStyle = opts.base ?? '#252f63';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = ctx.createPattern(tile, 'repeat');
  ctx.fillRect(0, 0, w, h);

  // subtle traffic wear along main aisles — per SQUARE METRE, so a long store
  // does not end up with the same 260 scuffs spread over three times the floor
  ctx.fillStyle = 'rgba(255,255,255,0.028)';
  const wear = Math.min(900, Math.round(wM * hM * 0.55));
  for (let i = 0; i < wear; i++) {
    const ax = w * (0.18 + rng() * 0.64), az = rng() * h;
    ctx.beginPath();
    ctx.ellipse(ax, az, (18 + rng() * 46) * grain, (8 + rng() * 18) * grain, rng() * 3, 0, 7);
    ctx.fill();
  }

  const toPx = (x, z) => ({ x: (x - bounds.minX) * px, y: (z - bounds.minZ) * px });

  // baked AO under every obstacle
  for (const o of obstacles) {
    const p = toPx(o.x - o.hw, o.z - o.hd);
    const ww = o.hw * 2 * px, hh = o.hd * 2 * px;
    const pad = px * 0.34;
    const g2 = ctx.createRadialGradient(p.x + ww / 2, p.y + hh / 2, Math.min(ww, hh) * 0.18, p.x + ww / 2, p.y + hh / 2, Math.max(ww, hh) * 0.72 + pad);
    g2.addColorStop(0, 'rgba(0,0,10,0.5)');
    g2.addColorStop(0.7, 'rgba(0,0,10,0.32)');
    g2.addColorStop(1, 'rgba(0,0,10,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(p.x - pad * 2, p.y - pad * 2, ww + pad * 4, hh + pad * 4);
  }
  // wall vignette
  const edge = px * 1.1;
  const grds = [
    ctx.createLinearGradient(0, 0, edge, 0), ctx.createLinearGradient(w, 0, w - edge, 0),
    ctx.createLinearGradient(0, 0, 0, edge), ctx.createLinearGradient(0, h, 0, h - edge),
  ];
  grds.forEach((g, i) => {
    g.addColorStop(0, 'rgba(0,0,12,0.42)'); g.addColorStop(1, 'rgba(0,0,12,0)');
    ctx.fillStyle = g;
    if (i === 0) ctx.fillRect(0, 0, edge, h);
    if (i === 1) ctx.fillRect(w - edge, 0, edge, h);
    if (i === 2) ctx.fillRect(0, 0, w, edge);
    if (i === 3) ctx.fillRect(0, h - edge, w, edge);
  });
  if (opts.entrance === false) return c;

  // Brighter toward the entrance (+z = bottom of canvas). Measured in METRES
  // from the front wall: as a fraction of depth this was a 30m-long ramp in a
  // nine-service store, which is exactly the "front bright, back muddy" read
  // the building is not supposed to have.
  const fr = ctx.createLinearGradient(0, h, 0, h - Math.min(h, 7 * px));
  fr.addColorStop(0, 'rgba(255,246,214,0.07)'); fr.addColorStop(1, 'rgba(255,246,214,0)');
  ctx.fillStyle = fr; ctx.fillRect(0, 0, w, h);

  // entrance mat
  const mat = toPx(-1.7, bounds.maxZ - 1.9);
  ctx.fillStyle = '#1a1d24';
  ctx.fillRect(mat.x, mat.y, 3.4 * px, 1.55 * px);
  ctx.strokeStyle = BRAND.gold; ctx.lineWidth = px * 0.05;
  ctx.strokeRect(mat.x + px * 0.1, mat.y + px * 0.1, 3.2 * px, 1.35 * px);
  ctx.fillStyle = BRAND.gold;
  ctx.font = `900 ${px * 0.42}px 'Arial Black',Arial`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('BE KIND · REWIND', mat.x + 1.7 * px, mat.y + 0.78 * px);
  return c;
}

export function makeCeiling(wM, dM, px = 26) {
  const w = Math.round(wM * px), h = Math.round(dM * px);
  const c = allocCanvas(w, h, 'wall');
  const ctx = c.getContext('2d');
  const rng = mulberry32(7);
  ctx.fillStyle = '#e8e6df';
  ctx.fillRect(0, 0, w, h);
  const tw = 0.61 * px, th = 1.22 * px; // 2×4 ft tiles
  for (let y = 0; y < h; y += th) for (let x = 0; x < w; x += tw) {
    ctx.fillStyle = `rgba(190,188,178,${0.05 + rng() * 0.1})`;
    ctx.fillRect(x, y, tw, th);
    speckle(ctx, x, y, tw, th, 26, rng, ['rgba(120,118,110,0.16)'], 0.7);
  }
  ctx.strokeStyle = 'rgba(140,138,128,0.6)';
  ctx.lineWidth = 1.2;
  for (let x = 0; x < w; x += tw) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y < h; y += th) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  return c;
}

export function makeWall(wM, hM, opts = {}, px = 40) {
  const w = Math.round(wM * px), h = Math.round(hM * px);
  const c = allocCanvas(w, h, 'wall');
  const ctx = c.getContext('2d');
  const rng = mulberry32(hashStr(opts.seed || 'wall'));
  // upper paint
  const gr = ctx.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, '#efece3'); gr.addColorStop(1, '#ddd9cd');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
  speckle(ctx, 0, 0, w, h * 0.9, Math.round(w * h / 900), rng, ['rgba(160,155,140,0.06)', 'rgba(255,255,255,0.05)'], 1.1);
  // brand band: navy with gold pinstripes (y measured from floor = bottom)
  const bandY0 = h - 2.62 * px, bandH = 0.5 * px;
  ctx.fillStyle = BRAND.navy;
  ctx.fillRect(0, bandY0, w, bandH);
  ctx.fillStyle = BRAND.gold;
  ctx.fillRect(0, bandY0 - 0.07 * px, w, 0.06 * px);
  ctx.fillRect(0, bandY0 + bandH + 0.01 * px, w, 0.06 * px);
  // baseboard + scuffs
  ctx.fillStyle = '#3a3f4a';
  ctx.fillRect(0, h - 0.16 * px, w, 0.16 * px);
  ctx.fillStyle = 'rgba(70,70,80,0.18)';
  for (let i = 0; i < w / 30; i++) {
    ctx.fillRect(rng() * w, h - (0.18 + rng() * 0.3) * px, 6 + rng() * 22, 2 + rng() * 3);
  }
  return c;
}

export function makeHangingSign(text, sub, hue = 220) {
  const c = allocCanvas(560, 220, 'sign');
  const ctx = c.getContext('2d');
  ctx.fillStyle = BRAND.navy;
  roundRect(ctx, 6, 6, 548, 208, 18); ctx.fill();
  ctx.strokeStyle = BRAND.gold; ctx.lineWidth = 7;
  roundRect(ctx, 13, 13, 534, 194, 14); ctx.stroke();
  ctx.fillStyle = hsl(hue, 80, 60, 0.22);
  roundRect(ctx, 13, 13, 534, 194, 14); ctx.fill();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  const px = fitFont(ctx, text, 480, 84, `'Arial Black','Arial',sans-serif`);
  ctx.font = `900 ${px}px 'Arial Black','Arial',sans-serif`;
  ctx.fillText(text, 280, sub ? 92 : 110);
  if (sub) {
    ctx.fillStyle = BRAND.goldLight;
    ctx.font = `700 30px Arial`;
    ctx.fillText(sub, 280, 165);
  }
  return c;
}

export function makeDeptHeader(label, hue = 48) {
  const c = allocCanvas(768, 96, 'sign');
  const ctx = c.getContext('2d');
  const gr = ctx.createLinearGradient(0, 0, 0, 96);
  gr.addColorStop(0, BRAND.goldLight); gr.addColorStop(1, BRAND.gold);
  ctx.fillStyle = gr; ctx.fillRect(0, 0, 768, 96);
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.fillRect(0, 88, 768, 8);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = BRAND.navy;
  const px = fitFont(ctx, label, 700, 62, `'Arial Black','Arial',sans-serif`);
  ctx.font = `900 ${px}px 'Arial Black','Arial',sans-serif`;
  ctx.fillText(label, 384, 52);
  return c;
}

export function makeLogoSign(w = 1024, h = 320) {
  const c = allocCanvas(w, h, 'sign');
  const ctx = c.getContext('2d');
  ctx.fillStyle = BRAND.navy;
  roundRect(ctx, 4, 4, w - 8, h - 8, 26); ctx.fill();
  ctx.strokeStyle = BRAND.gold; ctx.lineWidth = 10;
  roundRect(ctx, 14, 14, w - 28, h - 28, 20); ctx.stroke();
  // torn ticket glyph
  ctx.save();
  ctx.translate(w * 0.5, h * 0.40); ctx.rotate(-0.06);
  ctx.fillStyle = BRAND.gold;
  roundRect(ctx, -w * 0.34, -h * 0.19, w * 0.68, h * 0.38, 18); ctx.fill();
  ctx.fillStyle = BRAND.navy;
  for (let i = 0; i < 12; i++) {
    ctx.beginPath();
    ctx.arc(-w * 0.34 + (i + 0.5) * (w * 0.68 / 12), -h * 0.19, 5, 0, 7);
    ctx.arc(-w * 0.34 + (i + 0.5) * (w * 0.68 / 12), h * 0.19, 5, 0, 7);
    ctx.fill();
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = BRAND.navy;
  ctx.font = `italic 900 ${h * 0.30}px 'Arial Black','Arial',sans-serif`;
  ctx.fillText('TAPEBUSTER', 0, 2);
  ctx.restore();
  ctx.textAlign = 'center';
  ctx.fillStyle = BRAND.goldLight;
  ctx.font = `800 ${h * 0.10}px Arial`;
  ctx.fillText('MOVIES · SERIES · SNACKS', w / 2, h * 0.78);
  return c;
}

/**
 * What you see THROUGH a clerestory pane: night sky with the car-park sodium
 * glow washing up from below, and a scatter of far-off lights near the horizon.
 *
 * This is a real surface sitting at the back of the window reveal, not a glow
 * applied to the glass. That distinction is the whole point — an emissive pane
 * reads as a lit rectangle stuck on the wall, whereas glass in front of a bright
 * exterior reads as a window, and lets the glass itself stay glassy (dark, sharp
 * specular from the store's own fittings).
 */
export function makeSkyPanel(w = 256, h = 128, seed = 4711) {
  // SEEDED. Every window used to share one panel, so the same forty stars and
  // the same lamp bloom sat in every opening down a 148 m wall — the single
  // strongest tell that the elevation was one prefab repeated. The gradient
  // stops stay within a narrow band so the building still reads as one night,
  // one town glow; only the star field, the lamp position and a few degrees of
  // colour temperature move.
  const c = cv(w, h);
  const ctx = c.getContext('2d');
  const rng = mulberry32(seed);
  const warp = (rng() - 0.5) * 0.10;         // small, shared-sky variation
  // Pitched BRIGHT, and deliberately so. A physically honest night sky is nearly
  // black, which through a small opening just reads as a dark hole punched in the
  // wall — the first attempt did exactly that. What sells "window" from inside a
  // brightly lit shop is the town glow: a lifted, warm-toward-the-horizon wash
  // that stays clearly lighter than the wall around it at every viewing angle.
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#2b3c72');
  g.addColorStop(0.40 + warp, '#4a5c96');
  g.addColorStop(0.72 + warp * 0.5, '#8f83a4');
  g.addColorStop(1, '#e0b487');          // sodium spill off the lot
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  // A lamp standard just out of view. Its position wanders along the lot so
  // adjacent windows are lit from different places, and every third opening or
  // so has no lamp near it at all — an unbroken row of identical blooms is what
  // made the wall look printed.
  const lampN = rng() < 0.72 ? 1 : 0;
  for (let i = 0; i < lampN; i++) {
    const lx = w * (0.18 + rng() * 0.7);
    const lamp = ctx.createRadialGradient(lx, h * 1.02, 2, lx, h * 1.02, h * (0.6 + rng() * 0.3));
    lamp.addColorStop(0, `rgba(255,214,158,${(0.62 + rng() * 0.24).toFixed(2)})`);
    lamp.addColorStop(1, 'rgba(255,214,158,0)');
    ctx.fillStyle = lamp; ctx.fillRect(0, 0, w, h);
  }
  const stars = 28 + Math.floor(rng() * 26);
  for (let i = 0; i < stars; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.10 + rng() * 0.35})`;
    ctx.fillRect(rng() * w, rng() * h * 0.55, 1, 1);
  }
  // Distant roofline / signage across the lot, so there is something OUT there
  // rather than an empty gradient. Kept low-contrast: it must not compete with
  // the shop interior or start reading as a texture.
  const roof = h * (0.66 + rng() * 0.08);
  ctx.fillStyle = 'rgba(24,28,48,0.55)';
  let rx = 0;
  while (rx < w) {
    const bw = 12 + rng() * 34, bh = 4 + rng() * 14;
    ctx.fillRect(rx, roof - bh, bw, bh + 6);
    if (rng() < 0.22) {
      ctx.fillStyle = `rgba(255,${180 + Math.floor(rng() * 60)},120,0.5)`;
      ctx.fillRect(rx + 3, roof - bh + 2, Math.min(bw - 6, 6 + rng() * 10), 2);
      ctx.fillStyle = 'rgba(24,28,48,0.55)';
    }
    rx += bw + rng() * 10;
  }
  return c;
}

export function makeNightBackdrop(w = 1600, h = 560) {
  const c = allocCanvas(w, h, 'pano');
  const ctx = c.getContext('2d');
  const rng = mulberry32(99);
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.75);
  sky.addColorStop(0, '#070b1e'); sky.addColorStop(0.6, '#12183a'); sky.addColorStop(1, '#3a2c50');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 120; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.2 + rng() * 0.6})`;
    ctx.fillRect(rng() * w, rng() * h * 0.5, 1.4, 1.4);
  }
  // distant strip mall + horizon glow
  const glow = ctx.createLinearGradient(0, h * 0.55, 0, h * 0.75);
  glow.addColorStop(0, 'rgba(255,150,60,0)'); glow.addColorStop(1, 'rgba(255,150,60,0.25)');
  ctx.fillStyle = glow; ctx.fillRect(0, h * 0.5, w, h * 0.25);
  ctx.fillStyle = '#0a0d18';
  ctx.fillRect(0, h * 0.68, w, h * 0.1);
  // parking lot
  ctx.fillStyle = '#171a22';
  ctx.fillRect(0, h * 0.74, w, h * 0.26);
  ctx.strokeStyle = 'rgba(240,230,180,0.5)'; ctx.lineWidth = 3;
  for (let i = 0; i < 9; i++) {
    const x = w * 0.06 + i * w * 0.11;
    ctx.beginPath(); ctx.moveTo(x, h * 0.99); ctx.lineTo(x + w * 0.02, h * 0.8); ctx.stroke();
  }
  // cars
  for (let i = 0; i < 5; i++) {
    const x = w * (0.08 + rng() * 0.8), y = h * (0.8 + rng() * 0.1), cw = w * 0.075, ch = h * 0.075;
    ctx.fillStyle = ['#2a3242', '#402a33', '#2c3a31', '#3a3a48', '#232733'][i];
    roundRect(ctx, x, y, cw, ch, 8); ctx.fill();
    roundRect(ctx, x + cw * 0.18, y - ch * 0.42, cw * 0.62, ch * 0.55, 7); ctx.fill();
    ctx.fillStyle = 'rgba(160,190,230,0.28)';
    roundRect(ctx, x + cw * 0.22, y - ch * 0.36, cw * 0.54, ch * 0.4, 5); ctx.fill();
  }
  // light poles
  for (let i = 0; i < 3; i++) {
    const x = w * (0.18 + i * 0.32);
    ctx.fillStyle = '#0d0f16';
    ctx.fillRect(x, h * 0.42, 5, h * 0.4);
    const lg = ctx.createRadialGradient(x + 2, h * 0.42, 2, x + 2, h * 0.42, 90);
    lg.addColorStop(0, 'rgba(255,225,150,0.8)'); lg.addColorStop(1, 'rgba(255,225,150,0)');
    ctx.fillStyle = lg;
    ctx.beginPath(); ctx.arc(x + 2, h * 0.42, 90, 0, 7); ctx.fill();
  }
  return c;
}

export function makeSnackShelf(row) {
  const c = allocCanvas(512, 128, 'sign');
  const ctx = c.getContext('2d');
  const rng = mulberry32(300 + row);
  ctx.fillStyle = '#1a1e2c';
  ctx.fillRect(0, 0, 512, 128);
  const names = ['POP', 'CHOC', 'SOUR', 'FIZZ', 'CHEW', 'CORN', 'MIX', 'BITS'];
  let x = 6;
  while (x < 470) {
    const bw = 40 + rng() * 26, bh = 86 + rng() * 26, hue = rng() * 360;
    ctx.fillStyle = hsl(hue, 78, 52);
    roundRect(ctx, x, 122 - bh, bw, bh, 5); ctx.fill();
    ctx.fillStyle = hsl((hue + 180) % 360, 80, 82);
    roundRect(ctx, x + 5, 122 - bh + 8, bw - 10, bh * 0.3, 4); ctx.fill();
    ctx.fillStyle = hsl(hue, 90, 20);
    ctx.font = `900 ${10 + rng() * 4}px Arial`;
    ctx.textAlign = 'center';
    ctx.fillText(names[(rng() * names.length) | 0], x + bw / 2, 122 - bh + 8 + bh * 0.2);
    x += bw + 5;
  }
  return c;
}

export function makeReturnBinFace() {
  const c = allocCanvas(384, 512, 'sign');
  const ctx = c.getContext('2d');
  ctx.fillStyle = BRAND.navy; ctx.fillRect(0, 0, 384, 512);
  ctx.strokeStyle = BRAND.gold; ctx.lineWidth = 10;
  ctx.strokeRect(14, 14, 356, 484);
  ctx.textAlign = 'center';
  ctx.fillStyle = BRAND.goldLight;
  ctx.font = `900 58px 'Arial Black',Arial`;
  ctx.fillText('RETURN', 192, 150);
  ctx.fillText('MOVIES', 192, 220);
  ctx.fillText('HERE', 192, 290);
  ctx.fillStyle = '#0a0a14';
  roundRect(ctx, 60, 350, 264, 46, 20); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `700 26px Arial`;
  ctx.fillText('▼  DROP SLOT  ▼', 192, 440);
  return c;
}

export function makeCounterFront(wM = 3.0) {
  // W, NOT c.width. allocCanvas may return a physically smaller canvas with a
  // pre-scaled context, so c.width is the BACKING size while the painter works
  // in logical space — reading it back here would paint 70% of the counter on
  // a phone and centre the logo in the wrong place.
  const W = Math.round(wM * 280);
  const c = allocCanvas(W, 300, 'sign');
  const ctx = c.getContext('2d');
  ctx.fillStyle = BRAND.navy; ctx.fillRect(0, 0, W, 300);
  const gr = ctx.createLinearGradient(0, 0, 0, 300);
  gr.addColorStop(0, 'rgba(255,255,255,0.14)'); gr.addColorStop(0.2, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, W, 300);
  ctx.fillStyle = BRAND.gold; ctx.fillRect(0, 24, W, 14);
  const logo = makeLogoSign(560, 180);
  ctx.drawImage(logo, W / 2 - 140, 92, 280, 90);
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(0, 288, W, 12);
  return c;
}

export function makeOpenNeon() {
  const c = cv(256, 128);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 256, 128);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const [blur, alpha] of [[22, 0.7], [10, 0.9], [0, 1]]) {
    ctx.shadowColor = '#ff3355'; ctx.shadowBlur = blur;
    ctx.fillStyle = `rgba(255,120,150,${alpha})`;
    ctx.font = `900 74px 'Arial Black',Arial`;
    ctx.fillText('OPEN', 128, 66);
  }
  return c;
}

// Classic red/white striped popcorn-machine canopy with bold lettering.
export function makePopcornSign(w = 512, h = 128) {
  const c = allocCanvas(w, h, 'sign');
  const ctx = c.getContext('2d');
  const stripeW = w / 12;
  for (let i = 0; i < 12; i++) {
    ctx.fillStyle = i % 2 ? '#f4efe6' : '#c0271d';
    ctx.fillRect(i * stripeW, 0, stripeW + 1, h);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  roundRect(ctx, w * 0.08, h * 0.22, w * 0.84, h * 0.56, 14);
  ctx.fill();
  ctx.strokeStyle = '#c0271d'; ctx.lineWidth = 5;
  roundRect(ctx, w * 0.08, h * 0.22, w * 0.84, h * 0.56, 14);
  ctx.stroke();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#c0271d';
  ctx.font = `900 ${h * 0.42}px 'Arial Black',Arial`;
  ctx.fillText('POPCORN', w / 2, h * 0.52);
  return c;
}

// Mezzanine slab fascia: navy band, gold stripes, repeating wayfinding lettering.
export function makeFascia(text = 'TELEVISION & SERIES  ↑  UPSTAIRS') {
  const c = allocCanvas(1024, 64, 'sign');
  const ctx = c.getContext('2d');
  ctx.fillStyle = BRAND.navy; ctx.fillRect(0, 0, 1024, 64);
  ctx.fillStyle = BRAND.gold;
  ctx.fillRect(0, 3, 1024, 4); ctx.fillRect(0, 57, 1024, 4);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = BRAND.goldLight;
  ctx.font = `900 30px 'Arial Black',Arial`;
  ctx.fillText(text + '  ·  ', 512, 34, 1000);
  return c;
}

export function makeStepTread() {
  const c = cv(128, 64);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2c2e33'; ctx.fillRect(0, 0, 128, 64);
  ctx.fillStyle = '#3b3e45';
  for (let x = 2; x < 128; x += 6) ctx.fillRect(x, 0, 2.5, 64);
  ctx.fillStyle = '#e8c832'; // safety demarcation edges
  ctx.fillRect(0, 0, 128, 5); ctx.fillRect(0, 59, 128, 5);
  return c;
}

export function makeHandrailStripe() {
  const c = cv(64, 16);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#17181c'; ctx.fillRect(0, 0, 64, 16);
  ctx.fillStyle = '#26282e';
  ctx.fillRect(0, 0, 6, 16); ctx.fillRect(32, 0, 6, 16);
  return c;
}

// CRT static for the Binge Zone television (redraw + needsUpdate to animate)
export function drawStatic(canvas) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = (Math.random() * 210 + 20) | 0;
    img.data[i] = v * 0.75; img.data[i + 1] = v * 0.85; img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
  return canvas;
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
