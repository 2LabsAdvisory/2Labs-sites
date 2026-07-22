/**
 * generate-plan — POST /api/generate-plan  { site }   (auth-gated)
 *
 * Studio stage: UX Architect + Content Strategist. From the site's Wizard Brief
 * it produces a sitemap (pages + per-page section outline) aimed at the primary
 * goal, then writes the per-site tokens.css + nav Header drafts and marks the
 * site editable. Returns the page plan; the client then calls generate-page for
 * each page (kept per-request so nothing exceeds the gateway timeout).
 */
const { Anthropic } = require('@anthropic-ai/sdk');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getSite, upsertSite } = require('../lib/siteRegistry');
const { setDraftFile } = require('../lib/draftStore');
const { tokensFromBrand } = require('../lib/seedSite');
const { routeFor, isHome, headerDraft, kebab, routeForPath } = require('../lib/studio');
const { recordEvent, hashId } = require('../lib/feedbackStore');
const importStore = require('../lib/importStore');
const buildStore = require('../lib/buildStore');

// --- Imported (full-mirror) planning ---------------------------------------
// Clean, order and label the crawled nav tree, then write the manifest of every
// page to build. The IA comes from the real site; the model only tidies labels.
const ORGANIZE_TOOL = {
  name: 'organize_nav',
  description: 'Tidy the imported navigation: clean human labels, sensible order, and the primary call-to-action.',
  input_schema: {
    type: 'object',
    properties: {
      groups: {
        type: 'array',
        description: 'The top-level nav groups, in the order they should appear.',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'The exact group key (route) given in the input — do not change it.' },
            label: { type: 'string', description: 'A clean, human nav label (e.g. "Programs", "Get Involved", "About").' },
          },
          required: ['key', 'label'],
        },
      },
      primary_cta_route: { type: 'string', description: 'The route for the primary CTA button (e.g. a Donate or Contact route from the input).' },
      primary_cta_label: { type: 'string', description: 'A short CTA label (e.g. "Donate", "Get in touch").' },
    },
    required: ['groups'],
  },
};

const titleCase = (seg) => String(seg || '').replace(/^\//, '').replace(/[-_/]+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());

// Convert the crawl tree (path/title/children) into a header nav tree with clean
// routes; apply AI label/order tidying when available.
function buildNav(rawTree, tidy) {
  const labelByKey = new Map((tidy && tidy.groups || []).map((g) => [g.key, g.label]));
  const order = new Map((tidy && tidy.groups || []).map((g, i) => [g.key, i]));
  const nav = (rawTree || []).map((g) => {
    const route = g.path ? routeForPath(g.path) : '/';
    return {
      title: labelByKey.get(route) || labelByKey.get(g.path) || g.title || titleCase(g.path),
      route,
      children: (g.children || []).map((c) => ({ title: c.title || titleCase(c.path), route: routeForPath(c.path) })),
    };
  })
    // Drop a redundant "Home" group (the logo already links home) and any empty
    // top-level item that resolves to the site root.
    .filter((g) => g.route !== '/' && !/^home$/i.test(g.title));
  nav.sort((a, b) => (order.has(a.route) ? order.get(a.route) : 99) - (order.has(b.route) ? order.get(b.route) : 99));
  return nav;
}

async function planImport(context, email, site, slug) {
  const brief = site.brief || {};
  const rawTree = await importStore.getUrlTree(slug);
  const index = await importStore.getIndex(slug);
  if (!rawTree || !index.length) return null; // not an import corpus

  // Light, non-fatal AI tidy of the nav labels/order + primary CTA.
  let tidy = null;
  try {
    const groupsForAi = rawTree.map((g) => ({
      key: g.path ? routeForPath(g.path) : '/',
      current_label: g.title || titleCase(g.path),
      sample_children: (g.children || []).slice(0, 5).map((c) => c.title).filter(Boolean),
      child_count: (g.children || []).length,
    }));
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-5', max_tokens: 1500, thinking: { type: 'disabled' },
      system: 'You tidy a website navigation imported from a real site. Keep every group; give each a clean, conventional label; order them the way a good nonprofit/org site would (primary audience first, About/Contact later). Pick a primary CTA (Donate/Contact/Get Involved) from the given routes. Return via organize_nav only. Never invent groups or routes.',
      tools: [ORGANIZE_TOOL], tool_choice: { type: 'tool', name: 'organize_nav' },
      messages: [{ role: 'user', content: 'Nav groups (key = route, do not change keys):\n' + JSON.stringify(groupsForAi, null, 2) }],
    });
    const tool = (resp.content || []).find((c) => c.type === 'tool_use' && c.name === 'organize_nav');
    tidy = tool && tool.input || null;
  } catch (e) { context.log('[generate-plan] nav tidy skipped: ' + e.message); }

  const nav = buildNav(rawTree, tidy);

  // Full page list = every crawled page (home guaranteed first).
  const seen = new Set();
  const pages = [];
  const pushPage = (path, title) => {
    const route = routeForPath(path);
    const key = route === '/' ? '/' : route;
    if (seen.has(key)) return;
    seen.add(key);
    pages.push({ path: route, title: title || titleCase(path) });
  };
  pushPage('/', 'Home');
  for (const e of index) pushPage(e.path, e.title);

  // Validate the CTA route against known routes; else fall back to a contact-ish page.
  const routeSet = new Set(pages.map((p) => p.path));
  let goalRoute = (tidy && routeSet.has(tidy.primary_cta_route)) ? tidy.primary_cta_route : null;
  if (!goalRoute) { const c = pages.find((p) => /donat|contact|get-involved|volunteer|support/i.test(p.path)); goalRoute = c ? c.path : (pages[pages.length - 1] || { path: '/' }).path; }

  const logoUrl = (brief.brand && brief.brand.logo && brief.brand.logo.url) || '';
  await setDraftFile(slug, 'src/styles/tokens.css', tokensFromBrand(brief.brand));
  await setDraftFile(slug, 'src/components/Header.astro', headerDraft(null, goalRoute, logoUrl, nav));
  await buildStore.createManifest(slug, { ownerEmail: email, nav, pages });
  await upsertSite(email, { slug, editable: true });

  await recordEvent({ type: 'generate', stage: 'plan', result: 'success', mode: 'import', site: slug, user: hashId(email), pages: pages.length, archetype: (brief.interpretation && brief.interpretation.archetype) || null });
  return { status: 'ok', mode: 'import', total: pages.length, nav, pages: pages.map((p) => ({ slug: p.path, path: p.path, title: p.title, sections: [] })) };
}

