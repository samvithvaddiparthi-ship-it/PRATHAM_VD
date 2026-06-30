// Indian phone-number normalization.
//
// Patients enter numbers in many shapes: a bare 10-digit mobile, with the +91
// country code, with a 0091 international prefix, or with a leading 0 trunk code,
// often with spaces or dashes. We reduce all of those to the canonical 10-digit
// national number and an E.164 form (+91XXXXXXXXXX) so that storage, returning-
// patient lookup, and any downstream SMS/WhatsApp messaging all agree.
//
// Indian mobile numbers are 10 digits and start with 6-9 — that's the validity rule.
export function normalizeIndianPhone(raw) {
  let d = String(raw == null ? '' : raw).replace(/\D/g, ''); // digits only
  if (d.startsWith('00')) d = d.slice(2);                     // 0091... international prefix
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);  // 91XXXXXXXXXX country code
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);   // 0XXXXXXXXXX trunk prefix
  const valid = /^[6-9]\d{9}$/.test(d);
  return { national: d, e164: valid ? '+91' + d : '', valid };
}

// Display-only formatting: put a space between the +91 country code and the
// 10-digit number (+918660742795 → "+91 8660742795"). Anything that isn't the
// canonical E.164 Indian form is returned unchanged, so it's safe to wrap any
// stored phone value for display.
export function formatPhoneDisplay(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = s.match(/^\+91(\d{10})$/);
  return m ? `+91 ${m[1]}` : s;
}
