// canonicalSnapshot.js — FOR REVIEW ONLY. NOT EXECUTED.
//
// Codex Step 3C-8 THIRD repair round hardening:
//   - undefined is REJECTED (thrown), never collapsed into null.
//   - null, and every other JS/Firestore value kind, is wrapped in an explicit
//     {__canonKind, payload} tag — INCLUDING plain maps and arrays — so a real user-
//     authored map can never collide with a special type's tag: colliding would require
//     matching the FULL nested double-wrapped shape at every level, which a plain map's
//     own recursive canonicalization structurally cannot produce (see canonicalizeValue).
//   - NaN, +Infinity, -Infinity, and -0 are each tagged distinctly (plain JSON.stringify
//     silently collapses all of these to indistinguishable/wrong values: NaN and Infinity
//     both become the string "null", and -0 stringifies identical to 0 — both are genuine
//     information-loss bugs the prior round's canonicalizer did not guard against).
//   - VectorValue is explicitly REJECTED (thrown) — not expected in any reminder/delivery
//     document in this schema; encountering one is treated as a reason to fail loudly
//     rather than silently mis-canonicalize.
//
// The canonical content, every document path, and every digest are used ONLY to compute a
// SHA-256 digest; none of it is ever printed, logged, or returned to a caller that might
// print it. Only the document COUNT and a final digest-equality BOOLEAN are ever surfaced.
'use strict';

const { createHash } = require('node:crypto');
const {
  Timestamp,
  GeoPoint,
  DocumentReference,
} = require('C:/Users/adamb/neuroactive/functions/node_modules/firebase-admin/lib/firestore/index.js');
// firebase-admin's own Firestore re-export does NOT include VectorValue (confirmed by
// direct require — it resolves to `undefined` there), even though it exists on the
// underlying @google-cloud/firestore package it wraps. Imported from the correct source so
// the VectorValue-rejection check below can actually fire instead of silently no-op'ing.
const { VectorValue } = require('C:/Users/adamb/neuroactive/functions/node_modules/@google-cloud/firestore');

function tag(kind, payload) {
  return { __canonKind: kind, payload };
}

function canonicalizeValue(value) {
  if (value === undefined) {
    // Codex Step 3C-8 round 3, item 6: never collapse to null. A real Firestore
    // DocumentSnapshot.data() should never contain undefined at all (the Admin SDK either
    // rejects it at write time or omits the field entirely, depending on
    // ignoreUndefinedProperties) — encountering one here means either a genuine anomaly in
    // the live data or a bug in the calling code, and either way must fail loudly rather
    // than be silently treated as equivalent to an explicit null.
    throw new Error('canonicalSnapshot: undefined field value encountered — refusing to silently canonicalize as null');
  }
  if (value === null) return tag('null', null);
  if (typeof value === 'boolean') return tag('boolean', value);
  if (typeof value === 'string') return tag('string', value);
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return tag('number-nan', null);
    if (value === Infinity) return tag('number-posinf', null);
    if (value === -Infinity) return tag('number-neginf', null);
    if (Object.is(value, -0)) return tag('number-negzero', null);
    return tag('number', value); // finite ordinary number, including +0 — safe for JSON.stringify
  }
  if (value instanceof Timestamp) return tag('Timestamp', { s: value.seconds, n: value.nanoseconds });
  if (value instanceof GeoPoint) return tag('GeoPoint', { lat: value.latitude, lon: value.longitude });
  if (value instanceof DocumentReference) return tag('DocumentReference', { path: value.path });
  if (VectorValue && value instanceof VectorValue) {
    throw new Error('canonicalSnapshot: VectorValue field encountered — explicitly rejected, not expected in reminder/delivery documents');
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return tag('Bytes', { b64: Buffer.from(value).toString('base64') });
  }
  if (Array.isArray(value)) {
    // Order preserved — array element order is semantically meaningful (e.g. attemptHistory).
    return tag('array', value.map(canonicalizeValue));
  }
  if (typeof value === 'object') {
    const sortedKeys = Object.keys(value).sort();
    const out = {};
    for (const k of sortedKeys) out[k] = canonicalizeValue(value[k]); // throws on nested undefined too
    return tag('map', out);
  }
  throw new Error(`canonicalSnapshot: unrecognized field value type "${typeof value}"`);
}

function canonicalizeDoc(queryDocumentSnapshot) {
  return {
    path: queryDocumentSnapshot.ref.path,
    updateTime: queryDocumentSnapshot.updateTime
      ? { s: queryDocumentSnapshot.updateTime.seconds, n: queryDocumentSnapshot.updateTime.nanoseconds }
      : null,
    data: canonicalizeValue(queryDocumentSnapshot.data()),
  };
}

function digestSnapshot(docs) {
  const entries = docs.map(canonicalizeDoc);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const serialized = JSON.stringify(entries);
  const digestHex = createHash('sha256').update(serialized).digest('hex');
  return { count: entries.length, digestHex };
}

// Codex Step 3C-8 round 3, item 7: reminders scoped to the exact canonical top-level
// collection (never collectionGroup — there is exactly one reminders collection in this
// schema, at a fixed path, so a plain .collection() query is both correct and narrower).
// deliveries remain a genuine collection GROUP (a subcollection under every reminder doc —
// enumerating them without first knowing every reminderId requires collectionGroup), but
// every returned document's path is verified against the exact canonical hierarchy shape
// before being accepted into the digest — anything outside that shape is rejected (fails
// closed) rather than silently treated as canonical.
const CANONICAL_DELIVERY_PATH_PATTERN = /^artifacts\/neuroactive-prod\/reminders\/[^/]+\/deliveries\/[^/]+$/;

async function captureStrongCensus(db) {
  const [remindersSnap, deliveriesSnap] = await Promise.all([
    db.collection('artifacts/neuroactive-prod/reminders').get(),
    db.collectionGroup('deliveries').get(),
  ]);

  const deliveryDocs = deliveriesSnap.docs;
  for (const d of deliveryDocs) {
    if (!CANONICAL_DELIVERY_PATH_PATTERN.test(d.ref.path)) {
      throw new Error('canonicalSnapshot: a delivery document outside the canonical NeuroActive hierarchy was encountered — refusing to treat it as canonical');
    }
  }

  return {
    reminders: digestSnapshot(remindersSnap.docs),
    deliveries: digestSnapshot(deliveryDocs),
  };
}

function censusUnchanged(before, after) {
  return (
    before.deliveries.count === after.deliveries.count &&
    before.deliveries.digestHex === after.deliveries.digestHex &&
    before.reminders.count === after.reminders.count &&
    before.reminders.digestHex === after.reminders.digestHex
  );
}

module.exports = { captureStrongCensus, censusUnchanged, canonicalizeValue };
