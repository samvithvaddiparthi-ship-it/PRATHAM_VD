// Single source of truth for "given a question node and the patient's answer, which
// node comes next?" — the core of department-questionnaire branching, shared by the
// web intake (routes/questionnaire.js) and the WhatsApp intake (routes/whatsapp.js)
// so the two can never drift.
//
// Model (authored on the HIS flow canvas, stored on each node):
//   next_rules   = [{ if_answer, go_to }]  per-answer branches
//   next_default = <node id> | null        where any un-branched answer continues
//
// Semantics (must match the frontend flow map's qResolveNext, or the map lies):
//   * A per-answer rule whose if_answer matches WINS.
//       - go_to = <id>       → go there
//       - go_to = null / ''  → END the interview here (→ vitals). This is a real,
//         drawn "answer → End" arrow, and is DISTINCT from "no rule matched".
//   * No matching rule → fall through to next_default (null/'' = end).
function resolveNext(node, answerRaw, answerStructured) {
  const answerVal = ((answerStructured && answerStructured.value) || answerRaw || '')
    .toString().toLowerCase();

  if (node.next_rules && Array.isArray(node.next_rules)) {
    for (const rule of node.next_rules) {
      if (rule.if_answer && String(rule.if_answer).toLowerCase() === answerVal) {
        return (rule.go_to == null || rule.go_to === '') ? null : rule.go_to;
      }
    }
  }
  return node.next_default || null;
}

module.exports = { resolveNext };
