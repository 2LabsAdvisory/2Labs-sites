/**
 * insights — GET /api/insights?status=pending   (auth-gated, 2Labs only)
 * The human review queue: list the Insights agent's proposals.
 */
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { listProposals } = require('../lib/insightsStore');

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) { context.res = { status: 401, body: { error: 'Authentication required.' } }; return; }
  const status = (req.query && req.query.status) || undefined;
  const proposals = await listProposals({ status });
  context.res = { status: 200, body: { status: 'ok', proposals } };
};
