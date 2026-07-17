'use strict';

/**
 * Seeds a brand-new site with a starter it can render/edit immediately: a
 * per-site tokens.css (brand colors/fonts from the Wizard Brief) and a home
 * page, written as drafts in the site's namespace and rendered against the
 * shared _base skeleton. Deterministic templating (no AI) — the rich
 * multi-page Studio generation is a later stage; this gives an editable start.
 */

const { setDraftFile } = require('./draftStore');
const { bestTextOn, relativeLuminance } = require('./contrast');

const isHex = (v) => /^#[0-9a-fA-F]{6}$/.test(String(v || ''));
function toRgb(hex) { const h = String(hex || '').replace('#', ''); return /^[0-9a-fA-F]{6}$/.test(h) ? [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) : null; }
const toHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
function darken(hex, f = 0.82) { const c = toRgb(hex); return c ? toHex(c.map((v) => v * f)) : hex; }
function mix(a, b, t) { const x = toRgb(a), y = toRgb(b); return x && y ? toHex(x.map((v, i) => v + (y[i] - v) * t)) : a; }
const byName = (arr, name) => (arr || []).find((c) => String(c.name || '').toLowerCase().includes(name))?.hex;
const first = (arr, i) => (arr && arr[i] && isHex(arr[i].hex) ? arr[i].hex : null);

// Robust brand → tokens. Ink/paper are chosen by LUMINANCE (darkest / lightest
// neutral) so body text is always readable regardless of how the palette is
// ordered or named — this is what was producing black-on-white / white-on-white.
function tokensFromBrand(brand) {
  const colors = (brand && brand.colors) || {};
  const core = colors.core || [];
  const accents = colors.accents || [];
  let neutral = (colors.neutral || []).filter((c) => isHex(c.hex));
  if (neutral.length < 2) neutral = [{ hex: '#1F242E' }, { hex: '#676F7E' }, { hex: '#E5E0DC' }, { hex: '#F7F8FA' }];

  const lum = (h) => { const l = relativeLuminance(h); return l == null ? 0.5 : l; };
  const sorted = [...neutral].sort((a, b) => lum(a.hex) - lum(b.hex));
  const ink = sorted[0].hex;                    // darkest
  const paper = sorted[sorted.length - 1].hex;  // lightest
  const inkSoft = byName(neutral, 'muted') || byName(neutral, 'slate') || mix(ink, paper, 0.42);
  const border = byName(neutral, 'line') || mix(ink, paper, 0.86);

  const primary = first(core, 0) || byName(accents, '') || first(accents, 0) || '#2F5DA8';
  const secondary = first(core, 1) || primary;
  const accent = first(accents, 0) || secondary;
  const t = (brand && brand.typography) || {};
  const heading = (t.heading || 'Plus Jakarta Sans').replace(/'/g, '');
  const body = (t.body || 'Inter').replace(/'/g, '');

  return `:root {
  --bg: ${paper};
  --surface: #FFFFFF;
  --surface-2: ${mix(paper, ink, 0.04)};
  --ink: ${ink};
  --ink-soft: ${inkSoft};
  --border: ${border};
  --primary: ${primary};
  --primary-dark: ${darken(primary)};
  --primary-soft: ${mix(primary, '#FFFFFF', 0.88)};
  --primary-contrast: ${bestTextOn(primary)};
  --secondary: ${secondary};
  --secondary-contrast: ${bestTextOn(secondary)};
  --accent: ${accent};
  --accent-contrast: ${bestTextOn(accent)};
  --success: #2F8558;
  --radius: 14px;
  --shadow: 0 1px 2px rgba(16,24,40,0.04), 0 10px 28px rgba(16,24,40,0.08);
  --font-heading: '${heading}', sans-serif;
  --font-body: '${body}', sans-serif;
  /* aliases — so a page that reaches for a common name still resolves */
  --on-primary: var(--primary-contrast);
  --text: var(--ink); --text-muted: var(--ink-soft); --muted: var(--ink-soft);
  --background: var(--bg); --card: var(--surface); --heading: var(--ink);
  --color-primary: var(--primary); --primary-tint-strong: var(--primary-soft);
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: var(--font-body); -webkit-font-smoothing: antialiased; }
h1, h2, h3, h4 { font-family: var(--font-heading); letter-spacing: -0.01em; margin: 0; color: var(--ink); }
p, li { color: var(--ink); }
a { color: inherit; }
img { max-width: 100%; }
`;
}

function homeFromBrief(brief) {
  const content = (brief && brief.content) || {};
  const org = content.org_name || 'Your Site';
  const mission = content.mission || 'We help our community do more good. Tell the editor what you do and we’ll shape this page around it.';
  const cta = content.primary_goal || 'Get in touch';
  const offers = Array.isArray(content.offers) ? content.offers.filter(Boolean).slice(0, 12) : [];
  const S = (v) => JSON.stringify(v); // safe JS literal (handles quotes/newlines)

  return `---
import BaseLayout from '../layouts/BaseLayout.astro';
const org = ${S(org)};
const mission = ${S(mission)};
const cta = ${S(cta)};
const offers = ${S(offers)};
---
<BaseLayout title="Home" description={mission} orgName={org} primaryCta={cta}>
  <section class="hero">
    <h1>Welcome to {org}</h1>
    <p>{mission}</p>
    <a class="hero-cta" href="/contact">{cta}</a>
  </section>
  {offers.length > 0 && (
    <section class="offers">
      <h2>What we offer</h2>
      <div class="offer-grid">
        {offers.map((o) => (<div class="offer-card"><h3>{o}</h3></div>))}
      </div>
    </section>
  )}
</BaseLayout>
<style>
  .hero { max-width: 780px; margin: 0 auto; padding: 90px 24px 40px; text-align: center; }
  .hero h1 { font-size: 46px; line-height: 1.1; }
  .hero p { font-size: 18px; color: var(--ink-soft); line-height: 1.6; margin: 18px 0 28px; }
  .hero-cta { display: inline-block; background: var(--primary); color: var(--on-primary); font-weight: 600; padding: 13px 26px; border-radius: 10px; text-decoration: none; }
  .offers { max-width: 1000px; margin: 0 auto; padding: 30px 24px 60px; }
  .offers h2 { font-size: 26px; text-align: center; margin-bottom: 24px; }
  .offer-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
  .offer-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 22px; box-shadow: var(--shadow); }
  .offer-card h3 { font-size: 17px; }
</style>
`;
}

/** Write the starter drafts for a site from its Wizard Brief. */
async function seedStarter(slug, brief) {
  await setDraftFile(slug, 'src/styles/tokens.css', tokensFromBrand(brief && brief.brand));
  await setDraftFile(slug, 'src/pages/index.astro', homeFromBrief(brief));
}

module.exports = { seedStarter, tokensFromBrand, homeFromBrief };
