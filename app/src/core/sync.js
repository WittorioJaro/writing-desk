'use strict';
// Merge rules — a faithful port of WritingDeskCore/Sync.swift, so this app and the Swift sync
// server on the Mac mini agree exactly. Fingerprints are UInt64 values carried as decimal strings
// (they exceed JS's safe-integer range) and written to JSON as raw number literals.

const { canonical, stableStringify } = require('./model');

const TWO32 = 4294967296;
const enc = new TextEncoder();

/** FNV-1a 64-bit over a sequence of byte arrays, separated as the Swift code does. Returns {hi, lo}. */
function fnvStep(h, bytes) {
  let { hi, lo } = h;
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ bytes[i]) >>> 0;
    // h * 0x100000001b3 mod 2^64 == h * 0x1b3 + (h << 40)
    const loMul = lo * 0x1b3;
    const carry = Math.floor(loMul / TWO32);
    const newLo = loMul % TWO32;
    hi = (hi * 0x1b3 + carry + ((lo * 256) % TWO32)) % TWO32;
    lo = newLo;
  }
  return { hi, lo };
}
const FNV_INIT = { hi: 0xcbf29ce4, lo: 0x84222325 };
const toBig = ({ hi, lo }) => (BigInt(hi) << 32n) | BigInt(lo);

/** Content fingerprint (title + body) as a decimal string. */
function fingerprintBig(a) {
  let h = fnvStep(FNV_INIT, enc.encode(a.title));
  h = fnvStep(h, [0xff]);
  h = fnvStep(h, enc.encode(a.body));
  return toBig(h);
}
const fingerprint = (a) => fingerprintBig(a).toString();

function newerArticle(a, b) {
  if (a.updated !== b.updated) return a.updated > b.updated ? a : b;
  return fingerprintBig(a) >= fingerprintBig(b) ? a : b; // deterministic tie-break
}
const lastChange = (i) => i.updated ?? i.added;
function newerIdea(a, b) {
  if (lastChange(a) !== lastChange(b)) return lastChange(a) > lastChange(b) ? a : b;
  if (a.done !== b.done) return a.done ? a : b;
  return a.text >= b.text ? a : b;
}

const clone = (x) => structuredClone(x);
const idCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Canonical ordering: newest articles first, ideas in the order they arrived. */
function normalized(s) {
  const out = clone(s);
  out.articles.sort((a, b) => (a.created !== b.created ? b.created - a.created : idCmp(a.id, b.id)));
  out.ideas.sort((a, b) => (a.added !== b.added ? a.added - b.added : idCmp(a.id, b.id)));
  return out;
}

const statesEqual = (a, b) => stableStringify(a) === stableStringify(b);

function merge(x, y) {
  const tombstones = { ...x.tombstones };
  for (const [k, t] of Object.entries(y.tombstones)) tombstones[k] = Math.max(tombstones[k] ?? t, t);

  const articles = new Map();
  for (const a of [...x.articles, ...y.articles]) articles.set(a.id, articles.has(a.id) ? newerArticle(articles.get(a.id), a) : a);
  const ideas = new Map();
  for (const i of [...x.ideas, ...y.ideas]) ideas.set(i.id, ideas.has(i.id) ? newerIdea(ideas.get(i.id), i) : i);

  const byDevice = {};
  for (const src of [x.accountability.byDevice, y.accountability.byDevice]) {
    for (const [dev, days] of Object.entries(src)) {
      const t = (byDevice[dev] ||= {});
      for (const [k, v] of Object.entries(days)) t[k] = Math.max(t[k] ?? v, v);
    }
  }
  const gx = x.accountability, gy = y.accountability;
  const acc = { byDevice };
  const a = gx.goalUpdated, b = gy.goalUpdated;
  if (a !== undefined && b !== undefined && a !== b) {
    [acc.dailyGoal, acc.goalUpdated] = a > b ? [gx.dailyGoal, a] : [gy.dailyGoal, b];
  } else if (a !== undefined && b === undefined) {
    [acc.dailyGoal, acc.goalUpdated] = [gx.dailyGoal, a];
  } else if (a === undefined && b !== undefined) {
    [acc.dailyGoal, acc.goalUpdated] = [gy.dailyGoal, b];
  } else {
    acc.dailyGoal = Math.max(gx.dailyGoal, gy.dailyGoal);
    if (a !== undefined) acc.goalUpdated = a;
  }

  return normalized({
    articles: [...articles.values()].filter((art) => tombstones[art.id] === undefined || art.updated > tombstones[art.id]),
    ideas: [...ideas.values()],
    accountability: acc,
    tombstones,
  });
}

