'use strict';

/**
 * metricsStore — tiny Blob cache for per-site analytics (PageSpeed results).
 * One JSON blob per user+site so the Overview loads instantly and we don't
 * re-run a ~20s Lighthouse audit on every visit. Blob: <emailKey>/<slug>.json
 */

const { BlobServiceClient } = require('@azure/storage-blob');

function connectionString() {
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured.');
  return cs;
}
function containerName() {
  return process.env.METRICS_CONTAINER || 'metrics';
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
const blobName = (email, slug) => `${emailKey(email)}/${slug}.json`;

async function getCached(email, slug) {
  const c = await container();
  const blob = c.getBlockBlobClient(blobName(email, slug));
  try {
    return JSON.parse((await blob.downloadToBuffer()).toString('utf-8'));
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function putCached(email, slug, data) {
  const c = await container();
  const blob = c.getBlockBlobClient(blobName(email, slug));
  const buf = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
  await blob.upload(buf, buf.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
}

module.exports = { getCached, putCached };
