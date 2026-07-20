/**
 * publish-site
 * -----------------------------------------------------------------------
 * POST /api/publish-site  { site?: slug }   (auth-gated)
 *
 * The ONLY place git is touched. Publishes the given site's draft to ITS OWN
 * GitHub repo (from the user's registry), not the builder repo. Reads every
 * draft file, commits each to the site's branch (which triggers that site's
 * SWA production deploy). The draft is left in place as the working copy — a
 * generated site lives only in the draft store, so clearing it would wipe the
 * editable site.
 *
 * A site with no repo configured returns `not_connected` — we never push a
 * client site's files into the builder repo.
 *
 * Required app settings: GITHUB_TOKEN, AZURE_STORAGE_CONNECTION_STRING
 * (+ DRAFT_CONTAINER, REGISTRY_CONTAINER), plus shared-auth.
 */

const { Octokit } = require('@octokit/rest');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { listDraftFiles, getDraftFile, isDeleted } = require('../lib/draftStore');
const { scaffoldFiles } = require('../lib/publishScaffold');
const { getSite } = require('../lib/siteRegistry');
const { DEFAULT_SITE } = require('../lib/siteConfig');

module.exports = async function (context, req) {
  const sessionEmail = await validateSessionEmail(getBearerToken(req));
  if (!sessionEmail || !isEmailAllowed(sessionEmail)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }

  const slug = (req.body && req.body.site) || DEFAULT_SITE;
  let repoLabel = ''; // for clear error messages in the catch

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

    const files = await listDraftFiles(slug);

    const octokit = new Octokit({ auth: GITHUB_TOKEN });
    const repoRef = { owner: gh.owner, repo: gh.repo };
    repoLabel = `${gh.owner}/${gh.repo}`;
    const published = [];

    // Preflight: a clear, actionable message beats a generic 500 when the
    // configured repo doesn't exist or the token can't reach it.
    let repoInfo;
    try {
      repoInfo = await octokit.repos.get(repoRef);
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        context.res = { status: 409, body: { status: 'repo_forbidden', error: `The publishing token can't access ${repoLabel}. Give it Contents: read & write on that repo, or correct the repo in Settings.` } };
        return;
      }
      if (e.status !== 404) throw e;
      // Repo doesn't exist — create it as a PRIVATE repo under the configured
      // owner (org or the token's own account), empty; the branch bootstrap
      // below seeds the first commit.
      try {
        let isOrg = false;
        try { await octokit.orgs.get({ org: gh.owner }); isOrg = true; } catch (oe) { if (oe.status !== 404) throw oe; }
        const createArgs = { name: gh.repo, private: true, auto_init: false, description: `${site.name} — published by 2Labs Sites` };
        if (isOrg) {
          await octokit.repos.createInOrg({ org: gh.owner, ...createArgs });
        } else {
          const me = await octokit.users.getAuthenticated();
          if (String(me.data.login).toLowerCase() !== String(gh.owner).toLowerCase()) {
            context.res = { status: 409, body: { status: 'repo_missing', error: `Can't auto-create ${repoLabel}: "${gh.owner}" isn't an organization the publishing token can create in, and isn't the token's own account (${me.data.login}). Create the repo manually, or set the owner to an org/account the token controls.` } };
            return;
          }
          await octokit.repos.createForAuthenticatedUser(createArgs);
        }
        context.log(`[publish] created private repo ${repoLabel}`);
        repoInfo = await octokit.repos.get(repoRef);
      } catch (ce) {
        context.res = { status: 409, body: { status: 'repo_create_failed', error: `Couldn't create ${repoLabel}: ${ce.message}. The publishing token needs permission to create repositories in "${gh.owner}".` } };
        return;
      }
    }

    // Auto-initialize: make sure the target branch exists so publishing to a
    // brand-new/empty repo "just works". Missing branch on a repo that already
    // has commits → branch it off the default HEAD; a truly empty repo → seed a
    // first commit (which creates the branch).
    try {
      await octokit.repos.getBranch({ ...repoRef, branch });
    } catch (e) {
      if (e.status !== 404) throw e;
      const defaultBranch = (repoInfo && repoInfo.data && repoInfo.data.default_branch) || 'main';
      let baseSha = null;
      try {
        const ref = await octokit.git.getRef({ ...repoRef, ref: `heads/${defaultBranch}` });
        baseSha = ref.data.object.sha;
      } catch (e2) { if (e2.status !== 404 && e2.status !== 409) throw e2; }
      if (baseSha) {
        await octokit.git.createRef({ ...repoRef, ref: `refs/heads/${branch}`, sha: baseSha });
        context.log(`[publish] created branch "${branch}" on ${repoLabel} from "${defaultBranch}"`);
      } else {
        await octokit.repos.createOrUpdateFileContents({
          ...repoRef, path: 'README.md', branch,
          message: 'Initialize repository (2Labs Sites)',
          content: Buffer.from(`# ${site.name}\n\nPublished with 2Labs Sites.\n`, 'utf-8').toString('base64'),
        });
        context.log(`[publish] initialized empty repo ${repoLabel} on "${branch}"`);
      }
    }

    for (const filePath of files) {
      const content = await getDraftFile(slug, filePath);
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

    // Commit the project scaffolding (package.json, astro.config, tsconfig,
    // BaseLayout, SWA config) so the repo is a COMPLETE, buildable Astro site.
    // Gap-fill only: never overwrite a file that's already there (drafts win,
    // and any hand-tweaked scaffolding is preserved).
    const draftSet = new Set(files);
    for (const s of scaffoldFiles(slug)) {
      if (draftSet.has(s.path)) continue;
      let exists = false;
      try { await octokit.repos.getContent({ ...repoRef, path: s.path, ref: branch }); exists = true; }
      catch (err) { if (err.status !== 404) throw err; }
      if (exists) continue;
      await octokit.repos.createOrUpdateFileContents({
        ...repoRef, path: s.path, branch,
        message: `Scaffold: ${s.path} (by ${sessionEmail})`,
        content: Buffer.from(s.content, 'utf-8').toString('base64'),
      });
      published.push(s.path);
    }

    if (published.length === 0) {
      context.res = { status: 200, body: { status: 'nothing_to_publish', message: 'No draft changes to publish.' } };
      return;
    }

    // Deliberately DO NOT clear the draft here. A generated site lives ONLY in
    // the draft store (it has no local project directory), so clearing drafts on
    // publish would erase the editable copy and the editor would fall back to the
    // empty _base skeleton ("new site"). The draft is the working copy; publish
    // just commits a snapshot to GitHub. (Publishing again re-commits — cheap,
    // and safe.)

    context.res = {
      status: 200,
      body: {
        status: 'published',
        site: site.slug,
        repo: `${gh.owner}/${gh.repo}`,
        files: published,
        count: published.length,
        note: 'Committed. Connect this repo to a new Static Web App (framework: Astro, output: dist) to host it.',
      },
    };
  } catch (err) {
    context.log.error(err);
    const where = repoLabel ? ` to ${repoLabel}` : '';
    let error = 'Publish failed.';
    if (err.status === 404) error = `Publish failed: ${repoLabel || 'the repository'} or its branch wasn't found. Check the GitHub owner/repo/branch under Settings → Danger zone.`;
    else if (err.status === 401 || err.status === 403) error = `Publish failed: the publishing token can't write${where}. It needs a fine-grained PAT with Contents: read & write on that repo.`;
    else if (err.status === 409) error = `Publish failed: a conflict${where}. If the repo is brand-new and empty, add an initial commit (e.g. a README) so the branch exists, then publish again.`;
    else if (err.status === 422) error = `Publish failed${where}: ${err.message}. If the repo is empty, initialise it with a first commit and retry.`;
    else if (err.message) error = `Publish failed${where}: ${err.message}`;
    context.res = { status: 500, body: { error, detail: err.message } };
  }
};
