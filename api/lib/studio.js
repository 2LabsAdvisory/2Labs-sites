'use strict';

/** Shared helpers for the Studio generation pipeline (plan + page agents). */

const escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function kebab(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
const isHome = (slug) => { const k = kebab(slug); return k === '' || k === 'home' || k === 'index' || slug === '/'; };
function routeFor(slug) { return isHome(slug) ? '/' : '/' + kebab(slug); }
function pageFileFor(slug) { return isHome(slug) ? 'src/pages/index.astro' : `src/pages/${kebab(slug)}.astro`; }

// Path-aware variants for IMPORTED sites, which mirror a real, nested URL
// structure (e.g. "/program/linc"). Each segment is kebab-cased but nesting is
// preserved, so children live in subfolders. A lone "home"/"index"/"" is the
// site root. Astro serves "src/pages/newcomers.astro" (a section landing) and
// "src/pages/newcomers/english.astro" (its child) side by side.
function normSegs(path) { return String(path || '/').split('/').map((s) => kebab(s)).filter(Boolean); }
function routeForPath(path) {
  const segs = normSegs(path);
  if (!segs.length || (segs.length === 1 && (segs[0] === 'home' || segs[0] === 'index'))) return '/';
  return '/' + segs.join('/');
}
function pageFileForPath(path) {
  const r = routeForPath(path);
  return r === '/' ? 'src/pages/index.astro' : `src/pages/${r.slice(1)}.astro`;
}

// A nested page needs the right number of "../" to reach src/layouts. The page
// generator always emits `../layouts/BaseLayout.astro`; rewrite it to the depth
// this file actually sits at, so nested pages import the layout correctly.
function fixLayoutImport(content, pageFile) {
  const rel = String(pageFile || '').replace(/^src\/pages\//, '');
  const depth = (rel.match(/\//g) || []).length;           // intermediate folders
  const prefix = '../'.repeat(depth + 1);
  return String(content || '').replace(/((?:\.\.\/)+)layouts\/BaseLayout\.astro/g, `${prefix}layouts/BaseLayout.astro`);
}

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

// Normalize a nav tree for the header: accepts items with {title, route|path|slug}
// and optional children. Returns [{ title, route, children:[{title,route}] }].
function normalizeNav(nav) {
  const routeOf = (n) => n.route || (n.path ? routeForPath(n.path) : routeFor(n.slug || n.title));
  return (Array.isArray(nav) ? nav : [])
    .map((n) => ({
      title: String(n.title || '').trim(),
      route: routeOf(n),
      children: (Array.isArray(n.children) ? n.children : [])
        .map((c) => ({ title: String(c.title || '').trim(), route: routeOf(c) }))
        .filter((c) => c.title).slice(0, 24),
    }))
    .filter((n) => n.title);
}

/**
 * Deterministic per-site Header, overlaying _base's. Renders a grouped nav with
 * accessible CSS dropdowns / mega-menus when a nav tree is supplied (imported
 * sites), else a flat bar from the page list (blank/describe sites). Also the
 * fallback whenever generate-chrome doesn't produce a usable Header.
 */
function headerDraft(pages, goalRoute, logoUrl, navTree) {
  const tree = normalizeNav(navTree);
  const flat = !tree.length;
  const navItems = flat
    ? (pages || []).map((p) => ({ title: String(p.title || '').trim(), route: routeFor(p.slug), children: [] })).filter((n) => n.title)
    : tree;

  const li = (item) => {
    const label = escapeHtml(item.title);
    if (!item.children || !item.children.length) {
      return `<li class="nav-item"><a class="nav-top" href="${item.route}">${label}</a></li>`;
    }
    const wide = item.children.length > 6;
    const kids = item.children.map((c) => `<li><a href="${c.route}">${escapeHtml(c.title)}</a></li>`).join('');
    return `<li class="nav-item has-children">
        <a class="nav-top" href="${item.route}" aria-haspopup="true">${label}<span class="caret" aria-hidden="true"></span></a>
        <div class="mega${wide ? ' mega-wide' : ''}"><ul class="mega-list">${kids}</ul></div>
      </li>`;
  };

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
    <button class="nav-toggle" aria-expanded="false" aria-controls="primary-nav" aria-label="Menu"><span></span><span></span><span></span></button>
    <nav aria-label="Primary" class="primary-nav" id="primary-nav">
      <ul class="nav-list">
        ${navItems.map(li).join('\n        ')}
      </ul>
    </nav>
    <a href="${goalRoute}" class="cta">{primaryCta}</a>
  </div>
</header>
<style>
  .site-header { border-bottom: 1px solid var(--border); background: var(--surface); position: sticky; top: 0; z-index: 40; }
  .hdr-inner { max-width: 1240px; margin: 0 auto; padding: 12px 24px; display: flex; align-items: center; gap: 14px; }
  .brand { font-family: var(--font-heading); font-weight: 800; font-size: 18px; color: var(--ink); text-decoration: none; display: inline-flex; align-items: center; flex-shrink: 0; }
  .brand-logo { height: 34px; width: auto; max-width: 170px; object-fit: contain; display: block; }
  .primary-nav { display: flex; flex: 1 1 auto; min-width: 0; justify-content: flex-end; }
  .nav-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 1px; align-items: center; }
  .nav-item { position: relative; }
  .nav-top { display: inline-flex; align-items: center; gap: 4px; font-size: 13.5px; color: var(--ink-soft); text-decoration: none; font-weight: 600; padding: 9px 9px; border-radius: 8px; white-space: nowrap; }
  .nav-top:hover, .nav-item:focus-within .nav-top { color: var(--ink); background: var(--primary-soft); }
  .caret { width: 6px; height: 6px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(45deg) translateY(-1px); opacity: .6; }
  .mega { position: absolute; top: 100%; left: 0; margin-top: 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow); padding: 10px; min-width: 240px; opacity: 0; visibility: hidden; transform: translateY(6px); transition: opacity .16s ease, transform .16s ease, visibility .16s; z-index: 50; }
  .nav-item:hover .mega, .nav-item:focus-within .mega { opacity: 1; visibility: visible; transform: translateY(0); }
  .mega-wide { min-width: min(640px, 78vw); }
  .mega-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 1fr; gap: 2px; }
  .mega-wide .mega-list { grid-template-columns: repeat(2, minmax(180px, 1fr)); }
  .mega-list a { display: block; font-size: 13.5px; color: var(--ink-soft); text-decoration: none; padding: 8px 10px; border-radius: 7px; }
  .mega-list a:hover { color: var(--ink); background: var(--primary-soft); }
  .cta { flex-shrink: 0; background: var(--primary); color: var(--primary-contrast); font-weight: 700; font-size: 13.5px; padding: 10px 16px; border-radius: 10px; text-decoration: none; white-space: nowrap; }
  .cta:hover { background: var(--primary-dark); }
  .nav-toggle { display: none; flex-direction: column; gap: 4px; background: none; border: 0; cursor: pointer; padding: 8px; margin-left: auto; }
  .nav-toggle span { width: 22px; height: 2px; background: var(--ink); border-radius: 2px; }
  @media (max-width: 900px) {
    .nav-toggle { display: flex; }
    .brand { margin-right: 0; }
    .primary-nav { display: none; position: absolute; top: 100%; left: 0; right: 0; background: var(--surface); border-top: 1px solid var(--border); box-shadow: var(--shadow); padding: 10px 16px 18px; max-height: 78vh; overflow: auto; }
    .primary-nav.open { display: block; }
    .nav-list { flex-direction: column; align-items: stretch; gap: 0; }
    .nav-top { padding: 12px 8px; font-size: 15px; }
    .mega { position: static; opacity: 1; visibility: visible; transform: none; box-shadow: none; border: 0; border-radius: 0; padding: 0 0 8px 14px; margin: 0; min-width: 0; }
    .mega-wide .mega-list, .mega-list { grid-template-columns: 1fr; }
    .cta { display: none; }
  }
</style>
<script>
  (function () {
    var btn = document.querySelector('.nav-toggle'); var nav = document.getElementById('primary-nav');
    if (!btn || !nav) return;
    btn.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  })();
</script>
`;
}

module.exports = { kebab, isHome, routeFor, pageFileFor, routeForPath, pageFileForPath, fixLayoutImport, normalizeNav, brandSummary, headerDraft, escapeHtml };
