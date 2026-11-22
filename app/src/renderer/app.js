import { Field, Flame, odometer, tween } from './fx.js';
import { seedFrom, renderCover, STYLES, EXPORT_W } from './covers.js';
import * as A from './acc.js';

const $ = (s) => document.querySelector(s);
const desk = window.desk;
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const el = {
  body: document.body, scroller: $('#scroller'), page: $('#page'), title: $('#title'), text: $('#body'),
  goal: $('#goal-line'), goalFill: $('#goal-line .fill'),
  pieceWords: $('#piece-words'), pieceRead: $('#piece-read'),
  chipRing: $('#momentum-chip .prog'), chipToday: $('#chip-today'), chipGoal: $('#chip-goal'), chipStreak: $('#chip-streak'), chipEmber: $('#chip-ember'),
  drawerA: $('#drawer-articles'), drawerP: $('#drawer-prompts'), list: $('#article-list'), filter: $('#filter'),
  ideas: $('#idea-list'), ideasDone: $('#idea-done'), doneWrap: $('#done-wrap'), doneCount: $('#done-count'), ideaInput: $('#idea-input'), badge: $('#prompts-badge'),
  toast: $('#toast'), syncDot: $('#sync-dot'), syncDot2: $('#sync-dot-2'), syncMsg: $('#sync-msg'), syncUrl: $('#sync-url'),
};

let snap = null;
let currentId = null;
let prevMet = null;
let prevProgress = 0;
let lastInput = 0;
const createdHere = new Set();
const field = new Field($('#fx'));
const flame = new Flame($('#flame-canvas'));
const seen = new Set(store.get('seenIdeas', []));

// ---------- Helpers ----------
const acc = () => snap.state.accountability;
const article = (id = currentId) => snap.state.articles.find((a) => a.id === id);
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
function relDay(ref) {
  const d = A.refToDate(ref), today = new Date();
  const diff = Math.round((A.addDays(today, 0) - A.addDays(d, 0)) / 864e5);
  if (diff === 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
let toastTimer;
function toast(text, kind = '') {
  el.toast.textContent = text;
  el.toast.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.className = kind; }, kind === 'error' ? 6000 : 3200);
}
const center = (node) => { const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

// Ops run strictly in order (typing produces many).
let queue = Promise.resolve();
function op(name, ...args) {
  const p = queue.then(() => desk.op(name, ...args)).then((res) => {
    snap = res.snapshot;
    if (!res.ok) toast(res.error, 'error');
    afterChange();
    return res.result;
  });
  queue = p.catch(() => {});
  return p;
}

// Typing on an empty canvas creates the article once, however fast the keystrokes arrive.
let creating = null;
function ensureArticle() {
  if (currentId) return Promise.resolve(currentId);
  if (!creating) {
    creating = op('newArticle').then((id) => {
      if (id && !currentId) { currentId = id; createdHere.add(id); store.set('current', id); }
      creating = null;
      return currentId;
    });
  }
  return creating;
}

// ---------- Editor ----------
function autosize(t) {
  const top = el.scroller.scrollTop;
  t.style.height = 'auto';
  t.style.height = t.scrollHeight + 'px';
  el.scroller.scrollTop = top;
}

function fillEditor() {
  const a = article();
  el.title.value = a ? a.title : '';
  el.text.value = a ? a.body : '';
  autosize(el.title);
  autosize(el.text);
  updatePieceMeta();
}

function updatePieceMeta() {
  const n = A.wordCount(el.text.value);
  el.pieceWords.textContent = plural(n, 'word');
  const mins = Math.round(n / 230);
  el.pieceRead.textContent = mins < 1 ? 'under a minute' : `${mins} min read`;
}

function keepCaretInView() {
  if (el.text.selectionEnd < el.text.value.length - 2) return;
  const r = el.text.getBoundingClientRect();
  const over = r.bottom - innerHeight * 0.6;
  if (over > 4) el.scroller.scrollBy({ top: over, behavior: 'smooth' });
}

el.title.addEventListener('input', async () => {
  autosize(el.title);
  lastInput = Date.now();
  const v = el.title.value.replace(/\n/g, ' ');
  if (v !== el.title.value) el.title.value = v;
  const id = await ensureArticle();
  if (id) op('setTitle', id, el.title.value);
});
el.title.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); el.text.focus(); el.text.setSelectionRange(0, 0); }
});
el.text.addEventListener('input', async () => {
  autosize(el.text);
  updatePieceMeta();
  keepCaretInView();
  lastInput = Date.now();
  const id = await ensureArticle();
  if (id) op('setBody', id, el.text.value);
});

