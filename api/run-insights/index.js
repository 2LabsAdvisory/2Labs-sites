/**
 * run-insights — POST /api/run-insights?days=30   (2Labs session OR internal key)
 *
 * The Insights agent (Memory brief v1.2 §5.1): aggregates the feedback signal
 * (edits, generation outcomes, KB hit-rate) and turns it into concrete,
 * testable PROPOSALS to improve agent prompts and KB playbooks. It only
 * PROPOSES — a human at 2Labs approves each one (see /api/insights-decide).
 *
 * Runs OFF the build path; schedule it (GitHub Actions cron hits this with the
 * internal key) or run it manually from the review page.
 */
const { Anthropic } = require('@anthropic-ai/sdk');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { readEvents } = require('../lib/feedbackStore');
const { list: listKb } = require('../lib/kb');
const { listAddenda } = require('../lib/learningStore');
const { addProposals } = require('../lib/insightsStore');

const PROPOSALS_TOOL = {
  name: 'submit_proposals',
  description: 'Return evidence-based improvement proposals.',
  input_schema: {
    type: 'object',
    properties: {
      period_summary: { type: 'string', description: 'One paragraph on what the data shows this period.' },
      proposals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'What to change: "prompt:generate-page", "prompt:research-category", "prompt:edit", "prompt:generate-plan", or "kb_playbook:<archetype>".' },
            change: { type: 'string', description: 'The specific improvement to make — written as an instruction the target agent can apply directly.' },
            evidence: { type: 'string', description: 'The signal that supports it, QUANTIFIED (e.g. "hero rewritten in 7/10 builds").' },
            source_metrics: { type: 'object', description: 'The quantified numbers behind this proposal as key→value, e.g. {"edit_rate": 0.7, "builds": 10}. Must not be empty.' },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            suggested_review: { type: 'string', enum: ['auto', 'human'] },
          },
          required: ['target', 'change', 'evidence', 'source_metrics', 'risk'],
        },
      },
    },
    required: ['proposals', 'period_summary'],
  },
};

function systemPrompt() {
  return [
    'You are a product analyst for a website-building studio. You turn signals from real builds into specific, testable improvements to our agent prompts and knowledge-base playbooks. You propose; humans approve.',
    'FIND and prioritize: (1) recurring EDITS — files/sections clients consistently rewrite mean the agent that generates them (or the playbook) is weak; say which target and how to change it. (2) FAILURE PATTERNS — stages with high error rates or the plan falling back. (3) WINNERS — anything correlated with clean, low-edit builds to reinforce.',
    'Valid targets: prompt:generate-page, prompt:generate-plan, prompt:research-category, prompt:edit, or kb_playbook:<archetype>.',
    'RULES: base every proposal on evidence in the data and QUANTIFY it — no hunches. For each proposal, also fill source_metrics with the exact numbers behind it as key→value (e.g. {"page_edit_rate": 0.7, "builds": 10}). Prefer small, reversible changes. Never propose anything that would reduce originality, accessibility, or factual accuracy. Do NOT apply changes — only propose. If the data is too thin to justify a change, return an empty proposals list and say so.',
    'Return via submit_proposals only.',
  ].join('\n');
}

// Compact aggregate of the feedback signal for the agent to reason over.
function aggregate(events) {
  const tally = (arr, fn) => { const m = {}; for (const x of arr) { const k = fn(x); if (k == null || k === '') continue; m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, count]) => ({ key, count })); };
  const edits = events.filter((e) => e.type === 'edit');
  const gens = events.filter((e) => e.type === 'generate');
  const kb = events.filter((e) => e.type === 'kb');
  const editOk = edits.filter((e) => e.result === 'success');
  const editErr = edits.filter((e) => e.result === 'error');
  return {
    edits: {
      total: edits.length, errors: editErr.length,
      most_edited_files: tally(editOk.flatMap((e) => e.targets || []), (t) => t),
      failure_stages: tally(editErr, (e) => e.stage),
      top_errors: tally(editErr, (e) => e.error),
      qa_fixed: editOk.filter((e) => e.qa === 'fixed').length,
    },
    generation: ['brand', 'plan', 'page', 'chrome'].map((s) => { const g = gens.filter((x) => x.stage === s); return { stage: s, total: g.length, errors: g.filter((x) => x.result === 'error').length }; }),
    plan_fallbacks: gens.filter((x) => x.stage === 'plan' && x.used_fallback).length,
    top_generation_errors: tally(gens.filter((x) => x.result === 'error'), (e) => `${e.stage}: ${e.error}`),
    kb: { hits: kb.filter((e) => e.result === 'hit').length, refreshes: kb.filter((e) => e.result === 'refresh').length },
  };
}

