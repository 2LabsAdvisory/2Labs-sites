'use strict';

/**
 * Per-user sites registry in Blob Storage — the list of websites a signed-in
 * user manages in the builder. One JSON blob per user. Each site record:
 *   { slug, name, domain, github:{owner,repo,branch}, editable, createdAt }
 * `editable` marks sites whose project is wired up for in-editor editing
 * (currently only the seeded 2Labs site until per-site repos are connected).
 */

const { BlobServiceClient } = require('@azure/storage-blob');

function connectionString() {
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured.');
  return cs;
}
function containerName() {
  return process.env.REGISTRY_CONTAINER || 'registry';
}

let cachedService = null;
function service() {
  if (!cachedService) cachedService = BlobServiceClient.fromConnectionString(connectionString());
  return cachedService;
}
async function container() {
  const c = service().getContainerClient(containerName());
  await c.createIfNotExists();
  return c;
}

const emailKey = (email) => String(email || '').toLowerCase().replace(/[^a-z0-9._-]/g, '_');
const blobName = (email) => `${emailKey(email)}/sites.json`;

function slugify(name) {
  return String(name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
}

// Seeded for every user for now (all builder users are 2Labs operators).
function defaultSites() {
  return [
    {
      slug: '2labs',
      name: '2Labs Advisory',
      domain: '2labs.ca',
      editable: true,
      github: { owner: '', repo: '', branch: 'main' },
      createdAt: new Date().toISOString(),
    },
  ];
}

async function readSites(email) {
  const c = await container();
  const blob = c.getBlockBlobClient(blobName(email));
  try {
    return JSON.parse((await blob.downloadToBuffer()).toString('utf-8'));
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function writeSites(email, sites) {
  const c = await container();
  const blob = c.getBlockBlobClient(blobName(email));
  const data = Buffer.from(JSON.stringify(sites, null, 2), 'utf-8');
  await blob.upload(data, data.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
}

/** The user's sites, seeding defaults on first access. */
async function listSites(email) {
  let sites = await readSites(email);
  if (sites == null) {
    sites = defaultSites();
    await writeSites(email, sites);
  }
  return sites;
}

async function getSite(email, slug) {
  return (await listSites(email)).find((s) => s.slug === slug) || null;
}

/** Create or update a site (matched by slug). Returns the saved record. */
async function upsertSite(email, input) {
  const sites = await listSites(email);
  const slug = input.slug || slugify(input.name);
  const existing = sites.find((s) => s.slug === slug);
  if (existing) {
    Object.assign(existing, {
      name: input.name ?? existing.name,
      domain: input.domain ?? existing.domain,
      github: { ...existing.github, ...(input.github || {}) },
      ...(input.brief ? { brief: input.brief } : {}), // wizard brief (Studio input)
    });
    await writeSites(email, sites);
    return existing;
  }
  const site = {
    slug,
    name: input.name || slug,
    domain: input.domain || '',
    editable: false, // a new site becomes editable once its repo/project is connected
    github: { owner: '', repo: '', branch: 'main', ...(input.github || {}) },
    ...(input.brief ? { brief: input.brief } : {}), // wizard brief the Studio will build from
    createdAt: new Date().toISOString(),
  };
  sites.push(site);
  await writeSites(email, sites);
  return site;
}

module.exports = { listSites, getSite, upsertSite, slugify };
