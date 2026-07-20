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
const { getDraftFile, setDraftFile, listDraftFiles, saveUndoManifest, isDeleted, markDeleted, removeDraftFile } = require('../lib/draftStore');
const { recordEdit } = require('../lib/usageStore');
const { getAsset } = require('../lib/assetStore');
const { putResult } = require('../lib/editResultStore');
const { recordEvent, hashId } = require('../lib/feedbackStore');
const { qualityBar, qaChecklist } = require('../lib/standards');
const { renderDraft } = require('../lib/renderDraft');
const { siteRoot, brand, org, DEFAULT_SITE } = require('../lib/siteConfig');

// The draft namespace and the render root are both the site slug (per-site).

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
  'src/styles/tokens.css', // so edits reuse the brand tokens (and can fix colour issues)
];

const APPLY_TOOL = {
  name: 'apply_site_changes',
  description:
    'Apply the website changes by returning the COMPLETE new content of every file to create or modify.',
  input_schema: {
    type: 'object',
    properties: {
      // The actual change comes FIRST so the model commits to it before writing
      // the summary (writing the summary first makes it "narrate and forget").
      files: {
        type: 'array',
        minItems: 1,
        description: 'Every file to write, each with its complete content. This is the ACTUAL change — it must NOT be empty (a summary alone is not a change).',
        items: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
      primary_path: { type: 'string', description: 'Repo-relative path of the page to show in the preview (the main page created or edited).' },
      summary: { type: 'string', description: 'A friendly 1–2 sentence summary of what you did, in a boutique-studio voice.' },
    },
    required: ['files', 'primary_path', 'summary'],
  },
};

// Targeted edits: exact text replacement in EXISTING files. Tiny output (just
// the changed snippets) vs. rewriting whole files, so it's dramatically faster
// — the right tool for localized changes (swap an image, tweak copy/style).
const EDIT_TOOL = {
  name: 'edit_files',
  description:
    'Make small, localized changes to EXISTING files by exact text replacement. STRONGLY PREFER this over apply_site_changes for anything short of a new page or major restructure — swapping an image, editing copy, changing a style, updating a link — because it is far faster than rewriting whole files. Use apply_site_changes only to create new pages or do large rewrites.',
  input_schema: {
    type: 'object',
    properties: {
      // The actual change comes FIRST so the model commits to it before the summary.
      edits: {
        type: 'array',
        minItems: 1,
        description: 'Each edit replaces an exact snippet of existing file text with new text. This is the ACTUAL change — it must NOT be empty (a summary alone is not a change).',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Repo-relative file path to edit (must already exist).' },
            old_string: { type: 'string', description: 'The exact existing text to replace — include enough surrounding context to be unambiguous.' },
            new_string: { type: 'string', description: 'The replacement text.' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
      primary_path: { type: 'string', description: 'Repo-relative path of the page to show in the preview.' },
      summary: { type: 'string', description: 'A friendly 1–2 sentence summary of what you changed, in a boutique-studio voice.' },
    },
    required: ['edits', 'primary_path', 'summary'],
  },
};

// Delete existing page(s). Also remove nav links/references to them via edits.
const DELETE_TOOL = {
  name: 'delete_pages',
  description:
    'Delete existing page(s) from the site. List the page file path(s) to remove in `delete`, and use `edits` to remove any navigation links or references to the deleted page(s) (e.g. drop the <a> from Header.astro). Set primary_path to a page that still exists (usually the homepage) to show in the preview.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'A friendly 1–2 sentence summary of what you removed, in a boutique-studio voice.' },
      primary_path: { type: 'string', description: 'A page that still exists to show in the preview after deletion (e.g. src/pages/index.astro).' },
      delete: {
        type: 'array',
        description: 'Repo-relative page file paths to delete, e.g. "src/pages/old-page.astro".',
        items: { type: 'string' },
      },
      edits: {
        type: 'array',
        description: 'Targeted old_string→new_string edits to remove links/references to the deleted page(s) (e.g. remove the nav <a> in Header.astro). May be empty.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
    required: ['summary', 'primary_path', 'delete'],
  },
};

module.exports = async function (context, req) {
  const sessionEmail = await validateSessionEmail(getBearerToken(req));
  if (!sessionEmail || !isEmailAllowed(sessionEmail)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }

  const prompt = req.body && req.body.prompt;
  const attachments = Array.isArray(req.body && req.body.attachments) ? req.body.attachments.slice(0, 8) : [];
  // The client sends a requestId so it can poll for the result if this request
  // outlives the gateway's client-side timeout (page creation can take ~80s).
  const requestId = req.body && req.body.requestId;
  // Which site's drafts/project this edit targets (namespace + render root).
  const site = (req.body && req.body.site) || DEFAULT_SITE;
  const evStart = Date.now();
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
    for (const p of await listSitePages(site)) context_files[p] = await effectiveContent(p, site);
    for (const p of CONTEXT_EXTRAS) {
      const c = await effectiveContent(p, site);
      if (c != null) context_files[p] = c;
    }

    // 1b. Load any uploaded photos/PDFs so the model can SEE them (images) or
    //     READ them (PDFs), and so it embeds images by their hosted URL.
    const attachmentBlocks = await buildAttachmentBlocks(attachments, context);

    // 2. Ask Claude for the file changes via a forced tool call. Sonnet 5 is on
    //    by default; disable adaptive thinking (structured codegen, not
    //    reasoning) and stream so a large max_tokens can't hit an HTTP timeout.
    //    The model occasionally narrates the change in `summary` but leaves the
    //    edits empty — retry once, pushing it to output the ACTUAL change.
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const baseContent = [...attachmentBlocks, { type: 'text', text: buildUserMessage(prompt, context_files, attachments) }];
    const rawCountOf = (tu) => {
      if (!tu || !tu.input) return 0;
      if (tu.name === 'edit_files') return (tu.input.edits || []).length;
      if (tu.name === 'delete_pages') return (tu.input.delete || []).length + (tu.input.edits || []).length;
      return (tu.input.files || []).length;
    };
    let response, toolUse;
    const tGen = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      // On retry, feed the empty attempt back as a proper tool_result (a
      // tool_use turn MUST be answered by tool_result, or the API 400s) so the
      // model sees its output was rejected for having no edits.
      const priorTools = attempt > 0 ? (response.content || []).filter((b) => b.type === 'tool_use') : [];
      const messages = attempt === 0
        ? [{ role: 'user', content: baseContent }]
        : [
            { role: 'user', content: baseContent },
            { role: 'assistant', content: response.content },
            { role: 'user', content: [
              ...priorTools.map((b) => ({ type: 'tool_result', tool_use_id: b.id, content: 'Rejected: that tool call contained no edits/files. The summary is NOT the change.', is_error: true })),
              { type: 'text', text: 'Make the change for real now: return the ACTUAL edits (edit_files old_string→new_string) or complete files (apply_site_changes). The edits/files array must not be empty.' },
            ] },
          ];
      try {
        // Generous ceiling so a legitimately large change isn't truncated.
        const stream = anthropic.messages.stream({
          model: 'claude-sonnet-5', max_tokens: 32000, thinking: { type: 'disabled' },
          system: buildSystemPrompt(brand, org), tools: [EDIT_TOOL, APPLY_TOOL, DELETE_TOOL], tool_choice: { type: 'any' },
          messages,
        });
        response = await stream.finalMessage();
      } catch (e) {
        throw new Error(`anthropic: ${e.message}`);
      }
      context.log(`[edit-site] anthropic ${Date.now() - tGen}ms, stop=${response.stop_reason}, attempt=${attempt}`);
      // Truncation: never ship a partial — bail with actionable guidance.
      if (response.stop_reason === 'max_tokens') {
        throw new Error('That change was too large to build in one step. Try it in smaller batches — for example "create profile pages for the first 5 animals", then repeat for the rest.');
      }
      toolUse = (response.content || []).find((b) => b.type === 'tool_use' && (b.name === 'edit_files' || b.name === 'apply_site_changes' || b.name === 'delete_pages'));
      if (rawCountOf(toolUse) > 0) break; // got a real change — stop retrying
    }
    if (!toolUse || !toolUse.input) throw new Error('The AI did not return any file changes. Try rephrasing.');

    const { summary, primary_path } = toolUse.input;
    // The tools converge on files (full {path,content} to write) + deletions
    // (paths to remove). apply_site_changes gives full files; edit_files applies
    // snippet replacements; delete_pages removes pages (+ optional nav edits).
    let files = [];
    let deletions = [];
    if (toolUse.name === 'edit_files') {
      // Guard the empty case here so we can surface WHY (the model's summary)
      // instead of the cryptic "No edits were produced".
      const rawEdits = Array.isArray(toolUse.input.edits) ? toolUse.input.edits : [];
      files = rawEdits.length ? await applyTargetedEdits(rawEdits, site) : [];
    } else if (toolUse.name === 'delete_pages') {
      deletions = (Array.isArray(toolUse.input.delete) ? toolUse.input.delete : []).filter(Boolean);
      for (const p of deletions) if (!isEditablePath(p)) throw new Error(`Not allowed to delete "${p}".`);
      if (deletions.length === 0) throw new Error('No pages to delete were specified.');
      files = Array.isArray(toolUse.input.edits) && toolUse.input.edits.length ? await applyTargetedEdits(toolUse.input.edits, site) : [];
    } else {
      files = Array.isArray(toolUse.input.files) ? toolUse.input.files : [];
    }
    if (files.length === 0 && deletions.length === 0) {
      // The model called a tool but produced nothing. If it explained why in the
      // summary, surface that — it's far more useful than a generic error.
      const why = String(summary || '').trim();
      throw new Error(why
        ? `Couldn't make that change: ${why}`
        : "The AI couldn't produce that change. Try being specific about the page and what to change — e.g. \"on adoptable-animals.astro, wrap each animal card in a link to its profile page\".");
    }
    const deletedSet = new Set(deletions);

    // 3. Validate every written path is inside the client site (never app/API).
    for (const f of files) {
      if (!f || !isEditablePath(f.path)) throw new Error(`Not allowed to write "${f && f.path}".`);
      if (typeof f.content !== 'string' || f.content.trim().length < 10) throw new Error(`Empty content for "${f.path}".`);
    }

    // Preview a page that still exists (not one being deleted).
    let primary = isEditablePath(primary_path) && !deletedSet.has(primary_path) ? primary_path : null;
    if (!primary) primary = (files.find((f) => !deletedSet.has(f.path)) || {}).path || 'src/pages/index.astro';
    const primaryFile = files.find((f) => f.path === primary);
    const primaryContent = primaryFile ? primaryFile.content : await effectiveContent(primary, site);
    if (primaryContent == null) throw new Error('Could not find a page to preview after the change.');

    // 4. Render the primary page FIRST — a broken edit fails here and is not
    //    saved. Overlay every non-deleted edited file so nav/layout changes show
    //    live in the preview; exclude anything being deleted.
    const overlay = {};
    for (const p of await listDraftFiles(site)) {
      const c = await getDraftFile(site, p);
      if (!isDeleted(c)) overlay[p] = c;
    }
    for (const f of files) overlay[f.path] = f.content;
    for (const p of deletions) delete overlay[p];

    let html;
    const tRender = Date.now();
    try {
      html = await renderDraft(primary, primaryContent, overlay, site);
    } catch (e) {
      throw new Error(`render: ${e.message}`);
    }
    context.log(`[edit-site] render ${Date.now() - tRender}ms (primary=${primary}, files=${files.length})`);

    // 4b. EXPERT QA REVIEW — hold this update to the same bar as generation.
    //     An adversarial reviewer checks the changed files (contrast, brand
    //     tokens, accessibility, validity, quality); if it returns corrected
    //     files that still render, we ship the reviewed version. Non-fatal: any
    //     QA error keeps the original (already-rendered) edit.
    let qaOutcome = 'skipped';
    let qaUsage = {};
    if (files.length > 0) {
      try {
        const tokensCss = await effectiveContent('src/styles/tokens.css', site).catch(() => null);
        const { input: review, usage: qu } = await qaReview(anthropic, { files, tokensCss, prompt });
        qaUsage = qu || {};
        if (review && review.approved === true) qaOutcome = 'approved';
        else if (review && review.approved === false && Array.isArray(review.files) && review.files.length) {
          const corrected = review.files.filter((f) => f && isEditablePath(f.path) && typeof f.content === 'string' && f.content.trim().length >= 10);
          if (corrected.length) {
            const byPath = new Map(files.map((f) => [f.path, f]));
            for (const c of corrected) byPath.set(c.path, c);
            const merged = [...byPath.values()];
            const overlay2 = { ...overlay };
            for (const f of merged) overlay2[f.path] = f.content;
            const primaryFile2 = merged.find((f) => f.path === primary);
            const primaryContent2 = primaryFile2 ? primaryFile2.content : primaryContent;
            const html2 = await renderDraft(primary, primaryContent2, overlay2, site); // must still render
            files = merged; html = html2; qaOutcome = 'fixed';
          }
        }
      } catch (e) {
        context.log('[edit-site] QA review skipped: ' + (e && e.stack || e));
        qaOutcome = 'error';
      }
      context.log(`[edit-site] QA ${qaOutcome}`);
    }

    // 5. Snapshot the whole draft state for one-level undo, then save edits and
    //    apply deletions. A page that exists on disk gets a tombstone (so publish
    //    removes it from the repo); a draft-only page is just dropped. Undo works
    //    either way because the snapshot is taken before any change.
    try {
      const snapshot = {};
      for (const p of await listDraftFiles(site)) snapshot[p] = await getDraftFile(site, p);
      await saveUndoManifest(site, snapshot);
      for (const f of files) await setDraftFile(site, f.path, f.content);
      for (const p of deletions) {
        if (fs.existsSync(path.join(siteRoot(site), p))) await markDeleted(site, p);
        else await removeDraftFile(site, p);
      }
    } catch (e) {
      throw new Error(`draft-save: ${e.message}`);
    }

    // 6. Meter this edit's AI spend — the main generation PLUS the QA review
    //    pass — so the dollar cost reflects the whole edit. Never fail the edit
    //    on a metering error — the work is already saved.
    let usage = null;
    try {
      usage = await recordEdit(sessionEmail, addUsage(response.usage || {}, qaUsage));
    } catch (e) {
      context.log('[edit-site] usage record failed: ' + e.message);
    }

    const okBody = {
      status: 'ok',
      summary: summary || 'Updated your site.',
      files: files.map((f) => f.path),
      deleted: deletions,
      primary,
      html,
      credits: usage ? { used: usage.edits, period: usage.period } : null,
    };
    // Persist so a client whose POST timed out can still fetch the result.
    if (requestId) {
      try { await putResult(sessionEmail, requestId, okBody); }
      catch (e) { context.log.warn('[edit-site] result store failed: ' + e.message); }
    }
    // Learning signal: what the user changed + that it worked (metadata only).
    await recordEvent({
      type: 'edit', result: 'success', site, user: hashId(sessionEmail),
      tool: toolUse.name, targets: files.map((f) => f.path).concat(deletions),
      prompt: String(prompt || '').slice(0, 400), had_attachment: attachments.length > 0,
      qa: qaOutcome, duration_ms: Date.now() - evStart,
    });
    context.res = { status: 200, body: okBody };
  } catch (err) {
    context.log.error(err);
    const errBody = { status: 'error', error: 'Edit failed.', detail: err.message };
    if (requestId) { try { await putResult(sessionEmail, requestId, errBody); } catch (e) { /* best-effort */ } }
    // Learning signal: an edit the user wanted that FAILED — the reliability gold.
    // `stage` = the prefix our throws use (anthropic/render/draft-save/…) so we
    // can see WHERE edits break most.
    await recordEvent({
      type: 'edit', result: 'error', site, user: hashId(sessionEmail),
      prompt: String(prompt || '').slice(0, 400), had_attachment: attachments.length > 0,
      stage: (/^([a-z-]+):/.exec(err.message || '') || [])[1] || 'logic',
      error: String(err.message || '').slice(0, 300), duration_ms: Date.now() - evStart,
    });
    context.res = { status: 500, body: errBody };
  }
};

// ---- helpers ---------------------------------------------------------------

/**
 * Apply edit_files snippet replacements to current draft-or-disk content,
 * returning full {path, content} for each touched file. Edits to the same file
 * compound in order. Errors clearly if a snippet isn't found so the model (or
 * user) can retry — a bad match must never silently drop the change.
 */
async function applyTargetedEdits(edits, site) {
  if (!Array.isArray(edits) || edits.length === 0) throw new Error('No edits were produced.');
  const byPath = new Map();
  for (const e of edits) {
    if (!e || !isEditablePath(e.path)) throw new Error(`Not allowed to edit "${e && e.path}".`);
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string' || e.old_string === '') {
      throw new Error('An edit was missing its search or replacement text.');
    }
    if (!byPath.has(e.path)) {
      const cur = await effectiveContent(e.path, site);
      if (cur == null) throw new Error(`Can't edit "${e.path}" — that page doesn't exist yet.`);
      byPath.set(e.path, cur);
    }
    const content = byPath.get(e.path);
    if (!content.includes(e.old_string)) {
      throw new Error(`Couldn't find the exact text to replace in ${e.path}. Try describing the change and I'll rewrite the section.`);
    }
    byPath.set(e.path, content.split(e.old_string).join(e.new_string)); // replace all occurrences
  }
  return [...byPath.entries()].map(([path, content]) => ({ path, content }));
}

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
async function effectiveContent(relPath, site) {
  const draft = await getDraftFile(site, relPath);
  if (isDeleted(draft)) return null; // tombstoned — treat as gone
  if (draft != null) return draft;
  const abs = path.join(siteRoot(site), relPath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
}

/** The client's site pages (disk + draft), excluding builder-app pages. */
async function listSitePages(site) {
  const set = new Set();
  const dir = path.join(siteRoot(site), 'src/pages');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.astro')) set.add(`src/pages/${f}`);
  }
  const deleted = new Set();
  for (const p of await listDraftFiles(site)) {
    if (!p.startsWith('src/pages/') || !p.endsWith('.astro')) continue;
    if (isDeleted(await getDraftFile(site, p))) deleted.add(p);
    else set.add(p);
  }
  return [...set].filter((p) => !PROTECTED.has(p) && !deleted.has(p));
}

