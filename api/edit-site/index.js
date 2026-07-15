/**
 * edit-site
 * -----------------------------------------------------------------------
 * Phase 0 scope: one client (2Labs), one file (src/pages/index.astro).
 *
 * POST /api/edit-site
 * body: { prompt: string, confirmStructural?: boolean }
 *
 * Flow (no git — drafts live in Blob Storage, git only happens on publish):
 *   1. Auth: require a valid, allowlisted shared-auth session.
 *   2. Guardrail: refuse structural-looking prompts unless confirmed.
 *   3. Load the current DRAFT for this client from Blob Storage; if there's
 *      no draft yet, fall back to the deployed main version on disk.
 *   4. Call Claude for the complete updated file; validate + de-fence it.
 *   5. Save the result back to Blob Storage as the draft (no commit).
 *   6. Render the edited file in-process (Astro Container) and return the
 *      rendered HTML for a live preview — not a "staged" status.
 *
 * Required app settings:
 *   ANTHROPIC_API_KEY, AZURE_STORAGE_CONNECTION_STRING (+ DRAFT_CONTAINER),
 *   plus the shared-auth settings used by ../shared/auth.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Anthropic } = require('@anthropic-ai/sdk');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getDraftFile, setDraftFile } = require('../lib/draftStore');
const { renderDraft } = require('../lib/renderDraft');
const { siteRoot, brand, org, editPolicy } = require('../lib/siteConfig');

const TARGET_FILE = 'src/pages/index.astro'; // Phase 0: hardcoded to the homepage
const CLIENT_ID = brand.clientId; // Phase 0: single client

module.exports = async function (context, req) {
  // 1. Auth gate — a valid, allowlisted shared-auth session is required.
  const sessionEmail = await validateSessionEmail(getBearerToken(req));
  if (!sessionEmail || !isEmailAllowed(sessionEmail)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }

  const prompt = req.body && req.body.prompt;
  const confirmStructural = !!(req.body && req.body.confirmStructural);

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    context.res = { status: 400, body: { error: 'A non-empty "prompt" string is required.' } };
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    context.log.error('Missing ANTHROPIC_API_KEY.');
    context.res = { status: 500, body: { error: 'Server is not configured.' } };
    return;
  }

  try {
    // 2. Structural guardrail (Phase 0 keyword check; unchanged).
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

    // 3. Load the current draft, or fall back to the deployed main version.
    //    (Stage labels on the throws so a failure pinpoints where it broke.)
    let currentContent;
    try {
      currentContent = await getDraftFile(CLIENT_ID, TARGET_FILE);
      if (currentContent == null) {
        currentContent = fs.readFileSync(path.join(siteRoot(), TARGET_FILE), 'utf-8');
      }
    } catch (e) {
      throw new Error(`draft-load: ${e.message}`);
    }

    // 4. Ask Claude for the complete updated file.
    let message;
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      message = await anthropic.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 16000,
        system: buildSystemPrompt(brand, org),
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
    } catch (e) {
      throw new Error(`anthropic: ${e.message}`);
    }

    const newContent = stripCodeFences(extractText(message));

    // Guard the draft: only save output that still looks like this file.
    const rejection = validateAstroOutput(newContent, currentContent);
    if (rejection) {
      throw new Error(
        `Refusing to save: model output failed a safety check (${rejection}). The draft was left unchanged.`
      );
    }

    if (newContent.trim() === currentContent.trim()) {
      context.res = {
        status: 200,
        body: {
          status: 'no_change',
          file: TARGET_FILE,
          promptEcho: prompt,
          note: 'The model returned the file unchanged — the draft was not updated.',
        },
      };
      return;
    }

    // 5. Save the draft (no git). 6. Render a live preview and return the HTML.
    try {
      await setDraftFile(CLIENT_ID, TARGET_FILE, newContent);
    } catch (e) {
      throw new Error(`draft-save: ${e.message}`);
    }
    let html;
    try {
      html = await renderDraft(TARGET_FILE, newContent);
    } catch (e) {
      throw new Error(`render: ${e.message}`);
    }

    context.res = {
      status: 200,
      body: {
        status: 'ok',
        file: TARGET_FILE,
        promptEcho: prompt,
        html,
      },
    };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: 'Edit failed.', detail: err.message } };
  }
};

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
 * Sanity-check that the model returned an edited version of this .astro file
 * rather than a refusal, an explanation, or something malformed. Returns a
 * short reason string if the output is unsafe to save, else null.
 */
function validateAstroOutput(newContent, currentContent) {
  if (!newContent || newContent.trim().length < 40) return 'output too short';
  if (!newContent.includes('BaseLayout')) return 'missing BaseLayout';
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
 * Phase 0 guardrail: crude keyword check standing in for a future Haiku-based
 * intent classifier. Flags prompts that look like they want structural edits.
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

// Exposed for offline unit tests (api/tests/index.test.js).
module.exports.stripCodeFences = stripCodeFences;
module.exports.validateAstroOutput = validateAstroOutput;
module.exports.isLikelyStructuralRequest = isLikelyStructuralRequest;
