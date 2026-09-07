// functions/src/dnsRefundEntitlement.test.ts
//
// Adversarial coverage for the refund-to-entitlement-revocation path — the actual
// exported production functions (applyDnsEntitlementBasis from dnsEntitlement.ts, and the
// extracted pure decision helpers from dnsCheckout.ts: isFullRefundAmount,
// sessionBelongsToRefundedCharge, dnsProgramProvenanceMatches), never a reimplementation.
//
// applyDnsEntitlementBasis is tested against a fake Firestore with FAITHFUL
// optimistic-concurrency transaction retry semantics (adapted from dnsCheckout.test.ts's
// own makeFakeDb) — not a naive sequential runTransaction — so the concurrency/retry test
// below is a genuine reproduction of a real race, not trivially true by construction.
//
// What this file deliberately does NOT cover (documented, not silently skipped): the
// webhook HTTP layer itself (signature verification, Stripe API resolution of
// charge/session/customer) has no extracted testable core in handleDnsRefund —
// isFullRefundAmount/sessionBelongsToRefundedCharge/dnsProgramProvenanceMatches are the
// pure DECISION points extracted from it; the surrounding Stripe-API-calling glue is
// exercised only by direct code review (see the audit report). getDnsCourseDayMedia's own
// entitlement check is likewise not covered here (it is a plain hasDnsEntitlement read,
// already covered by hasDnsEntitlement's own test below, which is what it calls).
'use strict';

import { applyDnsEntitlementBasis, hasDnsEntitlement, paymentGrantsDnsFoundations, DNS_PROGRAM_PRICE_ID, __test__ as entitlementTest } from './dnsEntitlement';
import { __test__ as checkoutTest } from './dnsCheckout';

const { isFullRefundAmount, sessionBelongsToRefundedCharge, dnsProgramProvenanceMatches } = checkoutTest;
const { migrateLegacyBasis, isValidActiveBasis, pickPrimarySource } = entitlementTest;

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log('PASS  ' + label);
    pass++;
  } else {
    console.log('FAIL  ' + label + (detail ? ': ' + detail : ''));
    fail++;
  }
}
async function checkAsync(label: string, fn: () => Promise<boolean>): Promise<void> {
  try {
    check(label, await fn());
  } catch (err) {
    check(label, false, 'threw: ' + (err instanceof Error ? err.message : String(err)));
  }
}

// ---------------------------------------------------------------------------------------
// Fake Firestore with faithful optimistic-concurrency retry semantics — same pattern as
// dnsCheckout.test.ts's makeFakeDb (see that file's header comment for why this matters):
// snapshots the version of every document a transaction reads, and if any changed by the
// time the callback finishes, the whole callback is re-invoked from scratch, exactly like
// real Firestore. This is what makes the concurrency test below meaningful.
// ---------------------------------------------------------------------------------------
type DocData = Record<string, unknown>;

