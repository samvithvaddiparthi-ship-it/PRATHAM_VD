// Canonical ordered patient-flow steps — the single source of truth for the
// progress indicator. Keeping it here (instead of hardcoding dot counts per page)
// means the "Step X of Y" bar stays correct as the flow changes, and register's
// phone/OTP/identify sub-steps all count as the SAME step 1.
export const PATIENT_STEPS = ['consent', 'register', 'documents', 'interview', 'vitals'];

// { index (1-based), total } for a step id. When a department doesn't collect
// vitals, that step drops out of the count (pass { hasVitals: false }).
export function stepMeta(stepId, { hasVitals = true } = {}) {
  const steps = hasVitals ? PATIENT_STEPS : PATIENT_STEPS.filter(s => s !== 'vitals');
  const idx = steps.indexOf(stepId);
  return { index: idx >= 0 ? idx + 1 : 1, total: steps.length };
}
