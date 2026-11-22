// Motion: ember particles, the streak flame, odometer numbers and number tweens.

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EMBERS = ['#FFE3A3', '#FFC56B', '#FF9A4D', '#FF7A3D', '#F2385A'];
const GOLD = ['#FFF6D8', '#FFE3A3', '#FFD36E', '#FFC56B', '#FFB347'];

// ---- Glow sprites (pre-rendered, so hundreds of particles stay at 120 fps) -------------------------
const sprites = new Map();
function sprite(color, core = true) {
  const key = color + core;
  if (sprites.has(key)) return sprites.get(key);
  const s = 64, c = new OffscreenCanvas(s, s), g = c.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, core ? '#FFFFFF' : color);
  grd.addColorStop(0.18, color);
  grd.addColorStop(0.45, color + '66');
  grd.addColorStop(1, color + '00');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  sprites.set(key, c);
  return c;
}

// ---- Particle field ------------------------------------------------------------------------------
export class Field {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.ps = [];
    this.running = false;
    this.onArrive = null;
    this.resize();
    addEventListener('resize', () => this.resize());
  }
  resize() {
    const d = devicePixelRatio || 1;
    this.w = innerWidth; this.h = innerHeight;
    this.c.width = this.w * d; this.c.height = this.h * d;
    this.g.setTransform(d, 0, 0, d, 0, 0);
  }
  add(p) { this.ps.push(p); if (!this.running) { this.running = true; this.last = performance.now(); requestAnimationFrame((t) => this.tick(t)); } }
  tick(t) {
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    const g = this.g;
    g.clearRect(0, 0, this.w, this.h);
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    g.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    let arrived = 0;
    this.ps = this.ps.filter((p) => {
      p.age += dt;
      if (p.age < 0) return true;
      if (p.target && p.age > p.homeAt) {
        // ease toward the target, accelerating
        const k = Math.min(1, (p.age - p.homeAt) / p.homeDur);
        const e = k * k * (3 - 2 * k);
        if (!p.from) {
          p.from = { x: p.x, y: p.y };
          if (typeof p.target === 'function') p.target = p.target(); // resolve where home is *now*
        }
        const cx = (p.from.x + p.target.x) / 2 + p.curve, cy = Math.min(p.from.y, p.target.y) - 80;
        const u = 1 - e;
        p.x = u * u * p.from.x + 2 * u * e * cx + e * e * p.target.x;
        p.y = u * u * p.from.y + 2 * u * e * cy + e * e * p.target.y;
        if (k >= 1) { arrived++; return false; }
      } else {
        p.vx *= Math.pow(p.drag, dt * 60); p.vy *= Math.pow(p.drag, dt * 60);
        p.vy += p.gravity * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (!p.target && p.age > p.life) return false;
      }
      const lifeK = p.target ? 1 : 1 - p.age / p.life;
      const flick = 0.75 + 0.25 * Math.sin(p.age * p.flickF + p.phase);
      const size = p.size * (0.6 + 0.4 * lifeK) * flick;
      g.globalAlpha = Math.max(0, Math.min(1, lifeK * 1.4)) * (p.alpha ?? 1);
      g.drawImage(sprite(p.color), p.x - size * 3, p.y - size * 3, size * 6, size * 6);
      return true;
    });
    g.globalAlpha = 1;
    if (arrived && this.onArrive) this.onArrive(arrived);
    if (this.ps.length) requestAnimationFrame((tt) => this.tick(tt));
    else { this.running = false; g.clearRect(0, 0, this.w, this.h); }
  }

  /** The goal-met burst: a ring of embers that blooms outward, drifts, and partly flies home to `target`. */
  celebrate({ x, y, radius = 150, count = 220, target = null, gold = false }) {
    if (reduced) return;
    const pal = gold ? GOLD : EMBERS;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.2;
      const speed = 160 + Math.random() * 420;
      const homing = target && i % 3 === 0;
      this.add({
        x: x + Math.cos(a) * radius, y: y + Math.sin(a) * radius,
        vx: Math.cos(a) * speed, vy: Math.sin(a) * speed - 40,
        drag: 0.94 + Math.random() * 0.03, gravity: -18 - Math.random() * 30,
        size: 1.4 + Math.random() * 3.2, color: pal[(Math.random() * pal.length) | 0],
        age: -0.25 - Math.random() * 0.25, life: 1.6 + Math.random() * 1.8,
        flickF: 8 + Math.random() * 14, phase: Math.random() * 6,
        target: homing ? target : null, homeAt: 1.5 + Math.random() * 0.7, homeDur: 0.9 + Math.random() * 0.5,
        curve: (Math.random() - 0.5) * 300,
      });
    }
    // slow rising sparks for the afterglow
    for (let i = 0; i < 70; i++) {
      this.add({
        x: x + (Math.random() - 0.5) * this.w * 0.7, y: this.h + 10,
        vx: (Math.random() - 0.5) * 20, vy: -60 - Math.random() * 120,
        drag: 0.995, gravity: -6, size: 1 + Math.random() * 2, color: pal[(Math.random() * pal.length) | 0],
        age: -Math.random() * 1.8, life: 3 + Math.random() * 2, flickF: 6 + Math.random() * 10, phase: Math.random() * 6, alpha: 0.8,
      });
    }
  }

  /** A small puff, for milestones and inbox arrivals. */
  puff({ x, y, count = 26, spread = 90 }) {
    if (reduced) return;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, s = 30 + Math.random() * spread;
      this.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 30, drag: 0.93, gravity: -25, size: 1 + Math.random() * 2,
        color: EMBERS[(Math.random() * EMBERS.length) | 0], age: 0, life: 0.7 + Math.random() * 0.7, flickF: 12, phase: Math.random() * 6 });
    }
  }
}

