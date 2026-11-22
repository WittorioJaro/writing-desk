#!/usr/bin/env node
// Stand-in for the Codex CLI in tests: records what it was sent, then answers with three SVG covers.
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1];
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, prompt }) + '\n');
  if (process.env.FAKE_CODEX_FAIL) { process.stderr.write('ERROR: pretend failure\n'); process.exit(1); }
  const svg = (bg, fg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1500 600"><rect width="1500" height="600" fill="${bg}"/><circle cx="750" cy="300" r="180" fill="${fg}"/><text x="10" y="50">NO TEXT ALLOWED</text><script>alert(1)</script></svg>`;
  setTimeout(() => {
    fs.writeFileSync(out, JSON.stringify({ covers: [
      { name: 'Ember', idea: 'one', svg: svg('#1b1424', '#ff7a3d') },
      { name: 'Tide', idea: 'two', svg: svg('#0e1626', '#4df0c9') },
      { name: 'Paper', idea: 'three', svg: svg('#f3eee4', '#e2412e') },
    ] }));
    process.exit(0);
  }, Number(process.env.FAKE_CODEX_DELAY || 300));
});
