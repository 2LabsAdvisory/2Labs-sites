/**
 * insights-decide — POST /api/insights-decide  { id, decision, edit? }   (2Labs only)
 *
 * The human-in-the-loop gate on shared knowledge. Approving a proposal APPLIES
 * it as a versioned addendum the relevant agent injects into its prompt:
 *   - prompt:<agent>     → addendum on that agent's prompt.
 *   - kb_playbook:<arch> → addendum for research-category AND the archetype's
 *     cached playbook is marked do_not_use so it re-researches with the learning.
 * Everything is versioned and reversible; nothing changes prompts silently.
 */
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getProposal, updateProposal } = require('../lib/insightsStore');
const { setAddendum } = require('../lib/learningStore');
const { getEntry, putEntry } = require('../lib/kb');

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) { context.res = { status: 401, body: { error: 'Authentication required.' } }; return; }
  const b = req.body || {};
  const id = b.id;
  const decision = b.decision === 'approve' ? 'approve' : b.decision === 'reject' ? 'reject' : null;
  if (!id || !decision) { context.res = { status: 400, body: { error: 'id and decision (approve|reject) are required.' } }; return; }

  try {
    const p = await getProposal(id);
    if (!p) { context.res = { status: 404, body: { error: 'Proposal not found.' } }; return; }
    if (p.status !== 'pending') { context.res = { status: 409, body: { error: `Already ${p.status}.` } }; return; }

    if (decision === 'reject') {
      const updated = await updateProposal(id, { status: 'rejected', decided_by: email });
      context.res = { status: 200, body: { status: 'ok', proposal: updated } };
      return;
    }

    // Approve → apply the (optionally human-edited) change.
    const target = String(p.target || '');
    const text = String(b.edit || p.change || '').trim();
    if (!text || !/^(prompt:|kb_playbook:)/.test(target)) {
      context.res = { status: 400, body: { error: 'Proposal has no applicable target/change.' } }; return;
    }
    const rec = await setAddendum(target, text, { proposal_id: id, approved_by: email });

    // For a playbook learning, force the cached entry to re-research so the
    // learning actually flows into the next build of that archetype.
    if (target.startsWith('kb_playbook:')) {
      const key = target.slice('kb_playbook:'.length);
      try { const e = await getEntry('playbook', key); if (e) { e.do_not_use = true; e.review_status = 'human_updated'; await putEntry('playbook', key, e); } } catch (err) { /* best-effort */ }
    }

    const updated = await updateProposal(id, { status: 'applied', decided_by: email, applied_version: rec.version, applied_text: text });
    context.res = { status: 200, body: { status: 'ok', proposal: updated, addendum_version: rec.version } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { status: 'error', error: 'Could not apply the decision.', detail: err.message } };
  }
};
