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
const { routeFor, isHome, headerDraft, kebab } = require('../lib/studio');

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

    const system = [
      'You are a senior UX architect and content strategist. Design the information architecture for a mission-driven organization so visitors effortlessly reach the primary goal.',
      'Rules: every page has ONE clear primary action; mobile-first; a logical heading outline. Map the offers into pages/sections. Always include a Home page and a Contact page, plus a page that supports the primary goal. 4–6 pages total. Return via submit_plan only.',
    ].join('\n');
    const user = [
      `Organization: ${content.org_name || site.name || '(unnamed)'}`,
      `Mission: ${content.mission || '(not given)'}`,
      `Offerings: ${(content.offers || []).join(', ') || '(none given)'}`,
      `Primary goal (the site's main CTA): ${content.primary_goal || 'Contact us'}`,
      brief.mode === 'import' ? 'This is a redesign of an existing site — cover what such an org needs.' : 'This is a new site — use nonprofit/SMB best practice.',
    ].join('\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5', max_tokens: 4000, thinking: { type: 'disabled' },
      system, tools: [PLAN_TOOL], tool_choice: { type: 'tool', name: 'submit_plan' },
      messages: [{ role: 'user', content: user }],
    });
    const tool = (response.content || []).find((c) => c.type === 'tool_use' && c.name === 'submit_plan');
    if (!tool || !Array.isArray(tool.input.pages) || tool.input.pages.length === 0) throw new Error('No sitemap was produced.');

    // Normalize: exactly one Home (first), dedupe slugs, cap at 6.
    let pages = tool.input.pages.filter((p) => p && p.slug && p.title);
    const homeIdx = pages.findIndex((p) => isHome(p.slug));
    if (homeIdx > 0) pages.unshift(pages.splice(homeIdx, 1)[0]);
    if (homeIdx === -1) pages.unshift({ slug: 'home', title: 'Home', purpose: 'Introduce the organization and drive the primary goal.', sections: [] });
    const seen = new Set();
    pages = pages.filter((p) => { const k = isHome(p.slug) ? 'home' : kebab(p.slug); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);

    // Write the brand tokens + nav Header, and open the site for editing.
    const goalPage = pages.find((p) => /contact|donate|volunteer|sign|book|buy/i.test(p.slug + ' ' + p.title)) || pages[pages.length - 1];
    await setDraftFile(slug, 'src/styles/tokens.css', tokensFromBrand(brief.brand));
    await setDraftFile(slug, 'src/components/Header.astro', headerDraft(pages, routeFor(goalPage.slug)));
    await upsertSite(email, { slug, editable: true });

    context.res = { status: 200, body: { status: 'ok', pages: pages.map((p) => ({ slug: p.slug, title: p.title, purpose: p.purpose, sections: p.sections || [] })) } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { status: 'error', error: 'Could not plan the site.', detail: err.message } };
  }
};
