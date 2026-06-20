// The fixed, common "base" intake questions shared by EVERY department. They run
// first as a simple linear sequence (visit type is auto-resolved & hidden;
// progress is only shown to returning patients), then the department's own DAG
// questions follow. Seeded per-department (editable there) but always from this
// one template so they stay consistent. Department-specific question ids must
// NEVER collide with the `q_<dept>_base_<key>` namespace.
//
// Role of each base question is derived from the id suffix after `_base_`
// (see roleOf() in routes/questionnaire.js), so the conditional logic keeps
// working even if the text is edited in the HIS dashboard.

const BASE_TEMPLATE = [
  {
    key: 'visit_type',
    sort_order: 1,
    q_type: 'SINGLE_SELECT',
    text_en: 'Is this your first visit or a follow-up?',
    text_hi: 'क्या यह आपकी पहली विजिट है या फॉलो-अप?',
    text_te: 'ఇది మీ మొదటి సందర్శన లేదా ఫాలో-అప్?',
    options_json: [
      { value: 'first', label_en: 'First visit', label_hi: 'पहली विजिट', label_te: 'మొదటి సందర్శన' },
      { value: 'followup', label_en: 'Follow-up', label_hi: 'फॉलो-अप', label_te: 'ఫాలో-అప్' },
    ],
  },
  {
    key: 'progress',
    sort_order: 2,
    q_type: 'SINGLE_SELECT',
    text_en: 'How are you feeling compared to last visit?',
    text_hi: 'पिछली विजिट की तुलना में आप कैसा महसूस कर रहे हैं?',
    text_te: 'గత సందర్శనతో పోలిస్తే మీరు ఎలా భావిస్తున్నారు?',
    options_json: [
      { value: 'better', label_en: 'Better', label_hi: 'बेहतर', label_te: 'మెరుగ్గా' },
      { value: 'same', label_en: 'Same', label_hi: 'वैसा ही', label_te: 'అలాగే' },
      { value: 'worse', label_en: 'Worse', label_hi: 'बदतर', label_te: 'అధ్వాన్నంగా' },
      { value: 'new_symptoms', label_en: 'New symptoms', label_hi: 'नए लक्षण', label_te: 'కొత్త లక్షణాలు' },
    ],
  },
  {
    key: 'chief_complaint',
    sort_order: 3,
    q_type: 'FREE_TEXT',
    text_en: 'What is your main concern today?',
    text_hi: 'आज आपकी मुख्य समस्या क्या है?',
    text_te: 'ఈరోజు మీ ప్రధాన సమస్య ఏమిటి?',
    options_json: null,
  },
  {
    key: 'medications',
    sort_order: 4,
    q_type: 'FREE_TEXT',
    text_en: 'List your current medicines (name and dose)',
    text_hi: 'अपनी वर्तमान दवाइयाँ बताएं (नाम और खुराक)',
    text_te: 'మీ ప్రస్తుత మందులను తెలపండి (పేరు మరియు మోతాదు)',
    options_json: null,
  },
  {
    key: 'allergies',
    sort_order: 5,
    q_type: 'FREE_TEXT',
    text_en: 'Any known drug allergies?',
    text_hi: 'कोई ज्ञात दवा एलर्जी?',
    text_te: 'ఏదైనా తెలిసిన మందు అలెర్జీలు?',
    options_json: null,
  },
];

// Build the base question rows for a department (e.g. q_card_base_visit_type).
function baseNodesForDept(department) {
  const dept = department.toUpperCase();
  const slug = dept.toLowerCase();
  return BASE_TEMPLATE.map(b => ({
    id: `q_${slug}_base_${b.key}`,
    department: dept,
    text_en: b.text_en,
    text_hi: b.text_hi,
    text_te: b.text_te,
    q_type: b.q_type,
    options_json: b.options_json,
    required: true,
    triage_flag: null,
    triage_answer: null,
    next_default: null,   // base is walked linearly by sort_order, not by next pointers
    next_rules: null,
    sort_order: b.sort_order,
    is_base: true,
  }));
}

module.exports = { BASE_TEMPLATE, baseNodesForDept };