// Route a page file resolves to, e.g. src/pages/adopt/rex.astro -> /adopt/rex.
function routeFromPagePath(p) {
  if (!p.startsWith('src/pages/') || !p.endsWith('.astro')) return null;
  const rel = p.slice('src/pages/'.length, -'.astro'.length);
  const route = '/' + rel.replace(/\/?index$/, '');
  return route === '' ? '/' : route;
}

function buildUserMessage(prompt, contextFiles, attachments = []) {
  // An explicit route map so linking tasks ("link X to its page") are easy — the
  // model can see exactly which pages exist and where they live.
  const routes = Object.keys(contextFiles).map(routeFromPagePath).filter(Boolean).sort();
  const parts = [];
  if (routes.length) parts.push('SITE PAGES (existing routes you can link to): ' + routes.join(', '), '');
  parts.push('Here is the current site (each file with its full current content):', '');
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
    'For a localized change, call edit_files with targeted old_string→new_string replacements. For a new page or large rewrite, call apply_site_changes with complete file contents.',
    'ALWAYS make a concrete change. If the request can only be partly done — e.g. some list items have a matching page to link and others do not — do the part you CAN (link the ones that exist), and note what you skipped and why in the summary. If items are rendered from a data array, edit the template/map so each item links to its route. Never return an empty edit; if you truly cannot proceed, still explain exactly what is missing in the summary.'
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
    `Heading font: var(--font-heading) (${brand.fonts.heading}). Body font: var(--font-body) (${brand.fonts.body}).`,
    '',
    // Hold every EDIT to the same expert quality bar as new-site generation.
    qualityBar(),
    '- Before returning, self-review your change against this bar — especially contrast (no dark-on-dark / dark-on-colour) and brand-token usage — and fix any issue in the same output. A separate QA reviewer will re-check it.',
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
    'Choosing a tool (IMPORTANT for speed):',
    '- For localized changes to an existing page — swapping an image, editing copy, changing a color/style, updating a link — call edit_files with small, exact old_string→new_string replacements. Include enough surrounding text in old_string to match uniquely. This is much faster; use it whenever you are not creating a new page or doing a large rewrite.',
    '- Only use apply_site_changes (full file contents) to create a new page or when a change is too sweeping for targeted edits.',
    '- To DELETE a page, call delete_pages with the page file path(s) in `delete`, and use `edits` to remove its navigation link(s)/references (e.g. remove the <a> from Header.astro). Never blank a file to "delete" it — use delete_pages.',
    '- When replacing an image, edit the exact <img …> (or CSS url(…)) to point at the provided hosted URL.',
    '',
    'CRITICAL: the `summary` field is a short note for the user — it is NOT the change. The actual change MUST be in `edits` (edit_files) or `files` (apply_site_changes). Returning a summary that describes a change without the corresponding edits/files is a failure — always include the real edits.',
  ].join('\n');
}

