//
// Shared helpers for the smoke / e2e scripts (smoke.js, smoke-authz.js).
// No npm dependencies — relies on Node 18+ global fetch. Kept tiny on purpose so
// the CI e2e stays fast and readable.
//
// IMPORTANT: these run against a RUNNING stack in DEV mode. They need OTP in
// dev/dry-run (SMS NOT configured) so the code comes back in the response, and
// they create throwaway "Smoke Test" sessions — never point them at prod data.
//

// Build a `call(path, opts)` bound to a base URL. Adds JSON headers + bearer token,
// never throws on a non-2xx (returns { status, body }) so tests can assert on codes.
function makeCall(BASE) {
  return async function call(path, { token, ...opts } = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(BASE + path, { ...opts, headers });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON / empty body */ }
    return { status: res.status, body };
  };
}

// Minimal PASS/FAIL/SKIP reporter. SKIP is for steps that can't run on a given
// deployment by design (e.g. no demo doctor on prod) — it is NOT counted as a
// failure, so the same script goes fully green in CI and partially on prod.
function Reporter() {
  let passes = 0, failures = 0, skips = 0;
  return {
    ok(cond, msg) {
      console.log(`${cond ? 'PASS' : 'FAIL'} — ${msg}`);
      if (cond) passes++; else failures++;
      return !!cond;
    },
    skip(msg) { console.log(`SKIP — ${msg}`); skips++; },
    get failures() { return failures; },
    summary() {
      console.log(`\n${passes} passed, ${failures} failed, ${skips} skipped`);
      return failures;
    },
  };
}

// Drive a patient from QR scan → verified → registered (department chosen).
// Returns { token, sessionId, phone, tokenLabel }. Throws with a clear reason if
// the deployment can't support the flow (e.g. OTP not in dev mode on prod).
async function bootstrapPatient(call, { name = 'Smoke Test', department = process.env.SMOKE_DEPARTMENT || 'CARD', age = 30, gender = 'M' } = {}) {
  const hospitalId = process.env.SMOKE_HOSPITAL_ID || 'demo_hospital_01';

  // 1. Scan (hospital-only payload) → session + patient token
  const qr = Buffer.from(JSON.stringify({ hospital_id: hospitalId })).toString('base64');
  const scan = await call('/api/session/scan', { method: 'POST', body: JSON.stringify({ qr_payload: qr }) });
  const token = scan.body?.token;
  const sessionId = scan.body?.session?.id;
  if (!token || !sessionId) throw new Error(`scan did not return a session/token (status ${scan.status})`);

  // 2. OTP request → dev code. Prod (NODE_ENV=production) returns 503 without SMS,
  //    or sends a real SMS and never exposes the code — either way the smoke test
  //    cannot self-serve an OTP there. That's by design; surface it clearly.
  const phone = '9' + String(Math.floor(100000000 + Math.random() * 899999999));
  const otpReq = await call('/api/otp/request', { method: 'POST', token, body: JSON.stringify({ phone }) });
  const code = otpReq.body?.dev_code;
  if (!code) {
    throw new Error(
      `OTP dev_code unavailable (status ${otpReq.status}). The smoke test needs a DEV stack ` +
      `with SMS NOT configured. On a production deployment OTP is intentionally locked down — ` +
      `verify prod manually instead.`
    );
  }

  // 3. OTP verify → session verified
  await call('/api/otp/verify', { method: 'POST', token, body: JSON.stringify({ phone, code }) });

  // 4. Register (department chosen here) → queue token issued, state REGISTERED
  const reg = await call('/api/session/register', {
    method: 'POST', token,
    body: JSON.stringify({ patient_name: name, patient_age: age, patient_gender: gender, patient_phone: phone, language: 'en', department }),
  });

  return { token, sessionId, phone, tokenLabel: reg.body?.token_label, regStatus: reg.status };
}

module.exports = { makeCall, Reporter, bootstrapPatient };
