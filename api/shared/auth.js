'use strict';

/**
 * Shared auth helpers for the 2Labs Sites API.
 *
 * Auth is handled by the shared 2Labs OTP service (in the communications
 * function app), which every 2Labs product reuses. This app proxies
 * request-code / verify-code to it server-to-server (with the shared
 * X-Internal-Api-Key) and validates session tokens against its /auth/me.
 * PassCard-style OTP still underneath, but centralized and app-branded:
 * we pass app="2labs-websites", so the sign-in email uses the 2Labs
 * Websites template from 2Labs Command.
 *
 * Access here is additionally restricted to an explicit allowlist.
 *
 * Config (app settings):
 *   SHARED_AUTH_BASE_URL   e.g. https://func-2labs-communications-prod-....azurewebsites.net
 *   INTERNAL_API_KEY       shared service-to-service key for the auth endpoints
 *   APP_KEY                this app's registry key (default "2labs-websites")
 *   EDITOR_ALLOWED_EMAILS  comma-separated list of emails permitted to sign in
 */

function sharedAuthBaseUrl() {
  const base = process.env.SHARED_AUTH_BASE_URL;
  if (!base) throw new Error('SHARED_AUTH_BASE_URL is not configured.');
  return base.replace(/\/+$/, '');
}

function internalApiKey() {
  const key = process.env.INTERNAL_API_KEY;
  if (!key) throw new Error('INTERNAL_API_KEY is not configured.');
  return key;
}

function appKey() {
  return process.env.APP_KEY || '2labs-websites';
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

/** Call the shared auth service with the internal service-to-service key. */
async function sharedAuthFetch(path, { headers = {}, ...options } = {}) {
  return fetch(`${sharedAuthBaseUrl()}${path}`, {
    ...options,
    headers: { 'X-Internal-Api-Key': internalApiKey(), ...headers },
  });
}

/** Extract the session token from a classic-model Azure Functions request. */
function getBearerToken(req) {
  const headers = (req && req.headers) || {};
  // Azure Static Web Apps strips the standard Authorization header before
  // forwarding to managed functions, so the client also sends the token in a
  // custom x-2labs-session header. Read that first, then Authorization.
  const custom = headers['x-2labs-session'] || headers['X-2Labs-Session'];
  if (custom && String(custom).trim()) return String(custom).trim();

  const auth = headers.authorization || headers.Authorization || '';
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : null;
}

/**
 * Validate a session token against the shared auth service. Returns the
 * account's lowercased email if the token is valid AND scoped to this app,
 * else null. Never throws.
 */
async function validateSessionEmail(token) {
  if (!token) return null;
  try {
    const res = await sharedAuthFetch('/api/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    // The session must belong to this app — a token minted for another 2Labs
    // app must not be usable here.
    if (!data || !data.success || data.app !== appKey()) return null;
    const email = data.user && data.user.email;
    return email ? String(email).toLowerCase() : null;
  } catch {
    return null;
  }
}

module.exports = {
  sharedAuthBaseUrl,
  internalApiKey,
  appKey,
  allowedEmails,
  isEmailAllowed,
  sharedAuthFetch,
  getBearerToken,
  validateSessionEmail,
};
