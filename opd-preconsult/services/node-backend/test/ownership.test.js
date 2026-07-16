// Authorization is the highest-risk logic in the app: get requireSessionOwnership
// wrong and any valid token reads every patient's record. These tests pin the
// decision table so a future refactor can't silently open it up.
//
// Ported from the production repo, where this middleware lived in its own module
// as requireSessionAccess(). Here it lives in middleware/auth.js. The security
// decision table is identical; two deliberate differences from the original:
//
//   1. Default param name is 'id', not 'session_id'. Every real call site passes
//      the name explicitly (9 of them across 6 route files), so these tests do
//      the same rather than leaning on a default no route relies on.
//   2. A request with no session_data at all gets 403, not 401. Both DENY — only
//      the status differs, and the branch is unreachable in practice because
//      authMiddleware runs first and already 401s a missing/invalid token.
const { test } = require('node:test');
const assert = require('node:assert');
const { requireSessionOwnership } = require('../src/middleware/auth');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// requireSessionOwnership middleware is synchronous — next() fires (or doesn't)
// before this returns.
function run(mw, req) {
  const res = mockRes();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  return { res, nexted };
}

test('patient may access their own session', () => {
  const mw = requireSessionOwnership('session_id');
  const { nexted } = run(mw, { session_data: { role: 'patient', session_id: 'S1' }, params: { session_id: 'S1' } });
  assert.equal(nexted, true);
});

test('patient is denied another patient session (403)', () => {
  const mw = requireSessionOwnership('session_id');
  const { res, nexted } = run(mw, { session_data: { role: 'patient', session_id: 'S1' }, params: { session_id: 'S2' } });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
});

test('doctor may access any session', () => {
  const mw = requireSessionOwnership('session_id');
  const { nexted } = run(mw, { session_data: { role: 'doctor', session_id: 'SX' }, params: { session_id: 'S9' } });
  assert.equal(nexted, true);
});

test('admin may access any session', () => {
  const mw = requireSessionOwnership('session_id');
  const { nexted } = run(mw, { session_data: { role: 'admin' }, params: { session_id: 'S9' } });
  assert.equal(nexted, true);
});

test('no token → denied', () => {
  const mw = requireSessionOwnership('session_id');
  const { res, nexted } = run(mw, { params: { session_id: 'S1' } });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
});

test('patient token carrying no session_id → denied', () => {
  const mw = requireSessionOwnership('session_id');
  const { res, nexted } = run(mw, { session_data: { role: 'patient' }, params: { session_id: 'S1' } });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
});

test('unknown role → 403', () => {
  const mw = requireSessionOwnership('session_id');
  const { res, nexted } = run(mw, { session_data: { role: 'nurse' }, params: { session_id: 'S1' } });
  assert.equal(nexted, false);
  assert.equal(res.statusCode, 403);
});

test('custom param name is honoured', () => {
  const mw = requireSessionOwnership('id');
  const { nexted } = run(mw, { session_data: { role: 'patient', session_id: 'S1' }, params: { id: 'S1' } });
  assert.equal(nexted, true);
});
