#!/usr/bin/env node
// Stand-in for the Codex CLI in tests. Records what it was sent, "generates" a 5:2 PNG into
// $CODEX_HOME/generated_images/<run>/ like Codex's image tool, and replies with its path.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; const glow = Math.max(0, 1 - Math.hypot(x - w / 2, y - h / 2) / (h * 0.6)); raw[o] = Math.min(255, r + glow * 120); raw[o + 1] = Math.min(255, g + glow * 80); raw[o + 2] = b; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1];
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, prompt }) + '\n');
  if (process.env.FAKE_CODEX_FAIL) { process.stderr.write('ERROR: pretend failure\n'); process.exit(1); }
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const dir = path.join(home, 'generated_images', `run-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `exec-${process.pid}.png`);
  const color = /Bold geometric/.test(prompt) ? [200, 60, 30] : /Atmospheric/.test(prompt) ? [20, 40, 70] : [180, 160, 130];
  setTimeout(() => {
    fs.writeFileSync(file, png(500, 200, color));
    fs.writeFileSync(out, process.env.FAKE_CODEX_REPLY || file);
    process.exit(0);
  }, Number(process.env.FAKE_CODEX_DELAY || 300));
});
