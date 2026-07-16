/**
 * edit-site (multi-file, agentic)
 * -----------------------------------------------------------------------
 * POST /api/edit-site  { prompt: string }   (auth-gated)
 *
 * The AI acts like a boutique NYC web studio: it can create pages, wire them
 * into the navigation, restructure, and write real content — applying content,
 * UX, and SEO best practices. It returns the COMPLETE content of every file to
 * create/modify via a tool call; each is saved as a draft (Blob Storage, no
 * git) and the primary page is rendered for a live preview.
 *
 * Boundaries: the AI may only write files under src/ (client site pages, nav,
 * components, layout, styles) — never the builder app (editor/dashboard/login)
 * or the API. Publishing (separate) commits the drafts to main.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Anthropic } = require('@anthropic-ai/sdk');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getDraftFile, setDraftFile, listDraftFiles, saveUndoManifest } = require('../lib/draftStore');
const { recordEdit } = require('../lib/usageStore');
const { getAsset } = require('../lib/assetStore');
const { renderDraft } = require('../lib/renderDraft');
const { siteRoot, brand, org } = require('../lib/siteConfig');

const CLIENT_ID = brand.clientId;

// Builder-app pages the AI must never touch (they ARE this editor UI).
const PROTECTED = new Set([
  'src/pages/editor.astro',
  'src/pages/dashboard.astro',
  'src/pages/login.astro',
]);

// Files always shown to the AI for context (structure + nav).
const CONTEXT_EXTRAS = [
  'src/components/Header.astro',
  'src/components/Footer.astro',
  'src/layouts/BaseLayout.astro',
];

const APPLY_TOOL = {
  name: 'apply_site_changes',
  description:
    'Apply the website changes by returning the COMPLETE new content of every file to create or modify.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'A friendly 1–2 sentence summary of what you did, in a boutique-studio voice.' },
      primary_path: { type: 'string', description: 'Repo-relative path of the page to show in the preview (the main page created or edited).' },
      files: {
        type: 'array',
        description: 'Every file to write, each with its complete content.',
        items: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
    },
    required: ['summary', 'primary_path', 'files'],
  },
};

module.exports = async function (context, req) {
  const sessionEmail = await validateSessionEmail(getBearerToken(req));
  if (!sessionEmail || !isEmailAllowed(sessionEmail)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }

  const prompt = req.body && req.body.prompt;
  const attachments = Array.isArray(req.body && req.body.attachments) ? req.body.attachments.slice(0, 6) : [];
  if ((!prompt || typeof prompt !== 'string' || !prompt.trim()) && attachments.length === 0) {
    context.res = { status: 400, body: { error: 'A non-empty "prompt" string is required.' } };
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    context.log.error('Missing ANTHROPIC_API_KEY.');
    context.res = { status: 500, body: { error: 'Server is not configured.' } };
    return;
  }

  try {
    // 1. Gather the current site (client pages + nav/layout), draft-or-disk.
    const context_files = {};
    for (const p of await listSitePages()) context_files[p] = await effectiveContent(p);
    for (const p of CONTEXT_EXTRAS) {
      const c = await effectiveContent(p);
      if (c != null) context_files[p] = c;
    }

    // 1b. Load any uploaded photos/PDFs so the model can SEE them (images) or
    //     READ them (PDFs), and so it embeds images by their hosted URL.
    const attachmentBlocks = await buildAttachmentBlocks(attachments, context);

    // 2. Ask Claude (studio persona) for the file changes via a tool call.
    let response;
    const tGen = Date.now();
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      // This is structured code generation behind a forced tool call, not a
      // reasoning task: disable adaptive thinking (on by default for Sonnet 5)
      // to roughly halve latency and stay well under the platform timeout.
      // Stream + finalMessage() so a large max_tokens can't hit an HTTP timeout.
      const stream = anthropic.messages.stream({
        model: 'claude-sonnet-5',
        max_tokens: 16000,
        thinking: { type: 'disabled' },
        system: buildSystemPrompt(brand, org),
        tools: [APPLY_TOOL],
        tool_choice: { type: 'tool', name: 'apply_site_changes' },
        messages: [{ role: 'user', content: [...attachmentBlocks, { type: 'text', text: buildUserMessage(prompt, context_files, attachments) }] }],
      });
      response = await stream.finalMessage();
    } catch (e) {
      throw new Error(`anthropic: ${e.message}`);
    }
    context.log(`[edit-site] anthropic ${Date.now() - tGen}ms, stop=${response.stop_reason}`);

    const toolUse = (response.content || []).find((b) => b.type === 'tool_use' && b.name === 'apply_site_changes');
    if (!toolUse || !toolUse.input) throw new Error('The AI did not return any file changes. Try rephrasing.');

    const { summary, primary_path } = toolUse.input;
    const files = Array.isArray(toolUse.input.files) ? toolUse.input.files : [];
    if (files.length === 0) throw new Error('No file changes were produced.');

    // 3. Validate every path is inside the client site (never the app or API).
    for (const f of files) {
      if (!f || !isEditablePath(f.path)) throw new Error(`Not allowed to write "${f && f.path}".`);
      if (typeof f.content !== 'string' || f.content.trim().length < 10) throw new Error(`Empty content for "${f.path}".`);
    }
    const primary = isEditablePath(primary_path) && files.some((f) => f.path === primary_path) ? primary_path : files[0].path;
    const primaryContent = files.find((f) => f.path === primary).content;

    // 4. Render the primary page FIRST — a broken edit fails here and is not
    //    saved. Overlay EVERY edited file (prior drafts + this edit) so nav/
    //    layout changes (e.g. the updated Header) show live in the preview.
    const overlay = {};
    for (const p of await listDraftFiles(CLIENT_ID)) overlay[p] = await getDraftFile(CLIENT_ID, p);
    for (const f of files) overlay[f.path] = f.content;

    let html;
    const tRender = Date.now();
    try {
      html = await renderDraft(primary, primaryContent, overlay);
    } catch (e) {
      throw new Error(`render: ${e.message}`);
    }
    context.log(`[edit-site] render ${Date.now() - tRender}ms (primary=${primary}, files=${files.length})`);

    // 5. Snapshot the whole draft state for one-level undo, then save all files.
    try {
      const snapshot = {};
      for (const p of await listDraftFiles(CLIENT_ID)) snapshot[p] = await getDraftFile(CLIENT_ID, p);
      await saveUndoManifest(CLIENT_ID, snapshot);
      for (const f of files) await setDraftFile(CLIENT_ID, f.path, f.content);
    } catch (e) {
      throw new Error(`draft-save: ${e.message}`);
    }

    // 6. Meter this edit against the user's monthly AI credits (1 edit = 1
    //    credit; token/cost detail kept underneath). Never fail the edit on a
    //    metering error — the work is already saved.
    let usage = null;
    try {
      usage = await recordEdit(sessionEmail, response.usage || {});
    } catch (e) {
      context.log.warn('[edit-site] usage record failed:', e.message);
    }

    context.res = {
      status: 200,
      body: {
        status: 'ok',
        summary: summary || 'Updated your site.',
        files: files.map((f) => f.path),
        primary,
        html,
        credits: usage ? { used: usage.edits, period: usage.period } : null,
      },
    };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: 'Edit failed.', detail: err.message } };
  }
};

// ---- helpers ---------------------------------------------------------------

/** May the AI write this path? Client-site source only; never the app/API. */
function isEditablePath(p) {
  if (typeof p !== 'string') return false;
  const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (norm.includes('..') || norm.startsWith('/')) return false;
  if (PROTECTED.has(norm)) return false;
  if (!norm.startsWith('src/')) return false;
  return /\.(astro|css|md|mdx|ts|js)$/.test(norm);
}

