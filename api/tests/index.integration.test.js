/**
 * Integration test for the multi-file, agentic edit-site handler with the
 * draft store, renderer, auth, and Anthropic (tool use) all mocked. Proves
 * the control flow — gather context, tool call, path safety, render-before-
 * save, multi-file save — without credentials, Blob Storage, or Vite.
 * Run: node api/tests/index.integration.test.js
 */
const assert = require('node:assert');
const path = require('node:path');

let saveCalls = [];        // { path, content }
let nextResponse = null;   // Anthropic response .content array
let nextRenderThrows = false;

const CURRENT_INDEX = `---
import BaseLayout from '../layouts/BaseLayout.astro';
---
<BaseLayout title="Home" description="desc"><h1>Do More Good</h1></BaseLayout>`;

const toolResp = (input) => [{ type: 'tool_use', name: 'apply_site_changes', input }];
const editResp = (input) => [{ type: 'tool_use', name: 'edit_files', input }];
const textResp = (text) => [{ type: 'text', text }];

class FakeAnthropic {
  constructor() {
    this.messages = {
      create: async () => ({ content: nextResponse }),
      // edit-site streams and awaits finalMessage(); mirror that shape.
      stream: () => ({ finalMessage: async () => ({ content: nextResponse, usage: {} }) }),
    };
  }
}

require.cache[require.resolve('@anthropic-ai/sdk')] = { id: 'a', loaded: true, exports: { Anthropic: FakeAnthropic } };
require.cache[require.resolve('../shared/auth')] = {
  id: 'auth', loaded: true,
  exports: {
    getBearerToken: (req) => { const h = (req && req.headers && req.headers.authorization) || ''; return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null; },
    validateSessionEmail: async (t) => (t ? 'aslessor@2labs.ca' : null),
    isEmailAllowed: (e) => e === 'aslessor@2labs.ca',
  },
};
require.cache[require.resolve('../lib/draftStore')] = {
  id: 'draftStore', loaded: true,
  exports: {
    getDraftFile: async () => CURRENT_INDEX,
    setDraftFile: async (c, p, content) => { saveCalls.push({ path: p, content }); },
    listDraftFiles: async () => [],
    clearDraft: async () => {}, clearDraftFiles: async () => {},
    saveUndoManifest: async () => {}, getUndoManifest: async () => null, clearUndoManifest: async () => {},
  },
};
require.cache[require.resolve('../lib/renderDraft')] = {
  id: 'renderDraft', loaded: true,
  exports: { renderDraft: async () => { if (nextRenderThrows) throw new Error('boom'); return '<!DOCTYPE html><html><body>rendered</body></html>'; } },
};
require.cache[require.resolve('../lib/usageStore')] = {
  id: 'usageStore', loaded: true,
  exports: { recordEdit: async () => ({ period: '2026-07', edits: 1 }) },
};
require.cache[require.resolve('../lib/editResultStore')] = {
  id: 'editResultStore', loaded: true,
  exports: { putResult: async () => {}, getResult: async () => null },
};

process.env.ANTHROPIC_API_KEY = 'test';
const handler = require(path.join(__dirname, '..', 'edit-site', 'index.js'));

function makeContext() { return { log: Object.assign(() => {}, { error: () => {} }), res: null }; }
async function invoke(body, { authed = true, renderThrows = false } = {}) {
  saveCalls = []; nextRenderThrows = renderThrows;
  const ctx = makeContext();
  await handler(ctx, { body, headers: authed ? { authorization: 'Bearer t' } : {} });
  return ctx.res;
}

const PAGE = (title) => `---\nimport BaseLayout from '../layouts/BaseLayout.astro';\n---\n<BaseLayout title="${title}" description="d"><h1>${title}</h1></BaseLayout>`;

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

