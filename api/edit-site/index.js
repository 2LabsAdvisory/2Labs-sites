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
    // Guardrails removed: the AI may change anything on the page — structure,
    // layout, navigation, interactivity, whole new sections. The only real
    // limit is what actually renders; a broken edit surfaces as a render error
    // and is NOT saved (render runs before the draft is persisted, below).

    // Load the current draft, or fall back to the deployed main version.
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

    // Minimal sanity net (not a content guardrail): make sure we got an actual
    // page edit back, not an empty string or a plain-text refusal.
    if (!newContent || newContent.trim().length < 20 || !newContent.includes('<')) {
      throw new Error('The model did not return an editable page. Try rephrasing the request.');
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

    // Render FIRST — a broken edit fails here and is not saved, so a failed
    // experiment never corrupts your draft. Only persist once it renders.
    let html;
    try {
      html = await renderDraft(TARGET_FILE, newContent);
    } catch (e) {
      throw new Error(`render: ${e.message}`);
    }
    try {
      await setDraftFile(CLIENT_ID, TARGET_FILE, newContent);
    } catch (e) {
      throw new Error(`draft-save: ${e.message}`);
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

/** Extract plain text from an Anthropic message response. */
function extractText(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * Builds the system prompt every generation call is grounded in. Grounds the
 * model in the brand, but intentionally permissive about WHAT it can change —
 * the goal is to explore the full range of what's possible.
 */
function buildSystemPrompt(brand, org) {
  return [
    `You are editing the website for ${brand.orgName}, a real, live business site.`,
    `Voice: ${brand.voice}`,
    `Mission: ${org.mission}`,
    `Primary call to action: "${org.primaryCta}". Secondary: "${org.secondaryCta}".`,
    '',
    'Brand tokens available as global CSS variables (prefer these for a consistent look, but you may add your own styles too):',
    '  --bg, --surface, --ink, --ink-soft, --border, --primary, --primary-dark, --primary-tint-strong',
    `  Heading font: var(--font-heading) (${brand.fonts.heading}). Body font: var(--font-body) (${brand.fonts.body}).`,
    '',
    'You have broad latitude — fully implement whatever the user asks. You may:',
    '- restructure the page, change the layout, add or remove sections;',
    '- add new content, components, styles, images, and copy;',
    '- add interactivity with vanilla <script> tags (the site is static Astro,',
    '  so client-side JS runs, but framework components like React need an',
    '  integration that may not be installed — if unsure, prefer vanilla JS).',
    '',
    'Only hard requirements:',
    '- Return valid Astro (.astro) so the page renders. If you keep a frontmatter',
    '  block, keep it valid; imports you reference must exist in the project.',
    '- Return ONLY the complete updated file content — no explanation or code fences.',
  ].join('\n');
}

// Exposed for offline unit tests (api/tests/index.test.js).
module.exports.stripCodeFences = stripCodeFences;
