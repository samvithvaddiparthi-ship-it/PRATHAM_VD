const BASE = typeof window !== 'undefined' ? '' : 'http://gateway:80';

let token = null;

export function setToken(t) { token = t; }
export function getToken() { return token; }

async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // Carry the HTTP status on the Error so callers can tell a dead session
    // (401/440 — only recoverable by starting a fresh entry) apart from a
    // transient failure worth retrying. The message is unchanged, so existing
    // `catch (err) { setError(err.message) }` callers keep working.
    const e = new Error(err.error || res.statusText);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

export const api = {
  // Session
  scan: (qr_payload) => apiFetch('/api/session/scan', { method: 'POST', body: JSON.stringify({ qr_payload }) }),
  register: (data) => apiFetch('/api/session/register', { method: 'POST', body: JSON.stringify(data) }),
  // Phone OTP verification (gates registration)
  // Is this person (session's verified phone + name) already in an open visit?
  checkActive: (name) => apiFetch('/api/session/active-check', { method: 'POST', body: JSON.stringify({ name }) }),
  requestOtp: (phone) => apiFetch('/api/otp/request', { method: 'POST', body: JSON.stringify({ phone }) }),
  verifyOtp: (phone, code) => apiFetch('/api/otp/verify', { method: 'POST', body: JSON.stringify({ phone, code }) }),
  // §8f — the OTP response only returns masked initials for prior people on this
  // number; this reveals the FULL identity of the one the patient selects.
  revealPerson: (index) => apiFetch('/api/otp/reveal', { method: 'POST', body: JSON.stringify({ index }) }),
  consent: () => apiFetch('/api/session/consent', { method: 'POST', body: '{}' }),
  getSession: (id) => apiFetch(`/api/session/${id}`),
  listSessions: (params) => apiFetch(`/api/session?${new URLSearchParams(params)}`),

  // Public waiting-room board (no auth) — token numbers only
  queueBoard: (department) => apiFetch(`/api/queue/board?department=${encodeURIComponent(department)}`),
  // Last issued token per department (no auth) — powers the kiosk department picker.
  // Omit `department` to get every department's latest token in one call.
  queueLast: (department) => apiFetch(`/api/queue/last${department ? `?department=${encodeURIComponent(department)}` : ''}`),

  // Questionnaire
  nextQuestion: (sessionId) => apiFetch(`/api/q/next/${sessionId}`),
  getQuestionnaireSchema: (department) => apiFetch(`/api/q/schema/${department}`),
  submitAnswer: (data) => apiFetch('/api/q/answer', { method: 'POST', body: JSON.stringify(data) }),
  getAnswers: (sessionId) => apiFetch(`/api/q/answers/${sessionId}`),
  getInterviewHistory: (sessionId) => apiFetch(`/api/q/history/${sessionId}`),
  rewindAnswer: (questionId) => apiFetch('/api/q/rewind', { method: 'POST', body: JSON.stringify({ question_id: questionId }) }),

  // Admin — Departments
  getDepartments: () => apiFetch('/api/admin/departments'),
  createDepartment: (data) => apiFetch('/api/admin/departments', { method: 'POST', body: JSON.stringify(data) }),
  updateDepartment: (code, data) => apiFetch(`/api/admin/departments/${code}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteDepartment: (code) => apiFetch(`/api/admin/departments/${code}`, { method: 'DELETE' }),
  // What a delete would destroy — drives the confirmation copy.
  departmentImpact: (code) => apiFetch(`/api/admin/departments/${code}/impact`),
  // Permanent delete: also drops the department's questions and deactivates its
  // doctors. `confirm` must equal the code; the server re-checks it.
  forceDeleteDepartment: (code, confirm) =>
    apiFetch(`/api/admin/departments/${code}?force=1`, { method: 'DELETE', body: JSON.stringify({ confirm }) }),

  // Admin — Questionnaire management
  getQuestions: (department) => apiFetch(`/api/admin/questions/${department}`),
  createQuestion: (data) => apiFetch('/api/admin/questions', { method: 'POST', body: JSON.stringify(data) }),
  updateQuestion: (id, data) => apiFetch(`/api/admin/questions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteQuestion: (id) => apiFetch(`/api/admin/questions/${id}`, { method: 'DELETE' }),
  reorderQuestions: (items) => apiFetch('/api/admin/questions/reorder', { method: 'POST', body: JSON.stringify({ items }) }),
  publishQuestions: (department) => apiFetch('/api/admin/questions/publish', { method: 'POST', body: JSON.stringify({ department }) }),
  discardDraft: (department) => apiFetch('/api/admin/questions/discard', { method: 'POST', body: JSON.stringify({ department }) }),

  // Report tickets (doctor flags a systemic issue to HIS)
  createTicket: (data) => apiFetch('/api/tickets', { method: 'POST', body: JSON.stringify(data) }),
  getTickets: (status) => apiFetch(`/api/tickets${status ? `?status=${status}` : ''}`),
  getTicketCount: () => apiFetch('/api/tickets/count'),
  updateTicket: (id, data) => apiFetch(`/api/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // Vitals
  submitVitals: (sessionId, data) => apiFetch(`/api/vitals/${sessionId}`, { method: 'POST', body: JSON.stringify(data) }),
  getVitals: (sessionId) => apiFetch(`/api/vitals/${sessionId}`),

  // LLM
  interview: (data) => apiFetch('/api/llm/interview', { method: 'POST', body: JSON.stringify(data) }),

  // Triage
  evaluate: (sessionId) => apiFetch('/api/triage/evaluate', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) }),

  // Report
  // force: regenerate even if a report exists (used when late vitals change the
  // inputs). Patient-flow callers omit it — generation is then idempotent.
  generateReport: (sessionId, opts = {}) => apiFetch('/api/report/generate', { method: 'POST', body: JSON.stringify({ session_id: sessionId, force: !!opts.force }) }),
  getReport: (sessionId) => apiFetch(`/api/report/${sessionId}`),
  submitFeedback: (sessionId, feedback) => apiFetch(`/api/report/${sessionId}/feedback`, { method: 'POST', body: JSON.stringify({ feedback }) }),
  saveReportEdit: (sessionId, report_md) => apiFetch(`/api/report/${sessionId}/edit`, { method: 'POST', body: JSON.stringify({ report_md }) }),

  // Global app settings (feature flags). Public read is used by the patient flow
  // (e.g. whether to show the document/OCR step); the admin read/write is gated.
  getPublicSettings: () => apiFetch('/api/settings/public'),
  getAdminSettings: () => apiFetch('/api/settings'),
  updateSettings: (data) => apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify(data) }),

  // OCR
  uploadDocument: async (file, sessionId, docLabel) => {
    const formData = new FormData();
    formData.append('file', file);
    if (sessionId) formData.append('session_id', sessionId);
    if (docLabel) formData.append('doc_label', docLabel);
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${BASE}/api/ocr/process`, { method: 'POST', headers, body: formData });
    return res.json();
  },
  confirmDocument: (docId, confirmed = true) => apiFetch(`/api/ocr/confirm/${docId}`, { method: 'POST', body: JSON.stringify({ confirmed }) }),
  // Each document carries a short-lived signed `image_url` for the <img src>.
  // Never build `/api/ocr/documents/image/<id>` by hand — it 403s without a sig.
  getDocuments: (sessionId) => apiFetch(`/api/ocr/documents/${sessionId}`),

  // Per-answer voice recordings (patient capture → doctor playback)
  uploadAnswerAudio: async (blob, sessionId, questionId, durationMs, transcript) => {
    const fd = new FormData();
    fd.append('file', blob, `answer_${questionId || 'q'}.webm`);
    if (sessionId) fd.append('session_id', sessionId);
    if (questionId) fd.append('question_id', questionId);
    if (durationMs != null) fd.append('duration_ms', String(Math.round(durationMs)));
    if (transcript) fd.append('transcript', transcript);
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${BASE}/api/audio/answer`, { method: 'POST', headers, body: fd });
    if (!res.ok) throw new Error('audio upload failed');
    return res.json();
  },
  // Each clip in the response carries a short-lived signed `url` for playback —
  // an <audio src> can't send the Authorization header, so the authenticated
  // list call is what mints the capability. Never build the clip URL by hand.
  getAnswerAudio: (sessionId) => apiFetch(`/api/audio/session/${sessionId}`),

  // Bhashini transcription — returns the transcript in the SPOKEN language
  // (no translation). Also stores the clip (WAV) for doctor playback.
  transcribeVoice: async (blob, { lang, sessionId, questionId, patientName, durationMs } = {}) => {
    const fd = new FormData();
    fd.append('file', blob, `answer_${questionId || 'q'}.webm`);
    fd.append('lang', lang);
    if (patientName) fd.append('patient_name', patientName);
    if (sessionId) fd.append('session_id', sessionId);
    if (questionId) fd.append('question_id', questionId);
    if (durationMs != null) fd.append('duration_ms', String(Math.round(durationMs)));
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${BASE}/api/transcribe`, { method: 'POST', headers, body: fd });
    if (!res.ok) throw new Error('transcription failed');
    return res.json();
  },
  transcribeHealth: () => apiFetch('/api/transcribe/health'),
  // On-demand Bhashini NMT translation of a native transcript to English.
  translateText: async (text, sourceLang) => {
    const fd = new FormData();
    fd.append('text', text);
    fd.append('source_lang', sourceLang);
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${BASE}/api/transcribe/translate`, { method: 'POST', headers, body: fd });
    if (!res.ok) throw new Error('translation failed');
    return res.json();
  },

  // Admin (HIS dashboard)
  adminLogin: (passcode, adminName) => apiFetch('/api/admin/login', { method: 'POST', body: JSON.stringify({ passcode, admin_name: adminName }) }),

  // Doctor
  doctorLogin: (phone, pin) => apiFetch('/api/doctor/login', { method: 'POST', body: JSON.stringify({ phone, pin }) }),
  doctorQueue: () => apiFetch('/api/doctor/queue'),
  doctorAssign: (sessionId) => apiFetch(`/api/doctor/assign/${sessionId}`, { method: 'POST' }),
  doctorUnassign: (sessionId) => apiFetch(`/api/doctor/unassign/${sessionId}`, { method: 'POST' }),
  doctorReassign: (sessionId, targetDoctorId) => apiFetch(`/api/doctor/reassign/${sessionId}`, { method: 'POST', body: JSON.stringify({ target_doctor_id: targetDoctorId }) }),
  doctorReassignDept: (sessionId, department) => apiFetch(`/api/doctor/reassign/${sessionId}`, { method: 'POST', body: JSON.stringify({ department }) }),
  doctorRelease: (sessionId) => apiFetch(`/api/doctor/release/${sessionId}`, { method: 'POST' }),
  doctorOpen: async (sessionId) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${BASE}/api/doctor/open/${sessionId}`, { method: 'POST', headers });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409) return { ok: false, locked: true, locked_by: body.locked_by, dispatched: body.dispatched, message: body.message };
    if (!res.ok) throw new Error(body.error || res.statusText);
    return { ok: true, session: body };
  },
  doctorDispatch: (sessionId) => apiFetch(`/api/doctor/dispatch/${sessionId}`, { method: 'POST' }),
  doctorConsulted: () => apiFetch('/api/doctor/consulted'),
  doctorDeleteSession: (sessionId) => apiFetch(`/api/doctor/session/${sessionId}`, { method: 'DELETE' }),
  doctorChangePin: (old_pin, new_pin) => apiFetch('/api/doctor/change-pin', { method: 'POST', body: JSON.stringify({ old_pin, new_pin }) }),
  listDoctors: (department) => apiFetch(`/api/doctor${department ? '?department=' + department : ''}`),
  createDoctor: (data) => apiFetch('/api/doctor', { method: 'POST', body: JSON.stringify(data) }),
  updateDoctor: (id, data) => apiFetch(`/api/doctor/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deactivateDoctor: (id) => apiFetch(`/api/doctor/${id}/deactivate`, { method: 'POST' }),
  reactivateDoctor: (id) => apiFetch(`/api/doctor/${id}/reactivate`, { method: 'POST' }),
  allSessions: (params) => apiFetch(`/api/doctor/all-sessions?${new URLSearchParams(params || {})}`),

  // Prescription
  createPrescription: (data) => apiFetch('/api/prescription', { method: 'POST', body: JSON.stringify(data) }),
  getPrescriptions: (sessionId) => apiFetch(`/api/prescription/session/${sessionId}`),
  verifyQR: (qr_payload) => apiFetch('/api/prescription/verify-qr', { method: 'POST', body: JSON.stringify({ qr_payload }) }),
  getRxTemplate: () => apiFetch('/api/prescription/template'),
  saveRxTemplate: (config) => apiFetch('/api/prescription/template', { method: 'PUT', body: JSON.stringify(config) }),
  getAllergies: (phone) => apiFetch(`/api/prescription/allergies/${phone}`),
  addAllergy: (data) => apiFetch('/api/prescription/allergies', { method: 'POST', body: JSON.stringify(data) }),
  checkInteractions: (data) => apiFetch('/api/prescription/check-interactions', { method: 'POST', body: JSON.stringify(data) }),
  checkBulkInteractions: (data) => apiFetch('/api/prescription/check-bulk', { method: 'POST', body: JSON.stringify(data) }),

  // Drug formulary (autocomplete list — single source of truth in the backend)
  getDrugs: () => apiFetch('/api/drugs'),

  // Formulary admin (HIS)
  formularyDrugs: () => apiFetch('/api/drugs/admin/drugs'),
  saveFormularyDrug: (data) => apiFetch('/api/drugs/admin/drugs', { method: 'POST', body: JSON.stringify(data) }),
  deleteFormularyDrug: (generic) => apiFetch(`/api/drugs/admin/drugs?generic=${encodeURIComponent(generic)}`, { method: 'DELETE' }),
  formularyInteractions: () => apiFetch('/api/drugs/admin/interactions'),
  saveFormularyInteraction: (data) => apiFetch('/api/drugs/admin/interactions', { method: 'POST', body: JSON.stringify(data) }),
  deleteFormularyInteraction: (id) => apiFetch(`/api/drugs/admin/interactions/${id}`, { method: 'DELETE' }),
  formularyClassInteractions: () => apiFetch('/api/drugs/admin/class-interactions'),
  saveFormularyClassInteraction: (data) => apiFetch('/api/drugs/admin/class-interactions', { method: 'POST', body: JSON.stringify(data) }),
  deleteFormularyClassInteraction: (id) => apiFetch(`/api/drugs/admin/class-interactions/${id}`, { method: 'DELETE' }),
  // Review queue (AI findings → admin curation)
  reviewQueue: () => apiFetch('/api/drugs/review-queue'),
  approveReview: (id, data) => apiFetch(`/api/drugs/review-queue/${id}/approve`, { method: 'POST', body: JSON.stringify(data || {}) }),
  dismissReview: (id) => apiFetch(`/api/drugs/review-queue/${id}/dismiss`, { method: 'POST' }),

  // Scribe
  transcribeAudio: async (file, sessionId) => {
    const formData = new FormData();
    formData.append('file', file);
    if (sessionId) formData.append('session_id', sessionId);
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${BASE}/api/scribe/transcribe`, { method: 'POST', headers, body: formData });
    if (!res.ok) throw new Error('Transcription failed');
    return res.json();
  },
  extractSOAP: (data) => apiFetch('/api/scribe/extract-soap', { method: 'POST', body: JSON.stringify(data) }),
  getSOAP: (sessionId) => apiFetch(`/api/scribe/soap/${sessionId}`),
  saveSOAP: (sessionId, soap_text) => apiFetch(`/api/scribe/soap/${sessionId}`, { method: 'POST', body: JSON.stringify({ soap_text }) }),

  // Follow-ups
  getFollowups: (params) => apiFetch(`/api/followup?${new URLSearchParams(params || {})}`),
  createFollowup: (data) => apiFetch('/api/followup', { method: 'POST', body: JSON.stringify(data) }),
  respondFollowup: (id, response) => apiFetch(`/api/followup/${id}/respond`, { method: 'POST', body: JSON.stringify({ response }) }),

  // Analytics
  getAnalytics: (hours) => apiFetch(`/api/analytics/summary?hours=${hours || 24}`),

  // Protocols
  getProtocols: (department) => apiFetch(`/api/protocol${department ? '?department=' + department : ''}`),
  getProtocol: (id) => apiFetch(`/api/protocol/${id}`),
  createProtocol: (data) => apiFetch('/api/protocol', { method: 'POST', body: JSON.stringify(data) }),
  updateProtocol: (id, data) => apiFetch(`/api/protocol/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteProtocol: (id) => apiFetch(`/api/protocol/${id}`, { method: 'DELETE' }),
  evaluateProtocols: (sessionId) => apiFetch(`/api/protocol/evaluate/${sessionId}`),

  // Mock HIS
  hisDashboard: () => apiFetch('/his/dashboard'),
};
