'use strict';
// Elon's ideas inbox: plain .txt / .md files dropped into `inbox/`, one idea per line.
// Leading bullets (-, *, •, 1.) are stripped; lines starting with # are ignored; case-insensitive
// duplicates are skipped. A file is moved to `inbox/imported/` only *after* its ideas were saved.

const fs = require('node:fs');
const path = require('node:path');
const { newId } = require('./model');

function parse(text) {
  const out = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/^([-*•]|\d+[.)])\s+/u, '').trim();
    if (line) out.push(line);
  }
  return out;
}

/**
 * read -> add ideas -> persist -> archive, one file at a time.
 * A failed read or save leaves the file in the inbox; a failed save stops the import and rolls that
 * file's ideas back. Retrying is idempotent (duplicates are skipped).
 */
function importInbox(store, state, persist, now) {
  const result = { added: 0, archived: [], errors: [], addedIds: [] };
  let files;
  try {
    files = fs.readdirSync(store.inboxDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(txt|md)$/i.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch (e) {
    result.errors.push(`Couldn't list inbox: ${e.message}`);
    return { state, result };
  }
  for (const name of files) {
    const file = path.join(store.inboxDir, name);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      result.errors.push(`${name}: couldn't read (${e.message}); left in inbox`);
      continue;
    }
    const next = structuredClone(state);
    const seen = new Set(next.ideas.map((i) => i.text.toLowerCase()));
    const ids = [];
    for (const line of parse(text)) {
      if (seen.has(line.toLowerCase())) continue;
      seen.add(line.toLowerCase());
      const id = newId();
      next.ideas.push({ id, text: line, source: name, added: now(), done: false });
      ids.push(id);
    }
    // Always save before archiving, even when every line was a duplicate (see Swift IdeasInbox).
    try { persist(next); } catch (e) {
      result.errors.push(`${name}: couldn't save ideas (${e.message}); left in inbox`);
      break;
    }
    state = next;
    result.added += ids.length;
    result.addedIds.push(...ids);
    let dest = path.join(store.importedDir, name);
    if (fs.existsSync(dest)) dest = path.join(store.importedDir, `${Math.floor(Date.now() / 1000)}-${name}`);
    try { fs.renameSync(file, dest); result.archived.push(name); } catch (e) {
      result.errors.push(`${name}: ideas saved but couldn't archive (${e.message}); a retry will skip duplicates`);
    }
  }
  return { state, result };
}

module.exports = { parse, importInbox };
