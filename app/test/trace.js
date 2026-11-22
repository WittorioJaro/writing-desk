// Frame-by-frame animation trace: `npx electron test/trace.js <outdir> [scenario...]`
//
// Runs the real app on a seeded workspace with a fully controlled clock: Chromium's virtual time
// drives timers and performance.now(), requestAnimationFrame is replaced by a manual 60 fps tick,
// and every CSS/Web animation is paused and seeked to its exact age each frame. So transitions,
// keyframes, timers and the canvas particles all advance together, deterministically. Every
// scenario is saved as a contact sheet (one thumbnail per step, labelled with its time).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'wd-trace'));
const only = process.argv.slice(3);
fs.mkdirSync(out, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-trace-home-'));
process.env.WRITING_DESK_HOME = home;
process.env.WD_E2E = '1';
process.env.WD_CODEX_BIN = path.join(__dirname, 'fake-codex.js'); // never call the real Codex from tests
require('./seed')(home);

const { app, BrowserWindow, nativeTheme } = require('electron');
const { whenReady } = require('../src/main.js');

const W = 1280, H = 820, THUMB = 0.3;

whenReady.then(async ({ win }) => {
  nativeTheme.themeSource = process.env.TRACE_THEME || 'system';
  win.setSize(W, H);
  win.show();
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
  await new Promise((r) => setTimeout(r, 1200));

  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  const send = (m, p) => dbg.sendCommand(m, p);
  let waiting = null;
  dbg.on('message', (_e, m) => { if (m === 'Emulation.virtualTimeBudgetExpired' && waiting) { const r = waiting; waiting = null; r(); } });
  const advance = (ms) => new Promise((r) => { waiting = r; send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: ms }); });
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: false, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${expr.slice(0, 80)}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  const shot = async () => (await send('Page.captureScreenshot', { format: 'jpeg', quality: 80, clip: { x: 0, y: 0, width: W, height: H, scale: THUMB } })).data;
  // Manual frame clock, installed before the app's own scripts run.
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__vt = { q: [], birth: new WeakMap() };
    window.requestAnimationFrame = (cb) => { window.__vt.q.push(cb); return window.__vt.q.length; };
    window.cancelAnimationFrame = () => {};
    window.__vt.frame = () => {
      const q = window.__vt.q; window.__vt.q = [];
      const t = performance.now();
      for (const cb of q) { try { cb(t); } catch (e) { console.error(e); } }
      for (const a of document.getAnimations()) {
        if (!window.__vt.birth.has(a)) window.__vt.birth.set(a, t);
        a.pause();
        a.currentTime = t - window.__vt.birth.get(a);
      }
    };` });
  await send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
  // Reload so the clock is installed, then let the app boot under it.
  await send('Page.reload');
  await advance(300);
  const FRAME = 1000 / 60;
  let debt = 0;
  // Advance `ms` of app time as real 60 fps frames.
  const tick = async (ms) => {
    debt += ms;
    while (debt >= FRAME - 0.01) { await advance(FRAME); await js('window.__vt && window.__vt.frame()'); debt -= FRAME; }
  };

  // Each scenario: optional setup (run, then settle), an action, and how long / how finely to sample.
  const mouse = `(() => { for (const [x, y] of [[600, 400], [640, 430], [680, 460]]) window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y })); })()`;
  const key = `(() => { const t = document.querySelector('#body'); t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); })()`;
  const scenarios = [
    { name: 'boot', action: `location.reload()`, ms: 1400, step: 70, reload: true },
    { name: 'writing-fade-out', setup: `window.__desk.closeAll()`, action: key, ms: 1000, step: 50 },
    { name: 'writing-fade-in', action: mouse, ms: 1000, step: 50 },
    { name: 'articles-open', setup: mouse, action: `document.querySelector('#btn-articles').click()`, ms: 900, step: 45 },
    { name: 'articles-close', action: `document.querySelector('#scrim').click()`, ms: 900, step: 45 },
    { name: 'switch-article', action: `window.__desk.switchTo(window.__desk.snap.state.articles.find(a => a.id !== window.__desk.currentId).id)`, ms: 900, step: 45 },
    { name: 'prompts-open', action: `document.querySelector('#btn-prompts').click()`, ms: 900, step: 45 },
    { name: 'idea-check', action: `document.querySelector('#idea-list li .check').click()`, ms: 1500, step: 75 },
    { name: 'prompts-close', action: `window.__desk.closeAll()`, ms: 900, step: 45 },
    { name: 'momentum-open', action: `window.__desk.openOverlay('momentum')`, ms: 2600, step: 100 },
    { name: 'goal-stepper', action: `document.querySelector('#goal-plus').click()`, ms: 1200, step: 60 },
    { name: 'momentum-close', action: `window.__desk.closeAll()`, ms: 900, step: 45 },
    { name: 'cover-notice', setup: key, action: `window.__desk.showCoverNotice('A0000000-0000-4000-8000-000000000001')`, ms: 1400, step: 70 },
    { name: 'cover-notice-open', action: `document.querySelector('#cover-notice').click()`, ms: 1400, step: 70 },
    { name: 'use-cover', action: `document.querySelector('#smart-grid .cover .use').click()`, ms: 1800, step: 90 },
    { name: 'change-cover', setup: `window.__desk.openOverlay('covers')`, settle: 1400, action: `document.querySelectorAll('#smart-grid .cover .use')[1].click()`, ms: 1600, step: 80 },
    { name: 'covers-open', setup: `window.__desk.closeAll()`, action: `window.__desk.openOverlay('covers')`, ms: 1600, step: 80 },
    { name: 'covers-shuffle', action: `document.querySelector('#btn-shuffle').click()`, ms: 1400, step: 70 },
    { name: 'lightbox', action: `document.querySelector('.cover').click()`, ms: 900, step: 45 },
    { name: 'lightbox-close', action: `document.querySelector('#lightbox').dispatchEvent(new MouseEvent('click', { bubbles: true }))`, ms: 800, step: 40 },
    { name: 'covers-close', action: `window.__desk.closeAll()`, ms: 900, step: 45 },
    { name: 'sync-open', action: `window.__desk.openOverlay('sync')`, ms: 900, step: 45 },
    { name: 'sync-close', action: `window.__desk.closeAll()`, ms: 900, step: 45 },
    { name: 'celebration', setup: key, settle: 1200, action: `window.__desk.celebrate(7)`, ms: 5600, step: 100 },
    { name: 'goal-line-pulse', setup: mouse, action: `(() => { const g = document.querySelector('#goal-line'); g.classList.remove('pulse'); void g.offsetWidth; g.classList.add('pulse'); })()`, ms: 1400, step: 70 },
  ].filter((s) => !only.length || only.includes(s.name));

  await tick(1500);
  const sheets = [];
  for (const s of scenarios) {
    if (s.setup) { await js(s.setup); await tick(s.settle ?? 900); }
    if (s.reload) { await send('Page.reload'); await advance(300); } else await js(s.action);
    await tick(FRAME);
    const frames = [{ t: 0, data: await shot() }];
    for (let t = s.step; t <= s.ms; t += s.step) {
      await tick(s.step);
      frames.push({ t, data: await shot() });
      if (process.env.TRACE_DEBUG && t % 500 === 0) console.log(t, JSON.stringify(await js(`[Math.round(performance.now()), window.__vt.q.length, document.getAnimations().filter(a => a.animationName || a.transitionProperty).slice(0, 6).map(a => [a.animationName || a.transitionProperty, Math.round(a.currentTime), a.playState, a.effect && a.effect.target && (a.effect.target.id || a.effect.target.className)])]`)));
    }
    sheets.push({ name: s.name, frames });
    console.log(`${s.name}: ${frames.length} frames`);
  }
  dbg.detach();

  // Lay each scenario out as a contact sheet.
  const tw = Math.round(W * THUMB), th = Math.round(H * THUMB), cols = 5;
  const sheetWin = new BrowserWindow({ show: false, width: cols * (tw + 8) + 8, height: 800, webPreferences: { offscreen: true } });
  for (const { name, frames } of sheets) {
    const rows = Math.ceil(frames.length / cols);
    const height = rows * (th + 26) + 40;
    const html = `<html><body style="margin:0;background:#888;font:13px -apple-system;color:#111">
      <div style="padding:10px 8px 4px;font-weight:600">${name}</div>
      <div style="display:grid;grid-template-columns:repeat(${cols},${tw}px);gap:2px 8px;padding:0 8px">
      ${frames.map((f) => `<div><img style="display:block;width:${tw}px;height:${th}px" src="data:image/jpeg;base64,${f.data}"><div style="height:22px;line-height:22px">${f.t} ms</div></div>`).join('')}
      </div></body></html>`;
    sheetWin.setContentSize(cols * (tw + 8) + 8, height);
    const file = path.join(out, `_sheet.html`);
    fs.writeFileSync(file, html);
    await sheetWin.loadFile(file);
    await new Promise((r) => setTimeout(r, 400));
    const img = await sheetWin.webContents.capturePage({ x: 0, y: 0, width: cols * (tw + 8) + 8, height });
    fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
  }
  fs.rmSync(path.join(out, '_sheet.html'), { force: true });
  console.log('sheets in', out);
  app.exit(0);
}).catch((e) => { console.error('trace failed:', e); app.exit(1); });
