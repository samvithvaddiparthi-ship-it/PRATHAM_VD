'use client';

// Refined triage palette. `dot` is the vivid swatch (used for the dot, left
// borders, NEW badge); `text` is a darker, legible variant for label text on a
// soft tint (amber especially needs this — gold on a light wash is unreadable).
const TRIAGE_COLORS = { RED: '#D9544D', AMBER: '#E0A82E', GREEN: '#3FA869' };
const TRIAGE_TEXT = { RED: '#C0392B', AMBER: '#8A6400', GREEN: '#2E7D52' };
const TRIAGE_WORDS = { RED: 'SEVERE', AMBER: 'MODERATE', GREEN: 'MILD' };

// Default: the full pill (used in the report header).
// `compact`: a small dot + label chip — the uniform triage tag used on every
// list card (Queue and Consulted) so both tabs share one visual language.
export default function TriageBadge({ level, compact = false }) {
  const lvl = level || 'GREEN';
  const dot = TRIAGE_COLORS[lvl] || TRIAGE_COLORS.GREEN;
  const text = TRIAGE_TEXT[lvl] || TRIAGE_TEXT.GREEN;
  const word = TRIAGE_WORDS[lvl] || TRIAGE_WORDS.GREEN;

  if (compact) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '2px 8px', borderRadius: 20, background: `${dot}1F`,
        color: text, fontWeight: 700, fontSize: 10.5, letterSpacing: 0.4, whiteSpace: 'nowrap',
      }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, display: 'inline-block' }} />
        {word}
      </span>
    );
  }

  // Full pill: solid swatch background with a soft white dot instead of the
  // mismatched 🔴🟡🟢 emoji (which can't be recoloured to match the palette).
  return (
    <span className={`triage-badge triage-${lvl}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'rgba(255,255,255,0.9)', display: 'inline-block' }} />
      {word}
    </span>
  );
}
