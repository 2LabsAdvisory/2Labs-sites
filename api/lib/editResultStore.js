'use strict';

/**
 * editResultStore — lets a slow edit survive the SWA gateway client-timeout.
 *
 * The function runs to completion even after the browser's request is cut off
 * (~60-90s at the gateway). edit-site writes its final result here keyed by a
 * client-supplied requestId; if the browser's POST timed out, the client polls
 * /api/edit-result until the result appears and applies it as if it had
 * returned inline. One JSON blob per request: <emailKey>/<requestId>.json.
 */

const { BlobServiceClient } = require('@azure/storage-blob');

function connectionString() {
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured.');
  return cs;
}
function containerName() {
  return process.env.EDIT_RESULT_CONTAINER || 'editresults';
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
const ID_RE = /^[0-9a-fA-F-]{8,64}$/; // client-generated UUID (or similar)
const blobName = (email, id) => `${emailKey(email)}/${id}.json`;

async function putResult(email, id, result) {
  if (!ID_RE.test(String(id || ''))) return;
  const c = await container();
  const blob = c.getBlockBlobClient(blobName(email, id));
  const buf = Buffer.from(JSON.stringify(result), 'utf-8');
  await blob.upload(buf, buf.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
}

async function getResult(email, id) {
  if (!ID_RE.test(String(id || ''))) return null;
  const c = await container();
  const blob = c.getBlockBlobClient(blobName(email, id));
  try {
    return JSON.parse((await blob.downloadToBuffer()).toString('utf-8'));
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

module.exports = { putResult, getResult };
