/**
 * preview-page
 * -----------------------------------------------------------------------
 * POST /api/preview-page  { path: "/services" }   (auth-gated)
 *
 * Renders a client page's current draft-or-disk content (with all drafts
 * overlaid, so nav/components reflect the draft) and returns the HTML. Powers
 * clicking internal nav links inside the editor preview — so you can navigate
 * your draft pages without leaving the editor or hitting the live site.
 */

const fs = require('node:fs');
const path = require('node:path');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getDraftFile, listDraftFiles } = require('../lib/draftStore');
const { renderDraft } = require('../lib/renderDraft');
const { siteRoot, brand } = require('../lib/siteConfig');

const CLIENT_ID = brand.clientId;

/** Map a site URL path to a page source file. Returns null if unsafe. */
function pathToPageFile(urlPath) {
  let p = String(urlPath || '/').split('?')[0].split('#')[0];
  if (p === '' || p === '/') return 'src/pages/index.astro';
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  if (p.includes('..') || p.startsWith('.')) return null;
  if (p.endsWith('/')) p += 'index';
  return `src/pages/${p}.astro`;
}

module.exports = async function (context, req) {
  const sessionEmail = await validateSessionEmail(getBearerToken(req));
  if (!sessionEmail || !isEmailAllowed(sessionEmail)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }

  const urlPath = (req.body && req.body.path) || '/';
  const file = pathToPageFile(urlPath);
  if (!file) {
    context.res = { status: 400, body: { error: 'Invalid page path.' } };
    return;
  }

  try {
    let content = await getDraftFile(CLIENT_ID, file);
    if (content == null) {
      const abs = path.join(siteRoot(), file);
      content = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
    }
    if (content == null) {
      context.res = { status: 200, body: { status: 'not_found', path: urlPath, message: `There's no “${urlPath}” page yet.` } };
      return;
    }

    // Overlay all drafts so nav/layout/components reflect the current draft.
    const overlay = {};
    for (const p of await listDraftFiles(CLIENT_ID)) overlay[p] = await getDraftFile(CLIENT_ID, p);

    const html = await renderDraft(file, content, overlay);
    context.res = { status: 200, body: { status: 'ok', path: urlPath, file, html } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: 'Preview failed.', detail: err.message } };
  }
};
