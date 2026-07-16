/**
 * edit-result — GET /api/edit-result?id=<requestId>   (auth-gated)
 * Returns the stored result of an edit-site request (for polling when the
 * original POST was cut off by the gateway timeout), or { status: 'pending' }.
 */
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getResult } = require('../lib/editResultStore');

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }
  const id = req.query && req.query.id;
  if (!id) {
    context.res = { status: 400, body: { error: 'A request id is required.' } };
    return;
  }
  try {
    const result = await getResult(email, id);
    context.res = { status: 200, body: result || { status: 'pending' } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { status: 'error', error: 'Could not load the result.' } };
  }
};
