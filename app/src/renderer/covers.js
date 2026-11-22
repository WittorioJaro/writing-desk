// Offline, deterministic, text-free cover art derived from article content. Always exactly 5:2.
// Nothing here touches the network; article text is only measured (keywords, sentence rhythm), never drawn.

export const RATIO = 5 / 2;
export const EXPORT_W = 3000; // 3000 x 1200
export const STYLES = ['Bloom', 'Horizon', 'Orbit', 'Rhythm', 'Mosaic', 'Waves'];

const STOP = new Set(`the a an and or but if then of to in on at for with by from as is are was were be been being it its this that these those
i you he she we they me my your our their not no so do does did have has had will would can could should just than too very
about into over also more most some such what which who whom when where why how all any each there here out up down only own
same other again further once while because until both few nor off under above below between through during before after
i'm it's don't can't won't didn't isn't that's there's you're we're they're i've i'd i'll get got like really thing things`.split(/\s+/));

const seg = new Intl.Segmenter(undefined, { granularity: 'word' });
const words = (text) => [...seg.segment(text)].filter((s) => s.isWordLike).map((s) => s.segment);

function fnv32(str, h = 0x811c9dc5) {
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Topic signal extracted from the article. */
export function seedFrom(title, body) {
  const text = `${title}\n${body}`;
  const freq = new Map();
  for (const w0 of words(text.toLowerCase())) {
    if (w0.length <= 2 || STOP.has(w0) || /^\d+$/.test(w0)) continue;
    freq.set(w0, (freq.get(w0) || 0) + 1);
  }
  const keywords = [...freq.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6).map((e) => e[0]);
  const sentences = body.split(/[.!?\n]+/).map((s) => words(s).length).filter((n) => n > 0);
  const sentenceLengths = sentences.length ? sentences.slice(0, 64) : [3, 5, 2];
  const hash = fnv32(keywords.join(' ') + '|' + text);
  return { keywords, sentenceLengths, hash, wordCount: words(body).length };
}

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.int = (n) => Math.floor(next() * n);
  return next;
}

const PALETTES = [
  { bg: '#1B1424', bg2: '#3A1F3D', ink: '#F4E9DD', accent: '#FF6A3D', soft: '#7A3B5E' },
  { bg: '#E8EFEA', bg2: '#C9DDD3', ink: '#12302B', accent: '#FF7A59', soft: '#8DB9A8' },
  { bg: '#0E1626', bg2: '#1F3358', ink: '#E6ECF5', accent: '#FFC857', soft: '#3B5C8C' },
  { bg: '#F3EEE4', bg2: '#E4DAC8', ink: '#1D1A16', accent: '#E2412E', soft: '#C9B89C' },
  { bg: '#0F1E17', bg2: '#1F3A2C', ink: '#E7EFE3', accent: '#F2B134', soft: '#3F6B53' },
  { bg: '#F7E6DF', bg2: '#EEC9BB', ink: '#3A1E1A', accent: '#6C4DF6', soft: '#E0A895' },
  { bg: '#15102B', bg2: '#2E2063', ink: '#EDE8FF', accent: '#4DF0C9', soft: '#5240A0' },
  { bg: '#EFE4D2', bg2: '#E0CBA8', ink: '#2C2418', accent: '#1F6FEB', soft: '#C7AB80' },
  { bg: '#161616', bg2: '#2B2B2B', ink: '#F2F2F2', accent: '#FF4F79', soft: '#4A4A4A' },
  { bg: '#FFF4D6', bg2: '#FFE19A', ink: '#2B2412', accent: '#FF5B2E', soft: '#EEC25A' },
];

const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255); };
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

let grainTile = null;
function grain(ctx, W, H, alpha) {
  if (!grainTile) {
    grainTile = new OffscreenCanvas(256, 256);
    const g = grainTile.getContext('2d');
    const img = g.createImageData(256, 256);
    const r = rng(1234567);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.floor(r() * 255);
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'overlay';
  const scale = Math.max(1, W / 1500);
  ctx.scale(scale, scale);
  ctx.fillStyle = ctx.createPattern(grainTile, 'repeat');
  ctx.fillRect(0, 0, W / scale, H / scale);
  ctx.restore();
}

function smoothPath(ctx, pts) {
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const xc = (pts[i][0] + pts[i + 1][0]) / 2, yc = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], xc, yc);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
}

/**
 * Draws one cover. `style` indexes STYLES; `variant` reshuffles composition and palette while
 * staying derived from the same content.
 */
