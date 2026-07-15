/**
 * restore-version
 * -----------------------------------------------------------------------
 * POST /api/restore-version   { sha: string, path?: string }   (auth-gated)
 *
 * Pulls a file's content at a given commit and writes it into the client's
 * draft (Blob Storage) — powers "Load into editor" from the History tab.
 * Does NOT touch git or publish; the restored content becomes a draft the
 * user can review, edit further, and publish.
 *
 * Required app settings: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO,
 * AZURE_STORAGE_CONNECTION_STRING (+ DRAFT_CONTAINER), shared-auth.
 */

const { Octokit } = require('@octokit/rest');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { setDraftFile } = require('../lib/draftStore');
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

  const sha = req.body && typeof req.body.sha === 'string' ? req.body.sha.trim() : '';
  const filePath = (req.body && typeof req.body.path === 'string' && req.body.path.trim()) || TARGET_FILE;
  if (!sha) {
    context.res = { status: 400, body: { error: 'A commit "sha" is required.' } };
    return;
  }

  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    context.res = { status: 500, body: { error: 'Server is not configured.' } };
    return;
  }

  try {
    const octokit = new Octokit({ auth: GITHUB_TOKEN });
    const res = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: filePath,
      ref: sha,
    });
    const content = Buffer.from(res.data.content, 'base64').toString('utf-8');

    await setDraftFile(CLIENT_ID, filePath, content);

    // Render the restored draft so the editor can show it immediately.
    let html = null;
    try {
      html = await renderDraft(filePath, content);
    } catch (err) {
      context.log.error(`restore-version render failed: ${err.message}`);
    }

    context.res = {
      status: 200,
      body: {
        status: 'restored',
        file: filePath,
        sha,
        html,
        note: 'Loaded into your draft. Review and publish when ready.',
      },
    };
  } catch (err) {
    context.log.error(err);
    if (err.status === 404) {
      context.res = { status: 404, body: { error: 'That file/version was not found.' } };
      return;
    }
    context.res = { status: 500, body: { error: 'Restore failed.', detail: err.message } };
  }
};
