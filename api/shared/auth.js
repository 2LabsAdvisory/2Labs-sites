'use strict';

/**
 * Shared auth helpers for the 2Labs Sites API.
 *
 * We reuse the existing PassCard passwordless OTP flow (passcard-functions)
 * rather than rebuilding it: this app proxies request-code / verify-code to
 * PassCard server-to-server, and validates the resulting bearer token against
 * PassCard's /api/profile/me. PassCard auto-provisions any email that requests
 * a code, so access here is additionally restricted to an explicit allowlist.
 *
 * Config (app settings):
 *   PASSCARD_API_BASE_URL   e.g. https://passcard-functions-xxxx.canadacentral-01.azurewebsites.net
 *   EDITOR_ALLOWED_EMAILS   comma-separated list of emails permitted to sign in
 */

function passcardBaseUrl() {
  const base = process.env.PASSCARD_API_BASE_URL;
  if (!base) throw new Error('PASSCARD_API_BASE_URL is not configured.');
  return base.replace(/\/+$/, '');
}

/** Parsed allowlist (lowercased). An empty list means "deny everyone" (fail closed). */
function allowedEmails() {
  return (process.env.EDITOR_ALLOWED_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isEmailAllowed(email) {
  if (!email || typeof email !== 'string') return false;
  return allowedEmails().includes(email.trim().toLowerCase());
}

/** Forward a request to the PassCard functions app. Returns the fetch Response. */
async function passcardFetch(path, options) {
  return fetch(`${passcardBaseUrl()}${path}`, options);
}

/** Extract a bearer token from a classic-model Azure Functions request. */
function getBearerToken(req) {
  const header = (req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
}

/**
 * Validate a session token against PassCard. Returns the account's lowercased
 * email if the token is valid, else null. Never throws.
 */
async function validateSessionEmail(token) {
  if (!token) return null;
  try {
    const res = await passcardFetch('/api/profile/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const email = data && data.user && data.user.email;
    return email ? String(email).toLowerCase() : null;
  } catch {
    return null;
  }
}

module.exports = {
  passcardBaseUrl,
  allowedEmails,
  isEmailAllowed,
  passcardFetch,
  getBearerToken,
  validateSessionEmail,
};
