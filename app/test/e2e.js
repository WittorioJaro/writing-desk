// End-to-end check of the real app: `npx electron test/e2e.js`. Exits 0 when everything passes.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-e2e-'));
process.env.WRITING_DESK_HOME = home;
process.env.WD_E2E = '1';
// Smart covers run against a stand-in Codex that records what it was sent.
process.env.WD_CODEX_BIN = path.join(__dirname, 'fake-codex.js');
process.env.WD_COVER_DEBOUNCE = '400';
const codexLog = path.join(home, 'codex-calls.jsonl');
process.env.FAKE_CODEX_LOG = codexLog;

const { app } = require('electron');
const { whenReady } = require('../src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['ok', name]); console.log(`✔ ${name}`); }
  catch (e) { results.push(['fail', name]); console.log(`✖ ${name}\n  ${e.stack || e}`); }
}

whenReady.then(async ({ win, ws }) => {
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
  await wait(800);
  const js = (code) => win.webContents.executeJavaScript(code);
  const type = async (selector, text) => {
    await js(`document.querySelector('${selector}').focus()`);
    for (const ch of text) win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
    await wait(300);
  };

  await check('fresh start: empty canvas, no article until you type', async () => {
    assert.equal(ws.state.articles.length, 0);
    assert.equal(await js(`document.querySelector('#title').placeholder`), 'Untitled');
  });

  await check('typing creates an article, saves it, and counts words toward today', async () => {
    await type('#title', 'Rivers and patience');
    await type('#body', 'Water finds a way through stone by being patient. ');
    await wait(500);
    ws.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
    assert.equal(saved.articles.length, 1);
    assert.equal(saved.articles[0].title, 'Rivers and patience');
    assert.match(saved.articles[0].body, /^Water finds a way/);
    const today = await js(`document.querySelector('#chip-today').dataset.v`);
    assert.equal(Number(today), 9);
    assert.equal(await js(`document.querySelector('#piece-words').textContent`), '9 words');
  });

  await check('crossing the daily goal triggers the streak celebration once', async () => {
    await js(`window.__desk.op('setGoal', 50)`);
    await wait(200);
    assert.equal(await js(`document.querySelector('#celebrate').classList.contains('go')`), false);
    await type('#body', 'Stone remembers nothing but the river remembers everything it has ever touched and carried down toward the sea in slow seasons of rain and melt and drought and more rain again. Nothing about it hurries, and still the canyon is cut a little deeper each year. ');
    await wait(400);
    assert.equal(await js(`document.querySelector('#celebrate').classList.contains('go')`), true, 'celebration started');
    assert.equal(await js(`document.querySelector('#goal-line').classList.contains('met')`), true);
    assert.equal(await js(`document.querySelector('#chip-streak').textContent`), '1');
    await wait(4800);
    await js(`document.querySelector('#celebrate').classList.remove('go')`);
    await type('#body', 'More. ');
    assert.equal(await js(`document.querySelector('#celebrate').classList.contains('go')`), false, 'no repeat on the same day');
  });

  await check('smart covers: after a title and some words, Codex suggests covers in the background, sent only title + opening', async () => {
    assert.equal(fs.existsSync(codexLog), false, 'nothing sent before there are enough words');
    await type('#body', 'Rivers keep their promises slowly, one bend at a time, and the valley learns their shape. ');
    await wait(1500); // the writer pauses; Codex runs in the background
    const calls = fs.readFileSync(codexLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(calls.length >= 1);
    const last = calls[calls.length - 1];
    assert.match(last.prompt, /Article title: Rivers and patience\nOpening of the article:\nWater finds a way/);
    assert.ok(last.args.includes('read-only'));
    const id = ws.state.articles[0].id;
    const sug = JSON.parse(fs.readFileSync(path.join(home, 'covers.json'), 'utf8')).articles[id].suggestions;
    assert.equal(sug.status, 'ready');
    assert.equal(sug.covers.length, 3);
    assert.ok(sug.covers.every((c) => !/<text|<script/.test(c.svg)), 'sanitized');
  });

  await check('smart covers: a soft notice slides in from the top and opens the suggestions', async () => {
    const id = ws.state.articles[0].id;
    await js(`window.__desk.showCoverNotice('${id}')`);
    await wait(900);
    assert.equal(await js(`document.querySelector('#cover-notice').classList.contains('show')`), true);
    assert.equal(await js(`document.querySelectorAll('#cover-notice .thumbs canvas').length`), 3);
    assert.match(await js(`document.querySelector('#cover-notice .what').textContent`), /3 covers for “Rivers and patience”/);
    await js(`document.querySelector('#cover-notice').click()`);
    await wait(900);
    assert.equal(await js(`document.querySelector('#overlay-covers').classList.contains('open')`), true);
    assert.equal(await js(`document.querySelectorAll('#smart-grid .cover').length`), 3);
    assert.equal(await js(`document.querySelectorAll('#cover-grid .cover').length`), 6);
  });

  await check('chosen cover sits at the top of the page, per piece, and survives a restart of the view', async () => {
    const id = ws.state.articles[0].id;
    await js(`document.querySelector('#smart-grid .cover .use').click()`);
    await wait(1400);
    assert.equal(await js(`document.querySelector('#overlay-covers').classList.contains('open')`), false, 'panel closes');
    assert.equal(await js(`document.querySelector('#page-cover').classList.contains('on')`), true);
    const r = await js(`(() => { const c = document.querySelector('#page-cover canvas'); const b = c.getBoundingClientRect(); return [c.width, c.height, Math.round(b.width / b.height * 100)]; })()`);
    assert.equal(r[0] * 2, r[1] * 5, 'exactly 5:2');
    assert.equal(r[2], 250);
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'covers.json'), 'utf8')).articles[id].selected;
    assert.equal(saved.kind, 'codex');
    // a drawn cover can be chosen too, and its look is frozen even as the text changes
    await js(`window.__desk.useCover(window.__desk.genChoice(window.__desk.snap.state.articles.find(a => a.id === '${id}'), 2))`);
    await wait(900);
    const sel = JSON.parse(fs.readFileSync(path.join(home, 'covers.json'), 'utf8')).articles[id].selected;
    assert.equal(sel.kind, 'gen');
    assert.ok(sel.seed && sel.seed.keywords.length, 'seed frozen with the choice');
  });

  await check('covers: six options, exactly 5:2, content-dependent and deterministic', async () => {
    const r = await js(`(() => {
      const { seedFrom, renderCover } = window.__desk;
      const sig = (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 397) h = (h * 31 + d[i]) >>> 0; return h; };
      const a = seedFrom('Rivers and patience', 'Water finds a way through stone. The river is patient.');
      const b = seedFrom('Startup pricing', 'Charge more than you think. Pricing is positioning. Customers anchor.');
      const out = { dims: [], sameA: true, differ: 0 };
      for (let s = 0; s < 6; s++) {
        const ca = renderCover(a, s, 0, 1500), ca2 = renderCover(a, s, 0, 1500), cb = renderCover(b, s, 0, 1500);
        out.dims.push([ca.width, ca.height]);
        if (sig(ca) !== sig(ca2)) out.sameA = false;
        if (sig(ca) !== sig(cb)) out.differ++;
      }
      return out;
    })()`);
    for (const [w, h] of r.dims) assert.equal(w * 2, h * 5);
    assert.equal(r.sameA, true, 'same article -> same covers');
    assert.equal(r.differ, 6, 'different article -> different covers');
  });

  await check('covers: export writes a 3000x1200 PNG to the covers folder', async () => {
    const saved = await js(`window.__desk.exportCover(0)`);
    assert.ok(saved && saved.startsWith(path.join(home, 'covers')));
    const buf = fs.readFileSync(saved);
    assert.equal(buf.toString('ascii', 1, 4), 'PNG');
    assert.equal(buf.readUInt32BE(16), 3000);
    assert.equal(buf.readUInt32BE(20), 1200);
  });

  await check('ideas: a file dropped in the inbox appears on its own, separate from articles', async () => {
    fs.writeFileSync(path.join(home, 'inbox', 'elon.md'), '# Ideas\n- Why do rivers bend?\n- Think about patience as a skill\n');
    await wait(1800);
    assert.deepEqual(ws.state.ideas.map((i) => i.text), ['Why do rivers bend?', 'Think about patience as a skill']);
    assert.ok(fs.existsSync(path.join(home, 'inbox', 'imported', 'elon.md')));
    assert.equal(await js(`document.querySelector('#prompts-badge').hidden`), false, 'unseen badge');
    assert.equal(ws.state.articles.length, 1);
    assert.ok(!ws.state.articles[0].body.includes('rivers bend'));
    await js(`document.querySelector('#btn-prompts').click()`);
    await wait(700);
    assert.equal(await js(`document.querySelectorAll('#idea-list li').length`), 2);
    await js(`document.querySelector('#idea-list li .check').click()`);
    await wait(1200);
    assert.equal(ws.state.ideas.filter((i) => i.done).length, 1);
  });

  await check('the page itself cannot reach the network', async () => {
    const r = await js(`fetch('https://example.com').then(() => 'reached', (e) => 'blocked')`);
    assert.equal(r, 'blocked');
  });

  await check('new piece and switching keep each text separate', async () => {
    await js(`window.__desk.closeAll()`);
    await js(`document.querySelector('#btn-new').click()`);
    await wait(500);
    await type('#title', 'Second');
    await type('#body', 'Another page entirely.');
    await wait(300);
    const first = ws.state.articles.find((a) => a.title === 'Rivers and patience');
    await js(`window.__desk.switchTo('${first.id}')`);
    await wait(500);
    assert.match(await js(`document.querySelector('#body').value`), /^Water finds/);
    assert.equal(ws.state.articles.length, 2);
    assert.equal(await js(`document.querySelector('#page-cover').classList.contains('on')`), true, 'its cover is back');
    const second = ws.state.articles.find((a) => a.title === 'Second');
    await js(`window.__desk.switchTo('${second.id}')`);
    await wait(500);
    assert.equal(await js(`document.querySelector('#page-cover').classList.contains('on')`), false, 'other piece has no cover');
  });

  const failed = results.filter((r) => r[0] === 'fail').length;
  console.log(`\n${results.length - failed}/${results.length} end-to-end checks passed`);
  ws.flush();
  app.exit(failed ? 1 : 0);
});
