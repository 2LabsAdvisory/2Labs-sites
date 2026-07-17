/**
 * revert-draft
 * -----------------------------------------------------------------------
 * POST /api/revert-draft   { }   (auth-gated)
 *
 * Undoes the LAST edit (one level). Restores the full draft snapshot that
 * edit-site saved before the edit — so multi-file edits and newly-created
 * pages revert cleanly (a new page is removed; an edited file is restored).
 * Renders the homepage after reverting.
 */

const fs = require('node:fs');
const path = require('node:path');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getUndoManifest, clearDraftFiles, setDraftFile, clearUndoManifest, getDraftFile } = require('../lib/draftStore');
const { renderDraft } = require('../lib/renderDraft');
const { siteRoot, DEFAULT_SITE } = require('../lib/siteConfig');

const HOME = 'src/pages/index.astro';

module.exports = async function (context, req) {
  const sessionEmail = await validateSessionEmail(getBearerToken(req));
  if (!sessionEmail || !isEmailAllowed(sessionEmail)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }
  const site = (req.body && req.body.site) || DEFAULT_SITE;

  try {
    const manifest = await getUndoManifest(site);
    if (manifest == null) {
      context.res = { status: 200, body: { status: 'nothing_to_revert', message: 'There is no change to revert.' } };
      return;
    }

    // Restore the exact draft set from before the last edit.
    await clearDraftFiles(site);
    for (const [p, content] of Object.entries(manifest)) await setDraftFile(site, p, content);
    await clearUndoManifest(site); // one level of undo

    // Preview the homepage in its reverted state, overlaying the restored
    // draft set so nav/layout reflect the revert too.
    const overlay = { ...manifest };
    let homeContent = overlay[HOME];
    if (homeContent == null) {
      const abs = path.join(siteRoot(site), HOME);
      homeContent = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
    }
    const html = homeContent ? await renderDraft(HOME, homeContent, overlay, site) : null;

    context.res = {
      status: 200,
      body: { status: 'reverted', html, note: 'Reverted the last change.' },
    };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: 'Revert failed.', detail: err.message } };
  }
};
