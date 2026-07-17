/**
 * delete-site — POST /api/delete-site  { site: slug }   (auth-gated)
 * Permanently removes a site from the user's registry and clears its drafts.
 * (The shared _base skeleton and the on-disk 2labs project are never touched.)
 */
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getSite, deleteSite } = require('../lib/siteRegistry');
const { clearDraft } = require('../lib/draftStore');

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }
  const slug = req.body && req.body.site;
  if (!slug) {
    context.res = { status: 400, body: { error: 'A site is required.' } };
    return;
  }
  try {
    const site = await getSite(email, slug);
    if (!site) {
      context.res = { status: 404, body: { error: 'Site not found.' } };
      return;
    }
    await clearDraft(slug).catch((e) => context.log.warn('draft cleanup failed: ' + e.message));
    const { removed } = await deleteSite(email, slug);
    context.res = { status: 200, body: { status: 'ok', removed } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: 'Could not delete the site.', detail: err.message } };
  }
};