// Writing mode: everything but the words fades away once you type, and returns when you move the mouse.
let mouseAnchor = null;
for (const t of [el.title, el.text]) {
  t.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.key === 'Escape' || e.key.startsWith('Arrow')) return;
    if (!el.body.classList.contains('writing')) { el.body.classList.add('writing'); mouseAnchor = null; }
  });
}
addEventListener('mousemove', (e) => {
  if (!el.body.classList.contains('writing')) return;
  if (!mouseAnchor) { mouseAnchor = { x: e.clientX, y: e.clientY }; return; }
  if (Math.hypot(e.clientX - mouseAnchor.x, e.clientY - mouseAnchor.y) > 12) el.body.classList.remove('writing');
});

function switchTo(id, { focus = true } = {}) {
  const leaving = article();
  if (leaving && createdHere.has(leaving.id) && !leaving.title.trim() && !leaving.body.trim() && leaving.id !== id) {
    op('deleteArticle', leaving.id);
  }
  el.page.classList.add('leaving');
  setTimeout(() => {
    currentId = id;
    store.set('current', id);
    fillEditor();
    el.scroller.scrollTop = 0;
    el.page.classList.remove('leaving');
    el.page.classList.add('entering');
    requestAnimationFrame(() => requestAnimationFrame(() => el.page.classList.remove('entering')));
    if (focus) {
      const a = article();
      (a && !a.title ? el.title : el.text).focus();
    }
    renderArticles();
  }, 180);
}

async function newPiece() {
  closeAll();
  const a = article();
  if (a && !a.title.trim() && !a.body.trim()) { el.title.focus(); return; }
  if (!snap.writable) return;
  const id = await op('newArticle');
  if (id) { createdHere.add(id); switchTo(id); }
}

// ---------- Momentum (goal line, chip, celebration) ----------
const MILESTONES = { 3: 'Three days running', 7: 'One full week', 14: 'Two weeks strong', 21: 'Three weeks', 30: 'A whole month', 50: 'Fifty days', 75: 'Seventy-five days', 100: 'One hundred days', 150: '150 days', 200: '200 days', 365: 'A full year' };
const CHEERS = ['Goal met. Keep the fire going.', 'That’s the work. Today counts.', 'Done for today. Tomorrow, again.', 'Another day on the chain.', 'Words on the page. Well done.'];

function updateMomentum({ initial = false } = {}) {
  const a = acc();
  const today = A.wordsOn(a), goal = a.dailyGoal;
  const p = goal > 0 ? Math.min(1, today / goal) : 1;
  const met = goal > 0 && today >= goal;
  const st = A.streak(a);

  el.goalFill.style.transform = `scaleX(${initial ? 0 : p})`;
  if (initial) requestAnimationFrame(() => requestAnimationFrame(() => { el.goalFill.style.transform = `scaleX(${p})`; }));
  el.goal.classList.toggle('met', met);
  // Quarter marks get a little shimmer.
  if (!initial && Math.floor(p * 4) > Math.floor(prevProgress * 4) && p < 1) {
    el.goal.classList.remove('pulse'); void el.goal.offsetWidth; el.goal.classList.add('pulse');
  }
  prevProgress = p;

  el.chipRing.style.strokeDashoffset = String(100 - p * 100);
  tween(el.chipToday, today);
  el.chipGoal.textContent = goal.toLocaleString();
  el.chipStreak.textContent = st;
  el.chipEmber.classList.toggle('lit', met);
  el.chipEmber.classList.toggle('at-risk', !met && st > 0);
  el.chipEmber.style.setProperty('--heat', Math.min(1, st / 30));

  if (prevMet === false && met) celebrate(st);
  prevMet = met;
  if ($('#overlay-momentum').classList.contains('open')) renderMomentum(false);
}

