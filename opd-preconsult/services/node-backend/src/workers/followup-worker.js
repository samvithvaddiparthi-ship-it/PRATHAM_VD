/**
 * Follow-up worker — runs on setInterval, checks for due follow-ups and sends via Twilio.
 * Called from index.js after server starts.
 */
const pool = require('../models/db');
const { maskPhone } = require('../utils/phone');

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let twilio = null;

function getTwilioClient() {
  if (twilio !== null) return twilio;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || sid === 'your_sid_here') {
    twilio = false;
    return null;
  }
  try {
    twilio = require('twilio')(sid, token);
    console.log('[followup-worker] Twilio client initialized');
  } catch {
    twilio = false;
    console.log('[followup-worker] Twilio SDK not available');
  }
  return twilio || null;
}

async function processDueFollowups() {
  try {
    // Find pending follow-ups that are due
    const result = await pool.query(
      `SELECT * FROM scheduled_followups WHERE status = 'pending' AND send_at <= NOW() ORDER BY send_at LIMIT 10`
    );

    if (!result.rows.length) return;
    console.log(`[followup-worker] ${result.rows.length} follow-up(s) due`);

    const client = getTwilioClient();

    for (const followup of result.rows) {
      try {
        if (client) {
          const fromNumber = followup.channel === 'sms'
            ? process.env.TWILIO_SMS_FROM
            : process.env.TWILIO_WHATSAPP_FROM;
          const toNumber = followup.channel === 'sms'
            ? followup.patient_phone
            : `whatsapp:+91${followup.patient_phone}`;

          await client.messages.create({
            from: fromNumber,
            to: toNumber,
            body: followup.message,
          });
          console.log(`[followup-worker] Sent ${followup.channel} to ${maskPhone(followup.patient_phone)}`);
        } else {
          // Never log the recipient number or message body (PHI) — mask + length only.
          console.log(`[followup-worker] (dry-run) Would send ${followup.channel} to ${maskPhone(followup.patient_phone)} (${(followup.message || '').length} chars)`);
        }

        // Mark as sent
        await pool.query(
          `UPDATE scheduled_followups SET status = 'sent', sent_at = NOW() WHERE id = $1`,
          [followup.id]
        );
      } catch (err) {
        console.error(`[followup-worker] Failed to send follow-up ${followup.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[followup-worker] Error processing follow-ups:', err.message);
  }
}

function startFollowupWorker() {
  console.log('[followup-worker] Starting (interval: 5 min)');
  // Run once on startup after a short delay
  setTimeout(processDueFollowups, 10000);
  // Then every 5 minutes
  setInterval(processDueFollowups, INTERVAL_MS);
}

module.exports = { startFollowupWorker };
