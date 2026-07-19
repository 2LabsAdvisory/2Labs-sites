'use strict';

/**
 * kb — the Studio Knowledge Base (Memory brief v1.2, Store 2). SHARED across all
 * builds (never per-client): reusable, abstracted knowledge the research agents
 * produce, so repeat builds of a known archetype skip live research.
 *
 * Two collections today, each backed by one of the v1.1 research agents:
 *   - 'playbook'  : category playbooks keyed by archetype (from research-category)
 *   - 'reference' : IP-safe inspiration analyses keyed by a URL-set hash
 *                   (from analyze-references)
 *
 * Every entry carries freshness metadata (last_refreshed, ttl_days, confidence,
 * version, usage_count, review_status, do_not_use, provenance, sources). The
 * retrieve-or-refresh mechanic reads via getFresh() and writes via the Curator.
 */

const crypto = require('node:crypto');
const { BlobServiceClient } = require('@azure/storage-blob');

// Configurable TTLs / freshness (env-overridable).
const TTL_PLAYBOOK = Number(process.env.KB_TTL_PLAYBOOK_DAYS) || 90;
const TTL_REFERENCE = Number(process.env.KB_TTL_REFERENCE_DAYS) || 30;
const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };
const MIN_CONFIDENCE = process.env.KB_MIN_CONFIDENCE || 'low';

function connectionString() {
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured.');
  return cs;
}
const containerName = () => process.env.KB_CONTAINER || 'kb';

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

const slug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'x';
/** Stable key for a category playbook, from its archetype. */
const archetypeKey = (archetype) => slug(archetype);
/** Stable key for a set of reference URLs (order-independent). */
function refKey(references) {
  const urls = (references || []).map((r) => String((r && r.url) || r || '').trim().toLowerCase().replace(/\/+$/, '')).filter(Boolean).sort();
  return crypto.createHash('sha256').update(urls.join('|')).digest('hex').slice(0, 24);
}

const blobPath = (kind, key) => `${kind}/${key}.json`;

async function getEntry(kind, key) {
  try {
    const c = await container();
    const buf = await c.getBlobClient(blobPath(kind, key)).downloadToBuffer();
    return JSON.parse(buf.toString('utf-8'));
  } catch (e) {
    if (e.statusCode === 404) return null;
    return null; // best-effort — a KB read must never break a build
  }
}

async function putEntry(kind, key, entry) {
  const c = await container();
  const body = Buffer.from(JSON.stringify(entry, null, 2), 'utf-8');
  await c.getBlockBlobClient(blobPath(kind, key)).upload(body, body.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
  return entry;
}

function isFresh(entry, ttlDays) {
  if (!entry || entry.do_not_use) return false;
  if ((CONFIDENCE_RANK[entry.confidence] || 1) < (CONFIDENCE_RANK[MIN_CONFIDENCE] || 1)) return false;
  const ts = Date.parse(entry.last_refreshed || 0);
  if (!ts) return false;
  const ageDays = (Date.now() - ts) / 86400000;
  return ageDays <= (ttlDays || entry.ttl_days || 90);
}

/** Return the entry only if it's a fresh, usable hit — else null (miss/stale). */
async function getFresh(kind, key) {
  const entry = await getEntry(kind, key);
  const ttl = kind === 'playbook' ? TTL_PLAYBOOK : TTL_REFERENCE;
  return isFresh(entry, ttl) ? entry : null;
}

/** Increment usage_count on a hit (best-effort, for the learning loop). */
async function bumpUsage(kind, key) {
  try {
    const entry = await getEntry(kind, key);
    if (!entry) return;
    entry.usage_count = (entry.usage_count || 0) + 1;
    await putEntry(kind, key, entry);
  } catch (e) { /* best-effort */ }
}

/** List entry metadata (no heavy data) for one collection — for traceability. */
async function list(kind) {
  const out = [];
  try {
    const c = await container();
    for await (const item of c.listBlobsFlat({ prefix: `${kind}/` })) {
      const e = await getEntry(kind, item.name.replace(`${kind}/`, '').replace(/\.json$/, ''));
      if (e) out.push({ kind: e.kind, key: e.key, confidence: e.confidence, version: e.version, usage_count: e.usage_count, last_refreshed: e.last_refreshed, ttl_days: e.ttl_days, review_status: e.review_status, do_not_use: !!e.do_not_use, sources: (e.sources || []).length });
    }
  } catch (e) { /* best-effort */ }
  return out;
}

module.exports = { getEntry, putEntry, getFresh, bumpUsage, list, archetypeKey, refKey, TTL_PLAYBOOK, TTL_REFERENCE };