function celebrate(st) {
  const milestone = MILESTONES[st];
  odometer($('#c-streak'), st, Math.max(0, st - 1));
  $('#c-label').textContent = st === 1 ? 'day one' : 'day streak';
  $('#c-sub').textContent = milestone || CHEERS[st % CHEERS.length];
  const c = $('#celebrate');
  c.classList.remove('go'); void c.offsetWidth; c.classList.add('go');
  el.body.classList.add('celebrating');
  // The page starts returning as the stage leaves (see the timeline in styles.css).
  setTimeout(() => { el.body.classList.add('returning'); el.body.classList.remove('celebrating'); }, 3000);
  setTimeout(() => { el.body.classList.remove('returning'); c.classList.remove('go'); }, 4400);
  // bring the chip back so the embers have somewhere to land
  setTimeout(() => el.body.classList.remove('writing'), 1300);
  const target = () => center(el.chipEmber);
  // Embers burst from the drawn ring itself (radius 194 px) and partly fly home to the streak chip.
  field.celebrate({ x: innerWidth / 2, y: innerHeight * 0.48, radius: 194, count: milestone ? 320 : 220, target, gold: !!milestone });
}
field.onArrive = () => {
  el.chipEmber.classList.remove('bump'); void el.chipEmber.offsetWidth; el.chipEmber.classList.add('bump');
};

function renderMomentum(intro) {
  const a = acc();
  const today = A.wordsOn(a), goal = a.dailyGoal, st = A.streak(a), met = goal > 0 && today >= goal;
  const t = A.totals(a);
  if (intro) {
    // show 0 while the sheet fades in, then roll up to the streak
    odometer($('#hero-streak'), 0);
    clearTimeout(renderMomentum.roll);
    renderMomentum.roll = setTimeout(() => odometer($('#hero-streak'), st, 0), 260);
  } else if ($('#hero-streak').dataset.v !== String(st)) odometer($('#hero-streak'), st);
  $('#hero-streak').dataset.v = st;
  $('#hero-label').textContent = st === 1 ? 'day streak' : 'day streak';
  flame.set(st, met);
  const left = Math.max(0, goal - today);
  $('#nudge').textContent = met
    ? (st > 1 ? `Goal met. ${st} days and counting.` : 'Goal met. That’s day one.')
    : st > 0 ? `${plural(left, 'more word')} keeps your ${st}-day streak alive.`
    : today > 0 ? `${plural(left, 'more word')} to start a streak.` : `Write ${goal.toLocaleString()} words to start a streak.`;
  const ring = $('#big-ring');
  const p = goal > 0 ? Math.min(1, today / goal) : 1;
  if (intro) { ring.style.transition = 'none'; ring.style.strokeDashoffset = '100'; void ring.getBoundingClientRect(); ring.style.transition = ''; }
  requestAnimationFrame(() => { ring.style.strokeDashoffset = String(100 - p * 100); });
  tween($('#big-today'), today);
  $('#big-goal').textContent = goal.toLocaleString();
  $('#goal-val').textContent = goal.toLocaleString();
  $('#best-streak').textContent = A.bestStreak(a);
  let week = 0;
  for (let i = 0; i < 7; i++) week += t[A.dayKey(A.addDays(new Date(), -i))] || 0;
  tween($('#week-words'), week);
  tween($('#all-words'), Object.values(t).reduce((x, y) => x + y, 0));
  if (intro) renderHeat(t, goal, st, met);
}

function renderHeat(t, goal, st, met) {
  const heat = $('#heat');
  heat.classList.remove('in');
  heat.innerHTML = '';
  const today = new Date();
  const weeks = 20;
  const dow = (today.getDay() + 6) % 7; // Monday = 0
  const start = A.addDays(today, -(7 * (weeks - 1) + dow));
  const streakStart = A.addDays(today, met ? -(st - 1) : -st);
  let col = 0, s = 0;
  for (let i = 0; i < weeks * 7; i++) {
    const d = A.addDays(start, i);
    const cell = document.createElement('i');
    const k = A.dayKey(d), w = t[k] || 0;
    if (d > today) cell.style.visibility = 'hidden';
    else {
      const r = goal > 0 ? w / goal : 0;
      if (r >= 1) cell.className = 'met';
      else if (r >= 0.6) cell.className = 'lv3';
      else if (r >= 0.3) cell.className = 'lv2';
      else if (w > 0) cell.className = 'lv1';
      if (k === A.dayKey(today)) cell.classList.add('today');
      if (st > 0 && d >= streakStart && r >= 1) { cell.classList.add('wave'); cell.style.setProperty('--s', s++); }
      cell.dataset.tip = `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${plural(w, 'word')}`;
    }
    col = Math.floor(i / 7);
    cell.style.setProperty('--d', col * 3 + (i % 7));
    heat.append(cell);
  }
  requestAnimationFrame(() => heat.classList.add('in'));
}
$('#heat').addEventListener('mousemove', (e) => {
  const tip = $('#heat-tip');
  const c = e.target.closest('i');
  if (!c || !c.dataset.tip) { tip.style.opacity = 0; return; }
  const wr = $('.heat-wrap').getBoundingClientRect(), r = c.getBoundingClientRect();
  tip.textContent = c.dataset.tip;
  tip.style.left = `${r.left - wr.left + r.width / 2}px`;
  tip.style.top = `${r.top - wr.top}px`;
  tip.style.opacity = 1;
});
$('#heat').addEventListener('mouseleave', () => { $('#heat-tip').style.opacity = 0; });
$('#goal-minus').addEventListener('click', () => op('setGoal', Math.max(50, acc().dailyGoal - 50)));
$('#goal-plus').addEventListener('click', () => op('setGoal', acc().dailyGoal + 50));

