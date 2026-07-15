'use strict';

/**
 * Resolves a CLIENT SITE's Astro project at runtime. Each managed site lives
 * under sites/<siteId>/ (bundled into api/_site/sites/<siteId>/ for a deployed
 * Function; sites/<siteId>/ at the repo root in local dev). The render/edit
 * pipeline roots at the per-site project via siteRoot(siteId).
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SITE = '2labs';

function siteRoot(siteId = DEFAULT_SITE) {
  const bundled = path.resolve(__dirname, '..', '_site', 'sites', siteId);
  if (fs.existsSync(path.join(bundled, 'astro.config.mjs'))) return bundled;
  return path.resolve(__dirname, '..', '..', 'sites', siteId); // repo (local dev)
}

function readJson(rel, siteId) {
  return JSON.parse(fs.readFileSync(path.join(siteRoot(siteId), rel), 'utf8'));
}

// Default site's config (used by the edit persona). Per-site config lands later.
const brand = readJson('site-config/brand.json');
const org = readJson('site-config/org-context.json');
const editPolicy = readJson('site-config/edit-policy.json');

module.exports = { siteRoot, brand, org, editPolicy, DEFAULT_SITE };
