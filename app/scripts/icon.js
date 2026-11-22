// Renders assets/icon.png (1024x1024) — run with `npx electron scripts/icon.js`, then build.js makes the .icns.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const html = `<!doctype html><html><body style="margin:0;background:transparent"><canvas id="c" width="1024" height="1024"></canvas><script>
const c = document.getElementById('c'), g = c.getContext('2d');
// macOS icon grid: 824px rounded square centred in 1024
const x = 100, y = 100, s = 824, r = 186;
g.save();
g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 40; g.shadowOffsetY = 18;
g.beginPath(); g.roundRect(x, y, s, s, r); g.fillStyle = '#16120F'; g.fill();
g.restore();
g.save(); g.beginPath(); g.roundRect(x, y, s, s, r); g.clip();
let bg = g.createLinearGradient(0, y, 0, y + s); bg.addColorStop(0, '#2A201B'); bg.addColorStop(1, '#100C0A');
g.fillStyle = bg; g.fillRect(x, y, s, s);
// warm glow
let glow = g.createRadialGradient(512, 600, 10, 512, 600, 420);
glow.addColorStop(0, 'rgba(255,140,60,.55)'); glow.addColorStop(1, 'rgba(255,140,60,0)');
g.fillStyle = glow; g.fillRect(x, y, s, s);
// ember drop
g.save(); g.translate(512, 560);
g.beginPath();
g.moveTo(46, -282);
g.bezierCurveTo(12, -170, 178, -100, 178, 62);
g.bezierCurveTo(178, 168, 98, 238, 0, 238);
g.bezierCurveTo(-98, 238, -178, 168, -178, 62);
g.bezierCurveTo(-178, -30, -96, -88, -70, -168);
g.bezierCurveTo(-40, -112, -8, -120, 4, -150);
g.bezierCurveTo(18, -190, 30, -236, 46, -282);
let fl = g.createRadialGradient(0, 120, 10, 0, 40, 300);
fl.addColorStop(0, '#FFF1C9'); fl.addColorStop(.28, '#FFC56B'); fl.addColorStop(.62, '#FF7A3D'); fl.addColorStop(1, '#E0304F');
g.shadowColor = 'rgba(255,120,50,.9)'; g.shadowBlur = 90;
g.fillStyle = fl; g.fill();
g.restore();
// the page line: a thin goal line along the bottom
let ln = g.createLinearGradient(x + 150, 0, x + s - 150, 0);
ln.addColorStop(0, '#FFC56B'); ln.addColorStop(.6, '#FF7A3D'); ln.addColorStop(1, 'rgba(242,56,90,.0)');
g.fillStyle = ln; g.beginPath(); g.roundRect(x + 150, 842, s - 300, 14, 7); g.fill();
g.restore();
<\/script></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const dataURL = await win.webContents.executeJavaScript('document.getElementById("c").toDataURL("image/png")');
  const out = path.join(__dirname, '..', 'assets', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(dataURL.split(',')[1], 'base64'));
  console.log('wrote', out);
  app.quit();
});
