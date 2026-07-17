'use strict';

/**
 * Seeds a brand-new site with a starter it can render/edit immediately: a
 * per-site tokens.css (brand colors/fonts from the Wizard Brief) and a home
 * page, written as drafts in the site's namespace and rendered against the
 * shared _base skeleton. Deterministic templating (no AI) — the rich
 * multi-page Studio generation is a later stage; this gives an editable start.
 */

const { setDraftFile } = require('./draftStore');
const { bestTextOn } = require('./contrast');

function toRgb(hex) {
  const h = String(hex || '').replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
const toHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
function darken(hex, f = 0.85) { const c = toRgb(hex); return c ? toHex(c.map((v) => v * f)) : hex; }
function tint(hex, f = 0.9) { const c = toRgb(hex); return c ? toHex(c.map((v) => v + (255 - v) * f)) : hex; }
const byName = (arr, name) => (arr || []).find((c) => String(c.name || '').toLowerCase() === name)?.hex;

function tokensFromBrand(brand) {
  const colors = (brand && brand.colors) || {};
  const core = colors.core || [];
  const neutral = colors.neutral || [];
  const accents = colors.accents || [];
  const pick = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? v : d);

  const primary = pick(core[1] && core[1].hex, pick(accents[0] && accents[0].hex, pick(core[0] && core[0].hex, '#2F5DA8')));
  const ink = pick(byName(neutral, 'ink') || (neutral[0] && neutral[0].hex), '#1F242E');
  const inkSoft = pick(byName(neutral, 'muted') || (neutral[2] && neutral[2].hex), '#676F7E');
  const border = pick(byName(neutral, 'line') || (neutral[neutral.length - 2] && neutral[neutral.length - 2].hex), '#E5E0DC');
  const bg = pick(byName(core, 'surface') || byName(neutral, 'paper') || (neutral[neutral.length - 1] && neutral[neutral.length - 1].hex), '#F8F7F6');
  const t = (brand && brand.typography) || {};
  const heading = (t.heading || 'Plus Jakarta Sans').replace(/'/g, '');
  const body = (t.body || 'Inter').replace(/'/g, '');

  return `:root {
  --bg: ${bg};
  --surface: #FFFFFF;
  --ink: ${ink};
  --ink-soft: ${inkSoft};
  --border: ${border};
  --primary: ${primary};
  --primary-dark: ${darken(primary)};
  --primary-tint-strong: ${tint(primary)};
  --on-primary: ${bestTextOn(primary)};
  --success: #2F8558;
  --radius: 14px;
  --shadow: 0 1px 2px rgba(31,36,46,0.04), 0 10px 28px rgba(31,36,46,0.06);
  --font-heading: '${heading}', sans-serif;
  --font-body: '${body}', sans-serif;
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: var(--font-body); -webkit-font-smoothing: antialiased; }
h1, h2, h3, h4 { font-family: var(--font-heading); letter-spacing: -0.01em; margin: 0; }
a { color: inherit; }
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