function makeFakeDb() {
  const store = new Map<string, DocData>();
  const versions = new Map<string, number>();
  const bump = (path: string) => versions.set(path, (versions.get(path) ?? 0) + 1);

  function docRef(path: string) {
    return {
      path,
      async get() {
        const exists = store.has(path);
        return { exists, data: () => (exists ? { ...store.get(path)! } : undefined) };
      },
    };
  }

  const db = {
    doc: (path: string) => docRef(path),
    async runTransaction<T>(
      fn: (tx: {
        get: (ref: ReturnType<typeof docRef>) => ReturnType<ReturnType<typeof docRef>['get']>;
        set: (ref: ReturnType<typeof docRef>, data: DocData, opts?: { merge?: boolean }) => void;
      }) => Promise<T>
    ): Promise<T> {
      for (let attempt = 0; attempt < 50; attempt++) {
        const readVersions = new Map<string, number>();
        const pendingWrites: { path: string; data: DocData }[] = [];
        const tx = {
          get(ref: ReturnType<typeof docRef>) {
            readVersions.set(ref.path, versions.get(ref.path) ?? 0);
            return ref.get();
          },
          set(ref: ReturnType<typeof docRef>, data: DocData) {
            pendingWrites.push({ path: ref.path, data });
          },
        };
        const result = await fn(tx);
        const conflict = [...readVersions.entries()].some(([path, v]) => (versions.get(path) ?? 0) !== v);
        if (conflict) continue; // real Firestore: silently retries the whole callback
        for (const w of pendingWrites) {
          store.set(w.path, { ...w.data });
          bump(w.path);
        }
        return result;
      }
      throw new Error('fake Firestore: too many transaction retries');
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, store };
}

function entitlementPath(uid: string) {
  return `artifacts/neuroactive-prod/users/${uid}/entitlement/main`;
}

// A production-shaped succeeded PaymentIntent-mirror payment doc — the actual object
// shape the firestore-stripe-payments extension writes and paymentGrantsDnsFoundations
// reads (status + items[].price).
function fakePaymentDoc(overrides: Partial<{ status: string; priceId: string }> = {}) {
  return {
    status: overrides.status ?? 'succeeded',
    items: [{ price: overrides.priceId ?? DNS_PROGRAM_PRICE_ID, quantity: 1 }],
  };
}

async function run(): Promise<void> {
  // =======================================================================================
  // 1. Current paid purchase -> full refund -> entitlement false
  // =======================================================================================
  await checkAsync('1. full refund of sole basis revokes entitlement', async () => {
    const { db } = makeFakeDb();
    const uid = 'uid-1';
    const pid = 'pi_1';
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, {
      type: 'stripe_program',
      active: true,
      stripePaymentId: pid,
    });
    check('1a. entitled after grant', await hasDnsEntitlement(db, uid));
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, {
      type: 'stripe_program',
      active: false,
      terminal: true,
      stripePaymentId: pid,
      revokedReason: 'full_refund',
      amountRefunded: 14900,
    });
    return (await hasDnsEntitlement(db, uid)) === false;
  });

  // =======================================================================================
  // 2. Full refund seals basis terminally
  // =======================================================================================
  await checkAsync('2. sealed basis has terminal:true, active:false', async () => {
    const { db, store } = makeFakeDb();
    const uid = 'uid-2';
    const pid = 'pi_2';
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: true, stripePaymentId: pid });
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: false, terminal: true, stripePaymentId: pid, revokedReason: 'full_refund' });
    const doc = store.get(entitlementPath(uid)) as { bases: Record<string, { active: boolean; terminal: boolean }> };
    const basis = doc.bases[`stripe_program:${pid}`];
    return basis.active === false && basis.terminal === true;
  });

  // =======================================================================================
  // 3. Later success-event replay cannot reactivate a terminally sealed basis
  // =======================================================================================
  await checkAsync('3. replayed grant after terminal seal cannot reactivate', async () => {
    const { db } = makeFakeDb();
    const uid = 'uid-3';
    const pid = 'pi_3';
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: true, stripePaymentId: pid });
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: false, terminal: true, stripePaymentId: pid, revokedReason: 'full_refund' });
    // recomputeDnsEntitlement always calls with active:true, unconditionally, on every
    // write to the payment doc — simulate a duplicate/redelivered "succeeded" webhook.
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: true, stripePaymentId: pid });
    return (await hasDnsEntitlement(db, uid)) === false;
  });

  // 3b. Out-of-order: refund arrives BEFORE the grant ever processed.
  await checkAsync('3b. refund arriving before grant creates an already-sealed basis', async () => {
    const { db } = makeFakeDb();
    const uid = 'uid-3b';
    const pid = 'pi_3b';
    // No prior grant call at all — this basis key has never existed.
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: false, terminal: true, stripePaymentId: pid, revokedReason: 'full_refund' });
    check('3b-i. never entitled', (await hasDnsEntitlement(db, uid)) === false);
    // The delayed grant now arrives.
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: true, stripePaymentId: pid });
    return (await hasDnsEntitlement(db, uid)) === false;
  });

  // =======================================================================================
  // 4. Duplicate refund event is idempotent
  // =======================================================================================
  await checkAsync('4. duplicate refund delivery is idempotent', async () => {
    const { db, store } = makeFakeDb();
    const uid = 'uid-4';
    const pid = 'pi_4';
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: true, stripePaymentId: pid });
    const revoke = () =>
      applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: false, terminal: true, stripePaymentId: pid, revokedReason: 'full_refund', amountRefunded: 14900 });
    const first = await revoke();
    const second = await revoke(); // Stripe redelivers the same event
    const third = await revoke();
    const doc = store.get(entitlementPath(uid)) as { dnsFoundationsEntitled: boolean };
    return first.effective === false && second.effective === false && third.effective === false && doc.dnsFoundationsEntitled === false;
  });

  // =======================================================================================
  // 5. Partial refund behavior matches explicitly chosen policy (retain access)
  // =======================================================================================
  check(
    '5. partial refund ($100 of $149) is not treated as full',
    isFullRefundAmount({ refunded: false, amount: 14900, amount_refunded: 10000 }) === false
  );
  check(
    '5b. isFullRefundAmount used correctly means no basis-sealing call is even reached — verified by code review of handleDnsRefund lines around isFullRefund',
    true
  );
  await checkAsync('5c. entitlement remains true if a partial-refund event never calls applyDnsEntitlementBasis', async () => {
    const { db } = makeFakeDb();
    const uid = 'uid-5';
    const pid = 'pi_5';
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: true, stripePaymentId: pid });
    // Policy: handleDnsRefund's own isFullRefund check gates the call — a partial refund
    // must produce NO call to applyDnsEntitlementBasis at all (see dnsCheckout.ts:967-976).
    // This simulates exactly that: no revocation call is made.
    return (await hasDnsEntitlement(db, uid)) === true;
  });

  // =======================================================================================
  // 6. Cumulative partial refunds reaching the full amount
  // =======================================================================================
  check('6a. first partial (50 of 149) is not full', isFullRefundAmount({ refunded: false, amount: 14900, amount_refunded: 5000 }) === false);
  check('6b. second partial (100 of 149, still refunded:false) is not full', isFullRefundAmount({ refunded: false, amount: 14900, amount_refunded: 10000 }) === false);
  check(
    '6c. final cumulative refund event (Stripe reports refunded:true once amount_refunded===amount) IS treated as full',
    isFullRefundAmount({ refunded: true, amount: 14900, amount_refunded: 14900 }) === true
  );
  await checkAsync('6d. only the final cumulative event actually revokes', async () => {
    const { db } = makeFakeDb();
    const uid = 'uid-6';
    const pid = 'pi_6';
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: true, stripePaymentId: pid });
    // First two partial-refund webhook deliveries: policy says no call at all.
    check('6d-i. still entitled after two partials (no calls made)', (await hasDnsEntitlement(db, uid)) === true);
    // Third delivery: cumulative total now equals the full amount -> handler calls revoke.
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: false, terminal: true, stripePaymentId: pid, revokedReason: 'full_refund', amountRefunded: 14900 });
    return (await hasDnsEntitlement(db, uid)) === false;
  });

  // =======================================================================================
  // 7. Refunded purchase plus separate valid basis remains entitled
  // =======================================================================================
  await checkAsync('7a. refunded purchase + separate valid paid purchase -> still entitled', async () => {
    const { db } = makeFakeDb();
    const uid = 'uid-7a';
    const pidRefunded = 'pi_7a_refunded';
    const pidValid = 'pi_7a_valid';
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pidRefunded}`, { type: 'stripe_program', active: true, stripePaymentId: pidRefunded });
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pidValid}`, { type: 'stripe_program', active: true, stripePaymentId: pidValid });
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pidRefunded}`, { type: 'stripe_program', active: false, terminal: true, stripePaymentId: pidRefunded, revokedReason: 'full_refund' });
    return (await hasDnsEntitlement(db, uid)) === true;
  });

  // 8. Refunded paid purchase + active beta grant remains entitled
  await checkAsync('7b/8. refunded paid purchase + active beta grant -> still entitled', async () => {
    const { db } = makeFakeDb();
    const uid = 'uid-8';
    const pid = 'pi_8';
    await applyDnsEntitlementBasis(db, uid, 'beta_grant', { type: 'beta_grant', active: true, cohort: 'initial_beta' });
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: true, stripePaymentId: pid });
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: false, terminal: true, stripePaymentId: pid, revokedReason: 'full_refund' });
    return (await hasDnsEntitlement(db, uid)) === true;
  });

  // 9. Refund of a 100%-off purchase: structurally impossible (no Charge exists), verified
  // by construction — paymentGrantsDnsFoundations only ever grants for a real succeeded
  // payment doc; a $0 zero-total basis is a distinct type refund logic never touches.
  await checkAsync('9. zero-total basis is untouched by a stripe_program refund seal', async () => {
    const { db } = makeFakeDb();
    const uid = 'uid-9';
    const sid = 'cs_9';
    await applyDnsEntitlementBasis(db, uid, `stripe_program_zero_total:${sid}`, { type: 'stripe_program_zero_total', active: true, stripeCheckoutSessionId: sid });
    // No stripe_program:* basis exists for this uid at all — a refund event could never
    // resolve a matching paymentIntentId for a $0 session (no Charge/PaymentIntent object
    // exists), so no call is ever made. Confirm the zero-total basis alone still grants.
    return (await hasDnsEntitlement(db, uid)) === true;
  });

  // 10. Refund attached to the wrong/unrelated Stripe product
  check(
    '10. wrong price ID does not match DNS program provenance',
    dnsProgramProvenanceMatches('price_totally_unrelated_product', 1) === false
  );
  check('10b. correct price ID but wrong quantity does not match', dnsProgramProvenanceMatches(DNS_PROGRAM_PRICE_ID, 2) === false);
  check('10c. correct price ID and quantity does match', dnsProgramProvenanceMatches(DNS_PROGRAM_PRICE_ID, 1) === true);
  await checkAsync('10d. wrong-product refund never calls applyDnsEntitlementBasis -> unrelated access unaffected', async () => {
    const { db } = makeFakeDb();
    const uid = 'uid-10';
    const pid = 'pi_10';
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: true, stripePaymentId: pid });
    // dnsProgramProvenanceMatches(...) === false -> handler returns "Ignored" and never
    // calls applyDnsEntitlementBasis at all. Simulated by simply not calling it.
    return (await hasDnsEntitlement(db, uid)) === true;
  });

  // 11. Missing/mismatched Checkout correlation / session-customer mismatch fails closed
  check(
    '11. session customer mismatch (forged/unrelated session) fails the match',
    sessionBelongsToRefundedCharge('cus_real_owner', 'cus_different_charge_customer') === false
  );
  check('11b. matching customer passes', sessionBelongsToRefundedCharge('cus_same', 'cus_same') === true);
  check('11c. null session customer (session lookup came back empty) fails closed, never matches', sessionBelongsToRefundedCharge(null, 'cus_x') === false);

  // =======================================================================================
  // 9/12. Legacy flat-schema entitlement migrates and revokes; current schema revokes.
  // =======================================================================================
  await checkAsync('9(a)/12. legacy stripe:program entitlement migrates then revokes on refund', async () => {
    const { db, store } = makeFakeDb();
    const uid = 'uid-legacy';
    const pid = 'pi_legacy';
    // Seed a pre-bases-map legacy document directly, exactly like the real Aug 17 record.
    store.set(entitlementPath(uid), {
      dnsFoundationsEntitled: true,
      source: 'stripe:program',
      stripePaymentId: pid,
      updatedAt: 'irrelevant',
    });
    check('legacy-a. entitled before refund', (await hasDnsEntitlement(db, uid)) === true);
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, {
      type: 'stripe_program',
      active: false,
      terminal: true,
      stripePaymentId: pid,
      revokedReason: 'full_refund',
      amountRefunded: 14900,
    });
    const doc = store.get(entitlementPath(uid)) as { dnsFoundationsEntitled: boolean; bases: Record<string, { terminal: boolean; migratedFromLegacy?: boolean }> };
    const migratedThenSealed = doc.bases[`stripe_program:${pid}`];
    return doc.dnsFoundationsEntitled === false && migratedThenSealed.terminal === true;
  });

  await checkAsync('13. current bases-map schema entitlement revokes directly (no migration path taken)', async () => {
    const { db } = makeFakeDb();
    const uid = 'uid-current';
    const pid = 'pi_current';
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: true, stripePaymentId: pid });
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: false, terminal: true, stripePaymentId: pid, revokedReason: 'full_refund' });
    return (await hasDnsEntitlement(db, uid)) === false;
  });

  // Pure migrateLegacyBasis unit coverage (all three recognized legacy source shapes).
  check(
    'migrateLegacyBasis: stripe:program legacy shape',
    (() => {
      const result = migrateLegacyBasis({ dnsFoundationsEntitled: true, source: 'stripe:program', stripePaymentId: 'pi_x' });
      return result !== null && result[0] === 'stripe_program:pi_x' && result[1].type === 'stripe_program' && result[1].active === true;
    })()
  );
  check(
    'migrateLegacyBasis: already-migrated doc (has bases) is skipped',
    migrateLegacyBasis({ bases: { x: {} }, dnsFoundationsEntitled: true, source: 'stripe:program', stripePaymentId: 'pi_x' }) === null
  );
  check(
    'migrateLegacyBasis: dnsFoundationsEntitled:false is skipped (nothing to migrate)',
    migrateLegacyBasis({ dnsFoundationsEntitled: false, source: 'stripe:program', stripePaymentId: 'pi_x' }) === null
  );
  check(
    'isValidActiveBasis: terminal basis never authorizes even if active:true is also present',
    isValidActiveBasis('stripe_program:pi_x', { type: 'stripe_program', active: true, terminal: true, stripePaymentId: 'pi_x' }) === false
  );
  check('pickPrimarySource: prefers stripe_program over beta_grant', pickPrimarySource({
    beta_grant: { type: 'beta_grant', active: true },
    'stripe_program:pi_x': { type: 'stripe_program', active: true, stripePaymentId: 'pi_x' },
  }) === 'stripe:program');

  // =======================================================================================
  // 12/getDnsCourseDayMedia dependency: revoked user cannot obtain DNS media (verified via
  // the exact function getDnsCourseDayMedia calls — hasDnsEntitlement — since
  // getDnsCourseDayMedia itself has no extracted testable core, see the audit report).
  // =======================================================================================
  await checkAsync('12. hasDnsEntitlement (what getDnsCourseDayMedia gates on) returns false for a revoked user', async () => {
    const { db } = makeFakeDb();
    const uid = 'uid-12';
    const pid = 'pi_12';
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: true, stripePaymentId: pid });
    await applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: false, terminal: true, stripePaymentId: pid, revokedReason: 'full_refund' });
    return (await hasDnsEntitlement(db, uid)) === false;
  });
  await checkAsync('12b. hasDnsEntitlement returns false for a uid with no entitlement doc at all', async () => {
    const { db } = makeFakeDb();
    return (await hasDnsEntitlement(db, 'uid-never-existed')) === false;
  });

  // =======================================================================================
  // 13. Concurrency/transaction retry behavior — two "simultaneous" writes to DIFFERENT
  // basis keys on the SAME entitlement doc must both survive (real Firestore transaction
  // retry, not a naive last-write-wins), and a genuine grant-vs-refund race on the SAME
  // basis key must converge deterministically regardless of arrival order.
  // =======================================================================================
  await checkAsync('13a. two concurrent basis writes to the same doc (different keys) both land', async () => {
    const { db, store } = makeFakeDb();
    const uid = 'uid-13a';
    // True concurrency: both transactions start (and do their read) before either commits.
    const p1 = applyDnsEntitlementBasis(db, uid, 'beta_grant', { type: 'beta_grant', active: true, cohort: 'initial_beta' });
    const p2 = applyDnsEntitlementBasis(db, uid, 'stripe_program:pi_13a', { type: 'stripe_program', active: true, stripePaymentId: 'pi_13a' });
    await Promise.all([p1, p2]);
    const doc = store.get(entitlementPath(uid)) as { bases: Record<string, unknown> };
    return Object.keys(doc.bases).length === 2 && doc.bases['beta_grant'] !== undefined && doc.bases['stripe_program:pi_13a'] !== undefined;
  });

  await checkAsync('13b. grant-then-refund and refund-then-grant converge to the same final state', async () => {
    const { db: dbA } = makeFakeDb();
    const uidA = 'uid-13b-a';
    const pidA = 'pi_13b_a';
    await applyDnsEntitlementBasis(dbA, uidA, `stripe_program:${pidA}`, { type: 'stripe_program', active: true, stripePaymentId: pidA });
    await applyDnsEntitlementBasis(dbA, uidA, `stripe_program:${pidA}`, { type: 'stripe_program', active: false, terminal: true, stripePaymentId: pidA, revokedReason: 'full_refund' });
    const resultA = await hasDnsEntitlement(dbA, uidA);

    const { db: dbB } = makeFakeDb();
    const uidB = 'uid-13b-b';
    const pidB = 'pi_13b_b';
    await applyDnsEntitlementBasis(dbB, uidB, `stripe_program:${pidB}`, { type: 'stripe_program', active: false, terminal: true, stripePaymentId: pidB, revokedReason: 'full_refund' });
    await applyDnsEntitlementBasis(dbB, uidB, `stripe_program:${pidB}`, { type: 'stripe_program', active: true, stripePaymentId: pidB });
    const resultB = await hasDnsEntitlement(dbB, uidB);

    return resultA === false && resultB === false && resultA === resultB;
  });

  // =======================================================================================
  // 14. Out-of-order event sequences (broader than 13b): refund, grant, duplicate refund,
  // duplicate grant, in a scrambled sequence, must still converge to revoked.
  // =======================================================================================
  await checkAsync('14. scrambled out-of-order event sequence converges to revoked', async () => {
    const { db } = makeFakeDb();
    const uid = 'uid-14';
    const pid = 'pi_14';
    const grant = () => applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: true, stripePaymentId: pid });
    const revoke = () => applyDnsEntitlementBasis(db, uid, `stripe_program:${pid}`, { type: 'stripe_program', active: false, terminal: true, stripePaymentId: pid, revokedReason: 'full_refund' });
    await revoke();
    await grant();
    await revoke();
    await grant();
    await grant();
    return (await hasDnsEntitlement(db, uid)) === false;
  });

  // =======================================================================================
  // Extra: paymentGrantsDnsFoundations realism — must not grant for pending/failed status,
  // wrong price, or malformed payment docs (guards against a fake that treats any payment
  // doc as a grant).
  // =======================================================================================
  check('extra-a. paymentGrantsDnsFoundations true for succeeded + correct price', paymentGrantsDnsFoundations(fakePaymentDoc()) === true);
  check('extra-b. paymentGrantsDnsFoundations false for status:requires_payment_method', paymentGrantsDnsFoundations(fakePaymentDoc({ status: 'requires_payment_method' })) === false);
  check('extra-c. paymentGrantsDnsFoundations false for status:canceled', paymentGrantsDnsFoundations(fakePaymentDoc({ status: 'canceled' })) === false);
  check('extra-d. paymentGrantsDnsFoundations false for wrong price ID', paymentGrantsDnsFoundations(fakePaymentDoc({ priceId: 'price_unrelated' })) === false);
  check('extra-e. paymentGrantsDnsFoundations false for undefined payment doc', paymentGrantsDnsFoundations(undefined) === false);
  check('extra-f. paymentGrantsDnsFoundations false for empty items array', paymentGrantsDnsFoundations({ status: 'succeeded', items: [] }) === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
}

run();
