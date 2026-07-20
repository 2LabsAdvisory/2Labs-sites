'use strict';

/**
 * publishScaffold — the files that turn a published site into a COMPLETE,
 * self-contained, buildable Astro static site in its own repo.
 *
 * Generation only drafts the per-site overlays (pages, Header/Footer, tokens).
 * A standalone repo also needs the project scaffolding — package.json,
 * astro.config, tsconfig, and the shared BaseLayout every page imports — or its
 * own Static Web App build fails. We read those from the _base skeleton and
 * synthesize a package.json so the repo builds with `astro build` → dist/.
 */
const fs = require('node:fs');
const path = require('node:path');
const { siteRoot } = require('./siteConfig');

const ASTRO_VERSION = process.env.PUBLISH_ASTRO_VERSION || '^7.0.9';

function readBase(rel) {
  try { return fs.readFileSync(path.join(siteRoot('_base'), rel), 'utf-8'); } catch (e) { return null; }
}

function packageJson(slug) {
  return JSON.stringify({
    name: (slug || 'site').replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts: { dev: 'astro dev', build: 'astro build', preview: 'astro preview' },
    dependencies: { astro: ASTRO_VERSION },
  }, null, 2) + '\n';
}

/**
 * The scaffolding files [{path, content}] a published repo needs to build.
 * These fill gaps only — a site's own generated pages/components/tokens win.
 */
function scaffoldFiles(slug) {
  const out = [];
  const add = (p, c) => { if (c != null) out.push({ path: p, content: c }); };
  add('package.json', packageJson(slug));
  add('astro.config.mjs', readBase('astro.config.mjs'));
  add('tsconfig.json', readBase('tsconfig.json'));
  add('src/layouts/BaseLayout.astro', readBase('src/layouts/BaseLayout.astro'));
  return out;
}

module.exports = { scaffoldFiles };