// ---- Streak flame (Momentum view) -----------------------------------------------------------------
export class Flame {
  constructor(canvas) {
    this.c = canvas; this.g = canvas.getContext('2d');
    const d = devicePixelRatio || 1;
    this.size = 360;
    canvas.width = this.size * d; canvas.height = this.size * d;
    this.g.setTransform(d, 0, 0, d, 0, 0);
    this.ps = []; this.on = false; this.intensity = 0; this.target = 0;
  }
  set(streak, litToday) {
    // 0 = cold ember; grows with the streak and saturates around 30 days.
    this.target = streak <= 0 ? 0.08 : Math.min(1, 0.32 + Math.log2(1 + streak) / 6.5) * (litToday ? 1 : 0.72);
  }
  start() { if (this.on) return; this.on = true; this.intensity = 0; this.last = performance.now(); requestAnimationFrame((t) => this.tick(t)); }
  stop() { this.on = false; }
  tick(t) {
    if (!this.on) return;
    const dt = Math.min(0.05, (t - this.last) / 1000); this.last = t;
    this.intensity += (this.target - this.intensity) * Math.min(1, dt * 1.6);
    const I = this.intensity, g = this.g, S = this.size, cx = S / 2, base = S * 0.78;
    g.clearRect(0, 0, S, S);
    // soft halo
    const halo = g.createRadialGradient(cx, base - 70 * I, 0, cx, base - 60 * I, 70 + 120 * I);
    halo.addColorStop(0, `rgba(255,150,70,${0.32 * I + 0.05})`);
    halo.addColorStop(1, 'rgba(255,150,70,0)');
    g.fillStyle = halo; g.fillRect(0, 0, S, S);
    // spawn
    const rate = reduced ? 0 : 30 + 130 * I;
    let n = rate * dt;
    while (n > 0) {
      if (Math.random() < n) {
        const w = 16 + 54 * I;
        this.ps.push({ x: cx + (Math.random() - 0.5) * w, y: base + Math.random() * 6, vx: (Math.random() - 0.5) * 16,
          vy: -(40 + Math.random() * 120 * (0.4 + I)), life: 0.5 + Math.random() * (0.6 + 0.9 * I), age: 0, size: 5 + Math.random() * (8 + 18 * I),
          wob: Math.random() * 6 });
      }
      n -= 1;
    }
    const darkMode = matchMedia('(prefers-color-scheme: dark)').matches;
    g.globalCompositeOperation = darkMode ? 'lighter' : 'source-over';
    this.ps = this.ps.filter((p) => {
      p.age += dt;
      if (p.age > p.life) return false;
      const k = p.age / p.life;
      p.x += (p.vx + Math.sin(p.age * 7 + p.wob) * 18 + (cx - p.x) * 1.2) * dt;
      p.y += p.vy * dt;
      const col = k < 0.15 ? '#FFD38A' : k < 0.5 ? '#FF9A4D' : k < 0.8 ? '#FF7A3D' : '#F2385A';
      const sz = p.size * (1 - k * 0.8);
      g.globalAlpha = Math.min(1, Math.sin(Math.PI * Math.min(1, k * 1.6 + 0.08)) * (0.16 + 0.26 * I) * (darkMode ? 1 : 1.9));
      g.drawImage(sprite(col, false), p.x - sz * 2, p.y - sz * 2, sz * 4, sz * 4);
      return true;
    });
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    requestAnimationFrame((tt) => this.tick(tt));
  }
}

// ---- Odometer -------------------------------------------------------------------------------------
/** Renders `to` as rolling digit reels; when `from` is given, rolls up from it. */
export function odometer(el, to, from = null) {
  const s = String(Math.max(0, to));
  const f = from === null ? s : String(Math.max(0, from)).padStart(s.length, ' ');
  el.innerHTML = '';
  const reels = [];
  for (let i = 0; i < s.length; i++) {
    const digit = document.createElement('span'); digit.className = 'digit';
    const reel = document.createElement('span'); reel.className = 'reel';
    // two full turns so larger jumps visibly spin
    for (let k = 0; k < 20; k++) { const n = document.createElement('span'); n.textContent = k % 10; reel.append(n); }
    digit.append(reel); el.append(digit);
    const start = f[i] === ' ' ? 0 : Number(f[i]);
    let end = Number(s[i]);
    if (end < start) end += 10; // roll forward through 9 -> 0
    reel.style.transition = 'none';
    reel.style.transform = `translateY(${-start}em)`;
    reels.push([reel, end]);
  }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    reels.forEach(([reel, end], i) => {
      reel.style.transition = '';
      reel.style.transitionDelay = `${(reels.length - 1 - i) * 60}ms`;
      reel.style.transform = `translateY(${-end}em)`;
    });
  }));
}

// ---- Number tween ---------------------------------------------------------------------------------
const tweens = new WeakMap();
export function tween(el, to, { duration = 900, format = (n) => n.toLocaleString() } = {}) {
  const from = tweens.get(el)?.value ?? Number(el.dataset.v ?? to);
  el.dataset.v = to;
  if (reduced || from === to) { el.textContent = format(to); tweens.set(el, { value: to }); return; }
  const state = { value: from, start: performance.now(), id: 0 };
  const prev = tweens.get(el); if (prev?.id) cancelAnimationFrame(prev.id);
  tweens.set(el, state);
  const step = (t) => {
    const k = Math.min(1, (t - state.start) / duration);
    const e = 1 - Math.pow(1 - k, 4);
    state.value = Math.round(from + (to - from) * e);
    el.textContent = format(state.value);
    if (k < 1) state.id = requestAnimationFrame(step); else { state.id = 0; state.value = to; }
  };
  state.id = requestAnimationFrame(step);
}
