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
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export const api = {
  // Session
  scan: (qr_payload) => apiFetch('/api/session/scan', { method: 'POST', body: JSON.stringify({ qr_payload }) }),
  register: (data) => apiFetch('/api/session/register', { method: 'POST', body: JSON.stringify(data) }),
  consent: () => apiFetch('/api/session/consent', { method: 'POST', body: '{}' }),
  getSession: (id) => apiFetch(`/api/session/${id}`),
  listSessions: (params) => apiFetch(`/api/session?${new URLSearchParams(params)}`),
  updateState: (state) => apiFetch('/api/session/state', { method: 'POST', body: JSON.stringify({ state }) }),

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
  deleteDepartment: (code) => apiFetch(`/api/admin/departments/${code}`, { method: 'DELETE' }),

  // Admin — Questionnaire management
  getQuestions: (department) => apiFetch(`/api/admin/questions/${department}`),
  createQuestion: (data) => apiFetch('/api/admin/questions', { method: 'POST', body: JSON.stringify(data) }),
  updateQuestion: (id, data) => apiFetch(`/api/admin/questions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteQuestion: (id) => apiFetch(`/api/admin/questions/${id}`, { method: 'DELETE' }),

  // Vitals
  submitVitals: (sessionId, data) => apiFetch(`/api/vitals/${sessionId}`, { method: 'POST', body: JSON.stringify(data) }),
  getVitals: (sessionId) => apiFetch(`/api/vitals/${sessionId}`),

  // LLM
  interview: (data) => apiFetch('/api/llm/interview', { method: 'POST', body: JSON.stringify(data) }),

  // Triage
  evaluate: (sessionId) => apiFetch('/api/triage/evaluate', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) }),

  // Report
  generateReport: (sessionId) => apiFetch('/api/report/generate', { method: 'POST', body: JSON.stringify({ session_id: sessionId }) }),
  getReport: (sessionId) => apiFetch(`/api/report/${sessionId}`),
  submitFeedback: (sessionId, feedback) => apiFetch(`/api/report/${sessionId}/feedback`, { method: 'POST', body: JSON.stringify({ feedback }) }),

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
  getDocuments: (sessionId) => apiFetch(`/api/ocr/documents/${sessionId}`),

  // Doctor
  doctorLogin: (phone, pin) => apiFetch('/api/doctor/login', { method: 'POST', body: JSON.stringify({ phone, pin }) }),
  doctorQueue: () => apiFetch('/api/doctor/queue'),
  doctorAssign: (sessionId) => apiFetch(`/api/doctor/assign/${sessionId}`, { method: 'POST' }),
  doctorUnassign: (sessionId) => apiFetch(`/api/doctor/unassign/${sessionId}`, { method: 'POST' }),
  doctorReassign: (sessionId, targetDoctorId) => apiFetch(`/api/doctor/reassign/${sessionId}`, { method: 'POST', body: JSON.stringify({ target_doctor_id: targetDoctorId }) }),
  doctorConsulted: () => apiFetch('/api/doctor/consulted'),
  doctorChangePin: (old_pin, new_pin) => apiFetch('/api/doctor/change-pin', { method: 'POST', body: JSON.stringify({ old_pin, new_pin }) }),
  listDoctors: (department) => apiFetch(`/api/doctor${department ? '?department=' + department : ''}`),
  createDoctor: (data) => apiFetch('/api/doctor', { method: 'POST', body: JSON.stringify(data) }),
  deactivateDoctor: (id) => apiFetch(`/api/doctor/${id}/deactivate`, { method: 'POST' }),
  allSessions: (params) => apiFetch(`/api/doctor/all-sessions?${new URLSearchParams(params || {})}`),

  // Prescription
  createPrescription: (data) => apiFetch('/api/prescription', { method: 'POST', body: JSON.stringify(data) }),
  getPrescriptions: (sessionId) => apiFetch(`/api/prescription/session/${sessionId}`),
  verifyQR: (qr_payload) => apiFetch('/api/prescription/verify-qr', { method: 'POST', body: JSON.stringify({ qr_payload }) }),
  getAllergies: (phone) => apiFetch(`/api/prescription/allergies/${phone}`),
  addAllergy: (data) => apiFetch('/api/prescription/allergies', { method: 'POST', body: JSON.stringify(data) }),
  checkInteractions: (data) => apiFetch('/api/prescription/check-interactions', { method: 'POST', body: JSON.stringify(data) }),
  checkBulkInteractions: (data) => apiFetch('/api/prescription/check-bulk', { method: 'POST', body: JSON.stringify(data) }),

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
