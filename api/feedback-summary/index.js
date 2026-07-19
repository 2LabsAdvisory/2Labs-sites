/**
 * feedback-summary — GET /api/feedback-summary?days=30   (auth-gated, 2Labs only)
 *
 * Turns the raw feedback log into the reliability picture: where edits and
 * builds fail, which failure stages dominate, and which parts of generated
 * sites clients rewrite most (i.e. where the Studio's output is weakest). This
 * is the signal the learning loop and prompt improvements act on.
 */
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { readEvents } = require('../lib/feedbackStore');

const tally = (arr, keyFn) => {
  const m = {};
  for (const x of arr) { const k = keyFn(x); if (k == null || k === '') continue; m[k] = (m[k] || 0) + 1; }
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
};
const rate = (n, d) => (d ? +(n / d).toFixed(3) : 0);

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) { context.res = { status: 401, body: { error: 'Authentication required.' } }; return; }

  const days = Math.max(1, Math.min(parseInt((req.query && req.query.days) || '30', 10) || 30, 180));
  const events = await readEvents({ days });
  const edits = events.filter((e) => e.type === 'edit');
  const gens = events.filter((e) => e.type === 'generate');
  const kb = events.filter((e) => e.type === 'kb');
  const editOk = edits.filter((e) => e.result === 'success');
  const editErr = edits.filter((e) => e.result === 'error');

  const summary = {
    window_days: days,
    generated_at: new Date().toISOString(),
    totals: { events: events.length, edits: edits.length, generations: gens.length, sites: new Set(events.map((e) => e.site).filter(Boolean)).size },
    editing: {
      total: edits.length,
      success: editOk.length,
      errors: editErr.length,
      error_rate: rate(editErr.length, edits.length),
      // WHERE edits break most — the reliability targets.
      failure_stages: tally(editErr, (e) => e.stage),
      top_errors: tally(editErr, (e) => e.error).slice(0, 10),
      // WHAT clients rewrite most — where the AI's output is weakest.
      most_edited_files: tally(editOk.flatMap((e) => (Array.isArray(e.targets) ? e.targets : [])), (t) => t).slice(0, 15),
      by_tool: tally(editOk, (e) => e.tool),
    },
    generation: {
      by_stage: ['brand', 'plan', 'page', 'chrome'].map((s) => {
        const g = gens.filter((x) => x.stage === s);
        const errs = g.filter((x) => x.result === 'error').length;
        return { stage: s, total: g.length, errors: errs, error_rate: rate(errs, g.length) };
      }),
      // Plan fell back to the deterministic sitemap = the model call failed.
      plan_fallback_rate: (() => { const p = gens.filter((x) => x.stage === 'plan' && x.result === 'success'); return rate(p.filter((x) => x.used_fallback).length, p.length); })(),
      top_generation_errors: tally(gens.filter((x) => x.result === 'error'), (e) => `${e.stage}: ${e.error}`).slice(0, 10),
    },
    // Knowledge Base — the efficiency win: a high hit rate = builds skipping
    // live research. Broken out per collection.
    knowledge_base: {
      lookups: kb.length,
      hits: kb.filter((e) => e.result === 'hit').length,
      refreshes: kb.filter((e) => e.result === 'refresh').length,
      hit_rate: rate(kb.filter((e) => e.result === 'hit').length, kb.length),
      by_kind: ['playbook', 'reference'].map((k) => {
        const g = kb.filter((e) => e.stage === k);
        return { kind: k, hits: g.filter((e) => e.result === 'hit').length, refreshes: g.filter((e) => e.result === 'refresh').length, hit_rate: rate(g.filter((e) => e.result === 'hit').length, g.length) };
      }),
    },
  };

  context.res = { status: 200, body: { status: 'ok', summary } };
};
