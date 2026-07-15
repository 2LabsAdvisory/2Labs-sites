'use strict';

/**
 * Copies the Astro project files the API needs at runtime (the src/ tree for
 * rendering + site-config + astro.config) into api/_site, so they're packaged
 * with the deployed Function. Run by the api build step — during SWA/Oryx
 * deploy, `npm run build` runs in api/ with the whole repo checked out, so the
 * sibling files at ../ are available to copy.
 *
 * api/_site is gitignored (build artifact). Locally it's optional; siteConfig
 * falls back to the repo root when api/_site isn't present.
 */

const fs = require('node:fs');
const path = require('node:path');

const API_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(API_DIR, '..');
const DEST = path.join(API_DIR, '_site');

const ITEMS = ['src', 'site-config', 'astro.config.mjs', 'tsconfig.json'];

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

const copied = [];
for (const item of ITEMS) {
  const from = path.join(REPO_ROOT, item);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(DEST, item), { recursive: true });
  copied.push(item);
}

console.log(`[bundle-site] copied into api/_site: ${copied.join(', ') || '(nothing)'}`);
