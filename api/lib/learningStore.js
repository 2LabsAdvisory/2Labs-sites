'use strict';

/**
 * learningStore — the applied output of the learning loop. When a human
 * approves an Insights proposal, its improvement is written here as a versioned
 * ADDENDUM keyed by target (e.g. "prompt:generate-page", "kb_playbook:<archetype>").
 * The relevant agent appends its approved addendum to its prompt, so improvements
 * take effect on the next build — versioned and reversible.
 *
 * Reads are best-effort ('' on miss) so a build never depends on this store.
 */
const { BlobServiceClient } = require('@azure/storage-blob');

function connectionString() {
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured.');
  return cs;
}
const containerName = () => process.env.LEARNING_CONTAINER || 'learning';
const safe = (t) => String(t || '').replace(/[^a-z0-9:._-]/gi, '_').slice(0, 120);

let cachedService = null;
function service() { if (!cachedService) cachedService = BlobServiceClient.fromConnectionString(connectionString()); return cachedService; }
async function container() { const c = service().getContainerClient(containerName()); await c.createIfNotExists(); return c; }
const blobPath = (target) => `addenda/${safe(target)}.json`;

async function getRecord(target) {
  try { const c = await container(); return JSON.parse((await c.getBlobClient(blobPath(target)).downloadToBuffer()).toString('utf-8')); }
  catch (e) { return null; }
}

/** The approved addendum text for a target — '' if none. Best-effort. */
async function getAddendum(target) {
  const r = await getRecord(target);
  return (r && !r.disabled && r.text) ? r.text : '';
}

/** Append the current addendum to a base system prompt (best-effort). */
async function withAddendum(baseSystem, target) {
  let add = '';
  try { add = await getAddendum(target); } catch (e) { add = ''; }
  return add ? baseSystem + '\n\nAPPROVED IMPROVEMENTS (human-reviewed learnings — apply these):\n' + add : baseSystem;
}

/** Set/replace the approved addendum for a target, bumping its version. */
async function setAddendum(target, text, provenance) {
  const existing = await getRecord(target);
  const rec = {
    target,
    text: String(text || ''),
    version: existing ? (existing.version || 1) + 1 : 1,
    updated_at: new Date().toISOString(),
    disabled: false,
    provenance: provenance || null,
    history: [...((existing && existing.history) || []), ...(existing ? [{ version: existing.version, text: existing.text, at: existing.updated_at }] : [])].slice(-10),
  };
  const c = await container();
  const body = Buffer.from(JSON.stringify(rec, null, 2), 'utf-8');
  await c.getBlockBlobClient(blobPath(target)).upload(body, body.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
  return rec;
}

async function listAddenda() {
  const out = [];
  try {
    const c = await container();
    for await (const item of c.listBlobsFlat({ prefix: 'addenda/' })) {
      const r = await getRecord(item.name.replace('addenda/', '').replace(/\.json$/, ''));
      if (r) out.push({ target: r.target, version: r.version, updated_at: r.updated_at, disabled: !!r.disabled, chars: (r.text || '').length });
    }
  } catch (e) { /* best-effort */ }
  return out;
}

module.exports = { getAddendum, withAddendum, setAddendum, listAddenda };