export function drawCover(ctx, W, H, seed, style, variant = 0) {
  const pal = PALETTES[(seed.hash + style * 3 + variant * 7) % PALETTES.length];
  const r = rng(seed.hash ^ Math.imul(style + 1, 0x9e3779b1) ^ Math.imul(variant + 1, 0x85ebca6b));
  const kw = seed.keywords.length ? seed.keywords : ['blank'];
  const kv = kw.map((w) => (fnv32(w) % 9973) / 9973);
  const sl = seed.sentenceLengths;
  const maxLen = Math.max(...sl);
  const u = H / 600; // unit relative to the 1500x600 reference size

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const bgGrad = ctx.createLinearGradient(0, 0, W * 0.4, H * 1.4);
  bgGrad.addColorStop(0, pal.bg);
  bgGrad.addColorStop(1, pal.bg2);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  switch (STYLES[style]) {
    case 'Bloom': {
      ctx.save();
      ctx.filter = `blur(${Math.round(70 * u)}px)`;
      const colors = [pal.soft, pal.accent, pal.bg2, pal.soft, pal.ink];
      const n = Math.min(5, kw.length + 2);
      for (let i = 0; i < n; i++) {
        const v = kv[i % kv.length];
        const x = W * (0.1 + 0.8 * ((v + i * 0.37 + r() * 0.2) % 1));
        const y = H * (0.2 + 0.6 * r());
        const rad = H * (0.35 + 0.35 * v);
        ctx.globalAlpha = i === 1 ? 0.85 : i === 4 ? 0.18 : 0.75;
        ctx.fillStyle = colors[i];
        ctx.beginPath();
        ctx.ellipse(x, y, rad * (1.2 + r() * 0.6), rad, r() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      // one crisp focal point
      const fx = W * (0.62 + 0.25 * kv[0]), fy = H * (0.3 + 0.4 * r()), fr = H * 0.045;
      ctx.fillStyle = pal.ink;
      ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.arc(fx, fy, fr, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 2 * u;
      ctx.strokeStyle = pal.ink;
      ctx.beginPath(); ctx.arc(fx, fy, fr * 2.4, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
      grain(ctx, W, H, 0.22);
      break;
    }
    case 'Horizon': {
      const sky = ctx.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, pal.bg2);
      sky.addColorStop(1, pal.bg);
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, H);
      const sx = W * (0.2 + 0.6 * kv[0]), sy = H * (0.38 + 0.12 * r()), sr = H * (0.16 + 0.06 * kv[kv.length - 1]);
      const halo = ctx.createRadialGradient(sx, sy, sr * 0.5, sx, sy, sr * 4);
      halo.addColorStop(0, hexA(pal.accent, 0.45));
      halo.addColorStop(1, hexA(pal.accent, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = pal.accent;
      ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2); ctx.fill();
      const layers = 4 + (kw.length % 3);
      for (let l = 0; l < layers; l++) {
        const t = l / (layers - 1);
        const base = H * (0.5 + 0.42 * t);
        const pts = [];
        const steps = 14;
        for (let i = 0; i <= steps; i++) {
          const len = sl[(i + l * 5) % sl.length] / maxLen;
          pts.push([(W * i) / steps, base - H * (0.05 + 0.16 * len) * (1 - t * 0.5) + r() * 8 * u]);
        }
        ctx.beginPath();
        smoothPath(ctx, pts);
        ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
        const ground = lum(pal.bg) < lum(pal.ink) ? pal.bg : pal.ink;
        ctx.fillStyle = l === layers - 1 ? ground : hexA(pal.ink, 0.12 + 0.18 * t);
        if (l < layers - 1) {
          ctx.fill();
          ctx.fillStyle = hexA(pal.soft, 0.55 - 0.3 * t);
        }
        ctx.fill();
      }
      grain(ctx, W, H, 0.16);
      break;
    }
    case 'Orbit': {
      const cx = W * (0.56 + 0.28 * kv[0]), cy = H * r.range(0.35, 0.65);
      for (let i = 0; i < 40 + (seed.wordCount % 60); i++) {
        ctx.globalAlpha = 0.15 + 0.5 * r();
        ctx.fillStyle = pal.ink;
        ctx.beginPath(); ctx.arc(r() * W, r() * H, (0.6 + r() * 1.6) * u, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      const rings = kv.map((v, i) => H * (0.16 + 0.15 * i + 0.07 * v));
      rings.forEach((rad, i) => {
        ctx.strokeStyle = hexA(pal.ink, 0.5 - i * 0.06);
        ctx.lineWidth = (i === 0 ? 3 : 1.5) * u;
        ctx.setLineDash(i % 2 ? [2 * u, 7 * u] : []);
        ctx.beginPath(); ctx.ellipse(cx, cy, rad, rad * 0.98, 0, 0, Math.PI * 2); ctx.stroke();
      });
      ctx.setLineDash([]);
      const core = ctx.createRadialGradient(cx - H * 0.03, cy - H * 0.03, 0, cx, cy, H * 0.1);
      core.addColorStop(0, pal.ink);
      core.addColorStop(1, pal.soft);
      ctx.fillStyle = core;
      ctx.beginPath(); ctx.arc(cx, cy, H * 0.08, 0, Math.PI * 2); ctx.fill();
      // accent planet on the second ring, kept inside the frame
      const ring = rings[Math.min(1, rings.length - 1)], pr = H * (0.04 + 0.04 * kv[kv.length - 1]);
      let ang = r() * Math.PI * 2, px = 0, py = 0;
      for (let k = 0; k < 24; k++) {
        px = cx + ring * Math.cos(ang); py = cy + ring * Math.sin(ang);
        if (px - pr * 3 > 0 && px + pr * 3 < W && py - pr * 3 > 0 && py + pr * 3 < H) break;
        ang += Math.PI / 12;
      }
      const glow = ctx.createRadialGradient(px, py, 0, px, py, pr * 4);
      glow.addColorStop(0, hexA(pal.accent, 0.6));
      glow.addColorStop(1, hexA(pal.accent, 0));
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(px, py, pr * 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = pal.accent;
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
      grain(ctx, W, H, 0.12);
      break;
    }
    case 'Rhythm': {
      const n = Math.min(sl.length, 40);
      const x0 = W * 0.14, span = W * 0.72, gap = span / n;
      const bw = Math.max(3 * u, gap * 0.42);
      const hi = sl.indexOf(maxLen);
      ctx.strokeStyle = hexA(pal.ink, 0.15);
      ctx.lineWidth = 1.5 * u;
      ctx.beginPath(); ctx.moveTo(x0 - gap, H / 2); ctx.lineTo(x0 + span + gap * 0.2, H / 2); ctx.stroke();
      for (let i = 0; i < n; i++) {
        const h = H * 0.06 + H * 0.62 * (sl[i] / maxLen);
        const x = x0 + i * gap + (gap - bw) / 2;
        if (i === hi) {
          const g = ctx.createLinearGradient(0, (H - h) / 2, 0, (H + h) / 2);
          g.addColorStop(0, pal.accent);
          g.addColorStop(1, hexA(pal.accent, 0.55));
          ctx.fillStyle = g;
        } else ctx.fillStyle = hexA(pal.ink, 0.25 + 0.6 * (sl[i] / maxLen));
        ctx.beginPath();
        ctx.roundRect(x, (H - h) / 2, bw, h, bw / 2);
        ctx.fill();
      }
      grain(ctx, W, H, 0.12);
      break;
    }
    case 'Mosaic': {
      const cols = 25, rows = 10, cw = W / cols, ch = H / rows;
      const bits = new TextEncoder().encode(kw.join(''));
      const ax = r.int(cols - 4), ay = r.int(rows - 3);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const b = bits[(y * cols + x) % bits.length];
          const on = ((b >> ((x + y) % 7)) & 1) === 1;
          const inAccent = x >= ax && x < ax + 4 && y >= ay && y < ay + 3 && r() < 0.7;
          const size = on ? 0.36 : 0.12 + 0.08 * r();
          ctx.fillStyle = inAccent && on ? pal.accent : on ? hexA(pal.ink, 0.85) : hexA(pal.ink, 0.22);
          ctx.beginPath();
          ctx.arc(x * cw + cw / 2, y * ch + ch / 2, Math.min(cw, ch) * size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      grain(ctx, W, H, 0.1);
      break;
    }
    case 'Waves': {
      const lines = 10 + kw.length * 3;
      const accentLine = r.int(lines);
      for (let i = 0; i < lines; i++) {
        const t = i / (lines - 1);
        const base = H * (0.12 + 0.76 * t);
        const amp = H * 0.07 * ((sl[i % sl.length] % 9) + 1) / 9;
        const f = 1.2 + 3 * kv[i % kv.length], ph = r() * Math.PI * 2;
        ctx.beginPath();
        for (let x = 0; x <= W; x += 8 * u) {
          const y = base + amp * Math.sin(ph + (f * 2 * Math.PI * x) / W) + amp * 0.35 * Math.sin(ph * 1.7 + (f * 5.1 * Math.PI * x) / W);
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        if (i === accentLine) {
          ctx.strokeStyle = pal.accent;
          ctx.lineWidth = 5 * u;
          ctx.shadowColor = hexA(pal.accent, 0.6);
          ctx.shadowBlur = 24 * u;
        } else {
          ctx.strokeStyle = hexA(pal.ink, 0.12 + 0.3 * Math.sin(Math.PI * t));
          ctx.lineWidth = 1.6 * u;
          ctx.shadowBlur = 0;
        }
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      grain(ctx, W, H, 0.14);
      break;
    }
  }
  ctx.restore();
}

/** Renders a cover to a new canvas of the given width (height = width * 2/5). */
export function renderCover(seed, style, variant, width) {
  const height = Math.round((width * 2) / 5);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  drawCover(c.getContext('2d'), width, height, seed, style, variant);
  return c;
}
