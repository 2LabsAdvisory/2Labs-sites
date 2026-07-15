/**
 * Offline unit tests for edit-site's path-safety check.
 * Run: node api/tests/index.test.js
 *
 * The AI may write client-site source under src/ (pages, nav, components,
 * layout, styles) — but never the builder app (editor/dashboard/login) or
 * anything outside src/ (the API, workflows, etc.).
 */
const assert = require('node:assert');
const { isEditablePath } = require('../edit-site/index.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('isEditablePath');
check('allows a new client page', () => assert.strictEqual(isEditablePath('src/pages/services.astro'), true));
check('allows the homepage', () => assert.strictEqual(isEditablePath('src/pages/index.astro'), true));
check('allows editing nav (Header)', () => assert.strictEqual(isEditablePath('src/components/Header.astro'), true));
check('allows a stylesheet', () => assert.strictEqual(isEditablePath('src/styles/extra.css'), true));

check('blocks the editor app page', () => assert.strictEqual(isEditablePath('src/pages/editor.astro'), false));
check('blocks the dashboard app page', () => assert.strictEqual(isEditablePath('src/pages/dashboard.astro'), false));
check('blocks the login app page', () => assert.strictEqual(isEditablePath('src/pages/login.astro'), false));
check('blocks the API', () => assert.strictEqual(isEditablePath('api/edit-site/index.js'), false));
check('blocks path traversal', () => assert.strictEqual(isEditablePath('src/../api/secret.js'), false));
check('blocks outside src/', () => assert.strictEqual(isEditablePath('astro.config.mjs'), false));
check('blocks disallowed extensions', () => assert.strictEqual(isEditablePath('src/pages/thing.php'), false));

console.log(`\n${passed} passed`);
