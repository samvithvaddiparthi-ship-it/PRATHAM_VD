'use client';
import { stepMeta } from '../lib/flow';

// Thin progress bar + "Step X / Y" label for the patient flow. Fed a canonical
// step id (see lib/flow) so it's always correct — replaces the old hardcoded
// per-page dots that never advanced across register's sub-steps. Scales with --fs.
//
// Props: stepId (preferred) OR explicit current/total; lang for the label;
// hasVitals=false drops the vitals step from the count for departments that skip it.
const STEP_WORD = { en: 'Step', hi: 'चरण', te: 'దశ' };

export default function ProgressBar({ stepId, current, total, hasVitals = true, lang = 'en', note }) {
  let idx = current, tot = total;
  if (stepId) { const m = stepMeta(stepId, { hasVitals }); idx = m.index; tot = m.total; }
  idx = idx || 1;
  tot = tot || 1;
  const pct = Math.max(0, Math.min(100, Math.round((idx / tot) * 100)));

  return (
    <div style={{ padding: '12px 4px 8px' }}>
      <div style={{ marginBottom: 6 }}>
        <span style={{ fontSize: 'calc(12px * var(--fs, 1))', color: 'var(--text-light)', fontWeight: 600 }}>
          {STEP_WORD[lang] || STEP_WORD.en} {idx} / {tot}
          {/* Optional within-step note, e.g. "· Question 3" during a long questionnaire
              (no total — the questions branch, so there's no reliable denominator). */}
          {note ? <span style={{ fontWeight: 500 }}> · {note}</span> : null}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 999, background: '#E5EAEF', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--secondary)', borderRadius: 999, transition: 'width 0.3s ease' }} />
      </div>
    </div>
  );
}
