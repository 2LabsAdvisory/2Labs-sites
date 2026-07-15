/**
 * Offline unit tests for the pure helpers in edit-site/index.js.
 * Run: node api/tests/index.test.js
 *
 * Content guardrails were intentionally removed (the AI may edit anything;
 * a broken edit surfaces as a render error and isn't saved), so the only
 * pure helper left to unit-test is code-fence stripping.
 */
const assert = require('node:assert');
const { stripCodeFences } = require('../edit-site/index.js');

const CURRENT = `---
import BaseLayout from '../layouts/BaseLayout.astro';
---
<BaseLayout title="Home"><h1>Hello</h1></BaseLayout>`;

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('stripCodeFences');
check('leaves un-fenced content untouched', () => {
  assert.strictEqual(stripCodeFences(CURRENT), CURRENT.trim());
});
check('strips a ```astro fence', () => {
  assert.strictEqual(stripCodeFences('```astro\n' + CURRENT + '\n```'), CURRENT.trim());
});
check('strips a bare ``` fence', () => {
  assert.strictEqual(stripCodeFences('```\n' + CURRENT + '\n```'), CURRENT.trim());
});
check('strips a ~~~ fence', () => {
  assert.strictEqual(stripCodeFences('~~~\n' + CURRENT + '\n~~~'), CURRENT.trim());
});

console.log(`\n${passed} passed`);
