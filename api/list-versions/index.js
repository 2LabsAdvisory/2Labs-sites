/**
 * list-versions
 * -----------------------------------------------------------------------
 * GET /api/list-versions   (auth-gated)
 *
 * Lists recent commits on the client's `main` branch — powers the editor's
 * History tab. Read-only.
 *
 * Required app settings: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, shared-auth.
 */

const { Octokit } = require('@octokit/rest');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');

const BRANCH = 'main';

module.exports = async function (context, req) {
  const sessionEmail = await validateSessionEmail(getBearerToken(req));
  if (!sessionEmail || !isEmailAllowed(sessionEmail)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }

  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    context.res = { status: 500, body: { error: 'Server is not configured.' } };
    return;
  }

  try {
    const octokit = new Octokit({ auth: GITHUB_TOKEN });
    const res = await octokit.repos.listCommits({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      sha: BRANCH,
      per_page: 30,
    });

    const versions = res.data.map((c) => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: c.commit.message.split('\n')[0],
      author: c.commit.author && c.commit.author.name,
      date: c.commit.author && c.commit.author.date,
    }));

    context.res = { status: 200, body: { status: 'ok', versions } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: 'Could not list versions.', detail: err.message } };
  }
};
