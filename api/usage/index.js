/**
 * usage — GET /api/usage   (auth-gated)
 * Returns the signed-in user's current-month AI credit usage for the meter:
 * { status:'ok', period, used, limit, remaining, resetsOn, tokens, estCostUsd }.
 * A "credit" is 1 AI edit; token + cost detail is included for admin visibility.
 */
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getUsage } = require('../lib/usageStore');

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }
  try {
    const usage = await getUsage(email);
    context.res = { status: 200, body: { status: 'ok', ...usage } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: 'Could not load usage.', detail: err.message } };
  }
};
