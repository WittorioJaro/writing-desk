'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('./core/store');
const { Workspace } = require('./core/workspace');
const M = require('./core/model');
const { SmartCovers } = require('./core/smartcovers');

const E2E = process.env.WD_E2E === '1';
if (!E2E && !app.requestSingleInstanceLock()) app.quit();

let win = null;
let ws = null;
let smart = null;
const sync = { status: 'off', message: 'Sync is off', inFlight: false, timer: null, debounce: null, lastConflicts: 0 };
let readyResolve;
const whenReady = new Promise((r) => { readyResolve = r; });

function snapshot() {
  return {
    state: ws.state,
    deviceId: ws.deviceId,
    writable: ws.writable,
    loadError: ws.loadError,
    paths: { root: ws.store.root, inbox: ws.store.inboxDir, covers: ws.store.coversDir, state: ws.store.stateFile },
    sync: { config: ws.syncConfig, status: sync.status, message: sync.message, lastSync: ws.syncState.lastSync ?? null },
    covers: smart.snapshot(),
  };
}

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const pushState = () => send('desk:state', snapshot());
function setSync(status, message) {
  sync.status = status;
  sync.message = message;
  send('desk:sync', snapshot().sync);
}

// ---- Sync loop: at launch, every 30 s, and a few seconds after you stop typing ---------------------

async function syncNow(followUp = true) {
  if (!ws.writable || !ws.syncEnabled || sync.inFlight) return;
  sync.inFlight = true;
  setSync('syncing', 'Syncing…');
  try {
    const out = await ws.syncOnce();
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setSync('ok', out.conflicts > 0 ? `Synced ${time} · kept ${out.conflicts} conflict cop${out.conflicts === 1 ? 'y' : 'ies'}` : `Synced ${time}`);
    pushState();
    sync.inFlight = false;
    if (out.needsPush && followUp) await syncNow(false);
  } catch (e) {
    sync.inFlight = false;
    const msg = e.name === 'TimeoutError' ? 'server did not answer' : e.cause?.code || e.message;
    setSync('error', `Sync failed: ${msg}`);
  }
}

function restartSyncLoop() {
  clearInterval(sync.timer);
  if (!ws.writable) return setSync('paused', 'Sync paused (read-only)');
  if (!ws.syncEnabled) return setSync('off', 'Sync is off');
  sync.timer = setInterval(() => syncNow(), 30000);
  syncNow();
}

function scheduleSync() {
  if (!ws.syncEnabled) return;
  clearTimeout(sync.debounce);
  sync.debounce = setTimeout(() => syncNow(), 3000);
}

// ---- Inbox ------------------------------------------------------------------------------------------

function importInbox(manual) {
  if (!ws.writable) return { added: 0, errors: ['Read-only: inbox import is paused'], addedIds: [] };
  const r = ws.importInbox();
  if (r.added > 0 || manual) {
    pushState();
    send('desk:inbox', r);
  }
  if (r.added > 0) scheduleSync();
  return r;
}

let inboxWatch = null, inboxDebounce = null;
function watchInbox() {
  try {
    inboxWatch = fs.watch(ws.store.inboxDir, { persistent: false }, (_e, name) => {
      if (!name || !/\.(txt|md)$/i.test(name)) return;
      clearTimeout(inboxDebounce);
      inboxDebounce = setTimeout(() => importInbox(false), 700);
    });
  } catch {}
}

// ---- IPC --------------------------------------------------------------------------------------------

const considerCovers = (id) => { const a = ws.article(id); if (a) smart.consider(a, (i) => ws.article(i)); };
const ops = {
  newArticle: () => ws.newArticle(),
  setTitle: (id, t) => { ws.setTitle(id, t); considerCovers(id); },
  setBody: (id, b) => { ws.setBody(id, b); considerCovers(id); },
  deleteArticle: (id) => { ws.deleteArticle(id); smart.forget(id); },
  setGoal: (g) => ws.setGoal(g),
  addIdea: (t) => ws.addIdea(t),
  toggleIdea: (id) => ws.toggleIdea(id),
};

