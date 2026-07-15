/**
 * Integration test for the edit-site handler with the draft store, renderer,
 * auth, and Anthropic all mocked. Proves the Phase 0 loop's control flow —
 * auth, guardrail, load draft, generate, validate, SAVE DRAFT (no git),
 * render — and its safety exits, without credentials, Blob Storage, or Vite.
 *
 * Mocks are injected via require.cache before index.js is required, so the
 * function code under test is unchanged from what deploys to Azure.
 * Run: node api/tests/index.integration.test.js
 */
const assert = require('node:assert');
const path = require('node:path');

let saveCalls = []; // { path, content }
let nextModelText = '';

const CURRENT_INDEX = `---
import BaseLayout from '../layouts/BaseLayout.astro';
import org from '../../site-config/org-context.json';
---
<BaseLayout title="Home" description={org.mission}>
  <section class="hero"><h1>Do More Good</h1></section>
</BaseLayout>`;

class FakeAnthropic {
  constructor() {
    this.messages = { create: async () => ({ content: [{ type: 'text', text: nextModelText }] }) };
  }
}

// ---- Mock modules before requiring the handler ----------------------------
require.cache[require.resolve('@anthropic-ai/sdk')] = {
  id: '@anthropic-ai/sdk', loaded: true, exports: { Anthropic: FakeAnthropic },
};
require.cache[require.resolve('../shared/auth')] = {
  id: 'auth', loaded: true,
  exports: {
    getBearerToken: (req) => {
      const h = (req && req.headers && req.headers.authorization) || '';
      return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
    },
    validateSessionEmail: async (token) => (token ? 'aslessor@2labs.ca' : null),
    isEmailAllowed: (email) => email === 'aslessor@2labs.ca',
  },
};
require.cache[require.resolve('../lib/draftStore')] = {
  id: 'draftStore', loaded: true,
  exports: {
    getDraftFile: async () => CURRENT_INDEX, // there is already a draft; deterministic "current"
    setDraftFile: async (clientId, p, content) => { saveCalls.push({ path: p, content }); },
    listDraftFiles: async () => [], clearDraft: async () => {},
  },
};
let nextRenderThrows = false;
require.cache[require.resolve('../lib/renderDraft')] = {
  id: 'renderDraft', loaded: true,
  exports: {
    renderDraft: async () => {
      if (nextRenderThrows) throw new Error('boom');
      return '<!DOCTYPE html>\n<html><body>rendered</body></html>';
    },
  },
};

process.env.ANTHROPIC_API_KEY = 'test';

const handler = require(path.join(__dirname, '..', 'edit-site', 'index.js'));

// ---- Harness --------------------------------------------------------------
function makeContext() {
  return { log: Object.assign(() => {}, { error: () => {} }), res: null };
}
async function invoke(body, { authed = true, renderThrows = false } = {}) {
  saveCalls = [];
  nextRenderThrows = renderThrows;
  const ctx = makeContext();
  const headers = authed ? { authorization: 'Bearer test-session-token' } : {};
  await handler(ctx, { body, headers });
  return ctx.res;
}

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

(async () => {
  await check('valid edit → status "ok" with rendered html, saves ONE draft, no git', async () => {
    nextModelText = CURRENT_INDEX.replace('Do More Good', 'Do Even More Good');
    const res = await invoke({ prompt: 'reword the hero heading' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
    assert.match(res.body.html, /rendered/);
    assert.strictEqual(saveCalls.length, 1);
    assert.strictEqual(saveCalls[0].path, 'src/pages/index.astro');
    assert.match(saveCalls[0].content, /Do Even More Good/);
  });

  await check('plain-text refusal (no markup) → 500 and NO draft saved', async () => {
    nextModelText = "I'm sorry, but I can't help with that request.";
    const res = await invoke({ prompt: 'reword the hero heading' });
    assert.strictEqual(res.status, 500);
    assert.strictEqual(saveCalls.length, 0);
  });

  await check('render failure → 500 and NO save (render runs before save)', async () => {
    nextModelText = CURRENT_INDEX.replace('Do More Good', 'Broken Edit');
    const res = await invoke({ prompt: 'do something that breaks the render' }, { renderThrows: true });
    assert.strictEqual(res.status, 500);
    assert.match(res.body.detail, /render:/);
    assert.strictEqual(saveCalls.length, 0);
  });

  await check('```astro-fenced output → unwrapped and saved', async () => {
    const edited = CURRENT_INDEX.replace('Do More Good', 'Do Good Things');
    nextModelText = '```astro\n' + edited + '\n```';
    const res = await invoke({ prompt: 'reword the hero heading' });
    assert.strictEqual(res.body.status, 'ok');
    assert.ok(!saveCalls[0].content.includes('```'), 'saved draft must not contain a fence');
    assert.match(saveCalls[0].content, /Do Good Things/);
  });

  await check('identical output → status "no_change" and NO save', async () => {
    nextModelText = CURRENT_INDEX;
    const res = await invoke({ prompt: 'no real change' });
    assert.strictEqual(res.body.status, 'no_change');
    assert.strictEqual(saveCalls.length, 0);
  });

  await check('guardrails removed: a structural-word prompt just edits (ok)', async () => {
    nextModelText = CURRENT_INDEX.replace('Do More Good', 'Do More Good Today');
    const res = await invoke({ prompt: 'change the footer and navigation layout' });
    assert.strictEqual(res.body.status, 'ok');
    assert.strictEqual(saveCalls.length, 1);
  });

  await check('no session token → 401 and NO save', async () => {
    nextModelText = CURRENT_INDEX.replace('Do More Good', 'X');
    const res = await invoke({ prompt: 'reword the hero heading' }, { authed: false });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(saveCalls.length, 0);
  });

  await check('empty prompt → 400', async () => {
    const res = await invoke({ prompt: '   ' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(saveCalls.length, 0);
  });

  console.log(`\n${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
