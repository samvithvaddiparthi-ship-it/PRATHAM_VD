// Resolve the triage flag a given answer raises on a questionnaire node.
//
// Precedence:
//   1. answer_triage — the per-answer map { "<answer_value>": "RED"|"AMBER" }
//      written by the HIS editor (migration 030). Lets one question flag more
//      than one answer at different urgencies.
//   2. legacy triage_flag + triage_answer — the single-answer pair still present
//      on un-edited seed questions.
//
// Returns 'RED' | 'AMBER' | null. Case-insensitive on the answer value.
function flagForAnswer(node, answerVal) {
  if (!node || answerVal == null) return null;
  const v = String(answerVal).toLowerCase();

  const map = node.answer_triage;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const [ans, flag] of Object.entries(map)) {
      if (String(ans).toLowerCase() === v) return flag || null;
    }
  }
  if (node.triage_flag && node.triage_answer && String(node.triage_answer).toLowerCase() === v) {
    return node.triage_flag;
  }
  return null;
}

module.exports = { flagForAnswer };