// ---------- Articles drawer ----------
function renderArticles() {
  if (!el.drawerA.classList.contains('open')) return;
  const q = el.filter.value.trim().toLowerCase();
  const items = [...snap.state.articles].sort((a, b) => b.updated - a.updated)
    .filter((a) => !q || a.title.toLowerCase().includes(q) || a.body.toLowerCase().includes(q));
  const prev = new Set([...el.list.children].map((li) => li.dataset.id));
  el.list.innerHTML = '';
  if (!items.length) {
    el.list.innerHTML = `<li class="empty">${q ? 'Nothing matches.' : 'Nothing here yet. The page is yours.'}</li>`;
    return;
  }
  items.forEach((a, i) => {
    const li = document.createElement('li');
    li.dataset.id = a.id;
    if (a.id === currentId) li.classList.add('active');
    if (!prev.has(a.id)) { li.classList.add('enter'); li.style.animationDelay = `${Math.min(i, 12) * 28}ms`; }
    const title = document.createElement('div');
    title.className = 'a-title' + (a.title.trim() ? '' : ' untitled');
    title.textContent = a.title.trim() || 'Untitled';
    const snip = document.createElement('div');
    snip.className = 'a-snip';
    snip.textContent = a.body.trim().slice(0, 220) || ' ';
    const meta = document.createElement('div');
    meta.className = 'a-meta';
    meta.textContent = `${relDay(a.updated)} · ${plural(A.wordCount(a.body), 'word')}`;
    const del = document.createElement('button');
    del.className = 'icon small del';
    del.title = 'Delete';
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm'); del.textContent = 'Delete?';
        setTimeout(() => { if (del.isConnected) { del.classList.remove('confirm'); del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>'; } }, 3000);
        return;
      }
      li.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-24px)' }], { duration: 260, easing: 'ease-in', fill: 'forwards' });
      setTimeout(async () => {
        await op('deleteArticle', a.id);
        if (a.id === currentId) {
          const next = [...snap.state.articles].sort((x, y) => y.updated - x.updated)[0];
          currentId = null;
          if (next) switchTo(next.id, { focus: false }); else { fillEditor(); renderArticles(); }
        } else renderArticles();
      }, 240);
    });
    li.append(title, snip, meta, del);
    li.addEventListener('click', () => { closeAll(); if (a.id !== currentId) switchTo(a.id); });
    el.list.append(li);
  });
}
el.filter.addEventListener('input', renderArticles);

