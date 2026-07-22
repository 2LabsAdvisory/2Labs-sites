'use strict';

/**
 * importStore — the raw crawl corpus for an imported site.
 *
 * When a site is imported we crawl its real pages and stash the extracted
 * content here so the Studio (plan → chrome → per-page generation) can build a
 * faithful, full-depth mirror. This is INPUT to generation and is never
 * published or rendered, so it lives in its own container — separate from the
 * draft store.
 *
 * Layout (container IMPORT_CONTAINER, default "imports"):
 *   <slug>/tree.json            the discovered URL tree (nav hierarchy)
 *   <slug>/index.json           lightweight page index [{ path, url, title, description }]
 *   <slug>/pages/<hash>.json    full extracted content for one page
 *
 * Config: AZURE_STORAGE_CONNECTION_STRING, IMPORT_CONTAINER (default "imports").
 */

const crypto = require('crypto');
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

const pathHash = (p) => crypto.createHash('sha1').update(String(p || '/')).digest('hex').slice(0, 16);

async function putJson(name, obj) {
  const c = await container();
  const blob = c.getBlockBlobClient(name);
  const data = Buffer.from(JSON.stringify(obj), 'utf-8');
  await blob.upload(data, data.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
}
async function getJson(name) {
  const c = await container();
  const blob = c.getBlockBlobClient(name);
  try { return JSON.parse((await blob.downloadToBuffer()).toString('utf-8')); }
  catch (err) { if (err.statusCode === 404) return null; throw err; }
}

/** The discovered URL tree (sections → children) for this import. */
async function putUrlTree(slug, tree) { await putJson(`${slug}/tree.json`, tree); }
async function getUrlTree(slug) { return getJson(`${slug}/tree.json`); }

/** Lightweight index of crawled pages (for planning). */
async function putIndex(slug, index) { await putJson(`${slug}/index.json`, index); }
async function getIndex(slug) { return (await getJson(`${slug}/index.json`)) || []; }

/** Full extracted content for one crawled page (keyed by its path). */
async function putPage(slug, page) { await putJson(`${slug}/pages/${pathHash(page.path)}.json`, page); }
async function getPage(slug, path) { return getJson(`${slug}/pages/${pathHash(path)}.json`); }

/** True if this site has an import corpus (i.e. it was imported, not blank). */
async function hasCorpus(slug) { return (await getUrlTree(slug)) != null; }

module.exports = { putUrlTree, getUrlTree, putIndex, getIndex, putPage, getPage, hasCorpus, pathHash };
