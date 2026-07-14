'use strict';

/**
 * auth/verify-code — proxies to the shared 2Labs OTP service (app=
 * 2labs-websites) for allowlisted emails and passes through the resulting
 * { success, user, token } on success. The token is a shared-auth server-side
 * session token the client stores and sends on subsequent calls (validated by
 * /api/edit-site via the shared /auth/me).
 */
const { isEmailAllowed, sharedAuthFetch, appKey } = require('../shared/auth');

const GENERIC_ERROR = { success: false, error: 'That code is invalid or has expired.' };

module.exports = async function (context, req) {
  const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim() : '';
  const code = req.body && typeof req.body.code === 'string' ? req.body.code.trim() : '';

  if (!email || !code) {
    context.res = { status: 400, body: GENERIC_ERROR };
    return;
  }

  // Same generic failure as a wrong code — don't reveal allowlist membership.
  if (!isEmailAllowed(email)) {
    context.res = { status: 400, body: GENERIC_ERROR };
    return;
  }

  try {
    const res = await sharedAuthFetch('/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code, app: appKey() }),
    });
    const body = await res.json().catch(() => GENERIC_ERROR);
    context.res = { status: res.status, body };
  } catch (err) {
    context.log.error(`auth/verify-code proxy failed: ${err.message}`);
    context.res = { status: 500, body: { success: false, error: 'Unable to sign in right now. Please try again.' } };
  }
};