// ---------- Ideas drawer ----------
function ideaLi(i, fresh) {
  const li = document.createElement('li');
  li.dataset.id = i.id;
  if (i.done) li.classList.add('done');
  if (fresh) li.classList.add('fresh');
  const chk = document.createElement('button');
  chk.className = 'check';
  chk.setAttribute('aria-label', i.done ? 'Mark not done' : 'Mark done');
  chk.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  chk.addEventListener('click', () => {
    li.classList.toggle('done');
    if (!i.done) field.puff({ ...center(chk), count: 18, spread: 60 });
    // Let the check draw, then fold the row away before the list re-renders (no jump).
    setTimeout(() => {
      li.animate([{ height: `${li.offsetHeight}px`, opacity: 1 }, { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px' }],
        { duration: 340, easing: 'cubic-bezier(.32,.72,0,1)', fill: 'forwards' });
    }, 420);
    setTimeout(async () => { await op('toggleIdea', i.id); renderIdeas(); }, 780);
  });
  const body = document.createElement('div');
  const text = document.createElement('div'); text.className = 'i-text'; text.textContent = i.text;
  const meta = document.createElement('div'); meta.className = 'i-meta';
  meta.textContent = `${i.source === 'added in app' ? 'Added here' : i.source} · ${relDay(i.added)}`;
  body.append(text, meta);
  li.append(chk, body);
  return li;
}

function renderIdeas() {
  const open = snap.state.ideas.filter((i) => !i.done).sort((a, b) => b.added - a.added);
  const done = snap.state.ideas.filter((i) => i.done).sort((a, b) => (b.updated ?? b.added) - (a.updated ?? a.added));
  const unseen = open.filter((i) => !seen.has(i.id));
  el.badge.hidden = unseen.length === 0;
  if (!el.drawerP.classList.contains('open')) return;
  el.ideas.innerHTML = '';
  if (!open.length) el.ideas.innerHTML = '<li class="empty">No open prompts. When Elon drops a file in the inbox, it lands here.</li>';
  open.forEach((i) => el.ideas.append(ideaLi(i, !seen.has(i.id))));
  el.ideasDone.innerHTML = '';
  done.forEach((i) => el.ideasDone.append(ideaLi(i, false)));
  el.doneWrap.hidden = done.length === 0;
  el.doneCount.textContent = done.length ? `· ${done.length}` : '';
}
function markIdeasSeen() {
  for (const i of snap.state.ideas) seen.add(i.id);
  store.set('seenIdeas', [...seen].slice(-2000));
  el.badge.hidden = true;
}
el.ideaInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter' || !el.ideaInput.value.trim()) return;
  const id = await op('addIdea', el.ideaInput.value);
  if (id) seen.add(id);
  el.ideaInput.value = '';
  renderIdeas();
});
$('#btn-inbox').addEventListener('click', async () => {
  const r = await desk.checkInbox();
  if (!r.added && !r.errors.length) toast('Inbox checked. Nothing new.');
});

// ---------- Covers ----------
let coverVariant = 0;
function coverSource() {
  const a = article();
  return a && (a.title.trim() || a.body.trim()) ? a : null;
}
function renderCovers(animate) {
  const grid = $('#cover-grid');
  const a = coverSource();
  if (!a) {
    grid.innerHTML = '<div class="covers-empty">Write a little first. Covers are drawn from your words.</div>';
    $('#btn-shuffle').hidden = true;
    return;
  }
  $('#btn-shuffle').hidden = false;
  $('#covers-caption').textContent = `Drawn from the words in “${a.title.trim() || 'Untitled'}”. 5:2, no text.`;
  const seed = seedFrom(a.title, a.body);
  if (animate || grid.children.length !== STYLES.length) {
    grid.innerHTML = '';
    STYLES.forEach((name, i) => {
      const card = document.createElement('div');
      card.className = 'cover';
      card.style.setProperty('--i', i);
      card.append(renderCover(seed, i, coverVariant, 1200));
      const label = document.createElement('span'); label.className = 'name'; label.textContent = name;
      const btn = document.createElement('button'); btn.className = 'export'; btn.textContent = 'Export PNG';
      btn.addEventListener('click', (e) => { e.stopPropagation(); exportCover(i); });
      card.addEventListener('click', () => openLightbox(i));
      card.append(label, btn);
      grid.append(card);
      requestAnimationFrame(() => card.classList.add('in'));
    });
  } else {
    // Crossfade: the new cover blurs in on top of the old one, then the old one is dropped.
    [...grid.children].forEach((card, i) => {
      setTimeout(() => {
        card.querySelectorAll('canvas.incoming').forEach((c) => c.remove());
        const next = renderCover(seed, i, coverVariant, 1200);
        next.className = 'incoming';
        card.querySelector('canvas').after(next);
        requestAnimationFrame(() => requestAnimationFrame(() => next.classList.add('shown')));
        setTimeout(() => {
          if (!next.isConnected) return;
          [...card.querySelectorAll('canvas')].filter((c) => c !== next).forEach((c) => c.remove());
          next.className = '';
        }, 700);
      }, i * 50);
    });
  }
}
$('#btn-shuffle').addEventListener('click', () => { coverVariant++; renderCovers(false); });

