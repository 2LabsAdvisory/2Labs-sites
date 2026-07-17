'use strict';

/**
 * Topical stock imagery for the Studio's page generation. Uses the Unsplash API
 * when UNSPLASH_ACCESS_KEY is set (free demo key: 50 req/hr) — returning
 * hotlinkable images.unsplash.com URLs the generated pages embed. With no key it
 * returns [] and the page agent falls back to gradient/SVG art (never broken images).
 */

const ENDPOINT = 'https://api.unsplash.com/search/photos';

async function fetchStockImages(query, count = 4) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  const q = String(query || '').trim();
  if (!key || !q) return [];
  const params = new URLSearchParams({
    query: q,
    per_page: String(Math.max(1, Math.min(count, 8))),
    orientation: 'landscape',
    content_filter: 'high',
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
      headers: { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || [])
      .map((p) => ({
        url: p.urls && p.urls.regular,
        alt: (p.alt_description || p.description || q).slice(0, 140),
        credit: p.user && p.user.name,
      }))
      .filter((x) => x.url);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchStockImages };
