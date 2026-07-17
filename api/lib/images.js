'use strict';

/**
 * Topical stock imagery for the Studio's page generation.
 *
 * Two sources, tried in order so real photos ALWAYS appear (never geometric-only):
 *   1. Unsplash  — used when UNSPLASH_ACCESS_KEY is set (best-curated results).
 *   2. Openverse — keyless, no auth required; topical Creative-Commons photos
 *      served from Openverse's own CDN thumbnail proxy (reliable to hotlink).
 *
 * Both return { url, alt, credit }. If everything fails we return [] and the
 * page agent falls back to gradient/SVG art (never a broken <img>).
 */

const UNSPLASH_ENDPOINT = 'https://api.unsplash.com/search/photos';
const OPENVERSE_ENDPOINT = 'https://api.openverse.org/v1/images/';

function clampCount(count) {
  return Math.max(1, Math.min(Number(count) || 4, 8));
}

async function fetchJson(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fromUnsplash(query, count) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return [];
  const params = new URLSearchParams({
    query,
    per_page: String(clampCount(count)),
    orientation: 'landscape',
    content_filter: 'high',
  });
  const data = await fetchJson(`${UNSPLASH_ENDPOINT}?${params}`, {
    headers: { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' },
  }, 6000);
  if (!data) return [];
  return (data.results || [])
    .map((p) => ({
      url: p.urls && p.urls.regular,
      alt: (p.alt_description || p.description || query).slice(0, 140),
      credit: p.user && p.user.name,
    }))
    .filter((x) => x.url);
}

async function fromOpenverse(query, count) {
  const params = new URLSearchParams({
    q: query,
    page_size: String(clampCount(count)),
    mature: 'false',
    // Prefer licenses with no attribution burden for a clean generated site.
    license: 'pdm,cc0',
    aspect_ratio: 'wide',
  });
  let data = await fetchJson(`${OPENVERSE_ENDPOINT}?${params}`, {
    headers: { Accept: 'application/json', 'User-Agent': '2LabsSites-Studio/1.0' },
  }, 7000);
  // If the strict license filter starved results, retry without it.
  if (!data || !(data.results || []).length) {
    const relaxed = new URLSearchParams({ q: query, page_size: String(clampCount(count)), mature: 'false', aspect_ratio: 'wide' });
    data = await fetchJson(`${OPENVERSE_ENDPOINT}?${relaxed}`, {
      headers: { Accept: 'application/json', 'User-Agent': '2LabsSites-Studio/1.0' },
    }, 7000);
  }
  if (!data) return [];
  return (data.results || [])
    .map((p) => ({
      // The proxied thumbnail is CDN-backed and reliably hotlinkable, unlike the
      // original source URL which may 404 or block hotlinking.
      url: p.thumbnail || p.url,
      alt: (p.title || query).slice(0, 140),
      credit: p.creator || (p.source || 'Openverse'),
    }))
    .filter((x) => x.url);
}

async function fetchStockImages(query, count = 4) {
  const q = String(query || '').trim();
  if (!q) return [];
  const unsplash = await fromUnsplash(q, count);
  if (unsplash.length) return unsplash;
  return fromOpenverse(q, count);
}

module.exports = { fetchStockImages, fromUnsplash, fromOpenverse };
