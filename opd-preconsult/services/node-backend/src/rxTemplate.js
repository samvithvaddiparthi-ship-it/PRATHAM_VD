// Hospital prescription-template defaults + merge helper.
//
// The admin configures branding, theme, and which optional fields show on the
// digital prescription. Convention-mandated clinical fields (patient identity,
// date, the medication table with strength/dose/frequency/duration, prescriber
// name + signature line, Rx id) are ALWAYS rendered and are not part of this
// config — they can't be toggled off.

const RX_TEMPLATE_DEFAULTS = {
  hospital_name: 'Pratham Hospital',
  address: '',
  phone: '',
  email: '',
  logo_url: '',
  registration_line: '',          // hospital registration / license line
  tagline: '',
  theme: 'classic',               // classic | modern
  accent: '#1c5d8c',
  footer: 'Digitally signed prescription. Verify the physical signature before dispensing.',
  valid_days: 30,
  generic_note_text: 'Generic substitution is permitted unless marked otherwise.',
  show: {
    logo: false,
    patient_age: true,
    patient_gender: true,
    patient_phone: false,
    department: true,
    doctor_registration: true,
    valid_until: false,
    generic_note: false,
  },
};

// Merge a stored (possibly partial) config over the defaults. `show` is merged
// one level deep so a stored config missing a toggle still gets the default.
function mergeRxTemplate(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  return {
    ...RX_TEMPLATE_DEFAULTS,
    ...s,
    show: { ...RX_TEMPLATE_DEFAULTS.show, ...(s.show || {}) },
  };
}

module.exports = { RX_TEMPLATE_DEFAULTS, mergeRxTemplate };
