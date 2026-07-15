'use strict';

/**
 * usageStore — per-user AI usage ledger in Blob Storage.
 *
 * A "credit" shown to the site owner is 1 AI edit. Underneath we also keep the
 * real token counts and an estimated USD cost per month so 2Labs can reconcile
 * actual API spend and tune the credit price later. One JSON blob per user:
 *   <emailKey>/usage.json = { updatedAt, periods: { "YYYY-MM": {...} } }
 *
 * Monthly rollup shape (per period):
 *   { edits, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, estCostUsd }
 *
 * Enforcement is deliberately NOT done here — callers read getUsage() to show a
 * meter and warnings; a hard cap can be turned on later against MONTHLY_EDIT_CREDITS.
 */

const { BlobServiceClient } = require('@azure/storage-blob');

// Sonnet 5 pricing, per 1M tokens. Intro rate applies through 2026-08-31.
const PRICING = {
  intro: { input: 2.0, output: 10.0, until: Date.parse('2026-09-01T00:00:00Z') },
  standard: { input: 3.0, output: 15.0 },
};
const CACHE_WRITE_MULT = 1.25; // cache creation costs ~1.25x input
const CACHE_READ_MULT = 0.1; //   cache read costs ~0.1x input

const DEFAULT_MONTHLY_CREDITS = 100;
function monthlyCredits() {
  const n = parseInt(process.env.MONTHLY_EDIT_CREDITS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MONTHLY_CREDITS;
}

function rates(at = Date.now()) {
  return at < PRICING.intro.until ? PRICING.intro : PRICING.standard;
}

/** Estimated USD cost for one Anthropic `usage` object. */
function estCost(usage, at = Date.now()) {
  const r = rates(at);
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  return (
    (input * r.input +
      cacheWrite * r.input * CACHE_WRITE_MULT +
      cacheRead * r.input * CACHE_READ_MULT +
      output * r.output) /
    1_000_000
  );
}

function connectionString() {
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured.');
  return cs;
}
function containerName() {
  return process.env.USAGE_CONTAINER || 'usage';
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
const blobName = (email) => `${emailKey(email)}/usage.json`;
const currentPeriod = (at = new Date()) =>
  `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;

// First day of the next month, UTC — when the monthly allowance resets.
function resetsOn(period) {
  const [y, m] = period.split('-').map(Number);
  const next = m === 12 ? new Date(Date.UTC(y + 1, 0, 1)) : new Date(Date.UTC(y, m, 1));
  return next.toISOString();
}

function emptyPeriod() {
  return { edits: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, estCostUsd: 0 };
}

async function readAll(email) {
  const c = await container();
  const blob = c.getBlockBlobClient(blobName(email));
  try {
    return JSON.parse((await blob.downloadToBuffer()).toString('utf-8'));
  } catch (err) {
    if (err.statusCode === 404) return { periods: {} };
    throw err;
  }
}

async function writeAll(email, data) {
  const c = await container();
  const blob = c.getBlockBlobClient(blobName(email));
  data.updatedAt = new Date().toISOString();
  const buf = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
  await blob.upload(buf, buf.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
}

/** Record one AI edit for this user, folding its token usage into the month. */
async function recordEdit(email, usage) {
  const data = await readAll(email);
  const period = currentPeriod();
  const p = data.periods[period] || emptyPeriod();
  p.edits += 1;
  p.inputTokens += usage.input_tokens || 0;
  p.outputTokens += usage.output_tokens || 0;
  p.cacheReadTokens += usage.cache_read_input_tokens || 0;
  p.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
  p.estCostUsd = Math.round((p.estCostUsd + estCost(usage)) * 1e6) / 1e6;
  data.periods[period] = p;
  await writeAll(email, data);
  return { period, ...p };
}

/** Current-month usage + limit for the meter. */
async function getUsage(email) {
  const data = await readAll(email);
  const period = currentPeriod();
  const p = data.periods[period] || emptyPeriod();
  const limit = monthlyCredits();
  return {
    period,
    used: p.edits,
    limit,
    remaining: Math.max(0, limit - p.edits),
    resetsOn: resetsOn(period),
    tokens: {
      input: p.inputTokens,
      output: p.outputTokens,
      cacheRead: p.cacheReadTokens,
      cacheCreation: p.cacheCreationTokens,
    },
    estCostUsd: Math.round(p.estCostUsd * 100) / 100,
  };
}

module.exports = { recordEdit, getUsage, estCost, monthlyCredits };
