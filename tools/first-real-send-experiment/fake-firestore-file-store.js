// fake-firestore-file-store.js — TEST INFRASTRUCTURE ONLY. NOT a production file, never
// referenced by activation-controller.js/activation-watchdog.js's real production code
// paths. A minimal JSON-file-backed Firestore substitute so a REAL, separately-spawned OS
// child process (the watchdog under test) and the parent test process can share the same
// "production" state without either ever touching real GCP. Not truly atomic across
// concurrent processes (no file locking) — tests using this coordinate timing explicitly
// rather than relying on real concurrency guarantees, which is adequate for exercising
// orchestration logic, not a claim about real Firestore's own consistency model.
'use strict';

const fs = require('node:fs');

function readStore(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeStoreAtomic(filePath, store) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, filePath);
}

class FileDocRef {
  constructor(filePath, docPath) {
    this.filePath = filePath;
    this.path = docPath;
  }
  async get() {
    const store = readStore(this.filePath);
    const exists = Object.prototype.hasOwnProperty.call(store, this.path);
    return { exists, ref: this, data: () => (exists ? JSON.parse(JSON.stringify(store[this.path])) : undefined) };
  }
}

function makeFileBackedDb(filePath) {
  return {
    doc(p) {
      return new FileDocRef(filePath, p);
    },
    collection(prefix) {
      return {
        async get() {
          const store = readStore(filePath);
          const docs = [];
          for (const p of Object.keys(store)) {
            if (p.startsWith(prefix + '/') && p.slice(prefix.length + 1).split('/').length === 1) {
              docs.push({ ref: { path: p }, data: () => JSON.parse(JSON.stringify(store[p])) });
            }
          }
          return { docs };
        },
      };
    },
    collectionGroup(name) {
      return {
        async get() {
          const store = readStore(filePath);
          const docs = [];
          for (const p of Object.keys(store)) {
            const segs = p.split('/');
            if (segs[segs.length - 2] === name) docs.push({ ref: { path: p }, data: () => JSON.parse(JSON.stringify(store[p])) });
          }
          return { docs };
        },
      };
    },
    async runTransaction(cb) {
      const store = readStore(filePath);
      const tx = {
        async get(ref) {
          const exists = Object.prototype.hasOwnProperty.call(store, ref.path);
          return { exists, data: () => (exists ? JSON.parse(JSON.stringify(store[ref.path])) : undefined) };
        },
        set(ref, data) {
          store[ref.path] = JSON.parse(JSON.stringify(data));
        },
        update(ref, data) {
          if (!Object.prototype.hasOwnProperty.call(store, ref.path)) throw new Error('FileBackedTransaction.update: missing doc ' + ref.path);
          store[ref.path] = { ...store[ref.path], ...data };
        },
      };
      const result = await cb(tx);
      writeStoreAtomic(filePath, store);
      return result;
    },
  };
}

module.exports = { makeFileBackedDb, readStore, writeStoreAtomic };
