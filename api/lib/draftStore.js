'use strict';

/**
 * Per-client draft storage in Azure Blob Storage. Drafts are edits that
 * haven't been published to GitHub yet; edit-site writes them here and
 * publish-site reads + commits + clears them. Thin wrapper over
 * @azure/storage-blob used by both functions.
 *
 * Layout: one blob per draft file at `<clientId>/<repoRelPath>` inside a
 * single container (DRAFT_CONTAINER, default "drafts").
 *
 * Config (app settings):
 *   AZURE_STORAGE_CONNECTION_STRING   storage account connection string
 *   DRAFT_CONTAINER                    container name (default "drafts")
 */

const { BlobServiceClient } = require('@azure/storage-blob');

function connectionString() {
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured.');
  return cs;
}

function containerName() {
  return process.env.DRAFT_CONTAINER || 'drafts';
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

function blobName(clientId, repoRelPath) {
  return `${clientId}/${repoRelPath}`;
}

// Undo state lives under this segment so it's never listed as a draft file
// (and so never published). One-level undo is a full snapshot of the draft
// set (path -> content) taken before each edit, so multi-file edits and new
// pages revert cleanly.
const UNDO_SEG = '__undo__/';
const MANIFEST_NAME = (clientId) => `${clientId}/${UNDO_SEG}manifest.json`;

/** Draft content for a file, or null if no draft exists. */
async function getDraftFile(clientId, repoRelPath) {
  const c = await container();
  const blob = c.getBlockBlobClient(blobName(clientId, repoRelPath));
  try {
    const buf = await blob.downloadToBuffer();
    return buf.toString('utf-8');
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

/** Write (create/overwrite) a draft file. */
async function setDraftFile(clientId, repoRelPath, content) {
  const c = await container();
  const blob = c.getBlockBlobClient(blobName(clientId, repoRelPath));
  const data = Buffer.from(content, 'utf-8');
  await blob.upload(data, data.length, {
    blobHTTPHeaders: { blobContentType: 'text/plain; charset=utf-8' },
  });
}

/** Repo-relative paths that currently have a draft for this client (excludes undo copies). */
async function listDraftFiles(clientId) {
  const c = await container();
  const prefix = `${clientId}/`;
  const files = [];
  for await (const item of c.listBlobsFlat({ prefix })) {
    const rel = item.name.slice(prefix.length);
    if (rel.startsWith(UNDO_SEG)) continue; // never publish undo copies
    files.push(rel);
  }
  return files;
}

/** Save a snapshot of the whole draft set (path -> content) as the undo point. */
async function saveUndoManifest(clientId, manifest) {
  const c = await container();
  const blob = c.getBlockBlobClient(MANIFEST_NAME(clientId));
  const data = Buffer.from(JSON.stringify(manifest), 'utf-8');
  await blob.upload(data, data.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
}

/** The undo snapshot (path -> content), or null if there's nothing to revert. */
async function getUndoManifest(clientId) {
  const c = await container();
  const blob = c.getBlockBlobClient(MANIFEST_NAME(clientId));
  try {
    return JSON.parse((await blob.downloadToBuffer()).toString('utf-8'));
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function clearUndoManifest(clientId) {
  const c = await container();
  await c.deleteBlob(MANIFEST_NAME(clientId)).catch(() => {});
}

/** Delete every draft file (but not the undo snapshot) — used by revert. */
async function clearDraftFiles(clientId) {
  const c = await container();
  const prefix = `${clientId}/`;
  for await (const item of c.listBlobsFlat({ prefix })) {
    if (item.name.slice(prefix.length).startsWith(UNDO_SEG)) continue;
    await c.deleteBlob(item.name);
  }
}

/** Delete all drafts for a client (after a successful publish). */
async function clearDraft(clientId) {
  const c = await container();
  const prefix = `${clientId}/`;
  for await (const item of c.listBlobsFlat({ prefix })) {
    await c.deleteBlob(item.name);
  }
}

module.exports = {
  getDraftFile, setDraftFile, listDraftFiles, clearDraft, clearDraftFiles, blobName,
  saveUndoManifest, getUndoManifest, clearUndoManifest,
};