async function exportCover(style) {
  const a = coverSource();
  if (!a) return;
  const canvas = renderCover(seedFrom(a.title, a.body), style, coverVariant, EXPORT_W);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const name = `${(a.title.trim() || 'cover').slice(0, 40)} – ${STYLES[style]}`;
  const saved = await desk.exportCover(bytes, name);
  if (saved) toast(`Saved ${saved.split('/').pop()}`);
  return saved;
}
let lbStyle = 0;
function openLightbox(style) {
  const a = coverSource();
  if (!a) return;
  lbStyle = style;
  const src = renderCover(seedFrom(a.title, a.body), style, coverVariant, 2400);
  const c = $('#lightbox-canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  $('#lb-name').textContent = STYLES[style];
  $('#lightbox').classList.add('open');
}
$('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') $('#lightbox').classList.remove('open'); });
$('#lb-export').addEventListener('click', () => exportCover(lbStyle));

// ---------- Sync ----------
function renderSync(s) {
  if (!s) return;
  snap.sync = s;
  for (const d of [el.syncDot, el.syncDot2]) d.className = `sync-dot ${s.status}`;
  el.syncMsg.textContent = s.message;
  $('#btn-sync').title = s.message;
  const on = s.config.enabled;
  $('#sync-off').hidden = !on;
  $('#sync-now').hidden = !on;
  $('#sync-on').textContent = on ? 'Save' : 'Turn on';
}
$('#sync-on').addEventListener('click', async () => {
  const r = await desk.setSync({ serverURL: el.syncUrl.value, enabled: true });
  if (!r.ok) { el.syncMsg.textContent = r.error; el.syncDot2.className = 'sync-dot error'; } else renderSync(r.sync);
});
$('#sync-off').addEventListener('click', async () => { const r = await desk.setSync({ serverURL: el.syncUrl.value, enabled: false }); if (r.ok) renderSync(r.sync); });
$('#sync-now').addEventListener('click', async () => renderSync(await desk.syncNow()));

// ---------- Drawers & overlays ----------
function openDrawer(which) {
  const d = which === 'articles' ? el.drawerA : el.drawerP;
  const other = which === 'articles' ? el.drawerP : el.drawerA;
  closeOverlays();
  other.classList.remove('open');
  const opening = !d.classList.contains('open');
  d.classList.toggle('open', opening);
  el.body.classList.toggle('drawer-open', opening);
  el.body.classList.remove('writing');
  if (!opening) return;
  if (which === 'articles') { el.list.innerHTML = ''; renderArticles(); }
  else { renderIdeas(); setTimeout(markIdeasSeen, 2500); }
}
function closeDrawers() {
  el.drawerA.classList.remove('open'); el.drawerP.classList.remove('open');
  el.body.classList.remove('drawer-open');
}
function openOverlay(id) {
  closeDrawers();
  const o = $(`#overlay-${id}`);
  const opening = !o.classList.contains('open');
  closeOverlays();
  if (!opening) return;
  o.classList.add('open');
  el.body.classList.remove('writing');
  if (id === 'momentum') { renderMomentum(true); flame.start(); }
  if (id === 'covers') renderCovers(true);
  if (id === 'sync') {
    el.syncUrl.value = snap.sync.config.serverURL || 'http://my-mac:8765';
    renderSync(snap.sync);
    setTimeout(() => el.syncUrl.focus(), 50);
  }
}
function closeOverlays() {
  const momentumWasOpen = $('#overlay-momentum').classList.contains('open');
  document.querySelectorAll('.overlay.open').forEach((o) => o.classList.remove('open'));
  $('#lightbox').classList.remove('open');
  if (momentumWasOpen) {
    // keep the flame alive while the sheet fades, then stop it and the heat-map shimmer
    setTimeout(() => { if (!$('#overlay-momentum').classList.contains('open')) { flame.stop(); $('#heat').classList.remove('in'); } }, 500);
  }
}
function closeAll() { closeDrawers(); closeOverlays(); }
const anyOpen = () => document.querySelector('.overlay.open, .drawer.open, #lightbox.open');

document.querySelectorAll('.overlay').forEach((o) => o.addEventListener('mousedown', (e) => { if (e.target === o) closeOverlays(); }));
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeOverlays));
document.querySelectorAll('[data-reveal]').forEach((b) => b.addEventListener('click', () => desk.reveal(b.dataset.reveal)));
$('#scrim').addEventListener('click', closeDrawers);
$('#btn-articles').addEventListener('click', () => openDrawer('articles'));
$('#btn-prompts').addEventListener('click', () => openDrawer('prompts'));
$('#btn-new').addEventListener('click', newPiece);
$('#btn-new-2').addEventListener('click', newPiece);
$('#btn-covers').addEventListener('click', () => openOverlay('covers'));
$('#btn-sync').addEventListener('click', () => openOverlay('sync'));
$('#momentum-chip').addEventListener('click', () => openOverlay('momentum'));

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('#lightbox').classList.contains('open')) $('#lightbox').classList.remove('open');
    else if (anyOpen()) closeAll();
    else el.body.classList.remove('writing');
  }
});

