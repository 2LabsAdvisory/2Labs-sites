/**
 * Regression test for the in-process Astro render (api/lib/renderDraft.js).
 * Proves an edited .astro source — including one that imports BaseLayout and
 * site-config — renders to full HTML without a build or git commit.
 *
 * Needs `astro`/`vite` resolvable (root node_modules locally) and the project
 * src/ tree on disk. Run: node api/tests/container-render.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { renderDraft, closeRenderer, PROJECT_ROOT } = require('../lib/renderDraft');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }

(async () => {
  // 1. A standalone component renders.
  await check('renders a simple edited component', async () => {
    const html = await renderDraft('src/pages/index.astro', `---\nconst who = 'Editor';\n---\n<h1>Hello {who}</h1>`);
    assert.match(html, /<h1>Hello Editor<\/h1>/);
  });

  // 2. The real homepage (imports BaseLayout + org-context.json) renders to a
  //    full document — this is what the editor preview actually returns.
  await check('renders the real index.astro with its layout + a live edit', async () => {
    const real = fs.readFileSync(path.join(PROJECT_ROOT, 'src/pages/index.astro'), 'utf8');
    const edited = real.replaceAll('Do More Good', 'Do Something Wonderful');
    const html = await renderDraft('src/pages/index.astro', edited);
    assert.match(html, /<!DOCTYPE html>/i, 'should be a full document via BaseLayout');
    assert.match(html, /Do Something Wonderful/, 'should reflect the live edit');
    assert.ok(!html.includes('Do More Good'), 'old text should be gone');
    assert.match(html, /2Labs Advisory/, 'brand/org content should render');
    // Styles must be collected + injected (tokens.css + scoped component CSS),
    // else the preview renders unstyled.
    assert.match(html, /font-family/, 'global styles (tokens.css) should be injected');
    assert.match(html, /\.hero/, 'scoped component styles should be injected');
  });

  console.log(`\n${passed} passed`);
  await closeRenderer();
})().catch(async (e) => { console.error(e); await closeRenderer(); process.exit(1); });
