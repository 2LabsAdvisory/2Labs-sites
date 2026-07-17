'use strict';

/** Shared helpers for the Studio generation pipeline (plan + page agents). */

const escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function kebab(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
const isHome = (slug) => { const k = kebab(slug); return k === '' || k === 'home' || k === 'index' || slug === '/'; };
function routeFor(slug) { return isHome(slug) ? '/' : '/' + kebab(slug); }
function pageFileFor(slug) { return isHome(slug) ? 'src/pages/index.astro' : `src/pages/${kebab(slug)}.astro`; }

/** A short brand cheat-sheet for page prompts (CSS vars are already defined). */
function brandSummary(brand) {
  const c = (brand && brand.colors) || {};
  const hex = (a, i) => (a && a[i] && a[i].hex) || '';
  const t = (brand && brand.typography) || {};
  return [
    'Brand CSS variables are already defined in tokens.css — USE THEM, never hardcode colors/fonts:',
    '  --primary, --primary-dark, --on-primary (text on primary), --ink, --ink-soft, --border, --bg, --surface, --success',
    '  --font-heading, --font-body, --radius, --shadow',
    `Palette for reference — primary ${hex(c.core, 1) || hex(c.accents, 0)}, ink ${hex(c.neutral, 0)}, surface ${hex(c.core, 2) || '#fff'}.`,
    `Fonts — headings ${t.heading || 'sans-serif'}, body ${t.body || 'sans-serif'}. Voice — ${(brand && brand.voice || []).join(', ') || 'clear, warm'}.`,
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
