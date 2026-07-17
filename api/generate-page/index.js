/**
 * generate-page — POST /api/generate-page  { site, page, pages }   (auth-gated)
 *
 * Studio stage: Senior Web Designer + Developer + Content Strategist. Builds ONE
 * complete .astro page (real copy, brand tokens, SEO, semantic HTML) from its
 * plan entry and writes it as a draft. One page per request stays under the
 * gateway timeout; the client calls this for each page in the plan.
 */
const { Anthropic } = require('@anthropic-ai/sdk');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getSite } = require('../lib/siteRegistry');
const { setDraftFile } = require('../lib/draftStore');
const { brandSummary, routeFor, pageFileFor } = require('../lib/studio');

const PAGE_TOOL = {
  name: 'submit_page',
  description: 'Return the complete Astro page.',
  input_schema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The COMPLETE .astro file content for this page.' },
    },
    required: ['content'],
  },
};

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) { context.res = { status: 401, body: { error: 'Authentication required.' } }; return; }
  const slug = req.body && req.body.site;
  const page = req.body && req.body.page;
  const pages = Array.isArray(req.body && req.body.pages) ? req.body.pages : [];
  if (!slug || !page || !page.slug) { context.res = { status: 400, body: { error: 'A site and page are required.' } }; return; }
  if (!process.env.ANTHROPIC_API_KEY) { context.res = { status: 500, body: { error: 'Server is not configured.' } }; return; }

  try {
    const site = await getSite(email, slug);
    if (!site) { context.res = { status: 404, body: { error: 'Site not found.' } }; return; }
    const brief = site.brief || {};
    const content = brief.content || {};
    const orgName = content.org_name || site.name || 'Your Organization';
    const primaryCta = content.primary_goal || 'Get in touch';

    const nav = pages.map((p) => `- ${p.title} → ${routeFor(p.slug)}`).join('\n');
    const sections = (page.sections || []).map((s, i) => `${i + 1}. ${s.heading} — ${s.intent}`).join('\n') || '(design suitable sections for this page)';

    const system = [
      'You are a senior web designer, developer, and content strategist building ONE page of a world-class Astro site.',
      'HARD REQUIREMENTS:',
      '- Return the COMPLETE .astro file. It MUST `import BaseLayout from "../layouts/BaseLayout.astro";` and wrap the page in <BaseLayout title="…" description="…" orgName={…} primaryCta={…}> … </BaseLayout>.',
      '- Pass a unique, specific SEO title and a ≤155-char meta description via those props. Use exactly one <h1>. Logical heading order.',
      '- Use ONLY the brand CSS variables for all colour/typography/spacing (scoped <style> is fine). Never hardcode off-brand colours or fonts.',
      '- Real, on-voice copy that moves the reader toward the page’s primary action. No lorem ipsum, no placeholder text.',
      '- Do NOT use <img> with invented external URLs. Use styled sections, colour blocks, gradients, icons (emoji/inline SVG) instead.',
      '- Accessible: semantic landmarks, sufficient contrast (tokens already pass AA), descriptive link text, labelled controls.',
      '- Internal links must use the exact routes from the sitemap. Keep the page self-contained (no extra imports/components).',
      'Return via submit_page only.',
    ].join('\n');

    const user = [
      brandSummary(brief.brand),
      '',
      `Organization: ${orgName}`,
      `Mission: ${content.mission || '(not given)'}`,
      `Offerings: ${(content.offers || []).join(', ') || '(none given)'}`,
      `Primary goal / CTA: ${primaryCta}`,
      `Pass to BaseLayout: orgName={${JSON.stringify(orgName)}} primaryCta={${JSON.stringify(primaryCta)}}.`,
      '',
      `Build this page — "${page.title}" (route ${routeFor(page.slug)}). Purpose: ${page.purpose}`,
      'Sections:',
      sections,
      '',
      'Sitemap (use these routes for any internal links):',
      nav,
      brief.mode === 'import' ? '\nThis is a redesign — keep it faithful to the organization; preserve real facts, never invent specifics like hours/prices.' : '\nNew site — write credible best-practice copy; mark any invented specific with [confirm].',
    ].join('\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-5', max_tokens: 8000, thinking: { type: 'disabled' },
      system, tools: [PAGE_TOOL], tool_choice: { type: 'tool', name: 'submit_page' },
      messages: [{ role: 'user', content: user }],
    });
    const response = await stream.finalMessage();
    const tool = (response.content || []).find((c) => c.type === 'tool_use' && c.name === 'submit_page');
    const pageContent = tool && tool.input && typeof tool.input.content === 'string' ? tool.input.content : '';
    if (!pageContent.includes('BaseLayout')) throw new Error('The page did not build correctly.');

    const path = pageFileFor(page.slug);
    await setDraftFile(slug, path, pageContent);
    context.res = { status: 200, body: { status: 'ok', path, route: routeFor(page.slug) } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { status: 'error', error: 'Could not build the page.', detail: err.message } };
  }
};
