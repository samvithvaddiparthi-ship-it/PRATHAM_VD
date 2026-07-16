// PIN hashing + the legacy-SHA-256 lazy-migration path. If verifyPin ever stops
// accepting old hashes, every pre-migration doctor is locked out; if it stops
// flagging needsRehash, insecure hashes never get upgraded. Both are pinned here.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { hashPin, verifyPin } = require('../src/utils/pinHash');

test('bcrypt hash round-trips and rejects wrong PIN', async () => {
  const h = await hashPin('1234');
  assert.match(h, /^\$2[aby]\$/, 'should be a bcrypt hash');
  assert.equal((await verifyPin('1234', h)).ok, true);
  assert.equal((await verifyPin('9999', h)).ok, false);
});

test('bcrypt verify does not request a rehash', async () => {
  const h = await hashPin('4321');
  const r = await verifyPin('4321', h);
  assert.equal(r.ok, true);
  assert.equal(r.needsRehash, false);
});

test('legacy SHA-256 verifies and flags needsRehash', async () => {
  const legacy = crypto.createHash('sha256').update('1234').digest('hex');
  const r = await verifyPin('1234', legacy);
  assert.equal(r.ok, true);
  assert.equal(r.needsRehash, true, 'legacy match must trigger upgrade to bcrypt');
});

test('legacy SHA-256 rejects wrong PIN', async () => {
  const legacy = crypto.createHash('sha256').update('1234').digest('hex');
  assert.equal((await verifyPin('0000', legacy)).ok, false);
});

test('empty/missing stored hash never verifies', async () => {
  assert.equal((await verifyPin('1234', '')).ok, false);
  assert.equal((await verifyPin('1234', null)).ok, false);
});
