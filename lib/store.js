'use strict';
// Key-value storage for JSON documents. Keys look like "settings" or "users/alice".
// The app core (lib/app.js) only uses this interface, so the same code runs on the
// Pi (JSON files in DATA_DIR) and on Netlify (Blobs, netlify/blob-store.mjs):
//
//   get(key) -> value | null      set(key, value)      del(key)      list(prefix) -> [keys]
//
// Values are treated as immutable: callers replace documents, never edit them in place.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// In-memory store, for tests.
function memoryStore() {
  const m = new Map();
  return {
    async get(key) { return m.has(key) ? m.get(key) : null; },
    async set(key, value) { m.set(key, value); },
    async del(key) { m.delete(key); },
    async list(prefix) { return [...m.keys()].filter((k) => k.startsWith(prefix)); },
  };
}

// Atomic JSON files, one per key ("users/alice" -> DATA_DIR/users/alice.json).
// The Pi runs a single process, so every document is also kept in memory after its
// first read: requests never touch the disk unless something changed.
const KEY_RE = /^[a-z]+(\/[\w.-]+)?$/;
function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const mem = new Map();
  const file = (key) => {
    if (!KEY_RE.test(key)) throw new Error(`bad store key: ${key}`);
    return path.join(dir, key + '.json');
  };
  return {
    async get(key) {
      if (mem.has(key)) return mem.get(key);
      let v = null;
      try { v = JSON.parse(await fsp.readFile(file(key), 'utf8')); } catch { /* missing or corrupt */ }
      mem.set(key, v);
      return v;
    },
    async set(key, value) {
      const f = file(key);
      await fsp.mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(value));
      await fsp.rename(tmp, f);
      mem.set(key, value);
    },
    async del(key) {
      await fsp.rm(file(key), { force: true });
      mem.set(key, null);
    },
    async list(prefix) {
      const sub = prefix.replace(/\/$/, '');
      try {
        return (await fsp.readdir(path.join(dir, sub)))
          .filter((f) => f.endsWith('.json'))
          .map((f) => `${sub}/${f.slice(0, -5)}`);
      } catch { return []; }
    },
  };
}

module.exports = { memoryStore, fileStore };
