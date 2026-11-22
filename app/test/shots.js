// Visual review: `npx electron test/shots.js <outdir>` launches the real app on a seeded temp
// workspace and saves screenshots of each view.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'wd-shots'));
fs.mkdirSync(out, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-shots-home-'));
process.env.WRITING_DESK_HOME = home;
process.env.WD_E2E = '1';
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-codex-home-')); // fake Codex writes images here, never ~/.codex
process.env.WD_CODEX_BIN = path.join(__dirname, 'fake-codex.js'); // never call the real Codex from tests

require('./seed')(home);

const { app } = require('electron');
const { whenReady } = require('../src/main.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

whenReady.then(async ({ win }) => {
  const theme = process.env.SHOT_THEME || 'system';
  require('electron').nativeTheme.themeSource = theme;
  const light = theme === 'light';
  win.setSize(1280, 820);
  win.show(); win.focus();
  await new Promise((r) => win.webContents.once('did-finish-load', r)).catch(() => {});
  await wait(1800);
  win.webContents.on('console-message', (e) => console.log('[renderer]', e.message || e));
  const js = (code) => win.webContents.executeJavaScript(code);
  if (process.env.SHOT_DEBUG) { console.log(await js(process.env.SHOT_DEBUG)); }
  const shot = async (name) => { win.webContents.invalidate(); await wait(120); const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(out, `${name}${light ? '-light' : ''}.png`), img.toPNG()); };
  await shot('1-editor');
  await js(`document.body.classList.add('writing')`); await wait(900); await shot('2-writing');
  await js(`document.body.classList.remove('writing'); document.querySelector('#btn-articles').click()`); await wait(900); await shot('3-articles');
  await js(`window.__desk.closeAll(); document.querySelector('#btn-prompts').click()`); await wait(900); await shot('4-prompts');
  await js(`window.__desk.openOverlay('momentum')`); await wait(2200); await shot('5-momentum');
  await js(`window.__desk.openOverlay('covers')`); await wait(1500); await shot('6-covers');
  await js(`window.__desk.openOverlay('sync')`); await wait(900); await shot('7-sync');
  await js(`window.__desk.closeAll(); window.__desk.celebrate(7)`); await wait(900); await shot('8-celebrate-a'); await wait(900); await shot('8-celebrate-b'); await wait(1200); await shot('8-celebrate-c');
  await wait(5000);
  await js(`window.__desk.showCoverNotice('A0000000-0000-4000-8000-000000000001')`); await wait(1200); await shot('9-cover-notice');
  await js(`document.querySelector('#cover-notice').click()`); await wait(1500); await shot('10-covers-panel');
  await js(`document.querySelector('#smart-grid .cover .use').click()`); await wait(1800); await shot('11-page-cover');
  console.log('shots in', out);
  app.quit();
});
