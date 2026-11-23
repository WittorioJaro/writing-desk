'use strict';
// Local-only persistence. Same layout as the Swift app, so data carries over unchanged:
//
//   ~/Library/Application Support/WritingDesk/   (override with WRITING_DESK_HOME)
//     state.json        articles, ideas, goal + per-Mac word history
//     inbox/            drop .txt / .md files with ideas here
//     inbox/imported/   processed inbox files are moved here
//     covers/           default PNG export folder
//     device-id         random id for this Mac
//     sync.json         sync server URL + on/off
//     sync-state.json   what the server last confirmed (detects conflicting edits)

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { decodeState, emptyState, stableStringify, newId, canonical } = require('./model');
const { parseExact, rawBases } = require('./sync');

function defaultRoot() {
  const env = process.env.WRITING_DESK_HOME;
  if (env) return path.resolve(env.replace(/^~(?=$|\/)/, os.homedir()));
  return path.join(os.homedir(), 'Library', 'Application Support', 'WritingDesk');
}

/** Write to a temp file in the same folder, then rename: a crash never leaves a half-written file. */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

class Store {
  constructor(root = defaultRoot()) {
    this.root = root;
    this.stateFile = path.join(root, 'state.json');
    this.inboxDir = path.join(root, 'inbox');
    this.importedDir = path.join(this.inboxDir, 'imported');
    this.coversDir = path.join(root, 'covers');
    this.deviceIdFile = path.join(root, 'device-id');
    this.syncConfigFile = path.join(root, 'sync.json');
    this.syncStateFile = path.join(root, 'sync-state.json');
    for (const d of [root, this.inboxDir, this.importedDir, this.coversDir]) fs.mkdirSync(d, { recursive: true });
  }

  /** Missing file -> empty state. Unreadable/invalid file -> throws (the caller opens read-only). */
  load() {
    if (!fs.existsSync(this.stateFile)) return emptyState();
    return decodeState(JSON.parse(fs.readFileSync(this.stateFile, 'utf8')));
  }

  save(state) { writeAtomic(this.stateFile, stableStringify(state, true)); }

  deviceId() {
    try {
      const id = fs.readFileSync(this.deviceIdFile, 'utf8').trim();
      if (id) return id;
    } catch {}
    const id = newId();
    try { fs.writeFileSync(this.deviceIdFile, id); } catch {}
    return id;
  }

  loadSyncConfig() {
    try {
      const c = JSON.parse(fs.readFileSync(this.syncConfigFile, 'utf8'));
      return { serverURL: typeof c.serverURL === 'string' ? c.serverURL : '', enabled: c.enabled === true };
    } catch { return { serverURL: '', enabled: false }; }
  }

  saveSyncConfig(c) { writeAtomic(this.syncConfigFile, stableStringify({ serverURL: c.serverURL, enabled: c.enabled }, true)); }

  loadSyncState() {
    try {
      const s = parseExact(fs.readFileSync(this.syncStateFile, 'utf8'));
      const base = {};
      for (const [k, v] of Object.entries(s.base || {})) base[k.toUpperCase()] = String(v);
      const out = { base };
      if (typeof s.lastSync === 'number') out.lastSync = s.lastSync;
      return out;
    } catch { return { base: {} }; }
  }

  saveSyncState(s) {
    const obj = { base: rawBases(s.base) };
    if (s.lastSync !== undefined) obj.lastSync = s.lastSync;
    writeAtomic(this.syncStateFile, JSON.stringify(canonical(obj), null, 2));
  }
}

module.exports = { Store, defaultRoot, writeAtomic };
