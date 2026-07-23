const { Router } = require('express');
const twilio = require('twilio');
const pool = require('../models/db');
const { flagForAnswer } = require('../utils/triage');
const { resolveNext } = require('../utils/dagResolve');

const router = Router();

// In-memory session tracking for WhatsApp conversations
// Maps phone number -> { session_id, state, department, current_question_id }
const waConversations = new Map();

let warnedDryRun = false;

// §8a — verify the inbound request really came from Twilio before trusting
// req.body.From / req.body.Body. Twilio signs the exact webhook URL + POSTed
// params with the account auth token; validateRequest recomputes the HMAC.
// Returns 'skip' (creds unset — dry-run/dev), 'valid', or 'invalid'.
function checkTwilioSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  if (!authToken || !sid || sid === 'your_sid_here' || authToken === 'your_token_here') {
    return 'skip';
  }
  const signature = req.headers['x-twilio-signature'] || '';
  // Reconstruct the URL Twilio signed. Prefer an explicit override (avoids any
  // proxy header ambiguity); else build from forwarded proto/host + path.
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const url = process.env.TWILIO_WEBHOOK_URL || `${proto}://${host}${req.originalUrl}`;
  try {
    return twilio.validateRequest(authToken, signature, url, req.body || {}) ? 'valid' : 'invalid';
  } catch {
    return 'invalid';
  }
}

// Twilio WhatsApp webhook — receives incoming messages
router.post('/webhook', async (req, res) => {
  const sig = checkTwilioSignature(req);
  if (sig === 'skip') {
    if (!warnedDryRun) {
      console.warn('[whatsapp] TWILIO_AUTH_TOKEN unset — skipping webhook signature validation (dry-run). Set Twilio creds before production.');
      warnedDryRun = true;
    }
  } else if (sig === 'invalid') {
    // Forged / unsigned request — refuse to process it.
    return res.status(403).type('text/xml').send('<Response></Response>');
  }

  const from = (req.body.From || '').replace('whatsapp:', '');
  const body = (req.body.Body || '').trim();

  if (!from || !body) {
    return res.type('text/xml').send('<Response></Response>');
  }

  try {
    const reply = await handleMessage(from, body);
    // Respond with TwiML
    const twiml = `<Response><Message>${escapeXml(reply)}</Message></Response>`;
    res.type('text/xml').send(twiml);
  } catch (err) {
    console.error('[whatsapp] Error:', err);
    res.type('text/xml').send('<Response><Message>Sorry, something went wrong. Please try again.</Message></Response>');
  }
});

async function handleMessage(phone, text) {
  const textLower = text.toLowerCase();
  let conv = waConversations.get(phone);

  // Start new session
  if (!conv || textLower === 'start' || textLower === 'hi' || textLower === 'hello') {
    return await startSession(phone);
  }

  // Handle based on conversation state
  switch (conv.state) {
    case 'CHOOSE_DEPT':
      return await chooseDepartment(phone, text, conv);
    case 'REGISTER_NAME':
      return await registerName(phone, text, conv);
    case 'REGISTER_AGE':
      return await registerAge(phone, text, conv);
    case 'REGISTER_GENDER':
      return await registerGender(phone, text, conv);
    case 'INTERVIEW':
      return await answerQuestion(phone, text, conv);
    default:
      return await startSession(phone);
  }
}

async function startSession(phone) {
  // Get available departments
  let depts;
  try {
    const result = await pool.query('SELECT code, name FROM departments WHERE is_active = true ORDER BY name');
    depts = result.rows;
  } catch {
    depts = [{ code: 'CARD', name: 'Cardiology' }, { code: 'GEN', name: 'General Medicine' }];
  }

  waConversations.set(phone, { state: 'CHOOSE_DEPT', departments: depts });

  const deptList = depts.map((d, i) => `${i + 1}. ${d.name}`).join('\n');
  return `Welcome to OPD Pre-Consultation.\n\nPlease select your department:\n${deptList}\n\nReply with the number.`;
}

async function chooseDepartment(phone, text, conv) {
  const idx = parseInt(text) - 1;
  const depts = conv.departments || [];
  if (isNaN(idx) || idx < 0 || idx >= depts.length) {
    return `Invalid choice. Reply with a number (1-${depts.length}).`;
  }

  const dept = depts[idx];

  // Create session in DB
  const { v4: uuidv4 } = require('uuid');
  const sessionId = uuidv4();
  // Honour the deployment's configured hospital (HOSPITAL_ID), falling back to the
  // demo id. Every other entry path carries the hospital in the request — ?h=<id>
  // off the QR — but a WhatsApp visit has no URL to carry it, so this is the only
  // place the backend has to be told. Hardcoding it tagged every WhatsApp-initiated
  // visit as the demo hospital: invisible on a single-site box, silently wrong for
  // any deployment serving more than one.
  await pool.query(
    `INSERT INTO sessions (id, hospital_id, department, state, language)
     VALUES ($1, $2, $3, 'INIT', 'en')`,
    [sessionId, process.env.HOSPITAL_ID || 'demo_hospital_01', dept.code]
  );

  waConversations.set(phone, { ...conv, state: 'REGISTER_NAME', session_id: sessionId, department: dept.code });
  return `Selected: ${dept.name}\n\nPlease enter your full name:`;
}

async function registerName(phone, text, conv) {
  await pool.query(
    `UPDATE sessions SET patient_name = $1, patient_phone = $2, state = 'REGISTERED', updated_at = NOW() WHERE id = $3`,
    [text.trim(), phone, conv.session_id]
  );
  waConversations.set(phone, { ...conv, state: 'REGISTER_AGE' });
  return 'Thank you. Please enter your age:';
}

