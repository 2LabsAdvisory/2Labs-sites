'use strict';

/** Shared helpers for the Studio generation pipeline (plan + page agents). */

const escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function kebab(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
const isHome = (slug) => { const k = kebab(slug); return k === '' || k === 'home' || k === 'index' || slug === '/'; };
function routeFor(slug) { return isHome(slug) ? '/' : '/' + kebab(slug); }
function pageFileFor(slug) { return isHome(slug) ? 'src/pages/index.astro' : `src/pages/${kebab(slug)}.astro`; }

/** The exact design tokens available to a page (already defined in tokens.css). */
function brandSummary(brand) {
  const t = (brand && brand.typography) || {};
  return [
    'DESIGN TOKENS — these CSS variables are ALREADY defined in tokens.css. Use ONLY these; do NOT invent new variable names and do NOT declare your own :root variables:',
    '  Surfaces/text: --bg (page bg, light), --surface (#fff cards), --surface-2 (subtle), --ink (body text, dark), --ink-soft (secondary text), --border',
    '  Brand: --primary, --primary-dark, --primary-soft (light wash for section bgs), --primary-contrast (text ON primary), --secondary, --secondary-contrast, --accent, --accent-contrast, --success',
    '  Type/shape: --font-heading, --font-body, --radius, --shadow',
    `Fonts — headings ${t.heading || 'sans-serif'}, body ${t.body || 'sans-serif'}. Voice — ${(brand && brand.voice || []).join(', ') || 'clear, warm, credible'}.`,
    '',
    'READABILITY RULES (critical — the site must never be unreadable):',
    '- Every section MUST set an explicit background AND a contrasting text colour. Never rely on defaults.',
    '- On a colored background use its contrast token: background:var(--primary) → color:var(--primary-contrast); var(--secondary)→var(--secondary-contrast); var(--accent)→var(--accent-contrast).',
    '- On light backgrounds (--bg, --surface, --surface-2, --primary-soft) use color:var(--ink) for text and var(--ink-soft) for secondary text — NEVER white text on a light background.',
    '- Give the page visual rhythm by alternating section backgrounds among --bg, --surface, --primary-soft, and one bold band using --primary (with --primary-contrast text). Use --primary/--accent for buttons, links, and highlights so the brand colour is clearly present.',
  ].join('\n');
}

/** Deterministic per-site Header (nav from the sitemap), overlaying _base's. */
function headerDraft(pages, goalRoute) {
  const links = (pages || []).map((p) => `<a href="${routeFor(p.slug)}">${escapeHtml(p.title)}</a>`).join('\n      ');
  return `---
interface Props { orgName: string; primaryCta?: string; }
const { orgName, primaryCta = 'Get in touch' } = Astro.props;
---
<header class="site-header">
  <div class="hdr-inner">
    <a href="/" class="brand">{orgName}</a>
    <nav aria-label="Primary">
      ${links}
    </nav>
    <a href="${goalRoute}" class="cta">{primaryCta}</a>
  </div>
</header>
<style>
  .site-header { border-bottom: 1px solid var(--border); background: var(--surface); position: sticky; top: 0; z-index: 10; }
  .hdr-inner { max-width: 1120px; margin: 0 auto; padding: 16px 24px; display: flex; align-items: center; gap: 24px; }
  .brand { font-family: var(--font-heading); font-weight: 800; font-size: 18px; color: var(--ink); text-decoration: none; margin-right: auto; }
  nav { display: flex; gap: 20px; }
  nav a { font-size: 14px; color: var(--ink-soft); text-decoration: none; font-weight: 500; }
  nav a:hover { color: var(--ink); }
  .cta { background: var(--primary); color: var(--on-primary); font-weight: 600; font-size: 14px; padding: 10px 18px; border-radius: 10px; text-decoration: none; white-space: nowrap; }
  .cta:hover { background: var(--primary-dark); }
  @media (max-width: 720px) { nav { display: none; } }
</style>
`;
}

module.exports = { kebab, isHome, routeFor, pageFileFor, brandSummary, headerDraft, escapeHtml };