const PLAN_TOOL = {
  name: 'submit_plan',
  description: 'Return the sitemap for the new site.',
  input_schema: {
    type: 'object',
    properties: {
      pages: {
        type: 'array',
        description: '4–6 pages. Include a Home page and a Contact page. Order for the nav (Home first).',
        items: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: "Home is 'home'; others are kebab-case, e.g. 'programs', 'about', 'contact'." },
            title: { type: 'string', description: 'Nav label / page title.' },
            purpose: { type: 'string', description: 'One line: what this page is for and the ONE action it drives.' },
            sections: {
              type: 'array',
              description: 'Ordered sections for the page.',
              items: { type: 'object', properties: { heading: { type: 'string' }, intent: { type: 'string' } }, required: ['heading', 'intent'] },
            },
          },
          required: ['slug', 'title', 'purpose', 'sections'],
        },
      },
    },
    required: ['pages'],
  },
};

// Deterministic sitemap from the brief — used if the model call fails, so a
// site is always multi-page (Home + offers/services + About + Contact).
function fallbackPlan(content) {
  const offers = (content.offers || []).filter(Boolean).slice(0, 4);
  const pages = [{ slug: 'home', title: 'Home', purpose: 'Introduce the organization and drive the primary goal.', sections: [] }];
  if (offers.length && offers.length <= 3) offers.forEach((o) => pages.push({ slug: o, title: o, purpose: `Explain the ${o} offering and its benefits.`, sections: [] }));
  else pages.push({ slug: 'services', title: offers.length ? 'Services' : 'What We Do', purpose: 'Overview of what the organization offers.', sections: [] });
  pages.push({ slug: 'about', title: 'About', purpose: 'Who we are, our story, and why to trust us.', sections: [] });
  pages.push({ slug: 'contact', title: 'Contact', purpose: 'How to reach us and take the primary action.', sections: [] });
  return pages;
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
    const content = brief.content || {};

    // Imported site with a crawl corpus: mirror the real IA (grouped/mega-menu
    // nav + a manifest of every page) instead of inventing a shallow sitemap.
    if (brief.mode === 'import' && await importStore.hasCorpus(slug)) {
      const imported = await planImport(context, email, site, slug);
      if (imported) { context.res = { status: 200, body: imported }; return; }
    }

    const system = [
      'You are a senior UX architect and content strategist. Design the information architecture for a mission-driven organization so visitors effortlessly reach the primary goal.',
      'Rules: every page has ONE clear primary action; mobile-first; a logical heading outline. Map the offers into pages/sections. Always include a Home page and a Contact page, plus a page that supports the primary goal. 4–6 pages total. Return via submit_plan only.',
    ].join('\n');
    const interp = brief.interpretation || null;
    // Prefer the live-researched category playbook (§4.3) over the Brief
    // Interpreter's lighter read when it's available.
    const playbook = (brief.research && brief.research.category_playbook) || null;
    const userLines = [
      `Organization: ${content.org_name || site.name || '(unnamed)'}`,
      `Mission: ${content.mission || '(not given)'}`,
      `Offerings: ${(content.offers || []).join(', ') || '(none given)'}`,
      `Primary goal (the site's main CTA): ${content.primary_goal || 'Contact us'}`,
    ];
    if (interp) {
      if (interp.archetype) userLines.push(`Site type / archetype: ${interp.archetype}`);
      const mustHave = (playbook && playbook.must_have_sections) || interp.must_have_sections;
      if (Array.isArray(mustHave) && mustHave.length) userLines.push(`Category best-practice sections this site MUST cover (map into pages, in a sensible order): ${mustHave.join(', ')}`);
      if (playbook && Array.isArray(playbook.recommended_sections) && playbook.recommended_sections.length) userLines.push(`High-value sections that differentiate (include where they fit the offering): ${playbook.recommended_sections.join(', ')}`);
      if (playbook && Array.isArray(playbook.conversion_patterns) && playbook.conversion_patterns.length) userLines.push(`Conversion patterns proven for this category — design pages so these can be applied: ${playbook.conversion_patterns.join(', ')}`);
      const facts = (interp.extracted_facts || []).filter((f) => f && f.label);
      if (facts.length) userLines.push(`Facts the user stated — surface these on the appropriate pages, verbatim, never altered: ${facts.map((f) => `${f.label}: ${f.value}`).join(' | ')}`);
      if (interp.answers && Object.keys(interp.answers).length) userLines.push(`Answers the user gave to clarifying questions: ${Object.entries(interp.answers).map(([k, v]) => `${k}=${v}`).join(' | ')}`);
    }
    userLines.push(brief.mode === 'import' ? 'This is a redesign of an existing site — cover what such an org needs.' : 'This is a new site — use current best practice for this category.');
    const user = userLines.join('\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    let modelPages = [];
    try {
      const stream = anthropic.messages.stream({
        model: 'claude-sonnet-5', max_tokens: 12000, thinking: { type: 'disabled' },
        system, tools: [PLAN_TOOL], tool_choice: { type: 'tool', name: 'submit_plan' },
        messages: [{ role: 'user', content: user }],
      });
      const response = await stream.finalMessage();
      const tool = (response.content || []).find((c) => c.type === 'tool_use' && c.name === 'submit_plan');
      if (tool && Array.isArray(tool.input.pages)) modelPages = tool.input.pages.filter((p) => p && p.slug && p.title);
    } catch (e) {
      context.log.warn('[generate-plan] model call failed: ' + e.message);
    }

    // Never collapse to one page: if the model didn't return a usable sitemap,
    // build a sensible one from the brief so generation is always multi-page.
    let pages = modelPages.length ? modelPages : fallbackPlan(content);
    const homeIdx = pages.findIndex((p) => isHome(p.slug));
    if (homeIdx > 0) pages.unshift(pages.splice(homeIdx, 1)[0]);
    if (homeIdx === -1) pages.unshift({ slug: 'home', title: 'Home', purpose: 'Introduce the organization and drive the primary goal.', sections: [] });
    const seen = new Set();
    pages = pages.filter((p) => { const k = isHome(p.slug) ? 'home' : kebab(p.slug); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);

    // Write the brand tokens + nav Header, and open the site for editing.
    const goalPage = pages.find((p) => /contact|donate|volunteer|sign|book|buy/i.test(p.slug + ' ' + p.title)) || pages[pages.length - 1];
    await setDraftFile(slug, 'src/styles/tokens.css', tokensFromBrand(brief.brand));
    await setDraftFile(slug, 'src/components/Header.astro', headerDraft(pages, routeFor(goalPage.slug), (brief.brand && brief.brand.logo && brief.brand.logo.url) || ''));
    await upsertSite(email, { slug, editable: true });

    await recordEvent({ type: 'generate', stage: 'plan', result: 'success', site: slug, user: hashId(email), pages: pages.length, used_fallback: !modelPages.length, archetype: (brief.interpretation && brief.interpretation.archetype) || null });
    context.res = { status: 200, body: { status: 'ok', pages: pages.map((p) => ({ slug: p.slug, title: p.title, purpose: p.purpose, sections: p.sections || [] })) } };
  } catch (err) {
    context.log.error(err);
    await recordEvent({ type: 'generate', stage: 'plan', result: 'error', site: slug, user: hashId(email), error: String(err.message || '').slice(0, 300) });
    context.res = { status: 500, body: { status: 'error', error: 'Could not plan the site.', detail: err.message } };
  }
};
