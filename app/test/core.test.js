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
  fs.writeFileSync(path.join(dir, 'inbox', 'a.md'), '# Ideas\n- One\n- Think about covers\n');
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
    a.addIdea('From the inbox');
    a.setGoal(300);
    await a.syncOnce();
    await b.syncOnce();
    assert.equal(b.article(id).body, 'Written on the MacBook.');
    assert.equal(b.state.ideas[0].text, 'From the inbox');
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
      ideas: [{ added: 785400000.5, done: false, id: '99999999-2222-4333-8444-555555555555', source: 'ideas.md', text: 'Swift idea' }],
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
const FAKE = path.join(__dirname, 'fake-codex.js');
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

function withCodexHome(fn) {
  return async () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tmp();
    try { await fn(process.env.CODEX_HOME); } finally { if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev; }
  };
}

test('covers: one Codex image run is sandboxed, sends only title + opening, and returns a fresh PNG from Codex', withCodexHome(async () => {
  const log = path.join(tmp(), 'log.jsonl');
  process.env.FAKE_CODEX_LOG = log;
  try {
    const file = await SC.runCodexImage({ bin: FAKE, title: 'Rivers', excerpt: 'Water finds a way.', direction: SC.DIRECTIONS[0], model: 'gpt-6-luna', effort: 'low' });
    assert.ok(file.startsWith(path.join(process.env.CODEX_HOME, 'generated_images')));
    assert.equal(fs.readFileSync(file).subarray(1, 4).toString(), 'PNG');
    const call = JSON.parse(fs.readFileSync(log, 'utf8').trim());
    assert.ok(call.args.includes('--ephemeral') && call.args.includes('workspace-write'), 'empty temp workspace, nothing kept');
    assert.match(call.prompt, /image_gen tool/);
    assert.match(call.prompt, /exactly 5:2 \(2000x800/);
    assert.match(call.prompt, /no text, letters/);
    assert.match(call.prompt, /Article title: Rivers\nOpening of the article:\nWater finds a way\./);
  } finally { delete process.env.FAKE_CODEX_LOG; }
}));

test('covers: anything other than a fresh PNG inside Codex’s own image folder is refused', withCodexHome(async () => {
  const outside = path.join(tmp(), 'x.png');
  fs.writeFileSync(outside, 'not really');
  for (const reply of [outside, '/etc/passwd.png', 'NO_TOOL', 'I could not do that']) {
    process.env.FAKE_CODEX_REPLY = reply;
    try { await assert.rejects(SC.runCodexImage({ bin: FAKE, title: 'T', excerpt: 'e', direction: SC.DIRECTIONS[0] })); }
    finally { delete process.env.FAKE_CODEX_REPLY; }
  }
  process.env.FAKE_CODEX_FAIL = '1';
  try { await assert.rejects(SC.runCodexImage({ bin: FAKE, title: 'T', excerpt: 'e', direction: SC.DIRECTIONS[0] }), /pretend failure/); }
  finally { delete process.env.FAKE_CODEX_FAIL; }
}));

test('covers: three images are painted in parallel, moved into the app, and show up one by one', withCodexHome(async (home) => {
  const dir = tmp();
  const events = [];
  const sc = new SC.SmartCovers(dir, { onChange: (id, status) => events.push(status) });
  sc.bin = FAKE;
  const a = { id: 'X', title: 'Rivers', body: words(120) };
  const t0 = Date.now();
  await sc.generate(a);
  assert.ok(Date.now() - t0 < 3000, 'in parallel, not one after another');
  const sug = sc.data.articles.X.suggestions;
  assert.equal(sug.status, 'ready');
  assert.deepEqual(sug.covers.map((c) => c.name), ['Bold', 'Atmosphere', 'Object']);
  for (const c of sug.covers) assert.ok(fs.existsSync(sc.imagePath(c.file)), 'stored in the app’s covers folder');
  assert.deepEqual(events, ['running', 'progress', 'progress', 'ready']);
  assert.equal(fs.readdirSync(path.join(home, 'generated_images')).length, 0, 'moved out of Codex’s folder');
  assert.throws(() => sc.imagePath('../state.json'));
  // the next round replaces the images, but keeps a chosen one
  sc.select('X', sug.covers[1]);
  const chosen = sc.imagePath(sug.covers[1].file), dropped = sc.imagePath(sug.covers[0].file);
  await sc.generate(a);
  assert.ok(fs.existsSync(chosen));
  assert.ok(!fs.existsSync(dropped));
  // persists locally
  const again = new SC.SmartCovers(dir);
  assert.equal(again.data.articles.X.selected.name, 'Atmosphere');
}));

test('covers: suggestions start after a title and some words, wait for a pause, and come back as the piece grows', async () => {
  const calls = [];
  const sc = new SC.SmartCovers(tmp(), { debounceMs: 30, run: async (o) => { calls.push(o); throw new Error('skip'); } });
  sc.bin = '/fake/codex';
  const a = { id: 'X', title: '', body: words(100) };
  assert.equal(sc.wants(a), false, 'no title yet');
  a.title = 'Rivers';
  a.body = words(20);
  assert.equal(sc.wants(a), false, 'too few words');
  a.body = words(400);
  const get = () => a;
  sc.consider(a, get); sc.consider(a, get); sc.consider(a, get); // typing: debounced to one round
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(calls.length, 3, 'one round = three images');
  assert.ok(calls[0].excerpt.split(/\s+/).length <= SC.EXCERPT_WORDS + 1, 'only the opening is sent');
  assert.equal(sc.data.articles.X.suggestions.status, 'error');
  assert.equal(sc.wants(a), false, 'a failed round is not retried right away');
  sc.data.articles.X.suggestions = { status: 'ready', basis: { title: 'Rivers', words: 400 }, covers: [], autoRuns: 1 };
  assert.equal(sc.wants(a), false, 'not again for small edits');
  a.body = words(400 + SC.REGEN_WORDS);
  assert.equal(sc.wants(a), true, 'again once the piece has grown');
  a.title = 'Rivers and patience';
  assert.equal(sc.wants(a), true, 'again when the title changes');
  sc.setSettings({ smart: false });
  assert.equal(sc.wants(a), false, 'never when switched off');
});
