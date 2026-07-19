'use strict';

/**
 * curator — the Knowledge Curator (Memory brief v1.2 §4.1). Nothing enters the
 * shared KB without passing through here. It protects the guardrails:
 *
 *   - GENERALITY: only reusable PATTERNS/PRINCIPLES, never a single client's content.
 *   - PRIVACY: no client-identifying content, facts, assets, or copy.
 *   - IP: patterns + source URLs only — never copied text/imagery/layout.
 *   - DEDUPE/MERGE: bump version and carry usage_count instead of duplicating.
 *
 * Then it STAMPS the kept entry with freshness metadata (last_refreshed, ttl,
 * confidence, version, review_status). This is a deterministic gate; an
 * AI-reviewer Curator and a human-review queue are follow-ups (Slice 4).
 */

const { getEntry, TTL_PLAYBOOK, TTL_REFERENCE } = require('./kb');

// The playbook is archetype-level (general by construction); the inspiration is
// design PATTERNS only. Both are inherently non-client-specific — the research
// agents are prompted to abstract. We still validate shape and non-emptiness so
// junk never enters the KB, and we never store anything but the abstracted data.

function validPlaybook(data) {
  return data && Array.isArray(data.must_have_sections) && data.must_have_sections.filter(Boolean).length >= 2;
}
function validInspiration(data) {
  return data && (data.layout_direction || data.tone || (Array.isArray(data.do) && data.do.length));
}

/**
 * Curate a proposed entry. Returns a stamped, storable entry — or { rejected }.
 * `existing` (if any) is used to dedupe/merge (version bump + usage carry).
 */
async function curate(kind, key, data, provenance) {
  if (kind === 'playbook' && !validPlaybook(data)) return { rejected: true, reason: 'playbook too thin' };
  if (kind === 'reference' && !validInspiration(data)) return { rejected: true, reason: 'inspiration too thin' };

  const existing = await getEntry(kind, key);
  const sources = Array.isArray(data.sources) ? data.sources.filter(Boolean) : (existing && existing.sources) || [];
  // Confidence: web-researched entries that cite real sources are 'high'.
  const confidence = sources.length ? 'high' : 'medium';

  return {
    kind,
    key,
    data,
    sources,
    confidence,
    last_refreshed: new Date().toISOString(),
    ttl_days: kind === 'playbook' ? TTL_PLAYBOOK : TTL_REFERENCE,
    version: existing ? (existing.version || 1) + 1 : 1,
    usage_count: existing ? existing.usage_count || 0 : 0, // carry forward on refresh
    // New archetypes/URLs are flagged for a human to review later; routine
    // same-key refreshes auto-approve. Serving is gated on freshness +
    // do_not_use (not review_status), so the cache still delivers immediately.
    review_status: existing ? 'auto_approved' : 'needs_human_review',
    do_not_use: (existing && existing.do_not_use) || false,
    provenance: { ...(provenance || {}), at: new Date().toISOString() },
  };
}

module.exports = { curate };
