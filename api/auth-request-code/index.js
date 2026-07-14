'use strict';

/**
 * auth/request-code — proxies to PassCard's request-code, but only for
 * allowlisted emails. Non-allowlisted (or invalid) emails get the same
 * generic response without a code being sent or an account provisioned, so
 * the endpoint doesn't reveal who is allowed.
 */
const { isEmailAllowed, passcardFetch } = require('../shared/auth');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENERIC = { success: true, message: 'If that email is authorized, a code has been sent.' };

module.exports = async function (context, req) {
  const email = req.body && typeof req.body.email === 'string' ? req.body.email.trim() : '';

  if (!email || !EMAIL_REGEX.test(email)) {
    context.res = { status: 400, body: { success: false, error: 'A valid email address is required.' } };
    return;
  }

  // Fail closed: only allowlisted emails are forwarded to PassCard (which
  // would otherwise auto-provision any address on first contact).
  if (!isEmailAllowed(email)) {
    context.res = { status: 200, body: GENERIC };
    return;
  }

  try {
    const res = await passcardFetch('/api/auth/request-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const body = await res.json().catch(() => GENERIC);
    context.res = { status: res.status, body };
  } catch (err) {
    // Don't leak infrastructure errors as an enumeration signal; log server-side.
    context.log.error(`auth/request-code proxy failed: ${err.message}`);
    context.res = { status: 200, body: GENERIC };
  }
};
