/**
 * publish-site
 * -----------------------------------------------------------------------
 * POST /api/publish-site  { site?: slug }   (auth-gated)
 *
 * The ONLY place git is touched. Publishes the given site's draft to ITS OWN
 * GitHub repo (from the user's registry), not the builder repo. Reads every
 * draft file, commits each to the site's branch (which triggers that site's
 * SWA production deploy), then clears the draft on success.
 *
 * A site with no repo configured returns `not_connected` — we never push a
 * client site's files into the builder repo.
 *
 * Required app settings: GITHUB_TOKEN, AZURE_STORAGE_CONNECTION_STRING
 * (+ DRAFT_CONTAINER, REGISTRY_CONTAINER), plus shared-auth.
 */

const { Octokit } = require('@octokit/rest');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { listDraftFiles, getDraftFile, clearDraft, isDeleted } = require('../lib/draftStore');
const { getSite } = require('../lib/siteRegistry');
const { brand, DEFAULT_SITE } = require('../lib/siteConfig');

const CLIENT_ID = brand.clientId;

module.exports = async function (context, req) {
  const sessionEmail = await validateSessionEmail(getBearerToken(req));
  if (!sessionEmail || !isEmailAllowed(sessionEmail)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }

  const slug = (req.body && req.body.site) || DEFAULT_SITE;

  const { GITHUB_TOKEN } = process.env;
  if (!GITHUB_TOKEN) {
    context.log.error('Missing GITHUB_TOKEN app setting.');
    context.res = { status: 500, body: { error: 'Server is not configured.' } };
    return;
  }

  try {
    const site = await getSite(sessionEmail, slug);
    if (!site) {
      context.res = { status: 404, body: { error: 'Site not found.' } };
      return;
    }

    const gh = site.github || {};
    if (!gh.owner || !gh.repo) {
      context.res = {
        status: 409,
        body: {
          status: 'not_connected',
          message: `Connect ${site.name}'s GitHub repository in Settings before publishing.`,
        },
      };
      return;
    }
    const branch = gh.branch || 'main';

    const files = await listDraftFiles(CLIENT_ID);
    if (files.length === 0) {
      context.res = { status: 200, body: { status: 'nothing_to_publish', message: 'No draft changes to publish.' } };
      return;
    }

    const octokit = new Octokit({ auth: GITHUB_TOKEN });
    const repoRef = { owner: gh.owner, repo: gh.repo };
    const published = [];

    for (const filePath of files) {
      const content = await getDraftFile(CLIENT_ID, filePath);
      if (content == null) continue;

      // Current sha (needed to update or delete an existing file; absent = new).
      let sha;
      try {
        const existing = await octokit.repos.getContent({ ...repoRef, path: filePath, ref: branch });
        sha = existing.data.sha;
      } catch (err) {
        if (err.status !== 404) throw err;
      }

      // A tombstoned draft means "remove this page from the repo".
      if (isDeleted(content)) {
        if (sha) {
          await octokit.repos.deleteFile({ ...repoRef, path: filePath, branch, message: `Delete: ${filePath} (by ${sessionEmail})`, sha });
          published.push('− ' + filePath);
        }
        continue;
      }

      await octokit.repos.createOrUpdateFileContents({
        ...repoRef,
        path: filePath,
        branch,
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
        site: site.slug,
        repo: `${gh.owner}/${gh.repo}`,
        files: published,
        count: published.length,
        note: 'Committed. Azure Static Web Apps will rebuild and deploy production.',
      },
    };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: 'Publish failed.', detail: err.message } };
  }
};
