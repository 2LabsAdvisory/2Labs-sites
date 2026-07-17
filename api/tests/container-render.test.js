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

  // 3. Client-side component <script> must run in the preview: the Container
  //    emits it as <script src="…?astro&type=script…"> (a dev path that 404s in
  //    the srcdoc iframe); renderDraft transforms + inlines it so interactivity
  //    (accordions, menus) works. Regression guard for that inlining.
  await check('inlines hoisted component scripts (interactivity works in preview)', async () => {
    const page = `---\nimport BaseLayout from '../layouts/BaseLayout.astro';\n---\n` +
      `<BaseLayout title="T" description="d">` +
      `<button class="acc-btn">Toggle</button><div class="acc-panel">Panel</div>` +
      `<script>document.querySelector('.acc-btn')?.addEventListener('click',()=>` +
      `document.querySelector('.acc-panel')?.classList.toggle('open'));</script>` +
      `</BaseLayout>`;
    const html = await renderDraft('src/pages/index.astro', page);
    assert.ok(!/src="[^"]*type=script/.test(html), 'no un-executable hoisted-script src refs should remain');
    assert.match(html, /addEventListener\(\s*["']click["']/, 'the accordion JS should be inlined so it runs');
  });

  // 4. A brand-new site (slug with no on-disk project) renders against the
  //    shared _base skeleton, and its overlaid tokens.css brand colors are
  //    applied — this is what makes wizard-created sites editable.
  await check('renders a new site via _base with overlaid brand tokens', async () => {
    const home = `---\nimport BaseLayout from '../layouts/BaseLayout.astro';\n---\n` +
      `<BaseLayout title="Home" orgName="Acme"><h1>Welcome to Acme</h1></BaseLayout>`;
    const tokens = ':root{ --bg:#fff; --ink:#111; --ink-soft:#555; --border:#ddd; --primary:#E86A2C; --primary-dark:#c55; --on-primary:#ffffff; --font-heading:sans-serif; --font-body:sans-serif; }';
    const html = await renderDraft('src/pages/index.astro', home, { 'src/styles/tokens.css': tokens }, 'nonexistent-slug-xyz');
    assert.match(html, /Welcome to Acme/, 'new-site home renders via _base');
    assert.match(html, /#E86A2C/, 'overlaid tokens.css brand color should be collected');
  });

  console.log(`\n${passed} passed`);
  await closeRenderer();
})().catch(async (e) => { console.error(e); await closeRenderer(); process.exit(1); });
