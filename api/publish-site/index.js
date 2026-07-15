/**
 * publish-site
 * -----------------------------------------------------------------------
 * POST /api/publish-site  { }   (auth-gated)
 *
 * The ONLY place git is touched. Reads every draft file for the client from
 * Blob Storage, commits each to GitHub `main` (which triggers the SWA
 * production deploy), then clears the draft on success.
 *
 * Required app settings: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO,
 * AZURE_STORAGE_CONNECTION_STRING (+ DRAFT_CONTAINER), plus shared-auth.
 */

const { Octokit } = require('@octokit/rest');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { listDraftFiles, getDraftFile, clearDraft } = require('../lib/draftStore');
const { brand } = require('../lib/siteConfig');

const CLIENT_ID = brand.clientId;
const BRANCH = 'main';

module.exports = async function (context, req) {
  const sessionEmail = await validateSessionEmail(getBearerToken(req));
  if (!sessionEmail || !isEmailAllowed(sessionEmail)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }

  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    context.log.error('Missing GitHub app settings.');
    context.res = { status: 500, body: { error: 'Server is not configured.' } };
    return;
  }

  try {
    const files = await listDraftFiles(CLIENT_ID);
    if (files.length === 0) {
      context.res = { status: 200, body: { status: 'nothing_to_publish', message: 'No draft changes to publish.' } };
      return;
    }

    const octokit = new Octokit({ auth: GITHUB_TOKEN });
    const repoRef = { owner: GITHUB_OWNER, repo: GITHUB_REPO };
    const published = [];

    for (const filePath of files) {
      const content = await getDraftFile(CLIENT_ID, filePath);
      if (content == null) continue;

      // A file update needs the current blob sha; a brand-new file doesn't.
      let sha;
      try {
        const existing = await octokit.repos.getContent({ ...repoRef, path: filePath, ref: BRANCH });
        sha = existing.data.sha;
      } catch (err) {
        if (err.status !== 404) throw err;
      }

      await octokit.repos.createOrUpdateFileContents({
        ...repoRef,
        path: filePath,
        branch: BRANCH,
        message: `Publish: ${filePath} (by ${sessionEmail})`,
        content: Buffer.from(content, 'utf-8').toString('base64'),
        ...(sha ? { sha } : {}),
      });
      published.push(filePath);
    }

    // Only clear the draft once everything committed successfully.
    await clearDraft(CLIENT_ID);

    context.res = {
      status: 200,
      body: {
        status: 'published',
        files: published,
        count: published.length,
        note: 'Committed to main. Azure Static Web Apps will rebuild and deploy production.',
      },
    };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: 'Publish failed.', detail: err.message } };
  }
};
