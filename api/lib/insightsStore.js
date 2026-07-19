'use strict';

/**
 * insightsStore — the learning loop's proposal queue (Memory brief v1.2 §5).
 * The Insights agent writes evidence-based PROPOSALS here (pending); a human at
 * 2Labs approves/rejects each one. One blob per proposal so status updates on
 * different proposals never race. Shared, not per-client.
 */
const crypto = require('node:crypto');
const { BlobServiceClient } = require('@azure/storage-blob');

function connectionString() {
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured.');
  return cs;
}
const containerName = () => process.env.INSIGHTS_CONTAINER || 'insights';

let cachedService = null;
function service() { if (!cachedService) cachedService = BlobServiceClient.fromConnectionString(connectionString()); return cachedService; }
async function container() { const c = service().getContainerClient(containerName()); await c.createIfNotExists(); return c; }
const blobPath = (id) => `proposals/${id}.json`;

async function addProposals(proposals, meta) {
  const c = await container();
  const stored = [];
  for (const p of proposals || []) {
    const id = crypto.randomUUID();
    const rec = { id, status: 'pending', created_at: new Date().toISOString(), ...meta, ...p };
    const body = Buffer.from(JSON.stringify(rec, null, 2), 'utf-8');
    await c.getBlockBlobClient(blobPath(id)).upload(body, body.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
    stored.push(rec);
  }
  return stored;
}

async function getProposal(id) {
  try { const c = await container(); return JSON.parse((await c.getBlobClient(blobPath(id)).downloadToBuffer()).toString('utf-8')); }
  catch (e) { return null; }
}

async function updateProposal(id, patch) {
  const cur = await getProposal(id);
  if (!cur) return null;
  const next = { ...cur, ...patch, updated_at: new Date().toISOString() };
  const c = await container();
  const body = Buffer.from(JSON.stringify(next, null, 2), 'utf-8');
  await c.getBlockBlobClient(blobPath(id)).upload(body, body.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
  return next;
}

async function listProposals({ status } = {}) {
  const out = [];
  try {
    const c = await container();
    for await (const item of c.listBlobsFlat({ prefix: 'proposals/' })) {
      const p = await getProposal(item.name.replace('proposals/', '').replace(/\.json$/, ''));
      if (p && (!status || p.status === status)) out.push(p);
    }
  } catch (e) { /* best-effort */ }
  return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

module.exports = { addProposals, getProposal, updateProposal, listProposals };