// Peek: rest the pointer on the left edge to reveal your writing.
let edgeTimer = null;
addEventListener('mousemove', (e) => {
  if (e.clientX <= 3 && !anyOpen()) { if (!edgeTimer) edgeTimer = setTimeout(() => openDrawer('articles'), 280); }
  else { clearTimeout(edgeTimer); edgeTimer = null; }
});

desk.onCommand((c) => {
  ({ new: newPiece, articles: () => openDrawer('articles'), prompts: () => openDrawer('prompts'),
     covers: () => openOverlay('covers'), momentum: () => openOverlay('momentum'), sync: () => openOverlay('sync'),
     focus: () => { closeAll(); el.body.classList.toggle('writing'); el.text.focus(); } }[c] || (() => {}))();
});

// ---------- State from main (sync, inbox) ----------
function afterChange() {
  updateMomentum();
  renderArticles();
  renderIdeas();
}

let refreshTimer = null;
function refreshEditorWhenIdle() {
  clearTimeout(refreshTimer);
  const idle = Date.now() - lastInput;
  if (idle < 1500) { refreshTimer = setTimeout(refreshEditorWhenIdle, 1600 - idle); return; }
  queue.then(async () => {
    snap = await desk.init();
    const a = article();
    if (!a && currentId) {
      const next = [...snap.state.articles].sort((x, y) => y.updated - x.updated)[0];
      currentId = null;
      if (next) switchTo(next.id, { focus: false }); else fillEditor();
      return;
    }
    if (a && (a.body !== el.text.value || a.title !== el.title.value)) {
      const pos = el.text.selectionStart;
      el.title.value = a.title; el.text.value = a.body;
      autosize(el.title); autosize(el.text); updatePieceMeta();
      el.text.setSelectionRange(Math.min(pos, a.body.length), Math.min(pos, a.body.length));
    }
  });
}

desk.onState((s) => { snap = s; afterChange(); refreshEditorWhenIdle(); });
desk.onSync((s) => renderSync(s));
desk.onToast((t) => toast(t.text, t.kind));
desk.onInbox((r) => {
  if (r.added) {
    toast(`${plural(r.added, 'new prompt')} from Elon`);
    field.puff({ ...center($('#btn-prompts')), count: 30 });
    renderIdeas();
  }
  if (r.errors?.length) toast(`Inbox: ${r.errors[0]}`, 'error');
});

addEventListener('blur', () => el.body.classList.add('blurred'));
addEventListener('focus', () => el.body.classList.remove('blurred'));

// Day rollover and relative times.
setInterval(() => { if (snap) updateMomentum(); }, 60000);

// ---------- Boot ----------
async function boot() {
  snap = await desk.init();
  if (!snap.writable) {
    el.body.classList.add('readonly');
    $('#readonly').hidden = false;
    $('#readonly-msg').textContent = snap.loadError;
    el.title.readOnly = el.text.readOnly = true;
  }
  const saved = store.get('current', null);
  const byRecent = [...snap.state.articles].sort((a, b) => b.updated - a.updated);
  currentId = article(saved) ? saved : byRecent[0]?.id ?? null;
  fillEditor();
  const a = A.wordsOn(acc());
  prevMet = acc().dailyGoal > 0 && a >= acc().dailyGoal;
  updateMomentum({ initial: true });
  renderIdeas();
  renderSync(snap.sync);
  requestAnimationFrame(() => {
    el.body.classList.remove('booting');
    setTimeout(() => {
      const target = article() && !article().title ? el.title : el.text;
      target.focus();
      if (target === el.text) { el.text.setSelectionRange(el.text.value.length, el.text.value.length); }
    }, 300);
  });
}
boot();

// Exposed for the end-to-end test.
window.__desk = { celebrate, openOverlay, closeAll, switchTo, get snap() { return snap; }, get currentId() { return currentId; }, seedFrom, renderCover, exportCover, op };
