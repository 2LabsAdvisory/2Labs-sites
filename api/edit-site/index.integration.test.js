/**
 * Integration test for the edit-site handler with GitHub + Anthropic mocked.
 * Proves the whole Phase 0 loop's control flow — guardrail, fetch, generate,
 * validate, commit — and its safety exits, WITHOUT any real credentials or
 * network. Run with:  node api/edit-site/index.integration.test.js
 *
 * The mocks are injected via require.cache before index.js is required, so the
 * function code under test is unchanged from what deploys to Azure.
 */
const assert = require('node:assert');
const path = require('node:path');

// ---- Mock @octokit/rest and @anthropic-ai/sdk before requiring the handler --
let commitCalls = [];
let nextModelText = ''; // what the mocked Claude will "return"

const CURRENT_INDEX = `---
import BaseLayout from '../layouts/BaseLayout.astro';
import org from '../../site-config/org-context.json';
---
<BaseLayout title="Home" description={org.mission}>
  <section class="hero"><h1>Do More Good</h1></section>
</BaseLayout>`;

const FILES = {
  'site-config/brand.json': JSON.stringify({
    orgName: '2Labs Advisory', voice: 'Direct.', domain: '2labs.ca',
    fonts: { heading: 'Plus Jakarta Sans', body: 'Inter' },
  }),
  'site-config/org-context.json': JSON.stringify({
    mission: 'Help orgs do more good.', primaryCta: 'Book', secondaryCta: 'Explore',
  }),
  'site-config/edit-policy.json': JSON.stringify({ structuralFiles: [] }),
  'src/pages/index.astro': CURRENT_INDEX,
};

function b64(s) { return Buffer.from(s, 'utf-8').toString('base64'); }

class FakeOctokit {
  constructor() {
    this.repos = {
      getContent: async ({ path: p }) => {
        if (!(p in FILES)) throw new Error(`404 no such file: ${p}`);
        return { data: { content: b64(FILES[p]), sha: `sha-${p}` } };
      },
      createOrUpdateFileContents: async (args) => {
        commitCalls.push(args);
        return { data: { commit: { sha: 'new-sha' } } };
      },
    };
  }
}

class FakeAnthropic {
  constructor() {
    this.messages = { create: async () => ({ content: [{ type: 'text', text: nextModelText }] }) };
  }
}

require.cache[require.resolve('@octokit/rest')] = { id: '@octokit/rest', exports: { Octokit: FakeOctokit }, loaded: true };
require.cache[require.resolve('@anthropic-ai/sdk')] = { id: '@anthropic-ai/sdk', exports: { Anthropic: FakeAnthropic }, loaded: true };

// Env the handler requires
Object.assign(process.env, {
  ANTHROPIC_API_KEY: 'test', GITHUB_TOKEN: 'test',
  GITHUB_OWNER: '2LabsAdvisory', GITHUB_REPO: '2Labs-sites',
});

const handler = require(path.join(__dirname, 'index.js'));

// ---- Test harness ----------------------------------------------------------
function makeContext() {
  return { log: Object.assign(() => {}, { error: () => {} }), res: null };
}
async function invoke(body) {
  commitCalls = [];
  const ctx = makeContext();
  await handler(ctx, { body });
  return ctx.res;
}

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

(async () => {
  // Happy path: a valid content edit gets committed to staging.
  await check('valid edit → status "staged" and one commit to staging', async () => {
    nextModelText = CURRENT_INDEX.replace('Do More Good', 'Do Even More Good');
    const res = await invoke({ prompt: 'reword the hero heading' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'staged');
    assert.strictEqual(commitCalls.length, 1);
    assert.strictEqual(commitCalls[0].path, 'src/pages/index.astro');
    assert.strictEqual(commitCalls[0].branch, 'staging');
    assert.strictEqual(commitCalls[0].sha, 'sha-src/pages/index.astro');
  });

  // Safety: a refusal/prose reply must NOT be committed to the live homepage.
  await check('model refusal → 500 and NO commit', async () => {
    nextModelText = "I'm sorry, but I can't help with that request.";
    const res = await invoke({ prompt: 'reword the hero heading' });
    assert.strictEqual(res.status, 500);
    assert.match(res.body.detail, /safety check/);
    assert.strictEqual(commitCalls.length, 0);
  });

  // Fence-wrapped output is unwrapped and still commits cleanly.
  await check('```astro-fenced output → unwrapped and committed', async () => {
    const edited = CURRENT_INDEX.replace('Do More Good', 'Do Good Things');
    nextModelText = '```astro\n' + edited + '\n```';
    const res = await invoke({ prompt: 'reword the hero heading' });
    assert.strictEqual(res.body.status, 'staged');
    const committed = Buffer.from(commitCalls[0].content, 'base64').toString('utf-8');
    assert.ok(!committed.includes('```'), 'committed content must not contain a fence');
    assert.ok(committed.includes('Do Good Things'));
  });

  // No-op edit: identical content is not committed.
  await check('identical output → status "no_change" and NO commit', async () => {
    nextModelText = CURRENT_INDEX;
    const res = await invoke({ prompt: 'no real change' });
    assert.strictEqual(res.body.status, 'no_change');
    assert.strictEqual(commitCalls.length, 0);
  });

  // Guardrail: structural-looking prompt is held for confirmation, no commit.
  await check('structural prompt → needs_confirmation, NO commit', async () => {
    nextModelText = CURRENT_INDEX.replace('Do More Good', 'X');
    const res = await invoke({ prompt: 'change the footer text' });
    assert.strictEqual(res.body.status, 'needs_confirmation');
    assert.strictEqual(commitCalls.length, 0);
  });

  // Guardrail override: confirmStructural:true lets it through.
  await check('structural prompt + confirmStructural → staged', async () => {
    nextModelText = CURRENT_INDEX.replace('Do More Good', 'Do More Good Today');
    const res = await invoke({ prompt: 'change the footer text', confirmStructural: true });
    assert.strictEqual(res.body.status, 'staged');
    assert.strictEqual(commitCalls.length, 1);
  });

  // Input validation: empty prompt is rejected before any work.
  await check('empty prompt → 400', async () => {
    const res = await invoke({ prompt: '   ' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(commitCalls.length, 0);
  });

  console.log(`\n${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
