/**
 * revert-draft
 * -----------------------------------------------------------------------
 * POST /api/revert-draft   { }   (auth-gated)
 *
 * Undoes the LAST edit (one level): restores the pre-edit snapshot that
 * edit-site saved, renders it, and returns the HTML. Single-level — after a
 * revert there's nothing more to undo until the next edit.
 */

const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getUndoFile, setDraftFile, clearUndoFile } = require('../lib/draftStore');
const { renderDraft } = require('../lib/renderDraft');
const { brand } = require('../lib/siteConfig');

const CLIENT_ID = brand.clientId;
const TARGET_FILE = 'src/pages/index.astro';

module.exports = async function (context, req) {
  const sessionEmail = await validateSessionEmail(getBearerToken(req));
  if (!sessionEmail || !isEmailAllowed(sessionEmail)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }

  try {
    const previous = await getUndoFile(CLIENT_ID, TARGET_FILE);
    if (previous == null) {
      context.res = { status: 200, body: { status: 'nothing_to_revert', message: 'There is no change to revert.' } };
      return;
    }

    const html = await renderDraft(TARGET_FILE, previous);
    await setDraftFile(CLIENT_ID, TARGET_FILE, previous);
    await clearUndoFile(CLIENT_ID, TARGET_FILE); // one level of undo

    context.res = {
      status: 200,
      body: { status: 'reverted', file: TARGET_FILE, html, note: 'Reverted the last change.' },
    };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: 'Revert failed.', detail: err.message } };
  }
};
