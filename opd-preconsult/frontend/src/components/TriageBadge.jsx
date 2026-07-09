'use client';
import { t } from '../lib/i18n';

// Refined triage palette. `dot` is the vivid swatch (left borders, NEW badge);
// `text` is the darker variant used for BOTH the label text and the dot inside a
// compact chip — a 12%-alpha tint is too pale for the vivid swatch to reach the
// 3:1 non-text contrast floor (amber managed only 1.96:1), and the dot carries no
// information the adjacent word doesn't already carry.
//
// Every value below is pinned to a WCAG 2.1 AA threshold; if you change one,
// re-check it. `text` on its own 12% tint over white must clear 4.5:1.
const TRIAGE_COLORS = { RED: '#D9544D', AMBER: '#E0A82E', GREEN: '#3FA869' };
const TRIAGE_TEXT = { RED: '#B54640', AMBER: '#8C691D', GREEN: '#2E7A4D' };

// Severity words are shown to patients on /patient/done and the RED emergency
// interstitial, so they must follow the language the patient chose. Doctor and
// HIS surfaces pass no `lang` and stay on the English default.
const WORD_KEYS = { RED: 'triage_red', AMBER: 'triage_amber', GREEN: 'triage_green' };

// Default: the full pill (used in the report header).
// `compact`: a small dot + label chip — the uniform triage tag used on every
// list card (Queue and Consulted) so both tabs share one visual language.
export default function TriageBadge({ level, compact = false, lang = 'en' }) {
  const lvl = TRIAGE_COLORS[level] ? level : 'GREEN';
  const dot = TRIAGE_COLORS[lvl];
  const text = TRIAGE_TEXT[lvl];
  const word = t(WORD_KEYS[lvl], lang);

  if (compact) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '2px 8px', borderRadius: 20, background: `${dot}1F`,
        color: text, fontWeight: 700, fontSize: 11, letterSpacing: 0.4, whiteSpace: 'nowrap',
      }}>
        <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: text, display: 'inline-block' }} />
        {word}
      </span>
    );
  }

  // Full pill: solid swatch background with a soft white dot instead of the
  // mismatched 🔴🟡🟢 emoji (which can't be recoloured to match the palette).
  return (
    <span className={`triage-badge triage-${lvl}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: 'rgba(255,255,255,0.9)', display: 'inline-block' }} />
      {word}
    </span>
  );
}
