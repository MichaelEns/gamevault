/**
 * Contrast test.
 *
 * The Sources panel shipped unreadable: it hardcoded dark card backgrounds,
 * and because that CSS sat after the light-mode media query it overrode the
 * theme entirely, painting dark cards behind near-black text. On a phone in
 * light mode the result was roughly 1.2:1 -- effectively invisible.
 *
 * Eyeballing a dark-mode desktop browser is what let that through, so this
 * computes real WCAG 2.1 contrast ratios from the actual stylesheet, in
 * BOTH colour schemes.
 *
 * Thresholds (WCAG AA): 4.5:1 for body text, 3.0:1 for large text (>=18.66px
 * bold or >=24px) and for non-text UI boundaries.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PATHS } from '../lib/paths.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

const css = await readFile(path.join(PATHS.root, 'public', 'style.css'), 'utf8');

// ---- colour maths (WCAG 2.1 relative luminance) ----------------------------
function parseHex(hex) {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);      // ignore alpha
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg, bg) {
  const a = luminance(parseHex(fg));
  const b = luminance(parseHex(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// ---- pull the theme variables straight out of the stylesheet ---------------
function varsFrom(block) {
  const out = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) {
    out[m[1]] = m[2];
  }
  return out;
}
const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
const dark = varsFrom(rootBlock);

const lightStart = css.indexOf('@media (prefers-color-scheme: light)');
const lightBlock = css.slice(lightStart, css.indexOf('\n}', css.indexOf(':root', lightStart)));
const light = { ...dark, ...varsFrom(lightBlock) };

console.log('Both themes define the variables the panel uses');
for (const v of ['--bg', '--panel', '--panel2', '--line', '--text', '--dim', '--accent', '--link', '--ok-text']) {
  ok(Boolean(dark[v]), `dark  ${v} = ${dark[v]}`);
}
for (const v of ['--bg', '--panel', '--panel2', '--line', '--text', '--dim', '--link', '--ok-text']) {
  ok(Boolean(light[v]), `light ${v} = ${light[v]}`);
}

// ---- the pairs the Sources panel actually renders --------------------------
// Each entry mirrors a real rule in the "Sources / setup panel" block.
const PAIRS = [
  { name: 'source title (.src strong)',      fg: '--text',   bg: '--panel',  min: 4.5 },
  { name: 'source description (.src-unlocks)', fg: '--text', bg: '--panel',  min: 4.5 },
  { name: 'source badge (.src-badge)',       fg: '--dim',    bg: '--panel',  min: 4.5 },
  { name: 'source note (.src-note)',         fg: '--dim',    bg: '--panel',  min: 4.5 },
  { name: 'connected badge (.src.ok .src-badge)', fg: '--ok-text', bg: '--panel', min: 4.5 },
  { name: 'secret name chip (.src code)',    fg: '--text',   bg: '--panel2', min: 4.5 },
  { name: 'panel heading (.setup-title)',    fg: '--text',   bg: '--bg',     min: 3.0 },
  { name: 'panel intro (.setup-intro)',      fg: '--dim',    bg: '--bg',     min: 4.5 },
  { name: 'panel links (.src-links a)',      fg: '--link',   bg: '--panel',  min: 4.5 },
  { name: 'card edge vs page (.src border)', fg: '--line',   bg: '--bg',     min: 1.2 },

  // App-wide text, not just this panel. The link colour was 2.41:1 on white
  // for every link in the app, which is what prompted adding these.
  { name: 'body text',                       fg: '--text',   bg: '--bg',     min: 4.5 },
  { name: 'secondary text',                  fg: '--dim',    bg: '--bg',     min: 4.5 },
  { name: 'links on the page',               fg: '--link',   bg: '--bg',     min: 4.5 },
  { name: 'links on a card',                 fg: '--link',   bg: '--panel',  min: 4.5 },
  { name: 'text on a card',                  fg: '--text',   bg: '--panel',  min: 4.5 },
  // --accent is a FILL carrying dark text; darkening it for light mode would
  // break this pair, which is precisely why --link exists separately.
  { name: 'button label on --accent fill',   fg: '#08111f',  bg: '--accent', min: 4.5 },

  // The app's core output. These matter the moment prices exist, and were
  // broken in exactly the same way as the Sources panel: a hardcoded dark
  // background paired with a theme-driven (near-black in light mode) text
  // colour, or a pale accent colour with no background at all.
  { name: 'default verdict pill',            fg: '--text',    bg: '--panel2',   min: 4.5 },
  { name: 'discount % (.cut)',               fg: '--ok-text', bg: '--panel2',   min: 4.5 },
  { name: 'discount % on cheapest row',      fg: '--ok-text', bg: '--cheap-bg', min: 4.5 },
  { name: 'price shop name (.shop)',         fg: '--dim',     bg: '--panel2',   min: 4.5 },
  { name: 'price amount (.amt)',             fg: '--text',    bg: '--panel2',   min: 4.5 },
  { name: 'status ok (.panel .ok)',          fg: '--ok-text', bg: '--panel',    min: 4.5 },
  { name: 'status failed (.panel .no)',      fg: '--bad-text', bg: '--panel',   min: 4.5 },
  { name: 'footer text',                     fg: '--dim',     bg: '--bg',       min: 4.5 },
  { name: 'pull-to-refresh label (#ptr)',    fg: '--dim',     bg: '--bg',       min: 4.5 },
];

for (const [themeName, theme] of [['dark', dark], ['light', light]]) {
  console.log(`\nWCAG contrast in ${themeName} mode`);
  for (const p of PAIRS) {
    // A pair may name a variable or a literal (button label text).
    const fg = p.fg.startsWith('--') ? theme[p.fg] : p.fg;
    const bg = p.bg.startsWith('--') ? theme[p.bg] : p.bg;
    if (!fg || !bg) { ok(false, `${p.name}: missing colour (${p.fg}=${fg}, ${p.bg}=${bg})`); continue; }
    const ratio = contrast(fg, bg);
    ok(ratio >= p.min,
       `${p.name.padEnd(34)} ${fg} on ${bg} = ${ratio.toFixed(2)}:1 (need ${p.min})`);
  }
}

// ---- the regression itself -------------------------------------------------
console.log('\nThe panel takes its colours from the theme, not literals');
const start = css.indexOf('/* ---------- Sources / setup panel');
ok(start !== -1, 'panel block present');
const end = css.indexOf('@media (prefers-color-scheme: light)', start);
ok(end > start, 'panel block sits BEFORE the light-mode block, so light mode can override it');
const panelCss = css.slice(start, end === -1 ? undefined : end);
const literals = [...panelCss.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((m) => m[0]);
ok(literals.length === 0,
   literals.length ? `hardcoded colours would ignore the theme: ${literals.join(', ')}`
                   : 'no hardcoded colours in the panel');

// Any rule that paints a background must also state a text colour, or it
// inherits whatever the theme happens to be using -- the exact failure here.
console.log('\nEvery panel rule with a background also sets a colour');
for (const rule of panelCss.split('}')) {
  if (!/background\s*:/.test(rule)) continue;
  const sel = rule.split('{')[0].trim().replace(/\s+/g, ' ');
  if (!sel || sel.startsWith('/*')) continue;
  ok(/(^|[;{\s])color\s*:/.test(rule), `${sel} sets both background and color`);
}

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All contrast tests passed.');
