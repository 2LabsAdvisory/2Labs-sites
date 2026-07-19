/**
 * kb-list — GET /api/kb-list   (auth-gated, 2Labs only)
 *
 * Inspect the shared Studio Knowledge Base: every cached category playbook and
 * reference analysis with its freshness metadata (confidence, version,
 * usage_count, ttl, review_status, do_not_use). Supports traceability
 * ("which knowledge exists") and the human-review need until an admin UI ships.
 */
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { list } = require('../lib/kb');

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) { context.res = { status: 401, body: { error: 'Authentication required.' } }; return; }
  const [playbooks, references] = await Promise.all([list('playbook'), list('reference')]);
  context.res = { status: 200, body: { status: 'ok', playbooks, references } };
};
