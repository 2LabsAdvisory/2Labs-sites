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
const BASE_SITE = '_base'; // shared render skeleton for sites without their own project

// A site's project dir (bundled or repo), or null if it has no astro.config.
function resolveSiteDir(siteId) {
  const bundled = path.resolve(__dirname, '..', '_site', 'sites', siteId);
  if (fs.existsSync(path.join(bundled, 'astro.config.mjs'))) return bundled;
  const repo = path.resolve(__dirname, '..', '..', 'sites', siteId);
  if (fs.existsSync(path.join(repo, 'astro.config.mjs'))) return repo;
  return null;
}

// Render/edit root for a site: its own project if it exists, else the shared
// base skeleton (new wizard sites have no on-disk project — their pages/brand
// live in draft overlays rendered against _base).
function siteRoot(siteId = DEFAULT_SITE) {
  return resolveSiteDir(siteId) || resolveSiteDir(BASE_SITE)
    || path.resolve(__dirname, '..', '..', 'sites', BASE_SITE);
}

function readJson(rel, siteId) {
  return JSON.parse(fs.readFileSync(path.join(siteRoot(siteId), rel), 'utf8'));
}

// Default site's config (used by the edit persona). Per-site config lands later.
const brand = readJson('site-config/brand.json');
const org = readJson('site-config/org-context.json');
const editPolicy = readJson('site-config/edit-policy.json');

module.exports = { siteRoot, brand, org, editPolicy, DEFAULT_SITE };
