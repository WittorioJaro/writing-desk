'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const M = require('../src/core/model');
const S = require('../src/core/sync');
const { Store } = require('../src/core/store');
const { Workspace } = require('../src/core/workspace');
const inbox = require('../src/core/inbox');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wd-test-'));
const ws = (dir, opts) => new Workspace(new Store(dir), { saveDelayMs: 5, ...opts });

// ---- Model & persistence ---------------------------------------------------------------------------

test('fingerprint matches a reference BigInt FNV-1a implementation', () => {
  const ref = (a) => {
    let h = 0xcbf29ce484222325n;
    const step = (b) => { h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n); };
    for (const b of new TextEncoder().encode(a.title)) step(b);
    step(0xff);
    for (const b of new TextEncoder().encode(a.body)) step(b);
    return h.toString();
  };
  for (const a of [{ title: '', body: '' }, { title: 'Hello', body: 'World ✍️ zażółć' }, { title: 'x'.repeat(999), body: 'y\n'.repeat(5000) }]) {
    assert.equal(S.fingerprint(a), ref(a));
  }
});

test('persistence: edits round-trip through state.json exactly, with Swift-compatible encoding', () => {
  const dir = tmp();
  const w = ws(dir);
  const id = w.newArticle();
  w.setTitle(id, 'Streaks');
  w.setBody(id, 'One two three four.');
  w.addIdea('Why do streaks fail after week two?');
  w.setGoal(750);
  assert.ok(w.flush());
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.match(raw.articles[0].id, /^[0-9A-F-]{36}$/, 'upper-case UUID like Swift');
  assert.equal(typeof raw.articles[0].created, 'number', 'reference-date seconds');
  const w2 = ws(dir);
  assert.ok(S.statesEqual(w2.state, w.state));
  assert.equal(w2.state.accountability.dailyGoal, 750);
});

test('persistence: loads v1 files (ISO dates, single history) and migrates history to this Mac', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    articles: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Old', body: 'text', created: '2026-11-01T10:00:00Z', updated: '2026-11-01T10:05:00Z' }],
    ideas: [{ id: 'bbbbbbbb-0000-4000-8000-000000000001', text: 'idea', source: 'x.md', added: '2026-11-01T10:00:00Z', done: false }],
    accountability: { dailyGoal: 300, history: { '2026-11-01': 320 } },
  }));
  const w = ws(dir);
  assert.ok(w.writable);
  assert.equal(w.state.articles[0].id, 'AAAAAAAA-0000-4000-8000-000000000001');
  assert.equal(M.toUnixMs(w.state.articles[0].created), Date.parse('2026-11-01T10:00:00Z'));
  assert.deepEqual(w.state.accountability.byDevice, { [w.deviceId]: { '2026-11-01': 320 } });
  assert.notEqual(w.state.accountability.goalUpdated, undefined, 'non-default goal is marked as set');
});

