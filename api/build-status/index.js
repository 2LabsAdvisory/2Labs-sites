/**
 * build-status — GET /api/build-status?site=slug   (auth-gated)
 *
 * Progress + resumability for a full-mirror import build. Returns the manifest
 * summary (done/total), the nav tree, and the list of pages still pending, so
 * the wizard (or the editor, on reopen) can show progress and resume.
 */
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getSite } = require('../lib/siteRegistry');
const buildStore = require('../lib/buildStore');

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) { context.res = { status: 401, body: { error: 'Authentication required.' } }; return; }
  const slug = req.query && req.query.site;
  if (!slug) { context.res = { status: 400, body: { error: 'A site is required.' } }; return; }

  try {
    const site = await getSite(email, slug);
    if (!site) { context.res = { status: 404, body: { error: 'Site not found.' } }; return; }
    const m = await buildStore.getManifest(slug);
    if (!m) { context.res = { status: 200, body: { status: 'none' } }; return; }
    const summary = buildStore.summarize(m);
    const pending = m.pages.filter((p) => p.status !== 'done').map((p) => ({ path: p.path, title: p.title }));
    context.res = { status: 200, body: { status: 'ok', ...summary, nav: m.nav, pending } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { status: 'error', error: 'Could not read build status.' } };
  }
};
