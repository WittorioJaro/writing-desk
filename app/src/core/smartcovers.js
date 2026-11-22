'use strict';
// Smart covers: once a piece has a title and a few sentences, Codex (the user's own CLI, signed in
// with their ChatGPT account) designs three 5:2 SVG covers for it in the background.
//
// What leaves the Mac: only the title and the opening (~180 words) of the piece, sent by the Codex CLI.
// Nothing else, and only while "Smart covers" is on. Results and the chosen cover per piece are kept
// locally in `covers.json` (not synced, so the sync format stays unchanged).

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

function findCodex() {
  if (process.env.WD_CODEX_BIN) return process.env.WD_CODEX_BIN;
  for (const dir of [...(process.env.PATH || '').split(':'), ...SEARCH_DIRS]) {
    const p = path.join(dir, 'codex');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

// ---- SVG hygiene ------------------------------------------------------------------------------
/**
 * Returns a safe, text-free SVG pinned to 1500x600, or null. It is only ever displayed as an <img>
 * (where scripts never run and nothing external loads), but we still strip anything that could
 * smuggle in text, script or remote content.
 */
function sanitizeSVG(svg) {
  if (typeof svg !== 'string' || svg.length > 60000) return null;
  let s = svg.trim().replace(/^```(?:svg|xml)?\s*|```$/g, '').trim();
  const start = s.indexOf('<svg'), end = s.lastIndexOf('</svg>');
  if (start < 0 || end < 0) return null;
  s = s.slice(start, end + 6);
  s = s.replace(/<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!--[\s\S]*?-->/gi, '');
  for (const tag of ['script', 'foreignObject', 'text', 'tspan', 'textPath', 'image', 'a', 'style', 'iframe', 'video', 'audio']) {
    s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '').replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '');
  // only same-document references (url(#id), href="#id") may remain
  s = s.replace(/\s(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, '');
  s = s.replace(/url\(\s*(?!['"]?#)[^)]*\)/gi, 'none');
  // pin the frame to exactly 5:2
  s = s.replace(/<svg\b([^>]*)>/i, (_m, attrs) => {
    const keep = attrs.replace(/\s(?:width|height|viewBox|preserveAspectRatio|x|y)\s*=\s*("[^"]*"|'[^']*')/gi, '');
    const hasNS = /xmlns\s*=/.test(keep);
    return `<svg${hasNS ? '' : ' xmlns="http://www.w3.org/2000/svg"'}${keep} viewBox="0 0 1500 600" width="1500" height="600" preserveAspectRatio="xMidYMid slice">`;
  });
  return /<(rect|path|circle|ellipse|polygon|polyline|line|g)\b/i.test(s) ? s : null;
}

function excerptOf(body, n = EXCERPT_WORDS) {
  const words = body.trim().split(/\s+/);
  return words.slice(0, n).join(' ') + (words.length > n ? ' …' : '');
}

const PROMPT = `You are an award-winning editorial art director. Design 3 cover images for the article below, as hand-written SVG.

What great looks like:
- Poster-grade: one striking visual metaphor per cover that someone would stop scrolling for. Think Swiss posters, Saul Bass, modern editorial illustration.
- Minimal but rich: few elements, but crafted — layered depth, soft gradients, subtle grain (feTurbulence + feColorMatrix at low opacity), shadow or glow where it helps, a deliberate focal point.
- Confident, limited palettes (3–4 colors) that differ between the three covers. Contrast that reads at thumbnail size.
- Three genuinely different concepts and compositions (e.g. one bold geometric, one atmospheric scene, one symbolic object or close-up).
- The idea comes from what the article is about, not its literal words.

Hard rules:
- Each SVG: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1500 600" width="1500" height="600"> — exactly 5:2, everything inside the frame.
- NO text, letters, numerals, glyphs, signatures or words anywhere. No <text>, <tspan>, fonts.
- Self-contained: no <image>, no external hrefs, no scripts, no <style> or CSS. Unique ids per SVG.
- Keep each SVG under 12 KB.
- Don't run commands or read files. Just answer.
`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['covers'],
  properties: { covers: { type: 'array', minItems: 3, maxItems: 3, items: {
    type: 'object', additionalProperties: false, required: ['name', 'idea', 'svg'],
    properties: { name: { type: 'string' }, idea: { type: 'string' }, svg: { type: 'string' } },
  } } },
};

/** One Codex run. Resolves to [{name, idea, svg}] (sanitized), or rejects with a readable error. */
function runCodex({ bin, title, excerpt, model, effort, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-covers-'));
    const schema = path.join(work, 'schema.json'), out = path.join(work, 'out.json');
    fs.writeFileSync(schema, JSON.stringify(SCHEMA));
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', work, '--output-schema', schema, '-o', out];
    if (model) args.push('-m', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push('-');
    const env = { ...process.env, PATH: [...SEARCH_DIRS, process.env.PATH || ''].join(':') };
    const child = spawn(bin, args, { cwd: work, env, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); fs.rmSync(work, { recursive: true, force: true }); };
    child.on('error', (e) => { cleanup(); reject(new Error(`Couldn't start Codex (${e.message})`)); });
    child.on('close', (code, signal) => {
      let text = '';
      try { text = fs.readFileSync(out, 'utf8'); } catch {}
      cleanup();
      if (signal) return reject(new Error('Codex took too long'));
      const errLine = (stderr.match(/ERROR:? (.*)/) || [])[1];
      if (code !== 0 || !text) return reject(new Error(errLine || `Codex exited with ${code}`));
      let parsed;
      try { parsed = JSON.parse(text); } catch { return reject(new Error('Codex returned something that isn’t JSON')); }
      const covers = (parsed.covers || []).map((c) => ({ name: String(c.name || '').slice(0, 60), idea: String(c.idea || '').slice(0, 240), svg: sanitizeSVG(c.svg) })).filter((c) => c.svg);
      if (!covers.length) return reject(new Error('Codex returned no usable covers'));
      resolve(covers);
    });
    child.stdin.end(`${PROMPT}\nArticle title: ${title}\nOpening of the article:\n${excerpt}\n`);
  });
}

// ---- Local store + policy ----------------------------------------------------------------------

class SmartCovers {
  constructor(root, { onChange = () => {}, debounceMs = 6000, run = runCodex } = {}) {
    this.file = path.join(root, 'covers.json');
    this.onChange = onChange;
    this.debounceMs = debounceMs;
    this.run = run;
    this.timers = new Map();
    this.running = null;
    this.data = { settings: { smart: true, model: 'gpt-6-luna', effort: 'high' }, articles: {} };
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data.settings = { ...this.data.settings, ...(d.settings || {}) };
      this.data.articles = d.articles || {};
    } catch {}
    for (const a of Object.values(this.data.articles)) if (a.suggestions?.status === 'running') a.suggestions.status = 'stale';
    this.bin = findCodex();
  }

  save() { writeAtomic(this.file, JSON.stringify(this.data, null, 2)); }
  entry(id) { return (this.data.articles[id] ||= {}); }

  snapshot() {
    return { settings: this.data.settings, available: !!this.bin, articles: this.data.articles, running: this.running };
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
    if (this.running) return false; // one at a time
    const e = this.entry(article.id);
    const prev = e.suggestions;
    const basis = { title: article.title, words: wordCount(article.body) };
    e.suggestions = { ...(prev || {}), status: 'running', basis, at: Date.now(), autoRuns: (prev?.autoRuns || 0) + (auto ? 1 : 0) };
    this.running = article.id;
    this.save();
    this.onChange(article.id);
    try {
      const covers = await this.run({ bin: this.bin, title: article.title.trim(), excerpt: excerptOf(article.body), model: this.data.settings.model, effort: this.data.settings.effort });
      e.suggestions = { ...e.suggestions, status: 'ready', covers, at: Date.now(), error: undefined };
    } catch (err) {
      e.suggestions = { ...e.suggestions, status: 'error', error: err.message, at: Date.now() };
    } finally {
      this.running = null;
      this.save();
      this.onChange(article.id, e.suggestions.status);
    }
    return true;
  }
}

module.exports = { SmartCovers, sanitizeSVG, excerptOf, runCodex, findCodex, MIN_WORDS, REGEN_WORDS, EXCERPT_WORDS };
