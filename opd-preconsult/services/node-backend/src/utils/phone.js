// Indian phone-number normalization (server-side mirror of frontend/src/lib/phone.js).
//
// Never trust the client to send a canonical number — normalize again here so that
// what we store and match on is always the E.164 form (+91XXXXXXXXXX). Accepts bare
// 10-digit mobiles, +91 / 0091 prefixes, and a leading 0 trunk code, with any
// spaces/dashes. Indian mobiles are 10 digits starting 6-9.
function normalizeIndianPhone(raw) {
  let d = String(raw == null ? '' : raw).replace(/\D/g, ''); // digits only
  if (d.startsWith('00')) d = d.slice(2);                     // 0091... international prefix
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);  // 91XXXXXXXXXX country code
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);   // 0XXXXXXXXXX trunk prefix
  const valid = /^[6-9]\d{9}$/.test(d);
  return { national: d, e164: valid ? '+91' + d : '', valid };
}

// Mask a phone number for logs (PHI must never appear in plaintext logs).
// Keeps only the last 2 digits: 9876543210 -> ***10.
function maskPhone(raw) {
  const d = String(raw == null ? '' : raw).replace(/\D/g, '');
  return d.length < 2 ? '***' : '***' + d.slice(-2);
}

module.exports = { normalizeIndianPhone, maskPhone };
