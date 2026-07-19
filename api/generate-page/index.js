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
const { fetchStockImages } = require('../lib/images');
const { recordEvent, hashId } = require('../lib/feedbackStore');

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

    // Topical photography. Search by SUBJECT (archetype + offerings + page
    // topic) — not the org name or a generic "Home", which return nothing.
    const imgBits = [
      brief.interpretation && brief.interpretation.archetype,
      (content.offers || [])[0],
      (content.offers || [])[1],
      /^home$/i.test(page.title || '') ? '' : page.title,
    ].filter(Boolean);
    const imgQuery = (imgBits.join(' ').trim() || content.mission || orgName).slice(0, 80);
    const images = await fetchStockImages(imgQuery, 5);
    context.log(`[generate-page] images: q="${imgQuery}" -> ${images.length} (${images.length ? new URL(images[0].url).hostname : 'none'})`);

    const system = [
      'You are an award-winning art director and senior front-end engineer at a top-tier studio (calibre of Pentagram, Locomotive, Active Theory, Instrument). Build ONE page of a site that looks like it cost hundreds of thousands of dollars — modern, creative, editorial, unmistakably premium. Never generic, never a template.',
      '',
      'DESIGN BAR (this is the point — do NOT ship something ordinary):',
      '- Bold, confident hierarchy: oversized display headings, dramatic scale contrast, and generous, luxurious whitespace. Big type is your friend.',
      '- Distinctive, characterful layouts. Vary the rhythm across the page: a striking full-bleed hero, split/asymmetric layouts, overlapping/floating cards, a stat or logo band, a feature grid, an editorial content block, a testimonial or quote, and a strong closing CTA. No "centered hero + three plain cards" clichés.',
      '- Rich visual depth: layered gradients and soft mesh backgrounds built from the brand colours, subtle noise/blur, elegant thin borders, refined shadows, rounded corners, and decorative inline-SVG shapes/blobs. Use tasteful inline-SVG icons (never emoji as icons).',
      '- Motion & polish: premium micro-interactions — smooth hover states, gentle reveal-on-scroll or entrance animations via CSS @keyframes + animation, transforms and transitions. ALWAYS wrap non-trivial motion in @media (prefers-reduced-motion: no-preference).',
      '- Typography: use the brand fonts with a strong modular scale, tuned letter-spacing/line-height, and occasional accent treatment (a highlighted word, an underline flourish in the brand colour).',
      '- Responsive and flawless at mobile / tablet / desktop; use CSS grid/flex, clamp() for fluid type, and aspect-ratio boxes so nothing shifts.',
      '',
      'IMAGERY (this is critical — do not skip):',
      images.length
        ? `- ${images.length} real photographs are provided below. You MUST USE THEM — a full-bleed hero photo AND photos in at least 2 more sections (feature blocks, split layouts, cards, gallery). Use object-fit:cover inside aspect-ratio containers, rounded corners/masks where fitting, and descriptive alt text. Embed the EXACT URLs given, unchanged. NEVER invent, guess, or hardcode any other image URL — use ONLY the URLs provided below. A page with no <img> when photos were provided is a failure.\n- LEGIBILITY OVER PHOTOS (critical): any text on top of a photo needs a STRONG scrim so it is readable over both the lightest and darkest parts of the image — e.g. put the text over a linear-gradient overlay like linear-gradient(rgba(0,0,0,.15), rgba(0,0,0,.6)) or a brand-colour gradient at ~60-85% opacity — and use light text (#fff or var(--primary-contrast)). Prefer text BESIDE the photo (split layout) over text ON the photo when unsure. Never dark text directly on a photo.`
        : '- No photos are available, so create striking gradient/mesh/SVG art instead — full-bleed gradient heroes, abstract shapes, pattern fills. Do NOT invent or hardcode any external image URL (no made-up unsplash.com/other links) — they render broken. Never output a broken <img> or an empty grey box.',
      '',
      'HARD REQUIREMENTS:',
      '- Return the COMPLETE .astro file. It MUST `import BaseLayout from "../layouts/BaseLayout.astro";` and wrap the page in <BaseLayout title="…" description="…" orgName={…} primaryCta={…}> … </BaseLayout>.',
      '- Unique, specific SEO title + ≤155-char meta description via those props. Exactly one <h1>; logical heading order.',
      '- Use ONLY the design tokens listed below for colours/fonts (scoped <style> is fine). NEVER invent CSS variable names, NEVER declare your own :root, NEVER hardcode off-brand colours. Every section sets an explicit background and a readable contrasting text colour (use the *-contrast tokens on colour bands). White-on-white / dark-on-dark is a failure.',
      '- Real, on-voice copy that moves the reader toward the primary action. No lorem ipsum.',
      '- Accessible: semantic landmarks, AA contrast, descriptive links, labelled controls, alt text.',
      '- Internal links use the exact routes from the sitemap. Self-contained (no extra imports/components).',
      '- Anti-slop: never default Inter-on-white blandness, never generic purple gradients, never symmetrical cookie-cutter blocks. Make deliberate, art-directed choices with real personality.',
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
      ...(() => {
        const interp = brief.interpretation || null;
        if (!interp) return [];
        const out = [];
        if (interp.archetype) out.push(`Site type / archetype: ${interp.archetype}`);
        const facts = (interp.extracted_facts || []).filter((f) => f && f.label);
        if (facts.length) out.push(`FACTS THE USER STATED — use these verbatim where relevant; never alter a value and never invent competing ones: ${facts.map((f) => `${f.label}: ${f.value}`).join(' | ')}`);
        const insp = interp.inspiration || {};
        const dir = [insp.layout_direction, insp.palette_direction, insp.tone].filter(Boolean).join(' · ');
        if (dir) out.push(`Design direction (mood/patterns only — original work, never copy any specific site's text, images, logos, or exact layout): ${dir}`);
        if (interp.answers && Object.keys(interp.answers).length) out.push(`User's answers to clarifying questions: ${Object.entries(interp.answers).map(([k, v]) => `${k}=${v}`).join(' | ')}`);
        return out;
      })(),
      '',
      images.length ? 'PHOTOGRAPHS TO USE (exact URLs — embed with brand-tinted overlays + alt text):\n' + images.map((im, i) => `${i + 1}. ${im.url}\n   alt: ${im.alt}`).join('\n') : 'No photographs available — use gradient/SVG art.',
      '',
      `Build this page — "${page.title}" (route ${routeFor(page.slug)}). Purpose: ${page.purpose}`,
      'Sections:',
      sections,
      '',
      'Sitemap (use these routes for any internal links):',
      nav,
      brief.mode === 'import' ? '\nThis is a redesign — faithful to the organization; preserve real facts, never invent specifics like hours/prices.' : '\nNew site — credible best-practice copy; mark any invented specific with [confirm].',
    ].join('\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-5', max_tokens: 12000, thinking: { type: 'disabled' },
      system, tools: [PAGE_TOOL], tool_choice: { type: 'tool', name: 'submit_page' },
      messages: [{ role: 'user', content: user }],
    });
    const response = await stream.finalMessage();
    const tool = (response.content || []).find((c) => c.type === 'tool_use' && c.name === 'submit_page');
    const pageContent = tool && tool.input && typeof tool.input.content === 'string' ? tool.input.content : '';
    if (!pageContent.includes('BaseLayout')) throw new Error('The page did not build correctly.');

    const path = pageFileFor(page.slug);
    await setDraftFile(slug, path, pageContent);
    await recordEvent({ type: 'generate', stage: 'page', result: 'success', site: slug, user: hashId(email), page: page.slug, images: images.length, archetype: (brief.interpretation && brief.interpretation.archetype) || null });
    context.res = { status: 200, body: { status: 'ok', path, route: routeFor(page.slug) } };
  } catch (err) {
    context.log.error(err);
    await recordEvent({ type: 'generate', stage: 'page', result: 'error', site: slug, user: hashId(email), page: page && page.slug, error: String(err.message || '').slice(0, 300) });
    context.res = { status: 500, body: { status: 'error', error: 'Could not build the page.', detail: err.message } };
  }
};
