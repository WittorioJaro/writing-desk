'use strict';
// Owns the in-memory state and is the only thing that writes state.json.
//
// Safety rule: if an existing state.json can't be read or decoded, the workspace opens read-only
// and never writes (no edits, no inbox import, no sync), leaving the file untouched for recovery.

const M = require('./model');
const S = require('./sync');
const inbox = require('./inbox');

class ReadOnlyError extends Error {}

function validServerURL(text) {
  try {
    const u = new URL(String(text).trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? u : null;
  } catch { return null; }
}

class Workspace {
  /** @param {import('./store').Store} store */
  constructor(store, { saveDelayMs = 250 } = {}) {
    this.store = store;
    this.saveDelayMs = saveDelayMs;
    this.saveTimer = null;
    this.onSaveError = () => {};
    try {
      this.state = store.load();
      this.loadError = null;
    } catch (e) {
      this.state = M.emptyState();
      this.loadError = `Couldn't read ${store.stateFile} (${e.message}). The file was left untouched.`;
    }
    this.deviceId = store.deviceId();
    this.syncConfig = store.loadSyncConfig();
    this.syncState = store.loadSyncState();
    if (this.writable) {
      // v1 migration (saved with the next write): give old history this Mac's id, and mark a goal
      // changed from the default as set, so an empty server can't reset it.
      M.renameDevice(this.state.accountability, M.LEGACY_DEVICE, this.deviceId);
      const acc = this.state.accountability;
      if (acc.goalUpdated === undefined && acc.dailyGoal !== M.DEFAULT_GOAL) acc.goalUpdated = 1 - M.REF_EPOCH;
    }
  }

  get writable() { return this.loadError === null; }

  guard() { if (!this.writable) throw new ReadOnlyError(`Writing is disabled: ${this.loadError}`); }

  /** Saves soon (coalescing keystrokes). If a save fails the change stays in memory and is retried. */
  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), this.saveDelayMs);
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.writable) return true;
    try { this.store.save(this.state); return true; } catch (e) { this.onSaveError(e); return false; }
  }

  get pendingSave() { return this.saveTimer !== null; }

  mutate(change) {
    this.guard();
    change(this.state);
    this.scheduleSave();
  }

  article(id) { return this.state.articles.find((a) => a.id === id); }

  newArticle() {
    const t = M.now();
    const a = { id: M.newId(), title: '', body: '', created: t, updated: t };
    this.mutate((s) => s.articles.unshift(a));
    return a.id;
  }

  setTitle(id, title) {
    this.mutate(() => {
      const a = this.article(id);
      if (!a || a.title === title) return;
      a.title = title;
      a.updated = M.now();
    });
  }

  setBody(id, body, date = new Date()) {
    this.mutate((s) => {
      const a = this.article(id);
      if (!a || a.body === body) return;
      const old = M.wordCount(a.body);
      a.body = body;
      a.updated = M.now();
      M.recordEdit(s.accountability, old, M.wordCount(body), this.deviceId, date);
    });
  }

  deleteArticle(id) {
    this.mutate((s) => {
      s.articles = s.articles.filter((a) => a.id !== id);
      s.tombstones[id] = M.now();
    });
  }

  setGoal(goal) {
    this.mutate((s) => {
      s.accountability.dailyGoal = Math.max(50, Math.round(goal));
      s.accountability.goalUpdated = M.now();
    });
  }

  addIdea(text) {
    const t = text.trim();
    if (!t) return null;
    const idea = { id: M.newId(), text: t, source: 'added in app', added: M.now(), done: false };
    this.mutate((s) => s.ideas.push(idea));
    return idea.id;
  }

  toggleIdea(id) {
    this.mutate((s) => {
      const i = s.ideas.find((x) => x.id === id);
      if (!i) return;
      i.done = !i.done;
      i.updated = M.now();
    });
  }

  /** Imports the inbox, saving before any file is archived. */
  importInbox() {
    this.guard();
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const { state, result } = inbox.importInbox(this.store, this.state, (s) => this.store.save(s), M.now);
    this.state = state;
    return result;
  }

  // ---- Sync -------------------------------------------------------------------------------------

  setSyncConfig(cfg) {
    const c = { serverURL: String(cfg.serverURL || '').trim(), enabled: !!cfg.enabled };
    if (c.enabled && !validServerURL(c.serverURL)) throw new Error("Sync server URL isn't valid (expected http://host:port)");
    this.store.saveSyncConfig(c);
    this.syncConfig = c;
  }

  get syncEnabled() { return this.syncConfig.enabled && !!validServerURL(this.syncConfig.serverURL); }

  makeSyncRequest() { return { state: structuredClone(this.state), bases: { ...this.syncState.base } }; }

  /** Folds a server response into local state and saves it. Returns { conflicts, needsPush }. */
  applySync(sent, response) {
    this.guard();
    const r = S.reconcile(this.state, sent.state, response.state, sent.bases);
    this.state = r.state;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.store.save(this.state);
    this.syncState = { base: r.base, lastSync: M.now() };
    this.store.saveSyncState(this.syncState);
    return { conflicts: response.conflicts, needsPush: !S.statesEqual(this.state, S.normalized(response.state)) };
  }

  /** One round trip with the configured server. Only ever contacts that URL. */
  async syncOnce({ timeoutMs = 20000, fetchImpl = fetch } = {}) {
    this.guard();
    const base = validServerURL(this.syncConfig.serverURL);
    if (!base) throw new Error("Sync server URL isn't valid (expected http://host:port)");
    const url = new URL('v1/sync', base.href.endsWith('/') ? base.href : base.href + '/');
    const sent = this.makeSyncRequest();
    const body = JSON.stringify(S.canonical({ state: sent.state, bases: S.rawBases(sent.bases) }));
    const res = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`Server returned ${res.status}: ${text.slice(0, 300)}`);
    const raw = JSON.parse(text);
    const response = { state: M.decodeState(raw.state), conflicts: raw.conflicts | 0 };
    return this.applySync(sent, response);
  }
}

module.exports = { Workspace, ReadOnlyError, validServerURL };
