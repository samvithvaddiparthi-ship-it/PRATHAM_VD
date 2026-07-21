#!/usr/bin/env node
//
// Authorization integration tests (§5c horizontal IDOR + role gating), run against
// a RUNNING stack. The existing node unit tests (test/ownership.test.js) prove the
// authz *decision table* in isolation; this proves it is actually WIRED onto the
// live routes — the gap that lets a correct helper sit behind an ungated route.
//
//   Usage:  node scripts/smoke-authz.js [baseUrl]      (default http://localhost)
//
// Asserts NEGATIVE cases: unauthenticated → 401; one patient cannot touch another
// patient's data → 403; a patient token cannot reach doctor/admin routes → 403.
// Creates throwaway "Authz A/B" sessions — do NOT run against prod data.
//
const { makeCall, Reporter, bootstrapPatient } = require('./smoke-lib');

const BASE = process.argv[2] || 'http://localhost';
const DOCTOR_PHONE = process.env.SMOKE_DOCTOR_PHONE || '9876500001';
const DOCTOR_PIN = process.env.SMOKE_DOCTOR_PIN || '1234';

const call = makeCall(BASE);
const r = Reporter();

(async () => {
  console.log(`Authz integration test → ${BASE}\n`);

  // Two independent patients in the same department.
  const A = await bootstrapPatient(call, { name: 'Authz A' });
  const B = await bootstrapPatient(call, { name: 'Authz B' });
  r.ok(!!A.token && !!B.token && A.sessionId !== B.sessionId, 'set up two distinct patient sessions');

  // ── Unauthenticated → 401 ───────────────────────────────────────────────────
  const anon = await call(`/api/session/${A.sessionId}`, { method: 'GET' });
  r.ok(anon.status === 401, 'unauthenticated read of a session is rejected (401)');

  // ── Horizontal IDOR: A must not touch B's data (ownership → 403) ─────────────
  const readOther = await call(`/api/session/${B.sessionId}`, { method: 'GET', token: A.token });
  r.ok(readOther.status === 403, "patient A cannot read patient B's session (403)");

  const vitalsOther = await call(`/api/vitals/${B.sessionId}`, { method: 'GET', token: A.token });
  r.ok(vitalsOther.status === 403, "patient A cannot read patient B's vitals (403)");

  const reportOther = await call('/api/report/generate', { method: 'POST', token: A.token, body: JSON.stringify({ session_id: B.sessionId }) });
  r.ok(reportOther.status === 403, "patient A cannot generate patient B's report (403, python ownership)");

  // ── Vertical: a patient token must not reach doctor/admin routes (role → 403) ─
  const docQueue = await call('/api/doctor/queue', { method: 'GET', token: A.token });
  r.ok(docQueue.status === 403, 'patient token cannot read the doctor queue (403)');

  const prescribe = await call('/api/prescription', { method: 'POST', token: A.token, body: JSON.stringify({ session_id: A.sessionId, items: [] }) });
  r.ok(prescribe.status === 403, 'patient token cannot issue a prescription (403, doctor-only)');

  const createDoctor = await call('/api/doctor', { method: 'POST', token: A.token, body: JSON.stringify({ name: 'Mallory', phone: '9000000000', pin: '1234', department: 'CARD' }) });
  r.ok(createDoctor.status === 403, 'patient token cannot create a doctor (403, admin-only)');

  // ── A doctor token must not reach admin-only routes (skip if no doctor) ──────
  const login = await call('/api/doctor/login', { method: 'POST', body: JSON.stringify({ phone: DOCTOR_PHONE, pin: DOCTOR_PIN }) });
  const docToken = login.body?.token;
  if (!docToken) {
    r.skip(`doctor-vs-admin check — no usable doctor on this deployment (login status ${login.status})`);
  } else {
    const docCreatesDoctor = await call('/api/doctor', { method: 'POST', token: docToken, body: JSON.stringify({ name: 'Mallory', phone: '9000000001', pin: '1234', department: 'CARD' }) });
    r.ok(docCreatesDoctor.status === 403, 'doctor token cannot create a doctor (403, admin-only)');
  }

  process.exit(r.summary());
})().catch(e => { console.error('\nauthz test crashed:', e.message); process.exit(1); });