test('safety: an unreadable state.json opens read-only and is never touched', () => {
  const dir = tmp();
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{ not json');
  const w = ws(dir);
  assert.equal(w.writable, false);
  assert.throws(() => w.newArticle(), /disabled/);
  assert.throws(() => w.importInbox(), /disabled/);
  w.flush();
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

// ---- Accountability ---------------------------------------------------------------------------------

test('accountability: only new words count, per day, and streaks span consecutive goal days', () => {
  const dir = tmp();
  const w = ws(dir);
  const id = w.newArticle();
  w.setGoal(50);
  const day = (n) => M.addDays(new Date(), -n);
  const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  w.setBody(id, words(60), day(2));
  w.setBody(id, words(10), day(1));  // deleting never lowers a day
  w.setBody(id, words(70), day(1));  // +60 that day
  w.setBody(id, words(100), day(0)); // +30 today (not met yet)
  const acc = w.state.accountability;
  assert.equal(M.wordsOn(acc, day(2)), 60);
  assert.equal(M.wordsOn(acc, day(1)), 60);
  assert.equal(M.wordsOn(acc, day(0)), 30);
  assert.equal(M.streak(acc), 2, 'today unmet -> streak through yesterday');
  w.setBody(id, words(130), day(0));
  assert.equal(M.streak(w.state.accountability), 3);
  assert.equal(M.bestStreak(w.state.accountability), 3);
  assert.deepEqual(M.recent(acc, 3).map((d) => d.words), [60, 60, 60]);
});

test('accountability: word counting handles punctuation, unicode and whitespace', () => {
  assert.equal(M.wordCount(''), 0);
  assert.equal(M.wordCount('  Hello,   world!  '), 2);
  assert.equal(M.wordCount("Don't stop — zażółć gęślą jaźń."), 5);
});

// ---- Ideas inbox --------------------------------------------------------------------------------------

test('ideas: inbox parsing strips bullets, skips headings and duplicates, archives after saving', () => {
  assert.deepEqual(inbox.parse('# Ideas\n- One\n* Two\n• Three\n1. Four\n2) Five\n\n   \nSix'), ['One', 'Two', 'Three', 'Four', 'Five', 'Six']);
  const dir = tmp();
  const w = ws(dir);
  w.addIdea('one');
  fs.writeFileSync(path.join(dir, 'inbox', 'a.md'), '# Elon\n- One\n- Think about covers\n');
  fs.writeFileSync(path.join(dir, 'inbox', 'b.txt'), 'think about covers\nNew thing');
  fs.writeFileSync(path.join(dir, 'inbox', 'ignore.pdf'), 'x');
  const r = w.importInbox();
  assert.equal(r.added, 2);
  assert.deepEqual(r.archived, ['a.md', 'b.txt']);
  assert.deepEqual(w.state.ideas.map((i) => i.text), ['one', 'Think about covers', 'New thing']);
  assert.ok(fs.existsSync(path.join(dir, 'inbox', 'imported', 'a.md')));
  assert.ok(fs.existsSync(path.join(dir, 'inbox', 'ignore.pdf')));
  // saved before archiving
  assert.equal(ws(dir).state.ideas.length, 3);
  // ideas are separate from articles
  assert.equal(w.state.articles.length, 0);
});

test('ideas: a failed save leaves the file in the inbox and keeps nothing', () => {
  const dir = tmp();
  const w = ws(dir);
  fs.writeFileSync(path.join(dir, 'inbox', 'a.md'), 'Idea');
  w.store.save = () => { throw new Error('disk full'); };
  const r = w.importInbox();
  assert.equal(r.added, 0);
  assert.match(r.errors[0], /disk full/);
  assert.ok(fs.existsSync(path.join(dir, 'inbox', 'a.md')));
  assert.equal(w.state.ideas.length, 0);
});

test('ideas: toggling done is persisted with an update time (for sync)', () => {
  const dir = tmp();
  const w = ws(dir);
  const id = w.addIdea('x');
  w.toggleIdea(id);
  w.flush();
  const i = ws(dir).state.ideas[0];
  assert.equal(i.done, true);
  assert.equal(typeof i.updated, 'number');
});

// ---- Sync ---------------------------------------------------------------------------------------------

test('sync: exact UInt64 round trip through sync-state.json', () => {
  const dir = tmp();
  const store = new Store(dir);
  const big = '18446744073709551557';
  store.saveSyncState({ base: { A: big, B: '42' }, lastSync: 785000000.123456 });
  assert.match(fs.readFileSync(store.syncStateFile, 'utf8'), /"A": 18446744073709551557/);
  assert.deepEqual(store.loadSyncState(), { base: { A: big, B: '42' }, lastSync: 785000000.123456 });
});

test('sync: server merge keeps both sides of a conflict, idempotently', () => {
  const t = 800000000;
  const base = { id: 'A', title: 'T', body: 'base', created: t, updated: t };
  const stored = { ...M.emptyState(), articles: [{ ...base, body: 'server edit', updated: t + 10 }] };
  const incoming = { ...M.emptyState(), articles: [{ ...base, body: 'my edit', updated: t + 5 }] };
  const bases = { A: S.fingerprint(base) };
  const r = S.serverMerge(stored, incoming, bases);
  assert.equal(r.conflicts, 1);
  assert.deepEqual(r.state.articles.map((a) => a.body).sort(), ['my edit', 'server edit']);
  const r2 = S.serverMerge(r.state, incoming, bases);
  assert.equal(r2.conflicts, 0);
  assert.equal(r2.state.articles.length, 2);
});

// Integration with the real Swift server (skipped if it can't be built).
const repoRoot = path.resolve(__dirname, '..', '..');
function serverBinary() {
  try {
    execFileSync('swift', ['build', '--product', 'WritingDeskServer'], { cwd: repoRoot, stdio: 'ignore' });
    return path.join(repoRoot, '.build', 'debug', 'WritingDeskServer');
  } catch { return null; }
}

async function startServer(bin, dir) {
  const p = spawn(bin, ['--host', '127.0.0.1', '--port', '0', '--db', path.join(dir, 'db.sqlite'), '--allow', '127.0.0.1']);
  const port = await new Promise((resolve, reject) => {
    let out = '';
    p.stdout.on('data', (d) => { out += d; const m = out.match(/listening on 127\.0\.0\.1:(\d+)/); if (m) resolve(Number(m[1])); });
    p.on('exit', (c) => reject(new Error(`server exited ${c}: ${out}`)));
    setTimeout(() => reject(new Error('server start timeout')), 15000);
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => p.kill() };
}

test('sync: two Macs through the real Swift server (edits, conflicts, deletes, ideas, goal, words)', async (t) => {
  const bin = serverBinary();
  if (!bin) return t.skip('Swift server not buildable here');
  const srv = await startServer(bin, tmp());
  try {
    const a = ws(tmp()), b = ws(tmp());
    for (const w of [a, b]) w.setSyncConfig({ serverURL: srv.url, enabled: true });

    const id = a.newArticle();
    a.setTitle(id, 'Shared');
    a.setBody(id, 'Written on the MacBook.');
    a.addIdea('From Elon');
    a.setGoal(300);
    await a.syncOnce();
    await b.syncOnce();
    assert.equal(b.article(id).body, 'Written on the MacBook.');
    assert.equal(b.state.ideas[0].text, 'From Elon');
    assert.equal(b.state.accountability.dailyGoal, 300);

    // Sequential edits on both sides: no false conflicts.
    for (let i = 0; i < 3; i++) {
      b.setBody(id, b.article(id).body + ` b${i}`);
      await b.syncOnce();
      await a.syncOnce();
      a.setBody(id, a.article(id).body + ` a${i}`);
      await a.syncOnce();
      await b.syncOnce();
    }
    assert.equal(a.state.articles.length, 1, 'no conflict copies from sequential edits');
    assert.equal(a.article(id).body, b.article(id).body);

    // Concurrent edit -> exactly one conflict copy, both texts kept.
    a.setBody(id, a.article(id).body + ' CONCURRENT-A');
    b.setBody(id, b.article(id).body + ' CONCURRENT-B');
    await a.syncOnce();
    const out = await b.syncOnce();
    assert.equal(out.conflicts, 1);
    await a.syncOnce();
    const bodies = a.state.articles.map((x) => x.body).join('|');
    assert.match(bodies, /CONCURRENT-A/);
    assert.match(bodies, /CONCURRENT-B/);
    assert.ok(a.state.articles.some((x) => x.title.endsWith('(conflict copy)')));
    assert.ok(S.statesEqual(a.state, b.state), 'both Macs converge');

    // Words are per Mac and add up.
    const today = M.wordsOn(a.state.accountability);
    assert.ok(today > 0);
    assert.equal(Object.keys(a.state.accountability.byDevice).length, 2);

    // Delete propagates.
    const copy = a.state.articles.find((x) => x.title.endsWith('(conflict copy)'));
    a.deleteArticle(copy.id);
    await a.syncOnce();
    await b.syncOnce();
    assert.equal(b.article(copy.id), undefined);

    // Idea ticks sync.
    b.toggleIdea(b.state.ideas[0].id);
    await b.syncOnce();
    await a.syncOnce();
    assert.equal(a.state.ideas[0].done, true);

    // A further sync is a no-op (nothing left to push).
    const again = await a.syncOnce();
    assert.equal(again.needsPush, false);
  } finally { srv.stop(); }
});

test('sync: reads data written by the Swift app and keeps it byte-compatible for the server', async (t) => {
  const bin = serverBinary();
  if (!bin) return t.skip('Swift server not buildable here');
  const srv = await startServer(bin, tmp());
  try {
    const dir = tmp();
    // Shape exactly as Swift's encoder writes it (sortedKeys, ref-date doubles, optional fields omitted).
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      accountability: { byDevice: { 'MINI-1': { '2026-11-20': 512 } }, dailyGoal: 500 },
      articles: [{ body: 'Swift wrote this', created: 785500000.1234567, id: '11111111-2222-4333-8444-555555555555', title: 'From Swift', updated: 785500001.7654321 }],
      ideas: [{ added: 785400000.5, done: false, id: '99999999-2222-4333-8444-555555555555', source: 'elon.md', text: 'Swift idea' }],
      tombstones: {},
    }));
    const w = ws(dir);
    w.setSyncConfig({ serverURL: srv.url, enabled: true });
    await w.syncOnce();
    const again = await w.syncOnce();
    assert.equal(again.needsPush, false, 'dates and ids survive the round trip exactly');
    assert.equal(w.state.articles[0].updated, 785500001.7654321);
    assert.equal(w.state.articles.length, 1);
  } finally { srv.stop(); }
});

test('sync: wrong URL or unreachable server reports an error and changes nothing', async () => {
  const w = ws(tmp());
  assert.throws(() => w.setSyncConfig({ serverURL: 'not a url', enabled: true }), /isn't valid/);
  w.setSyncConfig({ serverURL: 'http://127.0.0.1:9', enabled: true });
  const before = structuredClone(w.state);
  await assert.rejects(w.syncOnce({ timeoutMs: 2000 }));
  assert.ok(S.statesEqual(before, w.state));
});

// ---- Smart covers ------------------------------------------------------------------------------
const SC = require('../src/core/smartcovers');

test('covers: SVG from Codex is made text-free, script-free, self-contained and exactly 5:2', () => {
  const dirty = '```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400" width="800" onload="x()"><defs><linearGradient id="g"/></defs>'
    + '<rect width="10" height="10" fill="url(#g)" style="fill:url(https://evil/x)"/><text>Hello</text><tspan>x</tspan><script>alert(1)</script>'
    + '<image href="https://evil/p.png"/><use href="#g"/><a href="https://x"><circle r="3"/></a><foreignObject><div>t</div></foreignObject></svg>\n```';
  const s = SC.sanitizeSVG(dirty);
  assert.ok(s);
  assert.match(s, /viewBox="0 0 1500 600" width="1500" height="600"/);
  for (const bad of [/<text/i, /<tspan/i, /<script/i, /<image/i, /onload/i, /https:/, /<foreignObject/i, /<a\b/]) assert.doesNotMatch(s, bad);
  assert.match(s, /fill="url\(#g\)"/, 'same-document gradients survive');
  assert.match(s, /<use href="#g"/);
  assert.equal(SC.sanitizeSVG('not svg'), null);
  assert.equal(SC.sanitizeSVG('<svg><text>only text</text></svg>'), null, 'nothing visual left');
});

test('covers: suggestions start after a title and some words, wait for a pause, and only go out with title + opening', async () => {
  const dir = tmp();
  const calls = [];
  const sc = new SC.SmartCovers(dir, { debounceMs: 30, run: async (o) => { calls.push(o); return [{ name: 'A', idea: 'i', svg: '<svg/>' }]; } });
  sc.bin = '/fake/codex';
  const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
  const a = { id: 'X', title: '', body: words(100) };
  assert.equal(sc.wants(a), false, 'no title yet');
  a.title = 'Rivers';
  a.body = words(20);
  assert.equal(sc.wants(a), false, 'too few words');
  a.body = words(400);
  const get = () => a;
  sc.consider(a, get); sc.consider(a, get); sc.consider(a, get); // typing: debounced to one run
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, 'Rivers');
  assert.ok(calls[0].excerpt.split(/\s+/).length <= SC.EXCERPT_WORDS + 1, 'only the opening is sent');
  assert.equal(sc.data.articles.X.suggestions.status, 'ready');
  assert.equal(sc.wants(a), false, 'not again for small edits');
  a.body = words(400 + SC.REGEN_WORDS);
  assert.equal(sc.wants(a), true, 'again once the piece has grown');
  a.title = 'Rivers and patience';
  assert.equal(sc.wants(a), true, 'again when the title changes');
  sc.setSettings({ smart: false });
  assert.equal(sc.wants(a), false, 'never when switched off');
  // choice + suggestions persist locally
  sc.select('X', { kind: 'codex', svg: '<svg/>', name: 'A' });
  const again = new SC.SmartCovers(dir);
  assert.equal(again.data.articles.X.selected.name, 'A');
  assert.equal(again.data.settings.smart, false);
});

test('covers: a failing Codex run is reported, not thrown, and is retried later', async () => {
  const sc = new SC.SmartCovers(tmp(), { run: async () => { throw new Error('model not available'); } });
  sc.bin = '/fake/codex';
  const a = { id: 'Y', title: 'T', body: Array(80).fill('w').join(' ') };
  await sc.generate(a);
  assert.equal(sc.data.articles.Y.suggestions.status, 'error');
  assert.match(sc.data.articles.Y.suggestions.error, /model not available/);
  assert.equal(sc.wants(a), false, 'no immediate retry loop');
});

test('covers: the real Codex runner works against a stand-in CLI and sanitizes its output', async () => {
  const log = path.join(tmp(), 'log.jsonl');
  process.env.FAKE_CODEX_LOG = log;
  try {
    const covers = await SC.runCodex({ bin: path.join(__dirname, 'fake-codex.js'), title: 'Rivers', excerpt: 'Water finds a way.', model: 'gpt-6-luna', effort: 'high' });
    assert.equal(covers.length, 3);
    for (const c of covers) { assert.doesNotMatch(c.svg, /<text|<script/); assert.match(c.svg, /viewBox="0 0 1500 600"/); }
    const call = JSON.parse(fs.readFileSync(log, 'utf8').trim());
    assert.ok(call.args.includes('read-only') && call.args.includes('--ephemeral'), 'sandboxed, nothing kept');
    assert.match(call.prompt, /Article title: Rivers\nOpening of the article:\nWater finds a way\./);
  } finally { delete process.env.FAKE_CODEX_LOG; }
});
