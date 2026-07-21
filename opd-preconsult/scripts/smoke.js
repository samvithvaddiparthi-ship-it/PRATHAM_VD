#!/usr/bin/env node
//
// A11 — critical-path e2e smoke test. Exercises the FULL journey against a RUNNING
// stack so a rebuild can't silently break intake, the report pipeline, or the
// doctor/prescribe flow:
//
//   patient:  scan → OTP → register → vitals → triage → generate report (COMPLETE)
//   doctor:   login → queue → open → view report → prescribe → dispatch
//
//   Usage:  node scripts/smoke.js [baseUrl]        (default http://localhost)
//   Env:    SMOKE_DOCTOR_PHONE / SMOKE_DOCTOR_PIN  (default demo 9876500001 / 1234)
//           SMOKE_HOSPITAL_ID                       (default demo_hospital_01)
//
// Runs against a DEV stack (SMS not configured, so OTP returns the code). The
// doctor leg SKIPS cleanly — not fails — when no usable doctor exists (e.g. prod,
// where the demo PIN is refused and no demo doctors are seeded). Creates a
// throwaway "Smoke Test" session — do NOT run against prod data.
//
const { makeCall, Reporter, bootstrapPatient } = require('./smoke-lib');

const BASE = process.argv[2] || 'http://localhost';
const DOCTOR_PHONE = process.env.SMOKE_DOCTOR_PHONE || '9876500001';
const DOCTOR_PIN = process.env.SMOKE_DOCTOR_PIN || '1234';

const call = makeCall(BASE);
const r = Reporter();

(async () => {
  console.log(`E2E smoke test → ${BASE}\n`);

  // ── PATIENT: scan → OTP → register ─────────────────────────────────────────
  const patient = await bootstrapPatient(call, { name: 'Smoke Test' });
  const { token, sessionId } = patient;
  r.ok(!!token && !!sessionId, 'scan → OTP → verify creates a verified session');
  r.ok(patient.regStatus === 200 && !!patient.tokenLabel, `register issues a queue token (${patient.tokenLabel || '?'})`);

  // ── PATIENT: vitals (advances state, feeds triage/report) ───────────────────
  const vitals = await call(`/api/vitals/${sessionId}`, {
    method: 'POST', token,
    body: JSON.stringify({ bp_systolic: 128, bp_diastolic: 82, heart_rate: 78, spo2_pct: 98, temperature_c: 36.8, source: 'manual' }),
  });
  r.ok(vitals.status === 200, `vitals accepted (status ${vitals.status})`);

  // ── PATIENT: triage (auth boundary A1 + rule engine reachable) ──────────────
  const noTok = await call('/api/triage/evaluate', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) });
  r.ok(noTok.status === 401, 'triage REJECTS an unauthenticated call (A1)');
  const triage = await call('/api/triage/evaluate', { method: 'POST', token, body: JSON.stringify({ session_id: sessionId }) });
  r.ok(triage.status === 200, `triage ACCEPTS an authenticated call (status ${triage.status})`);

  // ── PATIENT: generate report → marks session COMPLETE (enters doctor queue) ──
  const gen = await call('/api/report/generate', { method: 'POST', token, body: JSON.stringify({ session_id: sessionId }) });
  r.ok(gen.status === 200 && !!gen.body?.report_md, `report generated & session COMPLETE (triage ${gen.body?.triage_level || '?'})`);

  // ── DOCTOR: login (skips whole leg if no usable doctor on this deployment) ───
  const login = await call('/api/doctor/login', { method: 'POST', body: JSON.stringify({ phone: DOCTOR_PHONE, pin: DOCTOR_PIN }) });
  const docToken = login.body?.token;

  if (!docToken) {
    r.skip(`doctor journey — no usable doctor on this deployment (login status ${login.status}; ` +
           `demo PIN is refused in prod and prod seeds no demo doctors). Set SMOKE_DOCTOR_PHONE/PIN to run it.`);
  } else {
    r.ok(true, `doctor login (${login.body?.doctor?.name || 'doctor'})`);

    // Queue: the just-completed patient should appear in this doctor's department
    const queue = await call('/api/doctor/queue', { method: 'GET', token: docToken });
    const inQueue = Array.isArray(queue.body) && queue.body.some(s => s.id === sessionId);
    r.ok(queue.status === 200 && inQueue, 'completed patient appears in the doctor queue');

    // Self-heal: a doctor may hold only ONE open consultation at a time. Dispatch any
    // this doctor left open from a previous run so `open` below isn't blocked by
    // leftover dev-DB state (a fresh CI DB has none — this is a no-op there).
    const docId = login.body?.doctor?.id;
    if (Array.isArray(queue.body)) {
      for (const s of queue.body) {
        if (s.assigned_doctor_id === docId && s.consulted_at && !s.dispatched_at && s.id !== sessionId) {
          await call(`/api/doctor/dispatch/${s.id}`, { method: 'POST', token: docToken });
        }
      }
    }

    // Open (lock) the consultation
    const open = await call(`/api/doctor/open/${sessionId}`, { method: 'POST', token: docToken });
    r.ok(open.status === 200, `doctor opens the consultation (status ${open.status})`);

    // View the report (clinician read → also stamps the B7 patient_viewed audit)
    const view = await call(`/api/report/${sessionId}`, { method: 'GET', token: docToken });
    r.ok(view.status === 200 && !!view.body, 'doctor views the patient report');

    // Prescribe (advice-only Rx with one drug)
    const rx = await call('/api/prescription', {
      method: 'POST', token: docToken,
      body: JSON.stringify({ session_id: sessionId, items: [{ drug_name: 'Paracetamol', dose: '500mg', frequency: 'BD', duration: '3 days' }], notes: 'smoke test' }),
    });
    r.ok(rx.status === 200, `doctor issues a prescription (status ${rx.status})`);

    // Dispatch (hand off) — also cleans up so repeat runs don't leave an open consult
    const dispatch = await call(`/api/doctor/dispatch/${sessionId}`, { method: 'POST', token: docToken });
    r.ok(dispatch.status === 200, `doctor dispatches the patient (status ${dispatch.status})`);
  }

  process.exit(r.summary());
})().catch(e => { console.error('\nsmoke test crashed:', e.message); process.exit(1); });
