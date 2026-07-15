'use strict';

/**
 * Copies the managed client-site projects (sites/<slug>/) into api/_site/sites,
 * so the render pipeline can root at each site's project in a deployed Function.
 * Run by the api build step — during SWA/Oryx deploy, `npm run build` runs in
 * api/ with the whole repo checked out, so sites/ at ../ is available to copy.
 *
 * api/_site is gitignored (build artifact). Locally it's optional; siteConfig
 * falls back to the repo's sites/<slug>/ when api/_site isn't present.
 */

const fs = require('node:fs');
const path = require('node:path');

const API_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_DIR, '..');
const DEST = path.join(API_DIR, '_site');

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

const sitesFrom = path.join(REPO_ROOT, 'sites');
let copied = [];
if (fs.existsSync(sitesFrom)) {
  fs.cpSync(sitesFrom, path.join(DEST, 'sites'), { recursive: true });
  copied = fs.readdirSync(sitesFrom).filter((d) => fs.statSync(path.join(sitesFrom, d)).isDirectory());
}

console.log(`[bundle-site] bundled sites into api/_site/sites: ${copied.join(', ') || '(none)'}`);
