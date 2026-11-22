'use strict';
// Data model shared with the Swift sync server (same JSON on disk and on the wire).
//
// Dates are kept as *raw numbers*: seconds since 2001-01-01 (Apple's reference date), exactly as the
// Swift side writes them. We never round-trip them through JS Date objects, so values survive
// read -> write unchanged and fingerprints/equality match the server bit for bit.
// UUIDs are upper-case strings (Swift's `uuidString`).

const crypto = require('node:crypto');

const REF_EPOCH = 978307200; // 2001-01-01T00:00:00Z in Unix seconds
const DEFAULT_GOAL = 500;
const LEGACY_DEVICE = 'legacy';

const now = () => Date.now() / 1000 - REF_EPOCH;
const toUnixMs = (ref) => (ref + REF_EPOCH) * 1000;
const fromUnixMs = (ms) => ms / 1000 - REF_EPOCH;
const newId = () => crypto.randomUUID().toUpperCase();

/** Accepts a reference-date number or a v1 ISO-8601 string. Throws on anything else. */
function decodeDate(v, what) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return fromUnixMs(ms);
  }
  throw new Error(`Unrecognised date for ${what}: ${JSON.stringify(v)}`);
}

function req(obj, key, type, what) {
  const v = obj[key];
  if (typeof v !== type) throw new Error(`${what}: missing or invalid "${key}"`);
  return v;
}

function decodeArticle(a) {
  if (!a || typeof a !== 'object') throw new Error('article is not an object');
  return {
    id: req(a, 'id', 'string', 'article').toUpperCase(),
    title: req(a, 'title', 'string', 'article'),
    body: req(a, 'body', 'string', 'article'),
    created: decodeDate(a.created, 'article.created'),
    updated: decodeDate(a.updated, 'article.updated'),
  };
}

function decodeIdea(i) {
  if (!i || typeof i !== 'object') throw new Error('idea is not an object');
  const out = {
    id: req(i, 'id', 'string', 'idea').toUpperCase(),
    text: req(i, 'text', 'string', 'idea'),
    source: req(i, 'source', 'string', 'idea'),
    added: decodeDate(i.added, 'idea.added'),
    done: req(i, 'done', 'boolean', 'idea'),
  };
  if (i.updated !== undefined && i.updated !== null) out.updated = decodeDate(i.updated, 'idea.updated');
  return out;
}

function decodeAccountability(a) {
  const acc = { dailyGoal: DEFAULT_GOAL, byDevice: {} };
  if (!a || typeof a !== 'object') return acc;
  if (Number.isInteger(a.dailyGoal)) acc.dailyGoal = a.dailyGoal;
  if (a.goalUpdated !== undefined && a.goalUpdated !== null) acc.goalUpdated = decodeDate(a.goalUpdated, 'goalUpdated');
  if (a.byDevice && typeof a.byDevice === 'object') {
    for (const [dev, days] of Object.entries(a.byDevice)) {
      acc.byDevice[dev] = {};
      for (const [day, n] of Object.entries(days || {})) if (Number.isInteger(n)) acc.byDevice[dev][day] = n;
    }
  }
  // v1 stored a single `history`; keep it under a legacy device key.
  if (a.history && typeof a.history === 'object' && Object.keys(a.history).length) {
    const legacy = (acc.byDevice[LEGACY_DEVICE] ||= {});
    for (const [day, n] of Object.entries(a.history)) if (Number.isInteger(n)) legacy[day] = Math.max(legacy[day] ?? n, n);
  }
  return acc;
}

/** Decodes a state.json / server state object. Every top-level field is optional (older files still load). */
function decodeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('state is not a JSON object');
  const tombstones = {};
  for (const [id, t] of Object.entries(raw.tombstones || {})) tombstones[id.toUpperCase()] = decodeDate(t, 'tombstone');
  return {
    articles: (raw.articles || []).map(decodeArticle),
    ideas: (raw.ideas || []).map(decodeIdea),
    accountability: decodeAccountability(raw.accountability),
    tombstones,
  };
}

const emptyState = () => ({ articles: [], ideas: [], accountability: { dailyGoal: DEFAULT_GOAL, byDevice: {} }, tombstones: {} });

/** Object with keys sorted recursively and undefined dropped — the canonical form for files and equality. */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object' && !(typeof v.rawJSON === 'string')) {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

const stableStringify = (v, pretty = false) => JSON.stringify(canonical(v), null, pretty ? 2 : 0);

// ---- Words & accountability -------------------------------------------------------------------

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
function wordCount(text) {
  if (!text) return 0;
  let n = 0;
  for (const s of segmenter.segment(text)) if (s.isWordLike) n++;
  return n;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
/** Local calendar day ("yyyy-MM-dd") for a JS Date. */
function dayKey(date = new Date()) {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function addDays(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + n);
  return d;
}

/** Only net *new* words count: deleting text never lowers a day's total. */
function recordEdit(acc, oldCount, newCount, device, date = new Date()) {
  const delta = newCount - oldCount;
  if (delta <= 0) return;
  const days = (acc.byDevice[device] ||= {});
  const key = dayKey(date);
  days[key] = (days[key] || 0) + delta;
}

function wordsOn(acc, date = new Date()) {
  const key = dayKey(date);
  let n = 0;
  for (const days of Object.values(acc.byDevice)) n += days[key] || 0;
  return n;
}

const goalMet = (acc, date) => acc.dailyGoal > 0 && wordsOn(acc, date) >= acc.dailyGoal;

/** Consecutive days meeting the goal, ending today (or yesterday if today isn't met yet). */
function streak(acc, asOf = new Date()) {
  let day = addDays(asOf, 0);
  if (!goalMet(acc, day)) day = addDays(day, -1);
  let n = 0;
  while (goalMet(acc, day) && n < 100000) { n++; day = addDays(day, -1); }
  return n;
}

/** Longest run of goal-met days ever. */
function bestStreak(acc) {
  const totals = {};
  for (const days of Object.values(acc.byDevice)) for (const [k, v] of Object.entries(days)) totals[k] = (totals[k] || 0) + v;
  const met = Object.keys(totals).filter((k) => acc.dailyGoal > 0 && totals[k] >= acc.dailyGoal).sort();
  let best = 0, run = 0, prev = null;
  for (const k of met) {
    const [y, m, d] = k.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    run = prev && dayKey(addDays(prev, 1)) === k ? run + 1 : 1;
    best = Math.max(best, run);
    prev = date;
  }
  return best;
}

/** Last `days` days, oldest first. */
function recent(acc, days, asOf = new Date()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(asOf, -i);
    out.push({ day: dayKey(d), words: wordsOn(acc, d) });
  }
  return out;
}

function renameDevice(acc, from, to) {
  if (from === to || !acc.byDevice[from]) return;
  const days = acc.byDevice[from];
  delete acc.byDevice[from];
  const target = (acc.byDevice[to] ||= {});
  for (const [k, v] of Object.entries(days)) target[k] = (target[k] || 0) + v;
}

module.exports = {
  REF_EPOCH, DEFAULT_GOAL, LEGACY_DEVICE,
  now, toUnixMs, fromUnixMs, newId,
  decodeState, emptyState, canonical, stableStringify,
  wordCount, dayKey, addDays, recordEdit, wordsOn, goalMet, streak, bestStreak, recent, renameDevice,
};
