/**
 * generate-chrome — POST /api/generate-chrome  { site, pages }   (auth-gated)
 *
 * Studio stage: design the site's shared CHROME — the Header (navigation) and
 * Footer — as distinctive, on-brand components, instead of the deterministic
 * template every site shared. One AI call returns both full .astro components,
 * written as draft overlays (src/components/Header.astro + Footer.astro) so
 * they render on every page and stay editable from the editor like any page.
 */
const { Anthropic } = require('@anthropic-ai/sdk');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getSite } = require('../lib/siteRegistry');
const { setDraftFile } = require('../lib/draftStore');
const { brandSummary, routeFor, isHome, kebab } = require('../lib/studio');
const { recordEvent, hashId } = require('../lib/feedbackStore');

const CHROME_TOOL = {
  name: 'submit_chrome',
  description: 'Return the full Header and Footer Astro components.',
  input_schema: {
    type: 'object',
    properties: {
      header: { type: 'string', description: 'The COMPLETE src/components/Header.astro file (frontmatter + markup + scoped <style> + optional inline <script> for the mobile menu).' },
      footer: { type: 'string', description: 'The COMPLETE src/components/Footer.astro file (frontmatter + markup + scoped <style>).' },
    },
    required: ['header', 'footer'],
  },
};

function systemPrompt(brand) {
  return [
    'You are an award-winning art director and senior front-end engineer at a top-tier studio. Design the shared site CHROME — the Header (primary navigation) and the Footer — for a site that looks like it cost hundreds of thousands of dollars. These appear on EVERY page, so they must be polished, distinctive, and unmistakably on-brand — never a generic default bar.',
    '',
    'HEADER — requirements:',
    '- Frontmatter MUST be exactly: `interface Props { orgName: string; primaryCta?: string }` and destructure `const { orgName, primaryCta = "Get in touch" } = Astro.props;`.',
    '- A wordmark (render {orgName}) linking to "/", the full primary nav (use the EXACT routes provided), and a primary CTA button linking to the goal route.',
    '- GROUPED / MEGA-MENU NAV: when a nav group has children (listed under it), the top-level item opens an accessible dropdown containing links to every child. A LARGE group (7+ children, e.g. Programs) must open a **mega-menu panel** laid out in 2–3 columns — polished, generous, on-brand, not a plain list. Open on BOTH hover and keyboard focus (`:focus-within`), with `aria-haspopup` + `aria-expanded`. Never omit children — every provided route must be reachable from the nav.',
    '- LAYOUT MUST NOT OVERLAP: the bar has to fit the logo, the full nav, AND the CTA on one line without items colliding. With many top-level groups (8+), keep nav labels compact (smaller font, tight padding, no wrapping onto the CTA), let the nav take the flexible middle space (flex:1, min-width:0), and keep the CTA a fixed, non-shrinking element (flex-shrink:0). If it still cannot fit at ~1100px, reduce nav font/spacing further or move secondary items into a "More" dropdown — NEVER let text overlap. Test mentally at 1024px and 1280px.',
    '- Give it real character: consider a refined sticky bar with a subtle blur/shadow on scroll, an accent underline or pill on the active/hover link, a tasteful inline-SVG logo glyph beside the wordmark, or a bold color band — make a deliberate art-directed choice, not the default.',
    '- Fully responsive with a WORKING mobile menu: a hamburger button that toggles the nav open on small screens via a small inline <script> (vanilla JS, no imports); grouped items collapse into an accordion/indented list on mobile. Ensure it is keyboard-accessible (button element, aria-expanded).',
    '',
    'FOOTER — requirements:',
    '- Frontmatter MUST be exactly: `interface Props { orgName: string }` and `const { orgName } = Astro.props; const year = new Date().getFullYear();`.',
    '- Make it substantial and editorial: a brand column (wordmark + one-line blurb in the brand voice), a quick-links column (the same nav routes), and a closing column (a short CTA line or generic contact prompt). Add tasteful inline-SVG social icons. End with a legal row: © {year} {orgName} and generic Privacy / Terms links (href="#").',
    '- Do NOT invent specific facts — no made-up phone numbers, emails, or street addresses. Use generic prompts (e.g. "Get in touch") or omit. If you include a placeholder specific, append [confirm].',
    '',
    'HARD RULES (both):',
    '- Return COMPLETE files via submit_chrome. Self-contained — NO imports of other components.',
    '- Use ONLY the design tokens below for colours/fonts. NEVER invent CSS variable names, NEVER declare your own :root. Scoped <style> only.',
    '- Every element sets a readable colour on its background (use the *-contrast tokens on coloured bands; --ink/--ink-soft on light). A dark footer band must use light text; never dark-on-dark or white-on-white.',
    '- Internal links use the EXACT routes provided. No broken links.',
    '',
    brandSummary(brand),
  ].join('\n');
}

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) { context.res = { status: 401, body: { error: 'Authentication required.' } }; return; }
  const slug = req.body && req.body.site;
  if (!slug) { context.res = { status: 400, body: { error: 'A site is required.' } }; return; }
  if (!process.env.ANTHROPIC_API_KEY) { context.res = { status: 500, body: { error: 'Server is not configured.' } }; return; }

  try {
    const site = await getSite(email, slug);
    if (!site) { context.res = { status: 404, body: { error: 'Site not found.' } }; return; }
    const brief = site.brief || {};
    const brand = brief.brand || {};
    const content = brief.content || {};
    const orgName = content.org_name || site.name || 'Your Organization';
    const primaryCta = content.primary_goal || 'Get in touch';

    // Imported sites pass a nav TREE (groups → children) for mega menus; blank/
    // describe sites pass a flat page list.
    const navTree = Array.isArray(req.body.nav) && req.body.nav.length ? req.body.nav : null;
    const pages = Array.isArray(req.body.pages) && req.body.pages.length ? req.body.pages : [{ slug: 'home', title: 'Home' }, { slug: 'contact', title: 'Contact' }];
    const nav = navTree
      ? navTree.map((g) => `- ${g.title} → ${g.route}` + ((g.children || []).length ? '\n' + g.children.map((c) => `    · ${c.title} → ${c.route}`).join('\n') : '')).join('\n')
      : pages.map((p) => `- ${p.title} → ${routeFor(p.slug)}`).join('\n');
    let goalRoute;
    if (navTree) {
      const flat = navTree.flatMap((g) => [{ title: g.title, route: g.route }, ...((g.children || []))]);
      const g = flat.find((p) => /contact|donate|volunteer|sign|book|buy|register|get-started|quote|support/i.test((p.route || '') + ' ' + (p.title || '')));
      goalRoute = (g && g.route) || (navTree[navTree.length - 1] || {}).route || '/';
    } else {
      const goalPage = pages.find((p) => /contact|donate|volunteer|sign|book|buy|register|get-started|quote/i.test(kebab(p.slug) + ' ' + p.title)) || pages[pages.length - 1];
      goalRoute = routeFor(goalPage.slug);
    }

    const logoUrl = brand.logo && typeof brand.logo.url === 'string' ? brand.logo.url : '';
    const user = [
      `Organization: ${orgName}`,
      `Voice / tone: ${(brand.voice || []).join(', ') || 'clear, warm, credible'}`,
      brief.interpretation && brief.interpretation.archetype ? `Site type: ${brief.interpretation.archetype}` : '',
      logoUrl ? `Brand logo image (use it as the wordmark in the header and footer): <img src="${logoUrl}" alt="${orgName} logo" /> — style with a sensible height (e.g. 32–40px), do not distort.` : '',
      `Primary CTA label: ${primaryCta}  → links to route ${goalRoute}`,
      '',
      'Navigation (use these EXACT routes, in this order):',
      nav,
      '',
      'Design a Header and Footer that feel bespoke to THIS organization. Return via submit_chrome.',
    ].filter(Boolean).join('\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    // A mega-menu header (many child links) + full footer is large; 8k truncated
    // the tool JSON and dropped us to the plain fallback. Give it room and
    // validate COMPLETE components (closing tags), retrying once if truncated.
    const buildChrome = async (msg) => {
      const stream = anthropic.messages.stream({
        model: 'claude-sonnet-5', max_tokens: 16000, thinking: { type: 'disabled' },
        system: systemPrompt(brand), tools: [CHROME_TOOL], tool_choice: { type: 'tool', name: 'submit_chrome' },
        messages: [{ role: 'user', content: msg }],
      });
      const response = await stream.finalMessage();
      const tool = (response.content || []).find((c) => c.type === 'tool_use' && c.name === 'submit_chrome');
      return {
        header: tool && tool.input && typeof tool.input.header === 'string' ? tool.input.header : '',
        footer: tool && tool.input && typeof tool.input.footer === 'string' ? tool.input.footer : '',
        truncated: response.stop_reason === 'max_tokens',
      };
    };
    const headerOk = (h) => h.includes('Astro.props') && h.includes('orgName') && h.includes('<header') && /<\/header>/.test(h);
    const footerOk = (f) => f.includes('Astro.props') && f.includes('orgName') && f.includes('<footer') && /<\/footer>/.test(f);

    let { header, footer, truncated } = await buildChrome(user);
    if (truncated || !headerOk(header) || !footerOk(footer)) {
      context.log(`[generate-chrome] first attempt incomplete (truncated=${truncated}); retrying tighter`);
      const r = await buildChrome(user + '\n\nCRITICAL: return BOTH files COMPLETE (they must end with </header> and </footer> respectively). Keep the design rich but do not get cut off — if the nav has many groups, use compact mega-menu panels rather than very long markup.');
      if (headerOk(r.header)) header = r.header;
      if (footerOk(r.footer)) footer = r.footer;
    }

    // Only write COMPLETE components (props contract + closing tag), so a
    // truncated result can't break the render; anything missing keeps its prior
    // draft (deterministic header from generate-plan / _base footer).
    let wrote = [];
    if (headerOk(header)) { await setDraftFile(slug, 'src/components/Header.astro', header); wrote.push('header'); }
    if (footerOk(footer)) { await setDraftFile(slug, 'src/components/Footer.astro', footer); wrote.push('footer'); }
    if (!wrote.length) throw new Error('The chrome designer returned no usable components.');

    await recordEvent({ type: 'generate', stage: 'chrome', result: 'success', site: slug, user: hashId(email), wrote });
    context.res = { status: 200, body: { status: 'ok', wrote } };
  } catch (err) {
    context.log.error(err);
    await recordEvent({ type: 'generate', stage: 'chrome', result: 'error', site: slug, user: hashId(email), error: String(err.message || '').slice(0, 300) });
    context.res = { status: 500, body: { status: 'error', error: 'Could not design the header and footer.', detail: err.message } };
  }
};
