import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVersion, BUILD_VERSION } from '../../src/game/version.ts';

test('unbundled sources fall back to a dev placeholder', async () => {
  assert.equal(BUILD_VERSION, '0.0.0-dev');
  assert.equal(await resolveVersion({}), BUILD_VERSION);
});

test('desktop bridge wins and is read on every call (development reads package.json live)', async () => {
  let v = '1.2.3';
  const src = { bridge: async () => v };
  assert.equal(await resolveVersion(src), '1.2.3');
  v = '1.2.4';
  assert.equal(await resolveVersion(src), '1.2.4');
});

test('bridge failure or junk falls back to the build-time version', async () => {
  assert.equal(await resolveVersion({ bridge: async () => { throw new Error('ipc down'); } }), BUILD_VERSION);
  assert.equal(await resolveVersion({ bridge: async () => '  ' }), BUILD_VERSION);
});

test('browser dev server answers version.json; a static host (404) falls back', async () => {
  const live = { fetch: async (url: string) => ({ ok: url === 'version.json', json: async () => ({ version: '9.9.9' }) }) };
  assert.equal(await resolveVersion(live), '9.9.9');
  const missing = { fetch: async () => ({ ok: false, json: async () => ({}) }) };
  assert.equal(await resolveVersion(missing), BUILD_VERSION);
  const broken = { fetch: async () => { throw new TypeError('network'); } };
  assert.equal(await resolveVersion(broken), BUILD_VERSION);
});
