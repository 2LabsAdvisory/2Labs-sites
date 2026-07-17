/**
 * interpret-brief — POST /api/interpret-brief   (auth-gated)
 *   { description, references?:[{url,note}], style_notes? }
 *
 * The Brief Interpreter (Feature Brief §4.1), with light category + inspiration
 * awareness folded in: turns a plain-language pitch into a structured brief —
 * archetype, primary goal, extracted facts (verbatim), the category's must-have
 * sections, an IP-safe inspiration direction, gaps, and ≤5 clarifying questions.
 */
const { Anthropic } = require('@anthropic-ai/sdk');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');

const INTERPRET_TOOL = {
  name: 'submit_brief',
  description: 'Return the structured interpretation of the described site.',
  input_schema: {
    type: 'object',
    properties: {
      archetype: { type: 'string', description: 'Specific site archetype, e.g. "event/race registration site", "restaurant", "medical clinic", "SaaS landing page", "nonprofit", "portfolio".' },
      audience: { type: 'string', description: 'Who the site is for.' },
      primary_goal: { type: 'string', description: 'The one action the site drives — Register, Book, Donate, Buy, Contact, Subscribe, etc.' },
      org_name: { type: 'string', description: 'The organization / project name if stated or clearly implied; else "".' },
      summary: { type: 'string', description: 'A one-to-two sentence mission/summary of what this site is and who it serves.' },
      offers: { type: 'array', items: { type: 'string' }, description: 'Key offerings/things to feature (short labels).' },
      extracted_facts: {
        type: 'array',
        description: 'Every concrete fact the user stated — names, dates, distances, prices, locations, times. VERBATIM values (normalize date formats to ISO but never change a value).',
        items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['label', 'value'] },
      },
      must_have_sections: { type: 'array', items: { type: 'string' }, description: "The table-stakes sections a credible site of this archetype needs, ordered as they'd appear (category best practice)." },
      inspiration: {
        type: 'object',
        description: "IP-safe design DIRECTION synthesized from the user's style notes and reference NOTES (patterns/mood only — never copy a reference's content or exact design).",
        properties: { palette_direction: { type: 'string' }, layout_direction: { type: 'string' }, tone: { type: 'string' } },
      },
      gaps: { type: 'array', items: { type: 'string' }, description: 'Information this archetype genuinely needs that the user did NOT provide.' },
      clarifying_questions: {
        type: 'array',
        description: '2–5 short questions for the gaps ONLY (never for anything already stated). Empty if the description is already complete.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'kebab-case key, e.g. "registration_link".' },
            question: { type: 'string' },
            kind: { type: 'string', enum: ['text', 'choice'] },
            options: { type: 'array', items: { type: 'string' }, description: 'For kind=choice.' },
          },
          required: ['id', 'question', 'kind'],
        },
      },
      rationale: { type: 'string', description: 'One-line, client-facing summary of what you understood.' },
    },
    required: ['archetype', 'primary_goal', 'summary', 'extracted_facts', 'must_have_sections', 'gaps', 'clarifying_questions', 'rationale'],
  },
};

function systemPrompt() {
  return [
    'You are a senior digital strategist who turns a founder’s plain-language pitch into a precise, structured website brief. You are exact about facts and honest about gaps.',
    '',
    'DO:',
    '- Classify the site ARCHETYPE specifically (it drives category conventions).',
    '- Infer the PRIMARY GOAL the site exists to drive (becomes the primary CTA).',
    '- Extract every CONCRETE FACT the user stated — names, dates, distances, prices, locations, times, offerings — VERBATIM into extracted_facts. Normalize date formats to ISO but never change a value.',
    '- Give the archetype’s must_have_sections (ordered, category best practice) and, from the user’s style notes + reference NOTES, an IP-safe inspiration DIRECTION (mood/patterns only).',
    '- Identify GAPS (info this archetype needs that the user did not give) and draft 2–5 short clarifying_questions for the gaps ONLY.',
    '',
    'HARD RULES:',
    '- Never invent facts. Anything not stated goes in gaps (later marked [confirm]).',
    '- Never ask about anything already stated. Never exceed five questions. If the description is rich enough to build from, return an empty question list.',
    '- Reference NOTES describe what the user likes — extract PRINCIPLES only; never plan to copy a reference’s text, images, logos, or exact layout.',
    'Return via submit_brief only.',
  ].join('\n');
}

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) { context.res = { status: 401, body: { error: 'Authentication required.' } }; return; }
  const b = req.body || {};
  const description = (b.description || '').trim();
  if (!description) { context.res = { status: 400, body: { error: 'A description is required.' } }; return; }
  if (!process.env.ANTHROPIC_API_KEY) { context.res = { status: 500, body: { error: 'Server is not configured.' } }; return; }

  const refs = (Array.isArray(b.references) ? b.references : []).filter((r) => r && r.url).slice(0, 5);
  const user = [
    'DESCRIPTION:', description, '',
    refs.length ? 'REFERENCE SITES the user likes (patterns/inspiration only — never copy):\n' + refs.map((r) => `- ${r.url}${r.note ? ` — "${r.note}"` : ''}`).join('\n') : 'No reference sites provided.',
    '',
    b.style_notes ? `STYLE NOTES: ${b.style_notes}` : 'No style notes provided.',
  ].join('\n');

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5', max_tokens: 4000, thinking: { type: 'disabled' },
      system: systemPrompt(), tools: [INTERPRET_TOOL], tool_choice: { type: 'tool', name: 'submit_brief' },
      messages: [{ role: 'user', content: user }],
    });
    const tool = (response.content || []).find((c) => c.type === 'tool_use' && c.name === 'submit_brief');
    if (!tool || !tool.input) throw new Error('Could not interpret the description.');
    const interp = tool.input;
    interp.clarifying_questions = (interp.clarifying_questions || []).slice(0, 5);
    context.res = { status: 200, body: { status: 'ok', interpretation: interp } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { status: 'error', error: 'Could not interpret your description.', detail: err.message } };
  }
};
