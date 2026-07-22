/**
 * Offline unit tests for the Studio path/nav helpers used by the deep-import
 * (full-mirror) pipeline. Run: node api/tests/studio.test.js
 */
const assert = require('node:assert');
const s = require('../lib/studio.js');
const { isEditablePath } = require('../edit-site/index.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('routeForPath / pageFileForPath');
check('home', () => { assert.strictEqual(s.routeForPath('/'), '/'); assert.strictEqual(s.pageFileForPath('/'), 'src/pages/index.astro'); });
check('single "home" segment → root', () => assert.strictEqual(s.routeForPath('/home'), '/'));
check('top-level section', () => { assert.strictEqual(s.routeForPath('/newcomers'), '/newcomers'); assert.strictEqual(s.pageFileForPath('/newcomers'), 'src/pages/newcomers.astro'); });
check('nested page', () => { assert.strictEqual(s.routeForPath('/program/linc'), '/program/linc'); assert.strictEqual(s.pageFileForPath('/program/linc'), 'src/pages/program/linc.astro'); });
check('kebabs each segment', () => assert.strictEqual(s.pageFileForPath('/Get Involved/Major Gifts'), 'src/pages/get-involved/major-gifts.astro'));

console.log('fixLayoutImport (BaseLayout import depth)');
const tpl = 'import BaseLayout from "../layouts/BaseLayout.astro";';
check('top-level unchanged', () => assert.match(s.fixLayoutImport(tpl, 'src/pages/index.astro'), /"\.\.\/layouts\/BaseLayout\.astro"/));
check('1-deep → ../../', () => assert.match(s.fixLayoutImport(tpl, 'src/pages/program/linc.astro'), /"\.\.\/\.\.\/layouts\/BaseLayout\.astro"/));
check('2-deep → ../../../', () => assert.match(s.fixLayoutImport(tpl, 'src/pages/get-involved/help/faqs.astro'), /"\.\.\/\.\.\/\.\.\/layouts\/BaseLayout\.astro"/));

console.log('headerDraft mega menu');
const tree = [
  { title: 'Programs', route: '/program', children: Array.from({ length: 8 }, (_, i) => ({ title: 'P' + i, route: '/program/p' + i })) },
  { title: 'About', route: '/about', children: [{ title: 'Board', route: '/about/board' }] },
  { title: 'Contact', route: '/contact', children: [] },
];
const h = s.headerDraft(null, '/contact', '', tree);
check('renders mega-wide for a large group', () => assert.match(h, /mega-wide/));
check('reaches a deep child route', () => assert.match(h, /href="\/program\/p7"/));
check('has accessible toggle + script', () => { assert.match(h, /aria-expanded/); assert.match(h, /nav-toggle/); });
check('flat fallback when no tree', () => assert.match(s.headerDraft([{ slug: 'about', title: 'About' }], '/about', ''), /href="\/about"/));

console.log('isEditablePath allows nested imported pages');
check('nested program page editable', () => assert.strictEqual(isEditablePath('src/pages/program/linc.astro'), true));
check('nested section page editable', () => assert.strictEqual(isEditablePath('src/pages/get-involved/faqs.astro'), true));

console.log(`\n${passed} passed`);
