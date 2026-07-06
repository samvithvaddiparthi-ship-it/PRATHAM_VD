/**
 * Minimal SMS sender, reusing the project's existing Twilio setup (the same
 * TWILIO_* env vars the follow-up worker uses). When Twilio isn't configured we
 * fall into "dry-run" mode: nothing is sent, but the caller is told so it can
 * surface the code locally for testing. This mirrors the dry-run pattern in
 * services/node-backend/src/workers/followup-worker.js.
 */
const { maskPhone } = require('./phone');

let twilioClient = null; // null = not yet initialised, false = unavailable

function getTwilioClient() {
  if (twilioClient !== null) return twilioClient || null;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || sid === 'your_sid_here') {
    twilioClient = false;
    return null;
  }
  try {
    twilioClient = require('twilio')(sid, token);
    console.log('[sms] Twilio client initialized');
  } catch {
    twilioClient = false;
    console.log('[sms] Twilio SDK not available — dry-run mode');
  }
  return twilioClient || null;
}

/**
 * Send an SMS. `to` must be E.164 (+91XXXXXXXXXX).
 * Returns { sent: true } when actually dispatched, or { sent: false, dryRun: true }
 * when Twilio isn't configured (the message is logged instead).
 */
async function sendSms(to, body) {
  const client = getTwilioClient();
  if (!client) {
    console.log(`[sms] (dry-run) Would SMS ${maskPhone(to)} (${(body || '').length} chars)`);
    return { sent: false, dryRun: true };
  }
  const from = process.env.TWILIO_SMS_FROM;
  if (!from) {
    console.warn('[sms] TWILIO_SMS_FROM not set — cannot send; dry-run.');
    console.log(`[sms] (dry-run) Would SMS ${maskPhone(to)} (${(body || '').length} chars)`);
    return { sent: false, dryRun: true };
  }
  await client.messages.create({ from, to, body });
  return { sent: true };
}

// True when real SMS delivery is wired up (creds + sender present). Used so the
// OTP endpoint only ever leaks the code in dry-run/dev mode.
function smsConfigured() {
  return !!getTwilioClient() && !!process.env.TWILIO_SMS_FROM;
}

module.exports = { sendSms, smsConfigured };
