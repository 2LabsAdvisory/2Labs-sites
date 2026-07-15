/**
 * list-sites — GET /api/list-sites  (auth-gated)
 * Returns the signed-in user's managed sites (seeds defaults on first use).
 */
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { listSites } = require('../lib/siteRegistry');

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }
  try {
    const sites = await listSites(email);
    context.res = { status: 200, body: { status: 'ok', sites } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: 'Could not load sites.', detail: err.message } };
  }
};
