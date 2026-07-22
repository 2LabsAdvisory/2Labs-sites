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
    '  Surfaces/text: --bg (page bg, light), --surface (#fff cards), --surface-2 (subtle), --ink (body text, dark), --ink-soft (secondary text), --ink-contrast (light text that sits ON --ink), --border',
    '  Brand: --primary, --primary-dark, --primary-soft (light wash for section bgs), --primary-contrast (text ON primary), --secondary, --secondary-contrast, --accent, --accent-contrast, --success',
    '  Type/shape: --font-heading, --font-body, --radius, --shadow',
    `Fonts — headings ${t.heading || 'sans-serif'}, body ${t.body || 'sans-serif'}. Voice — ${(brand && brand.voice || []).join(', ') || 'clear, warm, credible'}.`,
    '',
    'READABILITY — NON-NEGOTIABLE. Illegible text (dark-on-dark, dark-on-colour, light-on-light) is the #1 failure. Follow these exactly:',
    '- Headings and paragraphs INHERIT their colour from the section. So set colour ONCE on each <section> and everything inside is legible — but if you set a coloured/dark background you MUST also set a matching text colour, or the text stays dark and vanishes.',
    '- EASIEST + SAFEST: put a band helper class on any coloured section and it sets background + guaranteed-contrasting text together — `band-primary`, `band-secondary`, `band-accent`, `band-dark` (dark ink bg, light text), `band-soft` (light primary wash), `band-surface`. Prefer these over hand-setting colours.',
    '- If you set a background by hand instead: background:var(--primary) → color:var(--primary-contrast); var(--secondary)→var(--secondary-contrast); var(--accent)→var(--accent-contrast); a dark/ink background → color:var(--ink-contrast). On light backgrounds (--bg,--surface,--surface-2,--primary-soft) → color:var(--ink) (secondary text var(--ink-soft)). NEVER dark-on-dark, dark-on-colour, or white-on-light.',
    '- TEXT OVER A PHOTO: photos are visually busy and often dark. Never place raw text on a bare photo. Put the text in a container with a strong scrim — e.g. a linear-gradient overlay from the brand colour or rgba(0,0,0,.55) over the image — and use a light text colour (var(--primary-contrast) or #fff). The text must stay readable over the lightest AND darkest part of the photo.',
    '- Decorative oversized/watermark text behind content must be very low contrast AND must never sit behind body copy you need to read.',
    '- Give the page rhythm by alternating section backgrounds among --bg, --surface, band-soft, and one bold band-primary (or band-dark). Use --primary/--accent for buttons, links, and highlights so the brand colour is clearly present.',
  ].join('\n');
}

/** Deterministic per-site Header (nav from the sitemap), overlaying _base's. */
function headerDraft(pages, goalRoute, logoUrl) {
  const links = (pages || []).map((p) => `<a href="${routeFor(p.slug)}">${escapeHtml(p.title)}</a>`).join('\n      ');
  // Use the brand logo as the wordmark when we have a safe URL; keep the org
  // name as the link's accessible name so the header stays readable & a11y-safe.
  const safeLogo = typeof logoUrl === 'string' && /^[^"'<>\s]+$/.test(logoUrl) ? logoUrl : '';
  const brand = safeLogo
    ? `<a href="/" class="brand" aria-label={orgName}><img src="${safeLogo}" alt="" class="brand-logo" /></a>`
    : `<a href="/" class="brand">{orgName}</a>`;
  return `---
interface Props { orgName: string; primaryCta?: string; }
const { orgName, primaryCta = 'Get in touch' } = Astro.props;
---
<header class="site-header">
  <div class="hdr-inner">
    ${brand}
    <nav aria-label="Primary">
      ${links}
    </nav>
    <a href="${goalRoute}" class="cta">{primaryCta}</a>
  </div>
</header>
<style>
  .site-header { border-bottom: 1px solid var(--border); background: var(--surface); position: sticky; top: 0; z-index: 10; }
  .hdr-inner { max-width: 1120px; margin: 0 auto; padding: 16px 24px; display: flex; align-items: center; gap: 24px; }
  .brand { font-family: var(--font-heading); font-weight: 800; font-size: 18px; color: var(--ink); text-decoration: none; margin-right: auto; display: inline-flex; align-items: center; }
  .brand-logo { height: 34px; width: auto; max-width: 180px; object-fit: contain; display: block; }
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
