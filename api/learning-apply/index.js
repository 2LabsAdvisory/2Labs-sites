/**
 * learning-apply — POST /api/learning-apply   (service-auth via X-Ingest-Key)
 *
 * The apply-back half of the shared Learning Loop: 2Labs Command calls this when
 * a reviewer APPROVES one of Sites' proposals, so the improvement actually takes
 * effect in Sites. Applies the change as a versioned prompt/playbook addendum
 * (the same mechanism as Sites' own review), and returns the new version so
 * Command can record applied_version.
 *
 *   Body: { target: "prompt:<agent>" | "kb_playbook:<archetype>", change: string }
 *   Auth: header X-Ingest-Key === LEARNING_INGEST_KEY (shared Sites↔Command key)
 */
const { setAddendum } = require('../lib/learningStore');
const { getEntry, putEntry } = require('../lib/kb');

module.exports = async function (context, req) {
  const key = process.env.LEARNING_INGEST_KEY;
  if (!key || (req.headers && req.headers['x-ingest-key']) !== key) {
    context.res = { status: 401, body: { error: 'Unauthorized.' } };
    return;
  }
  const b = req.body || {};
  const target = String(b.target || '').trim();
  const change = String(b.edited_change || b.change || '').trim();
  if (!target || !change || !/^(prompt:|kb_playbook:)/.test(target)) {
    context.res = { status: 400, body: { error: 'A "target" (prompt:<agent> or kb_playbook:<archetype>) and non-empty "change" are required.' } };
    return;
  }

  try {
    const rec = await setAddendum(target, change, { source: '2labs-command', at: new Date().toISOString() });

    // A playbook learning: force that archetype to re-research so the learning
    // flows into the next build of it.
    if (target.startsWith('kb_playbook:')) {
      const archetype = target.slice('kb_playbook:'.length);
      try {
        const e = await getEntry('playbook', archetype);
        if (e) { e.do_not_use = true; e.review_status = 'human_updated'; await putEntry('playbook', archetype, e); }
      } catch (err) { /* best-effort */ }
    }

    context.res = { status: 200, body: { status: 'ok', target, version: String(rec.version), applied_version: `v${rec.version}` } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: 'Apply failed.', detail: err.message } };
  }
};