function fnvString(s) { return toBig(fnvStep(FNV_INIT, enc.encode(s))); }

/** Deterministic id for a conflict copy, so retrying the same sync never creates duplicates. */
function conflictID(a) {
  const h1 = fnvString(a.id);
  const h2 = fingerprintBig(a) ^ 0x9E3779B97F4A7C15n;
  const bytes = new Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number((h1 >> BigInt(8 * i)) & 0xffn);
    bytes[8 + i] = Number((h2 >> BigInt(8 * i)) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The server's merge (used by tests; the real server is Swift). See Sync.serverMerge. */
function serverMerge(stored, incoming, bases) {
  const out = merge(stored, incoming);
  const byID = new Map(out.articles.map((a) => [a.id, a]));
  const storedByID = new Map(stored.articles.map((a) => [a.id, a]));
  let conflicts = 0;
  for (const inc of incoming.articles) {
    const key = inc.id, fi = fingerprint(inc), base = bases[key];
    const st = storedByID.get(inc.id);
    if (st) {
      const fs = fingerprint(st);
      if (fi === fs) continue;
      if (base === fs) byID.set(inc.id, { ...inc, updated: Math.max(inc.updated, st.updated) });
      else if (base === fi) byID.set(inc.id, st);
      else {
        const winner = newerArticle(st, inc);
        const loser = winner.id === st.id && fingerprint(winner) === fs ? inc : st;
        byID.set(inc.id, winner);
        const copyID = conflictID(loser);
        if (!byID.has(copyID)) {
          byID.set(copyID, { id: copyID, title: loser.title + ' (conflict copy)', body: loser.body, created: winner.updated, updated: loser.updated });
          conflicts++;
        }
      }
    } else if (out.tombstones[key] !== undefined && (base === undefined || fi !== base)) {
      byID.set(inc.id, { ...inc, updated: Math.max(inc.updated, out.tombstones[key] + 1) });
    }
  }
  out.articles = [...byID.values()];
  return { state: normalized(out), conflicts };
}

/**
 * Applies the server's response locally. The server's version wins, except for edits made on this
 * Mac while the request was in flight: those are kept and pushed next time. See Sync.reconcile.
 */
function reconcile(local, sent, response, oldBase) {
  const out = merge(response, local);
  const sentByID = new Map(sent.articles.map((a) => [a.id, a]));
  const byID = new Map(response.articles.map((a) => [a.id, a]));
  for (const l of local.articles) {
    const s = sentByID.get(l.id);
    if (s && fingerprint(s) === fingerprint(l)) continue;
    const keep = { ...l };
    const r = byID.get(l.id);
    if (r) keep.updated = Math.max(l.updated, r.updated);
    const deleted = out.tombstones[l.id];
    if (deleted !== undefined && keep.updated <= deleted) keep.updated = deleted + 1;
    byID.set(l.id, keep);
  }
  out.articles = [...byID.values()].filter((a) => out.tombstones[a.id] === undefined || a.updated > out.tombstones[a.id]);
  const base = {};
  for (const r of response.articles) {
    const fr = fingerprint(r);
    const fin = byID.get(r.id);
    if (fin && fingerprint(fin) === fr) base[r.id] = fr;
    else if (sentByID.has(r.id)) base[r.id] = fingerprint(sentByID.get(r.id));
    else if (oldBase[r.id] !== undefined) base[r.id] = oldBase[r.id];
  }
  return { state: normalized(out), base };
}

// ---- JSON with exact UInt64 values ----------------------------------------------------------------

/** Replaces decimal-string fingerprints with raw JSON number literals. */
function rawBases(bases) {
  const out = {};
  for (const [k, v] of Object.entries(bases)) out[k] = JSON.rawJSON(String(v));
  return out;
}

/** JSON.parse that keeps big integers exact (as decimal strings). */
function parseExact(text) {
  return JSON.parse(text, (key, value, ctx) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && ctx && /^\d+$/.test(ctx.source)) return ctx.source;
    return value;
  });
}

module.exports = {
  fingerprint, merge, normalized, statesEqual, serverMerge, reconcile, conflictID,
  rawBases, parseExact, canonical,
};
