/**
 * Error-tracking PHI scrubbing.
 *
 * These assert the property that makes it safe to send errors to a third party at
 * all: the event carries the fault, never the patient. A regression here would leak
 * health data to an external service silently — nothing would break, no test would
 * fail, and nobody would notice.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const trackingPath = path.join(__dirname, '..', 'src', 'utils', 'errorTracking.js');
// scrubEvent is module-private; read it out the same way the SDK would call it.
const { scrubEvent } = (() => {
  const src = require('node:fs').readFileSync(trackingPath, 'utf8');
  const mod = { exports: {} };
  // Re-evaluate the module body with the scrubber exposed, without initialising
  // Sentry (init() is a no-op with no DSN, but this keeps the test hermetic).
  const fn = new Function('module', 'exports', 'require', 'process', 'console',
    `${src}\nmodule.exports.scrubEvent = scrubEvent;`);
  fn(mod, mod.exports, require, { env: {} }, { log() {}, error() {} });
  return mod.exports;
})();

test('request body is dropped — it carries answers, names and phone numbers', () => {
  const event = scrubEvent({
    request: { data: { name: 'Ramesh Kumar', phone: '9876500001', answer: 'chest pain' } },
  });
  assert.strictEqual(event.request.data, undefined);
});

test('query string is dropped', () => {
  const event = scrubEvent({ request: { query_string: 'phone=9876500001&name=Ramesh' } });
  assert.strictEqual(event.request.query_string, undefined);
});

test('cookies are dropped', () => {
  const event = scrubEvent({ request: { cookies: { session: 'abc123' } } });
  assert.strictEqual(event.request.cookies, undefined);
});

test('authorization header is redacted, not forwarded', () => {
  const event = scrubEvent({
    request: { headers: { Authorization: 'Bearer secret.jwt.token', 'X-Real-IP': '10.0.0.1' } },
  });
  assert.strictEqual(event.request.headers.Authorization, '[redacted]');
});

test('header redaction is case-insensitive', () => {
  const event = scrubEvent({ request: { headers: { authorization: 'Bearer x', COOKIE: 'a=b' } } });
  assert.strictEqual(event.request.headers.authorization, '[redacted]');
  assert.strictEqual(event.request.headers.COOKIE, '[redacted]');
});

test('twilio signature is redacted', () => {
  const event = scrubEvent({ request: { headers: { 'X-Twilio-Signature': 'sig' } } });
  assert.strictEqual(event.request.headers['X-Twilio-Signature'], '[redacted]');
});

test('user identity is removed even if something upstream set it', () => {
  const event = scrubEvent({ user: { id: 'patient-42', ip_address: '10.0.0.1' } });
  assert.strictEqual(event.user, undefined);
});

test('the diagnostic payload survives — we still report the actual fault', () => {
  const event = scrubEvent({
    exception: { values: [{ type: 'TypeError', value: 'x is not a function' }] },
    request: { url: 'https://host/api/report/123', data: { phi: 'secret' } },
  });
  assert.strictEqual(event.exception.values[0].type, 'TypeError');
  assert.strictEqual(event.request.url, 'https://host/api/report/123');
  assert.strictEqual(event.request.data, undefined);
});

test('scrubbing never throws on a malformed event', () => {
  assert.doesNotThrow(() => scrubEvent({}));
  assert.doesNotThrow(() => scrubEvent({ request: null }));
  assert.doesNotThrow(() => scrubEvent({ request: { headers: null } }));
});
