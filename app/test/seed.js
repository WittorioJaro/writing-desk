'use strict';
// Seeds a demo workspace (a 6-day streak, three pieces, Elon's prompts) for screenshots and traces.
const fs = require('node:fs');
const path = require('node:path');

module.exports = function seed(home, { covers = true } = {}) {
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
  // Real Codex-painted covers for the first piece (test/fixtures/covers), so traces show the real thing.
  if (covers) {
    const id = 'A0000000-0000-4000-8000-000000000001';
    const dir = path.join(home, 'covers', 'suggested', id);
    fs.mkdirSync(dir, { recursive: true });
    const names = ['Bold', 'Atmosphere', 'Object'];
    const list = names.map((name, i) => {
      fs.copyFileSync(path.join(__dirname, 'fixtures', 'covers', `${i + 1}.png`), path.join(dir, `seed-${i + 1}.png`));
      return { kind: 'image', file: `suggested/${id}/seed-${i + 1}.png`, name };
    });
    fs.writeFileSync(path.join(home, 'covers.json'), JSON.stringify({
      settings: { smart: true, model: 'gpt-6-luna', effort: 'low' },
      articles: { [id]: { suggestions: { status: 'ready', at: Date.now(), pending: 0, basis: { title: 'The quiet discipline of small streaks', words: 85 }, covers: list } } },
    }));
  }
};
