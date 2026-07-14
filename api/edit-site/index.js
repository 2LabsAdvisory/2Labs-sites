/**
 * edit-site
 * -----------------------------------------------------------------------
 * Phase 0 scope: prove the core loop end to end for ONE client (2Labs
 * itself) and ONE file (src/pages/index.astro). Deliberately not
 * multi-tenant, not multi-file, not guardrail-complete yet — see TODOs.
 *
 * POST /api/edit-site
 * body: { prompt: string }
 *
 * Flow:
 *   1. Load site-config/brand.json + org-context.json + edit-policy.json
 *      from the `staging` branch (these are what every generation call
 *      is grounded in).
 *   2. Load the current content of the target file.
 *   3. Check edit-policy.json — refuse (for now) if the prompt appears to
 *      target a structural file without saying so explicitly.
 *   4. Call Claude (Sonnet 5) with a system prompt built from brand + org
 *      context, asking for the complete updated file content back.
 *   5. Commit the new content to the `staging` branch via the GitHub API.
 *      Azure Static Web Apps' GitHub Action (see
 *      .github/workflows/azure-static-web-apps.yml) picks up the push,
 *      runs `astro build`, and deploys it to the staging preview
 *      environment automatically — no separate deploy step needed here.
 *
 * Required app settings (Function App configuration / local.settings.json):
 *   ANTHROPIC_API_KEY   - Claude API key
 *   GITHUB_TOKEN         - token with repo write access to GITHUB_REPO
 *   GITHUB_OWNER          - e.g. "2labs-advisory"
 *   GITHUB_REPO            - e.g. "2labs-sites" (this repo)
 */

const { Anthropic } = require('@anthropic-ai/sdk');
const { Octokit } = require('@octokit/rest');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');

const TARGET_FILE = 'src/pages/index.astro'; // Phase 0: hardcoded to the homepage
const BRANCH = 'staging';

module.exports = async function (context, req) {
  // --- Auth gate: require a valid PassCard session whose email is allowlisted.
  // This is the real security boundary for the edit loop (the static editor/
  // dashboard HTML is not sensitive; committing AI edits + spending tokens is).
  const sessionEmail = await validateSessionEmail(getBearerToken(req));
  if (!sessionEmail || !isEmailAllowed(sessionEmail)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }

  const prompt = req.body && req.body.prompt;
  // Explicit override for the structural guardrail (see step 2). The client
  // confirms a flagged prompt by re-sending it with confirmStructural: true —
  // re-sending the same prompt alone can't confirm, it just re-trips the check.
  const confirmStructural = !!(req.body && req.body.confirmStructural);

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    context.res = { status: 400, body: { error: 'A non-empty "prompt" string is required.' } };
    return;
  }

  const { ANTHROPIC_API_KEY, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = process.env;
  if (!ANTHROPIC_API_KEY || !GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    context.log.error('Missing required app settings.');
    context.res = { status: 500, body: { error: 'Server is not configured. Missing app settings.' } };
    return;
  }

  const octokit = new Octokit({ auth: GITHUB_TOKEN });
  const repoRef = { owner: GITHUB_OWNER, repo: GITHUB_REPO };

  try {
    // 1. Load brand + org context + edit policy
    const [brand, org, editPolicy] = await Promise.all([
      getJsonFile(octokit, repoRef, 'site-config/brand.json'),
      getJsonFile(octokit, repoRef, 'site-config/org-context.json'),
      getJsonFile(octokit, repoRef, 'site-config/edit-policy.json'),
    ]);

    // 2. Guardrail check (Phase 0: simple keyword check; Phase 2: replace
    //    with a cheap Haiku classification pass per the model-routing plan)
    if (!confirmStructural && isLikelyStructuralRequest(prompt, editPolicy)) {
      context.res = {
        status: 200,
        body: {
          status: 'needs_confirmation',
          message:
            'This looks like it might change site-wide navigation, branding, or layout rather than page content. To go ahead anyway, re-send the request with "confirmStructural": true, or rephrase to target specific page content.',
        },
      };
      return;
    }

    // 3. Load current file content
    const fileRes = await octokit.repos.getContent({
      ...repoRef,
      path: TARGET_FILE,
      ref: BRANCH,
    });
    const currentContent = Buffer.from(fileRes.data.content, 'base64').toString('utf-8');

    // 4. Call Claude to produce the updated file
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const systemPrompt = buildSystemPrompt(brand, org);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      // Must comfortably exceed the whole file; a truncated response would
      // commit a half-written .astro file and fail the build.
      max_tokens: 16000,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            `Current file: ${TARGET_FILE}`,
            '```astro',
            currentContent,
            '```',
            '',
            `Requested change: ${prompt}`,
            '',
            'Return ONLY the complete updated file content, with no explanation, ',
            'no markdown code fences, and no surrounding commentary.',
          ].join('\n'),
        },
      ],
    });

    // Defensive: strip a stray ```astro/``` fence if the model wrapped the file
    // despite instructions — a fenced file is not valid Astro and fails the build.
    const newContent = stripCodeFences(extractText(message));

    // Guard the LIVE site: only commit output that still looks like this file.
    // A refusal or prose reply ("I can't help with that…") is valid text, so
    // astro build would happily ship it as the homepage — the build safety net
    // does NOT catch this. Require the invariants this page can't lose.
    const rejection = validateAstroOutput(newContent, currentContent);
    if (rejection) {
      throw new Error(
        `Refusing to commit: model output failed a safety check (${rejection}). ` +
          'The live homepage was left unchanged.'
      );
    }

    if (newContent.trim() === currentContent.trim()) {
      context.res = {
        status: 200,
        body: {
          status: 'no_change',
          file: TARGET_FILE,
          promptEcho: prompt,
          note: 'The model returned the file unchanged — nothing was committed.',
        },
      };
      return;
    }

    // 5. Commit to staging branch
    await octokit.repos.createOrUpdateFileContents({
      ...repoRef,
      path: TARGET_FILE,
      branch: BRANCH,
      message: `AI edit: ${prompt.slice(0, 72)}`,
      content: Buffer.from(newContent, 'utf-8').toString('base64'),
      sha: fileRes.data.sha,
    });

    context.res = {
      status: 200,
      body: {
        status: 'staged',
        file: TARGET_FILE,
        promptEcho: prompt,
        // TODO Phase 1: return the actual SWA staging preview URL once the
        // Static Web App resource exists (pattern: https://<app>-<branch>.<region>.azurestaticapps.net)
        note: 'Committed to staging. Azure Static Web Apps will rebuild and deploy automatically.',
      },
    };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: 'Edit failed.', detail: err.message } };
  }
};

