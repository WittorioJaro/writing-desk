'use strict';
// Smart covers: once a piece has a title and a few sentences, the user's own Codex CLI (signed in with
// their ChatGPT account) generates three 5:2 cover images for it in the background, using Codex's
// built-in image generation. Three runs go in parallel, one per art direction, and each image appears
// in the app as soon as it's ready.
//
// What leaves the Mac: only the title and the opening (~180 words) of the piece, sent by the Codex CLI,
// and only while "Smart covers" is on. Codex saves each image under ~/.codex/generated_images; the app
// moves it into its own covers/suggested/ folder. Suggestions and the chosen cover per piece are kept
// locally in covers.json (not synced, so the sync format stays unchanged).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { writeAtomic } = require('./store');
const { wordCount } = require('./model');

const MIN_WORDS = 60;          // "a title and some words"
const REGEN_WORDS = 200;       // suggest again once the piece has grown this much
const EXCERPT_WORDS = 180;
const MAX_AUTO_RUNS = 4;       // per piece; "Suggest again" is always allowed
const TIMEOUT_MS = 4 * 60 * 1000;

const SEARCH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.npm-global/bin'), '/usr/bin'];

const DIRECTIONS = [
  { name: 'Bold', style: 'Bold geometric: flat shapes and color fields, Swiss-poster feel.' },
  { name: 'Atmosphere', style: 'Atmospheric scene: soft light, depth and haze, cinematic calm.' },
  { name: 'Object', style: 'Symbolic object close-up: tactile, hand-crafted materials, soft studio lighting.' },
];

