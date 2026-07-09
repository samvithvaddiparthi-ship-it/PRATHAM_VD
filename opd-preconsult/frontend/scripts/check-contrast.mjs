#!/usr/bin/env node
/**
 * WCAG 2.1 AA contrast regression check for the design tokens.
 *
 * Reads the colour tokens straight out of src/app/globals.css and asserts every
 * foreground/background pair the UI actually renders clears its threshold:
 *   • 4.5:1  normal text                    (SC 1.4.3)
 *   • 3:1    non-text: borders, indicators  (SC 1.4.11)
 *
 * Run: npm run check:contrast     (also runs as part of `npm run verify`)
 *
 * Why this exists: these are the highest-stakes pixels in a clinical UI — triage
 * levels, drug-interaction flags, destructive buttons — and they carry the least
 * slack. Several tokens sit within 0.15 of their floor, so an innocuous retint
 * silently drops them below AA. If this script fails, do not "fix" it by lowering
 * a threshold; pick a darker colour.
 *
 * Exits non-zero on the first failing pair, listing all of them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CSS = join(here, '..', 'src', 'app', 'globals.css');

// ── colour maths (WCAG 2.x relative luminance) ────────────────────────────────
const parseHex = (h) => {
  let s = h.replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const channel = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// ── token extraction ──────────────────────────────────────────────────────────
// Scoped per rule block: `--text` and `--text-light` are declared twice, in :root
// and again in `html.assist`. A naive whole-file regex silently reports the
// assist values for the default theme.
function tokensIn(css, selector) {
  const block = css.match(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\}`));
  if (!block) throw new Error(`Could not find "${selector}" block in globals.css`);
  const out = {};
  for (const m of block[1].matchAll(/(--[a-z-]+):\s*(#[0-9a-fA-F]{3,6})/g)) out[m[1]] = m[2];
  return out;
}

const css = readFileSync(CSS, 'utf8');
const root = tokensIn(css, ':root');
const assist = tokensIn(css, 'html\\.assist');
const t = (name) => {
  const v = root[name];
  if (!v) throw new Error(`Token ${name} is missing from :root in globals.css`);
  return v;
};

const WHITE = '#FFFFFF';
const CARD = t('--card-bg');
const BG = t('--bg');
// Pale status chips that status text is printed on, taken from the dashboards.
const GREEN_TINT = '#D5F5E3';
const AMBER_TINT = '#FCF3CF';

const TEXT = 4.5;
const NONTEXT = 3.0;

const checks = [
  // Body copy
  ['--text on --bg', t('--text'), BG, TEXT],
  ['--text on card', t('--text'), CARD, TEXT],
  ['--text-light on --bg', t('--text-light'), BG, TEXT],
  ['--text-light on card', t('--text-light'), CARD, TEXT],

  // Surfaces that carry white text
  ['white on --primary', WHITE, t('--primary'), TEXT],
  ['white on --secondary (.btn-secondary, .voice-btn)', WHITE, t('--secondary'), TEXT],
  ['white on --red (.btn-red, .triage-RED, danger confirm)', WHITE, t('--red'), TEXT],
  ['white on --green (.triage-GREEN)', WHITE, t('--green'), TEXT],

  // Semantic colours used AS text on light surfaces
  ['--red text on --bg', t('--red'), BG, TEXT],
  ['--red text on card', t('--red'), CARD, TEXT],
  ['--green text on --bg', t('--green'), BG, TEXT],
  ['--amber-text on card (.flag-warning)', t('--amber-text'), CARD, TEXT],

  // Amber is a light swatch: it pairs with dark ink, never white.
  ['--amber-on on --amber (.triage-AMBER)', t('--amber-on'), t('--amber'), TEXT],

  // Status text on its own pale tint chip
  ['--green-on-tint on green chip', t('--green-on-tint'), GREEN_TINT, TEXT],
  ['--amber-on-tint on amber chip', t('--amber-on-tint'), AMBER_TINT, TEXT],

  // Light surface carrying dark text
  ['--primary on --accent (.btn-accent)', t('--primary'), t('--accent'), TEXT],

  // Non-text: SC 1.4.11
  ['--border on card (input outline)', t('--border'), CARD, NONTEXT],
  ['--dot-idle on --bg (progress dot)', t('--dot-idle'), BG, NONTEXT],
  ['--accent-strong on --bg (.dot.done)', t('--accent-strong'), BG, NONTEXT],
  ['--secondary focus ring on card', t('--secondary'), CARD, NONTEXT],

  // Assisted / high-contrast mode (patient flow) renders on pure white
  ['assist --text on white', assist['--text'], WHITE, TEXT],
  ['assist --text-light on white', assist['--text-light'], WHITE, TEXT],
];

let failed = 0;
const rows = checks.map(([label, fg, bg, min]) => {
  const ratio = contrast(fg, bg);
  const ok = ratio >= min;
  if (!ok) failed++;
  return { ok, ratio, min, label, fg, bg };
});

const width = Math.max(...rows.map((r) => r.label.length));
for (const r of rows) {
  const status = r.ok ? 'PASS' : 'FAIL';
  console.log(
    `${status}  ${r.ratio.toFixed(2).padStart(5)}:1  (min ${r.min})  ${r.label.padEnd(width)}  ${r.fg} on ${r.bg}`,
  );
}

console.log('');
if (failed) {
  console.error(`✗ ${failed} of ${rows.length} contrast pairs fail WCAG 2.1 AA.`);
  console.error('  Darken the foreground (or lighten the surface) — do not relax the threshold.');
  process.exit(1);
}
console.log(`✓ All ${rows.length} contrast pairs meet WCAG 2.1 AA.`);