/** Fetch and JSON.parse a file from the repo at the staging branch. */
async function getJsonFile(octokit, repoRef, path) {
  const res = await octokit.repos.getContent({ ...repoRef, path, ref: BRANCH });
  return JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf-8'));
}

/**
 * Remove a single wrapping markdown code fence if the model added one despite
 * being told not to (```astro / ``` / ~~~). Leaves un-fenced content untouched.
 */
function stripCodeFences(text) {
  const trimmed = text.trim();
  const fence = trimmed.match(/^(?:```|~~~)[^\n]*\n([\s\S]*?)\n?(?:```|~~~)\s*$/);
  return fence ? fence[1].trim() : trimmed;
}

/**
 * Sanity-check that the model actually returned an edited version of this
 * .astro file rather than a refusal, an explanation, or something malformed.
 * Returns a short reason string if the output is unsafe to commit, else null.
 * Phase 0 is one known file (index.astro), so we can assert its invariants.
 */
function validateAstroOutput(newContent, currentContent) {
  if (!newContent || newContent.trim().length < 40) return 'output too short';
  // index.astro is rendered through BaseLayout; losing it means the page lost
  // its layout/SEO shell (or the reply is prose, not the file).
  if (!newContent.includes('BaseLayout')) return 'missing BaseLayout';
  // The frontmatter fence is required for a valid .astro component.
  if (!newContent.trimStart().startsWith('---')) return 'missing frontmatter';
  return null;
}

/** Extract plain text from an Anthropic message response. */
function extractText(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Phase 0 guardrail: crude keyword check standing in for the future
 * Haiku-based intent classifier. Flags prompts that look like they want to
 * touch structural/brand elements rather than page content.
 */
function isLikelyStructuralRequest(prompt, editPolicy) {
  const structuralKeywords = ['navigation', 'nav bar', 'header', 'footer', 'logo', 'brand color', 'layout'];
  const lower = prompt.toLowerCase();
  return structuralKeywords.some((kw) => lower.includes(kw));
}

/** Builds the system prompt every generation call is grounded in. */
function buildSystemPrompt(brand, org) {
  return [
    `You are editing the website for ${brand.orgName}, a real, live business site — not a test fixture.`,
    `Voice: ${brand.voice}`,
    `Mission: ${org.mission}`,
    `Primary call to action: "${org.primaryCta}". Secondary: "${org.secondaryCta}".`,
    '',
    'Brand tokens (do not hardcode different colors/fonts — reuse these CSS variables, already defined globally):',
    '  --bg, --surface, --ink, --ink-soft, --border, --primary, --primary-dark, --primary-tint-strong',
    `  Heading font: var(--font-heading) (${brand.fonts.heading}). Body font: var(--font-body) (${brand.fonts.body}).`,
    '',
    'Rules:',
    '- This file is Astro (.astro). Keep the frontmatter (--- ... ---) block valid.',
    '- Preserve the overall component structure and imports unless the request clearly requires changing them.',
    '- Do not introduce client-side JavaScript frameworks or interactivity — this site is intentionally static/server-rendered for SEO.',
    '- Do not remove or alter SEO-relevant elements (title/description props passed to BaseLayout) unless asked.',
    '- Make the minimal change that satisfies the request. Do not rewrite unrelated sections.',
  ].join('\n');
}

// Exposed for offline unit tests (api/edit-site/index.test.js). Azure invokes
// the default function export and ignores these extra properties.
module.exports.stripCodeFences = stripCodeFences;
module.exports.validateAstroOutput = validateAstroOutput;
module.exports.isLikelyStructuralRequest = isLikelyStructuralRequest;