// Expert QA reviewer — the same standards gate new-site generation is held to,
// now applied to every edit. Reviews only the changed files and returns either
// approval or corrected complete files. Forced structured output.
const QA_TOOL = {
  name: 'submit_review',
  description: 'Return the QA review of the changed files.',
  input_schema: {
    type: 'object',
    properties: {
      approved: { type: 'boolean', description: 'true if the change fully passes with no fixes needed.' },
      issues: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, note: { type: 'string' } }, required: ['note'] }, description: 'Problems found (empty if approved).' },
      files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }, description: 'Corrected COMPLETE files — only those needing changes. Empty if approved.' },
    },
    required: ['approved'],
  },
};

async function qaReview(anthropic, { files, tokensCss, prompt }) {
  const user = [
    'The user asked for this change: ' + String(prompt || '').slice(0, 500),
    tokensCss ? '\nDESIGN TOKENS (src/styles/tokens.css) — the only colours/vars allowed:\n' + String(tokensCss).slice(0, 4000) : '',
    '\nCHANGED FILE(S) TO REVIEW:',
    ...files.map((f) => `\n--- ${f.path} ---\n` + String(f.content).slice(0, 16000)),
  ].join('\n');
  const stream = anthropic.messages.stream({
    model: 'claude-sonnet-5', max_tokens: 16000, thinking: { type: 'disabled' },
    system: qaChecklist(), tools: [QA_TOOL], tool_choice: { type: 'tool', name: 'submit_review' },
    messages: [{ role: 'user', content: user }],
  });
  const resp = await stream.finalMessage();
  const t = (resp.content || []).find((c) => c.type === 'tool_use' && c.name === 'submit_review');
  return { input: t ? t.input : null, usage: resp.usage || {} };
}

// Sum two Anthropic usage objects so an edit's cost includes its QA pass.
function addUsage(a, b) {
  const out = {};
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) out[k] = (a[k] || 0) + (b[k] || 0);
  return out;
}

// Exposed for offline unit tests (api/tests/index.test.js).
module.exports.isEditablePath = isEditablePath;
