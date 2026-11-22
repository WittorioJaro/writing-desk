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

const REF = 978307200;
const ref = (ms) => ms / 1000 - REF;
const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const history = {};
for (let i = 1; i <= 6; i++) history[day(i)] = 520 + i * 37;
for (let i = 9; i <= 40; i++) if (i % 3) history[day(i)] = (i * 97) % 800;
history[day(0)] = 380;
const t = Date.now();
fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({
  articles: [
    { id: 'A0000000-0000-4000-8000-000000000001', title: 'The quiet discipline of small streaks', created: ref(t - 864e5 * 3), updated: ref(t - 60000),
      body: 'Most habits fail in the second week. Not on the first day, when everything is new and the intention is bright, but somewhere around day nine, when the novelty has worn thin and the results have not arrived yet.\n\nThe trick is not motivation. Motivation is weather. The trick is making the smallest version of the habit so easy that skipping it feels stranger than doing it.\n\nFive hundred words is not a lot. It is a page. It is twenty minutes of honest attention.' },
    { id: 'A0000000-0000-4000-8000-000000000002', title: 'Notes on minimal covers', created: ref(t - 864e5 * 6), updated: ref(t - 864e5 * 2),
      body: 'A cover should work at thumbnail size. Shape before detail. One accent colour, used once.' },
    { id: 'A0000000-0000-4000-8000-000000000003', title: '', created: ref(t - 864e5 * 9), updated: ref(t - 864e5 * 8), body: 'Half an idea about cities and walking.' },
  ],
  ideas: [
    { id: 'B0000000-0000-4000-8000-000000000001', text: 'Why do streaks fail after week two?', source: 'elon-2026-11-21.md', added: ref(t - 864e5), done: false },
    { id: 'B0000000-0000-4000-8000-000000000002', text: 'Think about what “minimal” means for a cover', source: 'elon-2026-11-21.md', added: ref(t - 864e5), done: false },
    { id: 'B0000000-0000-4000-8000-000000000003', text: 'Write about the cost of context switching', source: 'added in app', added: ref(t - 864e5 * 4), done: true, updated: ref(t - 864e5 * 2) },
  ],
  accountability: { dailyGoal: 500, byDevice: { 'SHOT-DEVICE': history } },
  tombstones: {},
}));

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
  console.log('shots in', out);
  app.quit();
});
