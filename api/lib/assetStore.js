'use strict';

/**
 * assetStore — user-uploaded media (photos, PDFs) the AI can use as content.
 *
 * Uploads are stored in Blob Storage and served same-origin via /api/asset, so
 * an <img src="/api/asset?id=…"> works in the preview iframe and on the live
 * SWA. One blob per file: <emailKey>/<uuid>.<ext>.
 *
 * (When client sites move to their own repos/domains, publish will copy assets
 * into the repo's public/ and rewrite these URLs — not needed while the client
 * site is served from this same SWA.)
 */

const crypto = require('node:crypto');
const { BlobServiceClient } = require('@azure/storage-blob');

const TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
};
const EXT_TO_TYPE = Object.fromEntries(Object.entries(TYPES).map(([t, e]) => [e, t]));
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

function connectionString() {
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured.');
  return cs;
}
function containerName() {
  return process.env.ASSET_CONTAINER || 'assets';
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
// A valid id is exactly "<emailKey>/<uuid>.<ext>" — reject anything else (traversal, etc.).
const ID_RE = /^[a-z0-9._-]+\/[0-9a-f-]{36}\.[a-z0-9]+$/;

function extFor(type, name) {
  if (TYPES[type]) return TYPES[type];
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  const ext = m && m[1].toLowerCase();
  return ext && EXT_TO_TYPE[ext] ? ext : null;
}

/** Store one uploaded file. Returns a descriptor incl. its same-origin URL. */
async function putAsset(email, { name, type, buffer }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Empty file.');
  if (buffer.length > MAX_BYTES) throw new Error('File is larger than 8 MB.');
  const ext = extFor(type, name);
  if (!ext) throw new Error('Only images (PNG, JPG, WebP, GIF, SVG) and PDFs are supported.');
  const contentType = type && TYPES[type] ? type : EXT_TO_TYPE[ext];

  const id = `${emailKey(email)}/${crypto.randomUUID()}.${ext}`;
  const c = await container();
  const blob = c.getBlockBlobClient(id);
  await blob.upload(buffer, buffer.length, {
    blobHTTPHeaders: { blobContentType: contentType },
    metadata: { name: encodeURIComponent(String(name || '').slice(0, 200)) },
  });
  return { id, url: `/api/asset?id=${encodeURIComponent(id)}`, name: name || `file.${ext}`, type: contentType, size: buffer.length };
}

/** Fetch a stored asset's bytes + content type (for serving or for the model). */
async function getAsset(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  const c = await container();
  const blob = c.getBlockBlobClient(id);
  try {
    const buffer = await blob.downloadToBuffer();
    const props = await blob.getProperties();
    return { buffer, contentType: props.contentType || 'application/octet-stream', name: props.metadata && props.metadata.name ? decodeURIComponent(props.metadata.name) : id };
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

module.exports = { putAsset, getAsset, MAX_BYTES, TYPES };
