/**
 * research-category — POST /api/research-category  { site }   (auth-gated)
 *
 * The Category & Best-Practice Researcher (Feature Brief v1.1 §4.3): given the
 * site's archetype, it studies current, representative real-world examples via
 * live web search and turns them into a build playbook (must-have sections,
 * conversion patterns, content conventions, a11y notes) with cited sources.
 * Written into the site's brief.research so the UX Architect builds the sitemap
 * from proven category conventions — the experts still decide; this informs them.
 *
 * Best-effort and non-fatal: on any failure the build proceeds on the Brief
 * Interpreter's lighter category read (interpretation.must_have_sections).
 */
const { Anthropic } = require('@anthropic-ai/sdk');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getSite, upsertSite } = require('../lib/siteRegistry');
const { recordEvent, hashId } = require('../lib/feedbackStore');
const { getFresh, putEntry, bumpUsage, archetypeKey } = require('../lib/kb');
const { curate } = require('../lib/curator');
const { withAddendum } = require('../lib/learningStore');

const PLAYBOOK_TOOL = {
  name: 'submit_playbook',
  description: 'Return the researched category playbook for this archetype.',
  input_schema: {
    type: 'object',
    properties: {
      must_have_sections: { type: 'array', items: { type: 'string' }, description: 'Table-stakes sections a credible site of this archetype needs, ordered as they typically appear.' },
      recommended_sections: { type: 'array', items: { type: 'string' }, description: 'High-value additions that differentiate.' },
      conversion_patterns: { type: 'array', items: { type: 'string' }, description: "Proven techniques that drive THIS archetype's primary goal (urgency, comparison cards, trust signals, social proof…)." },
      content_conventions: { type: 'array', items: { type: 'string' }, description: 'Specific information visitors of this type expect.' },
      accessibility_notes: { type: 'array', items: { type: 'string' }, description: 'Category-specific accessibility considerations.' },
      sources: { type: 'array', items: { type: 'string' }, description: 'URLs of the real, current examples you based this on.' },
      rationale: { type: 'string', description: 'One-line, client-facing summary.' },
    },
    required: ['must_have_sections', 'conversion_patterns', 'content_conventions', 'rationale'],
  },
};

function systemPrompt() {
  return [
    'You are a senior web strategist specializing in what makes a given CATEGORY of website effective. You research the real world and turn it into a build playbook.',
    'Use the web_search tool to study several strong, CURRENT, representative examples of this archetype before answering — record their URLs as sources.',
    'Produce a category playbook: must_have_sections (ordered as they typically appear), recommended_sections, conversion_patterns proven to drive this archetype\'s primary goal, content_conventions (the specific info visitors expect), and accessibility_notes.',
    'HARD RULES: base recommendations on ACTUAL current examples and cite them in sources. Recommend best practices, never a copy of any one site. Distinguish table-stakes from nice-to-have so we don\'t overbuild. Keep it specific to the archetype — no generic "every website needs a homepage".',
    'First search the web, THEN return everything via the submit_playbook tool. Do not answer in prose.',
  ].join('\n');
}

// Run a server-tool (web search) turn, resolving any pause_turn continuations,
// and return the final message. Bounded so it can't loop forever.
async function runResearch(anthropic, system, user) {
  let messages = [{ role: 'user', content: user }];
  let response = null;
  for (let i = 0; i < 4; i++) {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-5', max_tokens: 8000, thinking: { type: 'disabled' },
      system, tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 4 }, PLAYBOOK_TOOL],
      messages,
    });
    response = await stream.finalMessage();
    if (response.stop_reason !== 'pause_turn') break;
    messages = messages.concat([{ role: 'assistant', content: response.content }]);
  }
  return response;
}

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) { context.res = { status: 401, body: { error: 'Authentication required.' } }; return; }
  const slug = req.body && req.body.site;
  if (!slug) { context.res = { status: 400, body: { error: 'A site is required.' } }; return; }
  if (!process.env.ANTHROPIC_API_KEY) { context.res = { status: 200, body: { status: 'skipped', reason: 'not-configured' } }; return; }

  try {
    const site = await getSite(email, slug);
    if (!site) { context.res = { status: 404, body: { error: 'Site not found.' } }; return; }
    const brief = site.brief || {};
    const interp = brief.interpretation || {};
    const archetype = interp.archetype;
    // Only the describe path has an archetype to research against; skip otherwise.
    if (!archetype) { context.res = { status: 200, body: { status: 'skipped', reason: 'no-archetype' } }; return; }

    // RETRIEVE-OR-REFRESH: a fresh KB playbook for this archetype skips live
    // research entirely (the efficiency path). The experts still adapt it.
    const key = archetypeKey(archetype);
    const fresh = await getFresh('playbook', key);
    if (fresh && fresh.data) {
      brief.research = { ...(brief.research || {}), category_playbook: fresh.data };
      await upsertSite(email, { slug, brief });
      await bumpUsage('playbook', key);
      await recordEvent({ type: 'kb', stage: 'playbook', result: 'hit', site: slug, user: hashId(email), key, version: fresh.version });
      context.res = { status: 200, body: { status: 'ok', cached: true, playbook: fresh.data } };
      return;
    }

    const content = brief.content || {};
    const facts = (interp.extracted_facts || []).filter((f) => f && f.label).map((f) => `${f.label}: ${f.value}`).join(' | ');
    const user = [
      `Archetype: ${archetype}`,
      `Primary goal (site's main CTA): ${interp.primary_goal || content.primary_goal || '(not given)'}`,
      interp.audience ? `Audience: ${interp.audience}` : '',
      facts ? `Facts the client stated (map the playbook to these): ${facts}` : '',
      '',
      'Research current, representative examples of this archetype, then submit the playbook.',
    ].filter(Boolean).join('\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    // Inject human-approved learning: this agent's addendum + any per-archetype
    // playbook learning approved for this specific category.
    let system = await withAddendum(systemPrompt(), 'prompt:research-category');
    system = await withAddendum(system, 'kb_playbook:' + key);
    const response = await runResearch(anthropic, system, user);
    const tool = ((response && response.content) || []).find((c) => c.type === 'tool_use' && c.name === 'submit_playbook');
    if (!tool || !tool.input || !Array.isArray(tool.input.must_have_sections)) throw new Error('No playbook was produced.');

    const playbook = tool.input;
    brief.research = { ...(brief.research || {}), category_playbook: playbook };
    await upsertSite(email, { slug, brief });
    // Curate the fresh research into the shared KB so the next build of this
    // archetype gets the fast cache path.
    const entry = await curate('playbook', key, playbook, { agent: 'research-category', archetype });
    if (entry && !entry.rejected) await putEntry('playbook', key, entry);
    await recordEvent({ type: 'kb', stage: 'playbook', result: 'refresh', site: slug, user: hashId(email), key });
    await recordEvent({ type: 'generate', stage: 'research-category', result: 'success', site: slug, user: hashId(email), archetype, sources: (playbook.sources || []).length });

    context.res = { status: 200, body: { status: 'ok', playbook } };
  } catch (err) {
    context.log.error(err);
    await recordEvent({ type: 'generate', stage: 'research-category', result: 'error', site: slug, user: hashId(email), error: String(err.message || '').slice(0, 300) });
    // Non-fatal: the build continues on the Brief Interpreter's lighter read.
    context.res = { status: 200, body: { status: 'skipped', reason: 'error', detail: err.message } };
  }
};
