/**
 * save-site — POST /api/save-site  { name?, slug?, domain?, github? }  (auth-gated)
 * Creates or updates a site in the user's registry (matched by slug), incl.
 * the GitHub settings. Returns the saved record.
 */
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { upsertSite } = require('../lib/siteRegistry');
const { setDraftFile } = require('../lib/draftStore');
const { tokensFromBrand } = require('../lib/seedSite');

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }
  const input = req.body || {};
  if (!input.slug && !input.name) {
    context.res = { status: 400, body: { error: 'A site name is required.' } };
    return;
  }
  try {
    const site = await upsertSite(email, input);
    // When the brand system is saved, regenerate the site's tokens.css so brand
    // edits (colors, fonts, type scale, radius, spacing, logo) actually reach
    // the rendered site — not just the stored record.
    if (site && site.slug && input.brief && input.brief.brand && input.brief.brand.colors) {
      try { await setDraftFile(site.slug, 'src/styles/tokens.css', tokensFromBrand(input.brief.brand)); }
      catch (e) { context.log.warn('[save-site] tokens regen failed: ' + e.message); }
    }
    context.res = { status: 200, body: { status: 'ok', site } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: 'Could not save the site.', detail: err.message } };
  }
};