/** Effective current content: draft if present, else disk, else null. */
async function effectiveContent(relPath) {
  const draft = await getDraftFile(CLIENT_ID, relPath);
  if (draft != null) return draft;
  const abs = path.join(siteRoot(), relPath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
}

/** The client's site pages (disk + draft), excluding builder-app pages. */
async function listSitePages() {
  const set = new Set();
  const dir = path.join(siteRoot(), 'src/pages');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.astro')) set.add(`src/pages/${f}`);
  }
  for (const p of await listDraftFiles(CLIENT_ID)) {
    if (p.startsWith('src/pages/') && p.endsWith('.astro')) set.add(p);
  }
  return [...set].filter((p) => !PROTECTED.has(p));
}

function buildUserMessage(prompt, contextFiles, attachments = []) {
  const parts = ['Here is the current site (each file with its full current content):', ''];
  for (const [p, content] of Object.entries(contextFiles)) {
    parts.push(`FILE: ${p}`, '```astro', content, '```', '');
  }
  parts.push(
    'The user may paste source material (copy, notes, or an outline) directly in their request — use it as the basis for the content.',
    ''
  );

  const imgs = attachments.filter((a) => a && a.type && a.type.startsWith('image/'));
  const pdfs = attachments.filter((a) => a && a.type === 'application/pdf');
  if (imgs.length || pdfs.length) {
    parts.push('The user attached files to use as content (also provided above as image/PDF blocks):');
    for (const a of imgs) {
      parts.push(`- IMAGE "${a.name}" is hosted at ${a.url}. To place it, embed it with <img src="${a.url}" alt="…"> (write descriptive alt text). Do NOT inline the bytes or invent a different path — use this exact URL.`);
    }
    for (const a of pdfs) {
      parts.push(`- PDF "${a.name}": read its content and write it into the page as real, well-structured copy. Do not link to the PDF unless the user asks.`);
    }
    parts.push('');
  }

  parts.push(
    `Request: ${prompt || '(no text — act on the attached file(s) per their intent)'}`,
    '',
    'Call apply_site_changes with the complete content of every file you create or modify.'
  );
  return parts.join('\n');
}