(async () => {
  await check('single-file edit → ok, summary + rendered html, saves the file', async () => {
    nextResponse = toolResp({ summary: 'Reworded the hero.', primary_path: 'src/pages/index.astro', files: [{ path: 'src/pages/index.astro', content: PAGE('Do Even More Good') }] });
    const res = await invoke({ prompt: 'reword the hero' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(res.body.summary, 'Reworded the hero.');
    assert.match(res.body.html, /rendered/);
    assert.deepStrictEqual(res.body.files, ['src/pages/index.astro']);
    assert.strictEqual(saveCalls.length, 1);
  });

  await check('add a page → creates page + wires nav (two files saved)', async () => {
    nextResponse = toolResp({
      summary: 'Added a Services page and linked it in the nav.',
      primary_path: 'src/pages/services.astro',
      files: [
        { path: 'src/pages/services.astro', content: PAGE('Services') },
        { path: 'src/components/Header.astro', content: '<header><nav><a href="/services">Services</a></nav></header>' },
      ],
    });
    const res = await invoke({ prompt: 'add a services page' });
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(res.body.primary, 'src/pages/services.astro');
    assert.strictEqual(saveCalls.length, 2);
    assert.deepStrictEqual(res.body.files.sort(), ['src/components/Header.astro', 'src/pages/services.astro']);
  });

  await check('targeted edit_files → applies replacement, saves full file', async () => {
    nextResponse = editResp({ summary: 'Swapped the headline.', primary_path: 'src/pages/index.astro', edits: [{ path: 'src/pages/index.astro', old_string: 'Do More Good', new_string: 'Do Even More Good' }] });
    const res = await invoke({ prompt: 'change the headline' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert.deepStrictEqual(res.body.files, ['src/pages/index.astro']);
    assert.strictEqual(saveCalls.length, 1);
    assert.match(saveCalls[0].content, /Do Even More Good/);
    assert.ok(!saveCalls[0].content.includes('Do More Good'), 'original text should be gone');
  });

  await check('edit_files with text that is not present → 500 and NO save', async () => {
    nextResponse = editResp({ summary: 'x', primary_path: 'src/pages/index.astro', edits: [{ path: 'src/pages/index.astro', old_string: 'NONEXISTENT SNIPPET', new_string: 'y' }] });
    const res = await invoke({ prompt: 'change something not there' });
    assert.strictEqual(res.status, 500);
    assert.match(res.body.detail, /Couldn't find/);
    assert.strictEqual(saveCalls.length, 0);
  });

  await check('disallowed path (builder app page) → 500 and NO save', async () => {
    nextResponse = toolResp({ summary: 'x', primary_path: 'src/pages/editor.astro', files: [{ path: 'src/pages/editor.astro', content: PAGE('hack') }] });
    const res = await invoke({ prompt: 'mess with the editor' });
    assert.strictEqual(res.status, 500);
    assert.match(res.body.detail, /Not allowed/);
    assert.strictEqual(saveCalls.length, 0);
  });

  await check('render failure → 500 and NO save (render runs before save)', async () => {
    nextResponse = toolResp({ summary: 'x', primary_path: 'src/pages/index.astro', files: [{ path: 'src/pages/index.astro', content: PAGE('Broken') }] });
    const res = await invoke({ prompt: 'break it' }, { renderThrows: true });
    assert.strictEqual(res.status, 500);
    assert.match(res.body.detail, /render:/);
    assert.strictEqual(saveCalls.length, 0);
  });

  await check('no tool call (model returned prose) → 500 and NO save', async () => {
    nextResponse = textResp("Sure, I can help with that.");
    const res = await invoke({ prompt: 'do something' });
    assert.strictEqual(res.status, 500);
    assert.match(res.body.detail, /did not return/);
    assert.strictEqual(saveCalls.length, 0);
  });

  await check('no session token → 401', async () => {
    nextResponse = toolResp({ summary: 'x', primary_path: 'src/pages/index.astro', files: [{ path: 'src/pages/index.astro', content: PAGE('x') }] });
    const res = await invoke({ prompt: 'edit' }, { authed: false });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(saveCalls.length, 0);
  });

  await check('empty prompt → 400', async () => {
    const res = await invoke({ prompt: '  ' });
    assert.strictEqual(res.status, 400);
  });

  console.log(`\n${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