async function registerAge(phone, text, conv) {
  const age = parseInt(text);
  if (isNaN(age) || age < 0 || age > 150) {
    return 'Please enter a valid age (number).';
  }
  await pool.query('UPDATE sessions SET patient_age = $1, updated_at = NOW() WHERE id = $2', [age, conv.session_id]);
  waConversations.set(phone, { ...conv, state: 'REGISTER_GENDER' });
  return 'Please select gender:\n1. Male\n2. Female\n3. Other';
}

async function registerGender(phone, text, conv) {
  const genderMap = { '1': 'M', '2': 'F', '3': 'O', 'male': 'M', 'female': 'F', 'other': 'O', 'm': 'M', 'f': 'F' };
  const gender = genderMap[text.toLowerCase().trim()];
  if (!gender) {
    return 'Please reply 1 (Male), 2 (Female), or 3 (Other).';
  }

  await pool.query(
    `UPDATE sessions SET patient_gender = $1, consent_given = true, state = 'CONSENTED', updated_at = NOW() WHERE id = $2`,
    [gender, conv.session_id]
  );

  // Start interview — load first question
  waConversations.set(phone, { ...conv, state: 'INTERVIEW' });
  return await sendNextQuestion(phone, conv);
}

async function answerQuestion(phone, text, conv) {
  // Get current question
  const nextQ = await getNextQuestion(conv.session_id, conv.department);
  if (!nextQ) {
    waConversations.delete(phone);
    return 'All questions answered. Please visit the OPD counter for vitals measurement. Thank you!';
  }

  // Map answer for select-type questions
  let answerRaw = text.trim();
  if (nextQ.q_type === 'BOOLEAN') {
    const boolMap = { '1': 'yes', '2': 'no', 'yes': 'yes', 'no': 'no', 'y': 'yes', 'n': 'no' };
    answerRaw = boolMap[text.toLowerCase().trim()] || text.trim();
  } else if (nextQ.q_type === 'SINGLE_SELECT' && nextQ.options_json) {
    const idx = parseInt(text) - 1;
    const opts = typeof nextQ.options_json === 'string' ? JSON.parse(nextQ.options_json) : nextQ.options_json;
    if (!isNaN(idx) && idx >= 0 && idx < opts.length) {
      answerRaw = opts[idx].value;
    }
  }

  // Store answer
  await pool.query(
    `INSERT INTO session_answers (session_id, question_id, answer_raw, input_mode)
     VALUES ($1, $2, $3, 'whatsapp') ON CONFLICT DO NOTHING`,
    [conv.session_id, nextQ.id, answerRaw]
  );

  // Check triage (per-answer map with legacy single-answer fallback)
  const wFlag = flagForAnswer(nextQ, answerRaw);
  if (wFlag) {
    await pool.query(
      `UPDATE sessions SET triage_level = CASE
        WHEN triage_level = 'RED' THEN 'RED'
        WHEN $1 = 'RED' THEN 'RED'
        WHEN triage_level = 'AMBER' THEN 'AMBER'
        ELSE $1 END, updated_at = NOW() WHERE id = $2`,
      [wFlag, conv.session_id]
    );
  }

  // Update session state
  await pool.query(
    `UPDATE sessions SET state = CASE WHEN state IN ('CONSENTED','INIT','REGISTERED') THEN 'INTERVIEW' ELSE state END, updated_at = NOW() WHERE id = $1`,
    [conv.session_id]
  );

  // Send next question
  return await sendNextQuestion(phone, conv);
}

async function sendNextQuestion(phone, conv) {
  const nextQ = await getNextQuestion(conv.session_id, conv.department);
  if (!nextQ) {
    waConversations.delete(phone);
    return 'All questions completed! Please visit the OPD counter for vitals measurement. Thank you!';
  }

  let msg = nextQ.text_en || nextQ.id;

  if (nextQ.q_type === 'BOOLEAN') {
    msg += '\n1. Yes\n2. No';
  } else if ((nextQ.q_type === 'SINGLE_SELECT' || nextQ.q_type === 'MULTI_SELECT') && nextQ.options_json) {
    const opts = typeof nextQ.options_json === 'string' ? JSON.parse(nextQ.options_json) : nextQ.options_json;
    msg += '\n' + opts.map((o, i) => `${i + 1}. ${o.label_en || o.value}`).join('\n');
  }

  return msg;
}

async function getNextQuestion(sessionId, department) {
  // Get answered questions
  const answeredResult = await pool.query(
    'SELECT question_id, answer_raw, answer_structured FROM session_answers WHERE session_id = $1 ORDER BY created_at',
    [sessionId]
  );
  const answered = answeredResult.rows;
  const answeredIds = new Set(answered.map(a => a.question_id));

  // Load DAG
  const dagResult = await pool.query(
    'SELECT * FROM questionnaire_nodes WHERE department = $1 AND is_active = true ORDER BY sort_order',
    [department]
  );
  if (!dagResult.rows.length) return null;
  const nodes = Object.fromEntries(dagResult.rows.map(n => [n.id, n]));
  const startNode = dagResult.rows[0];

  // Traverse
  let currentId = startNode.id;
  for (const ans of answered) {
    const node = nodes[ans.question_id];
    if (!node) continue;
    const nextId = resolveNext(node, ans.answer_raw, ans.answer_structured);
    if (!nextId) break;
    currentId = nextId;
  }

  if (answeredIds.has(currentId)) {
    const node = nodes[currentId];
    const lastAns = answered.find(a => a.question_id === currentId);
    if (node && lastAns) {
      const nextId = resolveNext(node, lastAns.answer_raw, lastAns.answer_structured);
      currentId = nextId || null;
    } else {
      currentId = null;
    }
  }

  if (!currentId || !nodes[currentId] || currentId === 'q_done') return null;
  return nodes[currentId];
}


function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = router;