/** Load uploaded assets as Anthropic content blocks (images = vision, PDFs = document). */
async function buildAttachmentBlocks(attachments, context) {
  const blocks = [];
  for (const a of attachments) {
    if (!a || !a.id) continue;
    let asset;
    try {
      asset = await getAsset(a.id);
    } catch (e) {
      context.log.warn(`[edit-site] attachment ${a.id} load failed: ${e.message}`);
      continue;
    }
    if (!asset) continue;
    const data = asset.buffer.toString('base64');
    if (asset.contentType === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
    } else if (asset.contentType && asset.contentType.startsWith('image/') && asset.contentType !== 'image/svg+xml') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: asset.contentType, data } });
    }
    // SVGs aren't a vision media type — the hosted-URL instruction covers them.
  }
  return blocks;
}

/** System prompt: a boutique NYC studio applying content/UX/SEO best practices. */
function buildSystemPrompt(brand, org) {
  return [
    `You are a senior web developer and content strategist at a boutique New York web studio, building and maintaining the website for ${brand.orgName}.`,
    `Brand voice: ${brand.voice}`,
    `Mission: ${org.mission}`,
    `Primary CTA: "${org.primaryCta}". Secondary: "${org.secondaryCta}".`,
    '',
    'Brand tokens are global CSS variables — reuse them for a consistent look:',
    '  --bg, --surface, --ink, --ink-soft, --border, --primary, --primary-dark, --primary-tint-strong',
    `  Heading font: var(--font-heading) (${brand.fonts.heading}). Body font: var(--font-body) (${brand.fonts.body}).`,
    '',
    'Work to a top studio standard:',
    '- CONTENT: sharp, benefit-led copy in the brand voice; scannable structure; a strong, specific headline; concrete CTAs; no filler.',
    '- UX: clear visual hierarchy, generous spacing, responsive layout, and accessibility (semantic HTML, one <h1> per page, alt text on images, labelled controls, good contrast).',
    '- SEO: a unique, descriptive title and meta description for every page (passed as the BaseLayout title/description props), sensible heading order, and descriptive link text.',
    '',
    'Technical rules (the site is Astro):',
    '- Every page imports BaseLayout (with the correct relative path) and passes title + description props.',
    '- Reuse the brand CSS variables; scoped <style> blocks are fine.',
    '- Interactivity: vanilla <script> only. Do NOT use React/Vue/Svelte or any package/integration that may not be installed.',
    '- Only write files under src/. Never edit editor.astro, dashboard.astro, or login.astro (those are the builder app).',
    '',
    'When asked to ADD A PAGE:',
    '- Create src/pages/<kebab-slug>.astro — self-contained, using BaseLayout with a strong title + meta description and real, useful content.',
    '- Wire it into the navigation by editing src/components/Header.astro (add a nav link to the new page).',
    '- Set primary_path to the new page so it shows in the preview.',
    '',
    'Return your work by calling apply_site_changes with the COMPLETE content of every file you create or modify.',
  ].join('\n');
}

// Exposed for offline unit tests (api/tests/index.test.js).
module.exports.isEditablePath = isEditablePath;
