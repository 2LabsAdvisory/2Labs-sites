/**
 * analyze-references — POST /api/analyze-references  { site }   (auth-gated)
 *
 * The Reference Analyst (Feature Brief v1.1 §4.2): given the sites the client
 * admires, it fetches each and abstracts the transferable DESIGN and UX
 * PATTERNS — never their content or assets — into ONE inspiration direction the
 * Web Designer adapts within the approved brand tokens.
 *
 * IP-safe and non-fatal: it extracts principles, not pixels; on any failure the
 * build proceeds on the Brief Interpreter's lighter inspiration read.
 */
const { Anthropic } = require('@anthropic-ai/sdk');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getSite, upsertSite } = require('../lib/siteRegistry');
const { recordEvent, hashId } = require('../lib/feedbackStore');
const { getFresh, putEntry, bumpUsage, refKey } = require('../lib/kb');
const { curate } = require('../lib/curator');

const INSPIRATION_TOOL = {
  name: 'submit_inspiration',
  description: 'Return ONE synthesized, IP-safe inspiration direction.',
  input_schema: {
    type: 'object',
    properties: {
      inspiration: {
        type: 'object',
        properties: {
          layout_direction: { type: 'string' },
          palette_direction: { type: 'string' },
          type_direction: { type: 'string' },
          tone: { type: 'string' },
          do: { type: 'array', items: { type: 'string' } },
          dont: { type: 'array', items: { type: 'string' } },
        },
        required: ['layout_direction', 'tone', 'do', 'dont'],
      },
      per_reference_notes: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, note: { type: 'string' } } } },
      skipped: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, why: { type: 'string' } } }, description: 'References you could not analyze without copying, or could not access.' },
      sources: { type: 'array', items: { type: 'string' } },
      rationale: { type: 'string' },
    },
    required: ['inspiration', 'rationale'],
  },
};

function systemPrompt() {
  return [
    'You are a senior design analyst. Given websites the user admires, you extract the transferable DESIGN and UX PATTERNS — never the content or assets — so our studio can build something ORIGINAL that captures what the user liked. Use the web_fetch tool to view each reference URL provided.',
    'From each reference, abstract PATTERNS ONLY: layout logic (hero style, grid, section rhythm, nav pattern, whitespace), visual language (palette DIRECTION warm/cool + saturated/muted, type personality, imagery style, motion), and UX patterns (how the primary action is presented, navigation model, content chunking, notable interactions). Note what the user specifically called out.',
    'Synthesize ACROSS all references into ONE inspiration direction with concrete do and dont lists, plus palette_direction, type_direction, and tone.',
    'HARD RULES (IP — non-negotiable): NEVER copy or reproduce a reference\'s text, images, logos, icons, illustrations, or exact proprietary layout. Extract PRINCIPLES, not pixels or paragraphs. Do not recommend imitating a distinctive, trademark-like design so closely the result could be confused with the reference — note anything to avoid in dont. If a reference can\'t be accessed or analyzed without copying, skip it and record why in skipped. Output is a DIRECTION for original work, not a clone spec.',
    'Fetch the references, THEN return everything via the submit_inspiration tool. Do not answer in prose.',
  ].join('\n');
}

async function runAnalysis(anthropic, system, user, maxFetch) {
  let messages = [{ role: 'user', content: user }];
  let response = null;
  for (let i = 0; i < 4; i++) {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-5', max_tokens: 6000, thinking: { type: 'disabled' },
      system, tools: [{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: maxFetch }, INSPIRATION_TOOL],
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
    const input = brief.input || {};
    const refs = (Array.isArray(input.references) ? input.references : []).filter((r) => r && r.url).slice(0, 5);
    // Nothing to analyze without references; skip cleanly.
    if (!refs.length) { context.res = { status: 200, body: { status: 'skipped', reason: 'no-references' } }; return; }

    // RETRIEVE-OR-REFRESH: a fresh cached analysis of this exact URL set skips
    // re-fetching the references.
    const key = refKey(refs);
    const fresh = await getFresh('reference', key);
    if (fresh && fresh.data) {
      brief.research = { ...(brief.research || {}), inspiration: fresh.data, inspiration_sources: fresh.sources || [] };
      await upsertSite(email, { slug, brief });
      await bumpUsage('reference', key);
      await recordEvent({ type: 'kb', stage: 'reference', result: 'hit', site: slug, user: hashId(email), key, version: fresh.version });
      context.res = { status: 200, body: { status: 'ok', cached: true, inspiration: fresh.data } };
      return;
    }

    // The reference URLs must appear in the conversation for web_fetch to reach them.
    const user = [
      'Reference sites the client admires (fetch each; patterns only, never copy):',
      ...refs.map((r, i) => `${i + 1}. ${r.url}${r.note ? `  — the client likes: "${r.note}"` : ''}`),
      input.style_notes ? `\nStyle notes from the client: ${input.style_notes}` : '',
      '\nFetch these URLs, then submit ONE IP-safe inspiration direction.',
    ].filter(Boolean).join('\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await runAnalysis(anthropic, systemPrompt(), user, Math.max(2, refs.length + 1));
    const tool = ((response && response.content) || []).find((c) => c.type === 'tool_use' && c.name === 'submit_inspiration');
    if (!tool || !tool.input || !tool.input.inspiration) throw new Error('No inspiration direction was produced.');

    const out = tool.input;
    brief.research = { ...(brief.research || {}), inspiration: out.inspiration, inspiration_sources: out.sources || [] };
    await upsertSite(email, { slug, brief });
    // Cache the abstracted, IP-safe direction for this URL set (Curator-gated).
    const entry = await curate('reference', key, { ...out.inspiration, sources: out.sources || [] }, { agent: 'analyze-references', urls: refs.map((r) => r.url) });
    if (entry && !entry.rejected) await putEntry('reference', key, entry);
    await recordEvent({ type: 'kb', stage: 'reference', result: 'refresh', site: slug, user: hashId(email), key });
    await recordEvent({ type: 'generate', stage: 'analyze-references', result: 'success', site: slug, user: hashId(email), refs: refs.length, skipped: (out.skipped || []).length });

    context.res = { status: 200, body: { status: 'ok', inspiration: out.inspiration, skipped: out.skipped || [] } };
  } catch (err) {
    context.log.error(err);
    await recordEvent({ type: 'generate', stage: 'analyze-references', result: 'error', site: slug, user: hashId(email), error: String(err.message || '').slice(0, 300) });
    context.res = { status: 200, body: { status: 'skipped', reason: 'error', detail: err.message } };
  }
};
