#!/usr/bin/env node

// Prints the single, hospital-level check-in URL for the kiosk poster. The QR is
// just this plain URL (human-readable, ?h=<hospital_id>) — the patient chooses
// their department on-screen after scanning, and the token is issued
// per-department at registration. For a printable poster use scripts/qr-poster.html.
// Usage: node generate-qr.js [baseUrl]
//   e.g. node generate-qr.js https://opd.hospital.gov.in
const hospitalId = process.env.DEMO_HOSPITAL_ID || 'demo_hospital_01';
const base = (process.argv[2] || 'http://localhost').replace(/\/+$/, '');
const url = `${base}/?h=${encodeURIComponent(hospitalId)}`;

console.log('Hospital ID:', hospitalId);
console.log('\nPatient check-in URL (encode this as the QR):');
console.log(url);
console.log('\nTip: a single-hospital deployment can drop ?h= — the app defaults it.');
