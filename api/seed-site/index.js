/**
 * seed-site — POST /api/seed-site  { site: slug }   (auth-gated)
 * Gives a brand-new site an editable starter: writes tokens.css + a home page
 * (templated from its Wizard Brief) as drafts, and marks the site editable so
 * it opens in the editor. Renders against the shared _base skeleton.
 */
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getSite, upsertSite } = require('../lib/siteRegistry');
const { seedStarter } = require('../lib/seedSite');

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
    await seedStarter(slug, site.brief || {});
    const updated = await upsertSite(email, { slug, editable: true });
    context.res = { status: 200, body: { status: 'ok', site: updated } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: 'Could not set up the site.', detail: err.message } };
  }
};