function registerIPC() {
  ipcMain.handle('desk:init', () => snapshot());
  ipcMain.handle('desk:op', (_e, name, ...args) => {
    if (!ops[name]) throw new Error(`unknown op ${name}`);
    try {
      const result = ops[name](...args);
      scheduleSync();
      return { ok: true, result, snapshot: snapshot() };
    } catch (e) {
      return { ok: false, error: e.message, snapshot: snapshot() };
    }
  });
  ipcMain.handle('desk:inbox', () => importInbox(true));
  // Covers: chosen cover per piece, and Codex suggestions (local only, see core/smartcovers.js)
  ipcMain.handle('desk:cover-select', (_e, id, choice) => { smart.select(id, choice); return smart.snapshot(); });
  ipcMain.handle('desk:cover-image', (_e, rel) => fs.readFileSync(smart.imagePath(rel)));
  ipcMain.handle('desk:cover-settings', (_e, s) => { smart.setSettings(s); return smart.snapshot(); });
  ipcMain.handle('desk:cover-suggest', async (_e, id) => {
    const a = ws.article(id);
    if (!a) return { ok: false, error: 'No such piece' };
    if (!smart.bin) return { ok: false, error: 'Codex isn’t installed (looked for the codex command)' };
    if (smart.running) return { ok: false, error: 'Codex is already drawing covers' };
    smart.generate(a).catch(() => {}); // runs in the background; progress arrives as desk:covers events
    return { ok: true };
  });
  ipcMain.handle('desk:sync-config', (_e, cfg) => {
    try { ws.setSyncConfig(cfg); } catch (e) { return { ok: false, error: e.message }; }
    restartSyncLoop();
    return { ok: true, sync: snapshot().sync };
  });
  ipcMain.handle('desk:sync-now', async () => { await syncNow(); return snapshot().sync; });
  ipcMain.handle('desk:export-cover', async (_e, bytes, name) => {
    const safe = String(name || 'cover').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 60) || 'cover';
    let target = path.join(ws.store.coversDir, `${safe}.png`);
    if (!E2E) {
      const r = await dialog.showSaveDialog(win, { title: 'Export cover', defaultPath: target, filters: [{ name: 'PNG image', extensions: ['png'] }] });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    fs.writeFileSync(target, Buffer.from(bytes));
    return target;
  });
  ipcMain.handle('desk:reveal', (_e, which) => {
    const p = { inbox: ws.store.inboxDir, covers: ws.store.coversDir, data: ws.store.root }[which];
    if (p) shell.openPath(p);
    else if (which === 'state') shell.showItemInFolder(ws.store.stateFile);
    else if (typeof which === 'string' && which.startsWith(ws.store.coversDir)) shell.showItemInFolder(which);
  });
}

// ---- Window & menu ----------------------------------------------------------------------------------

function command(name) { send('desk:command', name); }

function buildMenu() {
  const t = [
    { role: 'appMenu', submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Sync Settings…', accelerator: 'Cmd+,', click: () => command('sync') },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'File', submenu: [
      { label: 'New Piece', accelerator: 'Cmd+N', click: () => command('new') },
      { label: 'Generate Covers…', accelerator: 'Cmd+K', click: () => command('covers') },
      { type: 'separator' },
      { label: 'Check Ideas Inbox', accelerator: 'Shift+Cmd+I', click: () => importInbox(true) },
      { label: 'Open Inbox Folder', click: () => shell.openPath(ws.store.inboxDir) },
      { label: 'Show Data in Finder', click: () => shell.showItemInFolder(ws.store.stateFile) },
      { type: 'separator' }, { role: 'close' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Your Writing', accelerator: 'Cmd+O', click: () => command('articles') },
      { label: 'Prompts', accelerator: 'Cmd+I', click: () => command('prompts') },
      { label: 'Momentum', accelerator: 'Cmd+J', click: () => command('momentum') },
      { label: 'Focus', accelerator: 'Cmd+.', click: () => command('focus') },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }, { role: 'reload' }]),
    ] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 720, minHeight: 520,
    show: false,
    title: 'Writing Desk',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 20 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141312' : '#F6F3ED',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => { if (!E2E) win.show(); });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
  return win;
}

app.whenReady().then(() => {
  // The renderer may only load local files; it has no network access at all.
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    cb({ cancel: !/^(file|data|blob|devtools|chrome-extension):/.test(details.url) });
  });
  ws = new Workspace(new Store());
  smart = new SmartCovers(ws.store.root, { debounceMs: Number(process.env.WD_COVER_DEBOUNCE) || 6000, onChange: (id, status) => send('desk:covers', { covers: smart.snapshot(), id, status }) });
  ws.onSaveError = (e) => send('desk:toast', { kind: 'error', text: `Not saved: ${e.message}` });
  registerIPC();
  buildMenu();
  createWindow();
  if (ws.writable) {
    importInbox(false);
    watchInbox();
  }
  restartSyncLoop();
  readyResolve({ win, ws });
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('activate', () => { if (!win) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || E2E) app.quit(); });
app.on('before-quit', () => { if (ws) ws.flush(); inboxWatch?.close(); });

module.exports = { whenReady, M };
