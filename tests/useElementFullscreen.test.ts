// tests/useElementFullscreen.test.ts
// Run: node --test tests/useElementFullscreen.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enterFullscreen, fullscreenControlFor, isFullscreenAvailable } from '../src/hooks/useElementFullscreen.ts';

type FullscreenDoc = Parameters<typeof isFullscreenAvailable>[0];
const doc = (fullscreenEnabled: boolean | undefined, requestFullscreen?: unknown) =>
  ({ fullscreenEnabled, documentElement: { requestFullscreen } }) as unknown as FullscreenDoc;
const fn = () => Promise.resolve();

test('available: standard API present and enabled', () => {
  assert.equal(isFullscreenAvailable(doc(true, fn)), true);
});

test('unavailable: fullscreenEnabled false (permissions policy / embedded denial)', () => {
  assert.equal(isFullscreenAvailable(doc(false, fn)), false);
});

test('unavailable: fullscreenEnabled undefined (e.g. iPhone Safari)', () => {
  assert.equal(isFullscreenAvailable(doc(undefined, undefined)), false);
});

test('unavailable: only prefixed methods, no standard requestFullscreen', () => {
  assert.equal(isFullscreenAvailable(doc(true, undefined)), false);
});

type Target = Parameters<typeof enterFullscreen>[0];

test('request is issued synchronously (inside the tap gesture) and resolves true', async () => {
  let calls = 0;
  const el = { requestFullscreen: () => { calls++; return Promise.resolve(); } } as unknown as Target;
  const result = enterFullscreen(el);
  assert.equal(calls, 1, 'requestFullscreen called before enterFullscreen returned');
  assert.equal(await result, true);
});

test('rejection (e.g. TypeError: not allowed) resolves false, never throws', async () => {
  const el = { requestFullscreen: () => Promise.reject(new TypeError('Permissions check failed')) } as unknown as Target;
  assert.equal(await enterFullscreen(el), false);
});

test('synchronous throw resolves false', async () => {
  const el = { requestFullscreen: () => { throw new Error('boom'); } } as unknown as Target;
  assert.equal(await enterFullscreen(el), false);
});

test('missing element or method resolves false', async () => {
  assert.equal(await enterFullscreen(null), false);
  assert.equal(await enterFullscreen({} as unknown as Target), false);
});

test('opted in + fullscreen supported: teal button only', () => {
  assert.equal(fullscreenControlFor(true, isFullscreenAvailable(doc(true, fn))), 'button');
});

test('opted in + fullscreen unsupported (e.g. iPhone Safari): fallback hint only', () => {
  assert.equal(fullscreenControlFor(true, isFullscreenAvailable(doc(undefined, undefined))), 'hint');
  assert.equal(fullscreenControlFor(true, isFullscreenAvailable(doc(false, fn))), 'hint');
});

test('not opted in: neither button nor hint, regardless of support', () => {
  assert.equal(fullscreenControlFor(false, true), null);
  assert.equal(fullscreenControlFor(false, false), null);
});
