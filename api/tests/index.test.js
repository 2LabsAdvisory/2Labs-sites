/**
 * Offline unit tests for the pure guardrail helpers in index.js.
 * These need no Azure/GitHub/Anthropic credentials — run with:
 *   node api/edit-site/index.test.js
 * They prove the safety checks that protect the live homepage before the
 * first real end-to-end test.
 */
const assert = require('node:assert');
const { stripCodeFences, validateAstroOutput, isLikelyStructuralRequest } = require('../edit-site/index.js');

// A minimal but realistic current index.astro, used as the "before" content.
const CURRENT = `---
import BaseLayout from '../layouts/BaseLayout.astro';
import org from '../../site-config/org-context.json';
---
<BaseLayout title="Home" description={org.mission}>
  <section class="hero"><h1>Hello</h1></section>
</BaseLayout>`;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('stripCodeFences');
check('leaves un-fenced content untouched', () => {
  assert.strictEqual(stripCodeFences(CURRENT), CURRENT.trim());
});
check('strips a ```astro fence', () => {
  const fenced = '```astro\n' + CURRENT + '\n```';
  assert.strictEqual(stripCodeFences(fenced), CURRENT.trim());
});
check('strips a bare ``` fence', () => {
  assert.strictEqual(stripCodeFences('```\n' + CURRENT + '\n```'), CURRENT.trim());
});
check('strips a ~~~ fence', () => {
  assert.strictEqual(stripCodeFences('~~~\n' + CURRENT + '\n~~~'), CURRENT.trim());
});

console.log('validateAstroOutput');
check('accepts a valid edited file', () => {
  const edited = CURRENT.replace('Hello', 'Welcome');
  assert.strictEqual(validateAstroOutput(edited, CURRENT), null);
});
check('rejects a refusal / prose reply', () => {
  assert.ok(validateAstroOutput("I'm sorry, but I can't help with that request.", CURRENT));
});
check('rejects output missing BaseLayout', () => {
  const noLayout = '---\nconst x = 1;\n---\n<div>a standalone page with no layout wrapper here</div>';
  assert.strictEqual(validateAstroOutput(noLayout, CURRENT), 'missing BaseLayout');
});
check('rejects output missing frontmatter', () => {
  const noFrontmatter = '<BaseLayout title="Home" description="a homepage with no frontmatter fence at all">hi</BaseLayout>';
  assert.strictEqual(validateAstroOutput(noFrontmatter, CURRENT), 'missing frontmatter');
});
check('rejects empty/too-short output', () => {
  assert.ok(validateAstroOutput('   ', CURRENT));
});

console.log('isLikelyStructuralRequest');
check('flags a navigation prompt', () => {
  assert.strictEqual(isLikelyStructuralRequest('change the navigation links', {}), true);
});
check('allows a plain content prompt', () => {
  assert.strictEqual(isLikelyStructuralRequest('reword the hero subheading', {}), false);
});

console.log(`\n${passed} passed`);
