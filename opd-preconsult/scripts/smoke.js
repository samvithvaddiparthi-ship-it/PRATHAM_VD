#!/usr/bin/env node
//
// A11 — critical-path smoke test. Exercises scan → OTP → register → triage
// against a RUNNING stack so a rebuild can't silently break intake or auth.
//   Usage:  node scripts/smoke.js [baseUrl]      (default http://localhost)
// Requires SMS NOT configured (dev/dry-run) so the OTP code is returned for the
// test. Creates a throwaway "Smoke Test" session — do NOT run against prod data.
const BASE = process.argv[2] || 'http://localhost';
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} — ${msg}`); if (!cond) failures++; };

async function call(path, { token, ...opts } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { ...opts, headers });
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

(async () => {
  console.log(`Smoke test → ${BASE}\n`);

  // 1. Scan (hospital-only payload) → session + token
  const qr = Buffer.from(JSON.stringify({ hospital_id: 'demo_hospital_01' })).toString('base64');
  const scan = await call('/api/session/scan', { method: 'POST', body: JSON.stringify({ qr_payload: qr }) });
  ok(scan.status === 200 && !!scan.body?.token, 'scan creates a session + token');
  const token = scan.body?.token;
  const sessionId = scan.body?.session?.id;

  // 2. OTP request → dev code (SMS not configured)
  const phone = '9' + String(Math.floor(100000000 + Math.random() * 899999999));
  const otpReq = await call('/api/otp/request', { method: 'POST', token, body: JSON.stringify({ phone }) });
  const code = otpReq.body?.dev_code;
  ok(otpReq.status === 200 && !!code, 'OTP request returns a dev code');

  // 3. OTP verify → session verified
  const otpVer = await call('/api/otp/verify', { method: 'POST', token, body: JSON.stringify({ phone, code }) });
  ok(otpVer.status === 200 && otpVer.body?.verified === true, 'OTP verify marks the session verified');

  // 4. Register (department chosen here) → queue token issued
  const reg = await call('/api/session/register', {
    method: 'POST', token,
    body: JSON.stringify({ patient_name: 'Smoke Test', patient_age: 30, patient_gender: 'M', patient_phone: phone, language: 'en', department: 'CARD' }),
  });
  ok(reg.status === 200 && !!reg.body?.token_label, `register issues a queue token (${reg.body?.token_label || '?'})`);

  // 5. python-backend auth (A1): 401 without token, not-401/not-5xx with token
  const noTok = await call('/api/triage/evaluate', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) });
  ok(noTok.status === 401, 'triage REJECTS an unauthenticated call (A1)');
  const withTok = await call('/api/triage/evaluate', { method: 'POST', token, body: JSON.stringify({ session_id: sessionId }) });
  ok(withTok.status !== 401 && withTok.status < 500, `triage ACCEPTS an authenticated call (status ${withTok.status})`);

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL PASSED'}`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('smoke test crashed:', e.message); process.exit(1); });
