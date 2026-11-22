// Read-only accountability helpers for the UI (same rules as src/core/model.js).

const seg = new Intl.Segmenter(undefined, { granularity: 'word' });
export function wordCount(text) {
  if (!text) return 0;
  let n = 0;
  for (const s of seg.segment(text)) if (s.isWordLike) n++;
  return n;
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
export const dayKey = (d = new Date()) => `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };

export function totals(acc) {
  const t = {};
  for (const days of Object.values(acc.byDevice)) for (const [k, v] of Object.entries(days)) t[k] = (t[k] || 0) + v;
  return t;
}
export const wordsOn = (acc, d = new Date()) => totals(acc)[dayKey(d)] || 0;
const met = (acc, t, d) => acc.dailyGoal > 0 && (t[dayKey(d)] || 0) >= acc.dailyGoal;

export function streak(acc, asOf = new Date()) {
  const t = totals(acc);
  let d = addDays(asOf, 0);
  if (!met(acc, t, d)) d = addDays(d, -1);
  let n = 0;
  while (met(acc, t, d) && n < 100000) { n++; d = addDays(d, -1); }
  return n;
}

export function bestStreak(acc) {
  const t = totals(acc);
  const days = Object.keys(t).filter((k) => acc.dailyGoal > 0 && t[k] >= acc.dailyGoal).sort();
  let best = 0, run = 0, prev = null;
  for (const k of days) {
    run = prev && dayKey(addDays(prev, 1)) === k ? run + 1 : 1;
    best = Math.max(best, run);
    const [y, m, d] = k.split('-').map(Number);
    prev = new Date(y, m - 1, d);
  }
  return best;
}

export const REF_EPOCH = 978307200;
export const refToDate = (ref) => new Date((ref + REF_EPOCH) * 1000);