// Sites' prompt/playbook improvements are product-wide (not per client site).
const scopeFor = () => ({ type: 'global' });

// Push proposals to the SHARED 2Labs Command Learning Loop (POST /learning/ingest,
// service-authenticated with the shared X-Ingest-Key). Best-effort and non-fatal.
// Configure LEARNING_INGEST_URL (the full ingest endpoint URL) + LEARNING_INGEST_KEY
// (matching command-functions' LEARNING_INGEST_KEY).
async function ingestToCommand(proposals) {
  const url = process.env.LEARNING_INGEST_URL;
  const key = process.env.LEARNING_INGEST_KEY;
  if (!url || !key) return { configured: false, sent: 0 };
  const period = new Date().toISOString().slice(0, 10);
  let sent = 0, duplicate = 0, failed = 0;
  for (const p of proposals) {
    try {
      const metrics = (p.source_metrics && typeof p.source_metrics === 'object' && Object.keys(p.source_metrics).length)
        ? p.source_metrics : { note: String(p.evidence || '').slice(0, 200) };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-key': key },
        body: JSON.stringify({
          application: '2Labs Sites',
          scope: scopeFor(),
          target: p.target,
          change: p.change,
          evidence: p.evidence,
          source_metrics: metrics,
          risk: p.risk,
          suggested_review: p.suggested_review === 'auto' ? 'auto' : 'human',
          period,
          proposal_id: p.id,
        }),
      });
      if (res.status === 201) sent++;
      else if (res.status === 409) duplicate++;
      else failed++;
    } catch (e) { failed++; }
  }
  return { configured: true, sent, duplicate, failed };
}

module.exports = async function (context, req) {
  const internalOk = process.env.INTERNAL_API_KEY && (req.headers['x-internal-key'] === process.env.INTERNAL_API_KEY);
  if (!internalOk) {
    const email = await validateSessionEmail(getBearerToken(req));
    if (!email || !isEmailAllowed(email)) { context.res = { status: 401, body: { error: 'Authentication required.' } }; return; }
  }
  if (!process.env.ANTHROPIC_API_KEY) { context.res = { status: 500, body: { error: 'Server is not configured.' } }; return; }
  const days = Math.max(1, Math.min(parseInt((req.query && req.query.days) || '30', 10) || 30, 180));

  try {
    const events = await readEvents({ days });
    const agg = aggregate(events);
    const [playbooks, references] = await Promise.all([listKb('playbook'), listKb('reference')]);
    const addenda = await listAddenda();

    const user = [
      `Feedback aggregate for the last ${days} days:`,
      JSON.stringify(agg, null, 2),
      '',
      'Current KB playbooks (archetype, version, usage):',
      JSON.stringify(playbooks.map((p) => ({ key: p.key, version: p.version, usage_count: p.usage_count })), null, 2),
      'Approved prompt/playbook addenda already applied (target, version):',
      JSON.stringify(addenda, null, 2),
      '',
      'Propose the highest-value, evidence-backed improvements. If the data is thin, return no proposals.',
    ].join('\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5', max_tokens: 4000, thinking: { type: 'disabled' },
      system: systemPrompt(), tools: [PROPOSALS_TOOL], tool_choice: { type: 'tool', name: 'submit_proposals' },
      messages: [{ role: 'user', content: user }],
    });
    const tool = (response.content || []).find((c) => c.type === 'tool_use' && c.name === 'submit_proposals');
    const out = (tool && tool.input) || { proposals: [], period_summary: 'No output.' };
    const stored = await addProposals(out.proposals || [], { period_days: days, period_summary: out.period_summary });

    // Incorporate into the SHARED 2Labs Command Learning Loop: push each
    // proposal to Command's /learning/ingest (service-authenticated). Best-effort
    // and non-fatal — Sites keeps its own copy regardless.
    const ingest = await ingestToCommand(stored);

    context.res = { status: 200, body: { status: 'ok', period_summary: out.period_summary, proposals: stored, ingest } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { status: 'error', error: 'Could not run insights.', detail: err.message } };
  }
};
