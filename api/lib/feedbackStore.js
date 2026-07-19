'use strict';

/**
 * feedbackStore — the learning signal (Memory brief v1.2, Store 3).
 *
 * An append-only event log of what happens when clients edit and when the
 * Studio generates: which edits/builds succeed or fail, what users asked for,
 * where things break. This is the highest-value signal in the system — it tells
 * us where generation is weak so we can make future builds more reliable.
 *
 * Append Blob per day (events/YYYY-MM-DD.jsonl). Best-effort: recording must
 * NEVER break an edit or a build, so every write swallows its own errors.
 * Privacy: identities are hashed and we store intent + metadata, not client
 * content diffs — only abstracted signal, never raw copy.
 */

const crypto = require('node:crypto');
const { BlobServiceClient } = require('@azure/storage-blob');

function connectionString() {
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured.');
  return cs;
}
const containerName = () => process.env.FEEDBACK_CONTAINER || 'feedback';

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

/** Stable, non-reversible id so we can group by user/site without storing PII. */
const hashId = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 16);

/** Append one event. Best-effort — never throws. */
async function recordEvent(evt) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const c = await container();
    const blob = c.getAppendBlobClient(`events/${day}.jsonl`);
    await blob.createIfNotExists();
    const line = JSON.stringify({ at: new Date().toISOString(), ...evt }) + '\n';
    await blob.appendBlock(line, Buffer.byteLength(line));
  } catch (e) {
    /* swallow — telemetry must never break the request */
  }
}

/** Read events from the last `days` days, newest first. */
async function readEvents({ days = 30 } = {}) {
  const out = [];
  try {
    const c = await container();
    const cutoff = Date.now() - days * 86400000;
    for await (const item of c.listBlobsFlat({ prefix: 'events/' })) {
      const m = /events\/(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(item.name);
      if (!m || Date.parse(m[1] + 'T23:59:59Z') < cutoff) continue;
      const buf = await c.getBlobClient(item.name).downloadToBuffer();
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch (e) { /* skip bad line */ }
      }
    }
  } catch (e) {
    /* return whatever we have */
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

module.exports = { recordEvent, readEvents, hashId };
