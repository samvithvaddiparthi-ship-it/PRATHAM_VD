#!/usr/bin/env node
//
// Generate strong random secrets for a real deployment.
//   Usage:  node scripts/gen-secrets.js
// Copy the printed lines into your .env (NEVER commit .env). Do this before any
// pilot — the defaults in .env.example are placeholders and must not be used
// with real patient data.
//
// Uses only Node's built-in crypto — no dependency to install.
const crypto = require('crypto');

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
// URL/shell/DSN-safe: strip +,/,= so the value can't break a connection string
// or env parsing. Trim to `len` characters.
const safe = (len) => crypto.randomBytes(len).toString('base64').replace(/[+/=]/g, '').slice(0, len);

// MinIO KMS key for encryption at rest (B1). MinIO wants `<key-name>:<base64 of
// exactly 32 random bytes>`. BACK THIS UP — losing it makes encrypted objects
// unreadable.
const minioKmsKey = () => `opd-key-1:${crypto.randomBytes(32).toString('base64')}`;

const lines = [
  ['JWT_SECRET', hex(32)],          // shared by node + python for auth
  ['ADMIN_PASSCODE', safe(20)],     // HIS dashboard login (>=6 required)
  ['QR_SIGNING_SECRET', hex(32)],      // HMAC-signs prescription QR slips
  ['OTP_SECRET', hex(32)],          // binds OTP hashes
  ['POSTGRES_PASSWORD', safe(24)],
  ['MINIO_ACCESS_KEY', safe(20)],
  ['MINIO_SECRET_KEY', safe(40)],
  ['MINIO_KMS_SECRET_KEY', minioKmsKey()],  // encryption at rest — BACK THIS UP
];

console.log('# --- Generated secrets — paste into .env (do NOT commit .env) ---');
for (const [k, v] of lines) console.log(`${k}=${v}`);
console.log('# ----------------------------------------------------------------');
console.log('# Rotating JWT_SECRET logs everyone out. Rotating POSTGRES_PASSWORD /');
console.log('# MINIO_SECRET_KEY also requires updating the running datastore creds.');
console.log('# BACK UP MINIO_KMS_SECRET_KEY securely — if lost, encrypted uploads (B1)');
console.log('# can no longer be decrypted. Do NOT rotate it once objects are encrypted.');