function findCodex() {
  if (process.env.WD_CODEX_BIN) return process.env.WD_CODEX_BIN;
  for (const dir of [...(process.env.PATH || '').split(':'), ...SEARCH_DIRS]) {
    const p = path.join(dir, 'codex');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

function excerptOf(body, n = EXCERPT_WORDS) {
  const words = body.trim().split(/\s+/);
  return words.slice(0, n).join(' ') + (words.length > n ? ' …' : '');
}

function promptFor({ title, excerpt, direction }) {
  return `Use your built-in image_gen tool to create ONE cover image for a blog article, then reply with only the absolute path of the generated file. Generate exactly one image; don't read files or run other commands.

Format: a very wide banner, exactly 5:2 (2000x800 pixels if you can choose the size; otherwise the widest landscape size, with everything important inside the middle 60% of the height so it can be cropped to 5:2).
Absolutely no text, letters, numbers, logos, signatures or watermarks anywhere in the image.
Style: minimalist but eye-catching editorial cover art. ${direction.style} One clear focal point, generous negative space, a confident limited palette, poster-grade craft.
Subject: a visual metaphor for what the article is about (not its literal words).

Article title: ${title}
Opening of the article:
${excerpt}
`;
}

function isPNG(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(8);
    fs.readSync(fd, b, 0, 8, 0);
    fs.closeSync(fd);
    return b.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  } catch { return false; }
}

/**
 * One Codex run that generates one image. Resolves to the absolute path Codex saved it at (checked to
 * be a fresh PNG inside Codex's generated_images folder), or rejects with a readable error.
 * Image generation needs a writable sandbox, so Codex works in an empty temporary folder.
 */
function runCodexImage({ bin, title, excerpt, direction, model, effort, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-covers-'));
    const out = path.join(work, 'answer.txt');
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'workspace-write', '-C', work, '-o', out];
    if (model) args.push('-m', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push('-');
    const env = { ...process.env, PATH: [...SEARCH_DIRS, process.env.PATH || ''].join(':') };
    const child = spawn(bin, args, { cwd: work, env, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    const cleanup = () => { clearTimeout(timer); fs.rmSync(work, { recursive: true, force: true }); };
    child.on('error', (e) => { cleanup(); reject(new Error(`Couldn't start Codex (${e.message})`)); });
    child.on('close', (code, signal) => {
      let answer = '';
      try { answer = fs.readFileSync(out, 'utf8').trim(); } catch {}
      cleanup();
      if (signal) return reject(new Error('Codex took too long'));
      const errLine = (stderr.match(/ERROR:? (.*)/) || [])[1];
      if (code !== 0) return reject(new Error(errLine || `Codex exited with ${code}`));
      const file = (answer.match(/\/[^\s"'`]+\.png/i) || [])[0];
      if (!file) return reject(new Error(/no[_ ]tool|not available|unavailable/i.test(answer) ? 'Codex has no image tool here' : 'Codex didn’t return an image'));
      const root = path.join(codexHome(), 'generated_images') + path.sep;
      const real = path.resolve(file);
      let st;
      try { st = fs.statSync(real); } catch { return reject(new Error('Codex’s image file is missing')); }
      if (!real.startsWith(root) || !isPNG(real) || st.mtimeMs < started - 5000) return reject(new Error('Codex returned an unexpected file'));
      resolve(real);
    });
    child.stdin.end(promptFor({ title, excerpt, direction }));
  });
}

// ---- Local store + policy ----------------------------------------------------------------------

class SmartCovers {
  constructor(root, { onChange = () => {}, debounceMs = 6000, run = runCodexImage } = {}) {
    this.file = path.join(root, 'covers.json');
    this.coversDir = path.join(root, 'covers');
    this.dir = path.join(this.coversDir, 'suggested');
    this.onChange = onChange;
    this.debounceMs = debounceMs;
    this.run = run;
    this.timers = new Map();
    this.running = null;
    this.data = { settings: { smart: true, model: 'gpt-6-luna', effort: 'low' }, articles: {} };
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data.settings = { ...this.data.settings, ...(d.settings || {}) };
      this.data.articles = d.articles || {};
    } catch {}
    for (const a of Object.values(this.data.articles)) {
      if (a.suggestions?.status === 'running') a.suggestions.status = 'stale';
      // early builds stored SVG designs; images replaced them
      if (a.suggestions?.covers?.some((c) => !c.file)) a.suggestions = { ...a.suggestions, status: 'stale', covers: [] };
      if (a.selected && a.selected.kind !== 'gen' && !a.selected.file) delete a.selected;
    }
    this.bin = findCodex();
  }

  save() { writeAtomic(this.file, JSON.stringify(this.data, null, 2)); }
  entry(id) { return (this.data.articles[id] ||= {}); }

  snapshot() {
    return { settings: this.data.settings, available: !!this.bin, articles: this.data.articles, running: this.running };
  }

  /** Absolute path of a stored cover image (relative to covers/), refusing anything outside it. */
  imagePath(rel) {
    const base = this.coversDir + path.sep;
    const p = path.resolve(base, String(rel));
    if (!p.startsWith(base) || !/\.png$/i.test(p)) throw new Error('Not a cover image');
    return p;
  }

  setSettings(s) {
    this.data.settings = { ...this.data.settings, ...s };
    this.save();
    this.onChange(null);
  }

  select(id, choice) {
    const e = this.entry(id);
    if (choice) e.selected = { ...choice, at: Date.now() }; else delete e.selected;
    this.save();
    this.onChange(id);
  }

  forget(id) {
    if (!this.data.articles[id]) return;
    delete this.data.articles[id];
    this.save();
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
  }

  /** Should this article get (new) suggestions now? */
  wants(article) {
    if (!this.data.settings.smart || !this.bin) return false;
    const words = wordCount(article.body);
    if (!article.title.trim() || words < MIN_WORDS) return false;
    const s = this.data.articles[article.id]?.suggestions;
    if (!s || s.status === 'stale') return true;
    if (s.status === 'running') return false;
    if ((s.autoRuns || 0) >= MAX_AUTO_RUNS) return false;
    if (s.status === 'error') return Date.now() - (s.at || 0) > 10 * 60 * 1000; // retry after a while
    return s.basis.title.trim() !== article.title.trim() || words - s.basis.words >= REGEN_WORDS;
  }

  /** Call after any edit: waits until the writer pauses, then suggests covers if it's time. */
  consider(article, getArticle) {
    if (!this.wants(article)) return;
    clearTimeout(this.timers.get(article.id));
    this.timers.set(article.id, setTimeout(() => {
      this.timers.delete(article.id);
      const a = getArticle(article.id);
      if (a && this.wants(a)) this.generate(a, { auto: true });
    }, this.debounceMs));
  }

  async generate(article, { auto = false } = {}) {
    if (!this.bin) throw new Error('Codex isn’t installed (looked for the codex command)');
    if (this.running) return false; // one piece at a time
    const id = article.id;
    const e = this.entry(id);
    const prev = e.suggestions;
    const at = Date.now();
    e.suggestions = {
      status: 'running', at, pending: DIRECTIONS.length, covers: [],
      basis: { title: article.title, words: wordCount(article.body) },
      autoRuns: (prev?.autoRuns || 0) + (auto ? 1 : 0),
    };
    this.running = id;
    this.save();
    this.onChange(id, 'running');
    const dir = path.join(this.dir, id);
    fs.mkdirSync(dir, { recursive: true });
    const title = article.title.trim(), excerpt = excerptOf(article.body);
    const errors = [];
    await Promise.all(DIRECTIONS.map(async (direction, i) => {
      try {
        const src = await this.run({ bin: this.bin, title, excerpt, direction, model: this.data.settings.model, effort: this.data.settings.effort });
        const name = `${at}-${i + 1}.png`;
        try { fs.renameSync(src, path.join(dir, name)); } catch { fs.copyFileSync(src, path.join(dir, name)); fs.rmSync(src, { force: true }); }
        try { fs.rmdirSync(path.dirname(src)); } catch {} // Codex's per-run folder, if now empty
        e.suggestions.covers.push({ kind: 'image', file: `suggested/${id}/${name}`, name: direction.name, idea: direction.style });
        e.suggestions.covers.sort((x, y) => DIRECTIONS.findIndex((d) => d.name === x.name) - DIRECTIONS.findIndex((d) => d.name === y.name));
      } catch (err) {
        errors.push(err.message);
      } finally {
        e.suggestions.pending--;
        if (e.suggestions.pending > 0) { this.save(); this.onChange(id, 'progress'); }
      }
    }));
    e.suggestions.status = e.suggestions.covers.length ? 'ready' : 'error';
    if (errors.length) e.suggestions.error = errors[0];
    e.suggestions.at = Date.now();
    // drop the previous round's images, except a chosen one
    const keep = e.selected?.file;
    for (const c of prev?.covers || []) if (c.file && c.file !== keep) fs.rmSync(path.join(this.coversDir, c.file), { force: true });
    this.running = null;
    this.save();
    this.onChange(id, e.suggestions.status);
    return true;
  }
}

module.exports = { SmartCovers, runCodexImage, findCodex, excerptOf, promptFor, DIRECTIONS, MIN_WORDS, REGEN_WORDS, EXCERPT_WORDS };
