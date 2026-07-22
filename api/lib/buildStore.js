'use strict';

/**
 * buildStore — the build manifest for a site's full-mirror generation.
 *
 * A deep import generates many pages (tens), which can't finish in one request.
 * generate-plan writes a manifest of every page to build; the page generator
 * marks each done/failed as it goes. That makes the long build resumable (reopen
 * and continue) and drivable in batches by the client or a background worker.
 *
 * Layout (container IMPORT_CONTAINER, default "imports"):  <slug>/build.json
 */

const { BlobServiceClient } = require('@azure/storage-blob');

function connectionString() {
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured.');
  return cs;
}
function containerName() { return process.env.IMPORT_CONTAINER || 'imports'; }

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
const name = (slug) => `${slug}/build.json`;

async function getManifest(slug) {
  const c = await container();
  const blob = c.getBlockBlobClient(name(slug));
  try { return JSON.parse((await blob.downloadToBuffer()).toString('utf-8')); }
  catch (err) { if (err.statusCode === 404) return null; throw err; }
}

async function putManifest(slug, manifest) {
  const c = await container();
  const blob = c.getBlockBlobClient(name(slug));
  const m = { ...manifest, updatedAt: new Date().toISOString() };
  const data = Buffer.from(JSON.stringify(m), 'utf-8');
  await blob.upload(data, data.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
  return m;
}

/**
 * Create a fresh manifest. `pages` is [{ path, title }]; `nav` is the header
 * tree. Every page starts pending.
 */
async function createManifest(slug, { ownerEmail, nav, pages }) {
  return putManifest(slug, {
    slug,
    ownerEmail: ownerEmail || null,
    nav: nav || [],
    pages: (pages || []).map((p) => ({ path: p.path, title: p.title, slug: p.slug || null, status: 'pending', attempts: 0, error: null })),
    createdAt: new Date().toISOString(),
  });
}

/** Patch one page's status by path (read-modify-write). */
async function markPage(slug, path, patch) {
  const m = await getManifest(slug);
  if (!m) return null;
  const pg = m.pages.find((p) => p.path === path);
  if (pg) Object.assign(pg, patch);
  return putManifest(slug, m);
}

function summarize(m) {
  if (!m) return { total: 0, done: 0, failed: 0, pending: 0, complete: true };
  const total = m.pages.length;
  const done = m.pages.filter((p) => p.status === 'done').length;
  const failed = m.pages.filter((p) => p.status === 'failed').length;
  const pending = m.pages.filter((p) => p.status === 'pending').length;
  return { total, done, failed, pending, complete: pending === 0 };
}

module.exports = { getManifest, putManifest, createManifest, markPage, summarize };
