'use strict';

/**
 * Resolves the Astro project files the API needs at runtime (site-config +
 * the src/ tree for rendering). In a deployed Function these are bundled into
 * api/_site (see scripts/bundle-site.js, run by the api build step); in local
 * dev they live at the repo root. Everything that needs the project resolves
 * through siteRoot() instead of hardcoding ../../ paths, so it works in both.
 */

const fs = require('node:fs');
const path = require('node:path');

function siteRoot() {
  const bundled = path.resolve(__dirname, '..', '_site');
  if (fs.existsSync(path.join(bundled, 'astro.config.mjs'))) return bundled;
  return path.resolve(__dirname, '..', '..'); // repo root (local dev)
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(siteRoot(), rel), 'utf8'));
}

const brand = readJson('site-config/brand.json');
const org = readJson('site-config/org-context.json');
const editPolicy = readJson('site-config/edit-policy.json');

module.exports = { siteRoot, brand, org, editPolicy };
