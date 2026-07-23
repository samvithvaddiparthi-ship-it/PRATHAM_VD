// Department-questionnaire branch resolution — the logic that decides which question
// a patient sees next based on their answer. Authored visually on the HIS flow canvas
// (next_rules / next_default) and shared by the web and WhatsApp intakes, so it is
// worth pinning: a wrong turn here sends a patient down the wrong branch of the
// interview, or ends it early.
const test = require('node:test');
const assert = require('node:assert');
const { resolveNext } = require('../src/utils/dagResolve');

const q = (over) => ({ next_default: null, next_rules: null, ...over });

test('no rules → falls through to next_default', () => {
  assert.strictEqual(resolveNext(q({ next_default: 'q2' }), 'yes'), 'q2');
});

test('no default and no rules → ends the interview (null)', () => {
  assert.strictEqual(resolveNext(q({}), 'anything'), null);
});

test('a matching per-answer rule wins over the default', () => {
  const node = q({ next_default: 'q2', next_rules: [{ if_answer: 'yes', go_to: 'q_emergency' }] });
  assert.strictEqual(resolveNext(node, 'yes'), 'q_emergency');
});

test('a non-matching answer ignores the rule and uses the default', () => {
  const node = q({ next_default: 'q2', next_rules: [{ if_answer: 'yes', go_to: 'q_emergency' }] });
  assert.strictEqual(resolveNext(node, 'no'), 'q2');
});

test('MATCHED rule with null go_to ENDS the interview — not a fall-through to default', () => {
  // The regression this guards: a "Yes → End" arrow drawn on the canvas must actually
  // end the interview, even when a next_default exists for the other answers.
  const node = q({ next_default: 'q2', next_rules: [{ if_answer: 'yes', go_to: null }] });
  assert.strictEqual(resolveNext(node, 'yes'), null);   // Yes ends here
  assert.strictEqual(resolveNext(node, 'no'), 'q2');    // No still continues
});

test('matched rule with empty-string go_to also ends', () => {
  const node = q({ next_default: 'q2', next_rules: [{ if_answer: 'no', go_to: '' }] });
  assert.strictEqual(resolveNext(node, 'no'), null);
});

test('answer matching is case-insensitive', () => {
  const node = q({ next_rules: [{ if_answer: 'Yes', go_to: 'q_x' }] });
  assert.strictEqual(resolveNext(node, 'yes'), 'q_x');
  assert.strictEqual(resolveNext(q({ next_rules: [{ if_answer: 'severe', go_to: 'q_x' }] }), 'SEVERE'), 'q_x');
});

test('the structured answer value is preferred over the raw text', () => {
  const node = q({ next_rules: [{ if_answer: 'yes', go_to: 'q_x' }] });
  assert.strictEqual(resolveNext(node, 'the patient said yes at length', { value: 'yes' }), 'q_x');
});

test('first matching rule wins when several are present', () => {
  const node = q({ next_rules: [
    { if_answer: 'a', go_to: 'qa' },
    { if_answer: 'b', go_to: 'qb' },
  ] });
  assert.strictEqual(resolveNext(node, 'b'), 'qb');
});
