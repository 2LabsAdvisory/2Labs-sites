/**
 * crawl-site — POST /api/crawl-site  { site, phase, cursor }   (auth-gated)
 *
 * Deep content import. For an imported site, walk the real site and stash its
 * pages in the import corpus (importStore) so the Studio can build a faithful,
 * full-depth mirror instead of a shallow, invented 4–6 page site.
 *
 *  phase 'discover' — BFS from the homepage (+ a few section pages) over
 *                     same-origin links, classify into a nav tree, store the
 *                     tree + a flat page index. Returns { total, tree }.
 *  phase 'fetch'    — fetch the next batch of pages from the index (from
 *                     `cursor`), extract their real content, store each.
 *                     Returns { done, total, cursor, fetched }. Client loops.
 *
 * One page per fetch stays fast; batches are bounded to stay under the gateway
 * timeout. Sitemaps are often blocked, so link-following is the discovery path.
 */
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getSite } = require('../lib/siteRegistry');
const importStore = require('../lib/importStore');

const FETCH_BATCH = 8;         // pages fetched per 'fetch' call
const MAX_PAGES = 80;          // hard cap on crawl size
const DISCOVER_SEED = 6;       // section pages fetched during discovery to widen coverage
const PER_FETCH_MS = 9000;

// --- safe, bounded fetch ----------------------------------------------------
function safeUrl(u, base) {
  try {
    const url = new URL(u, base);
    if (!/^https?:$/.test(url.protocol)) return null;
    const h = url.hostname;
    // Block obvious internal/loopback targets (SSRF hygiene).
    if (/^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|::1)/i.test(h) || /\.(local|internal)$/i.test(h)) return null;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return null;
    url.hash = '';
    return url;
  } catch { return null; }
}

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PER_FETCH_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': '2LabsSites-Import/1.0' } });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(ct)) return null;
    return (await res.text()).slice(0, 600000);
  } catch { return null; } finally { clearTimeout(t); }
}

// A path we care about: same-origin page, not an asset / feed / wp plumbing.
function isContentPath(p) {
  if (!p || p === '/') return true;
  if (/\.(png|jpe?g|svg|gif|webp|ico|css|js|pdf|zip|mp4|woff2?|xml|json|rss)$/i.test(p)) return false;
  if (/(^|\/)(wp-json|wp-admin|wp-content|wp-includes|feed|xmlrpc|comments|tag|author|cart|checkout|my-account)(\/|$|\?)/i.test(p)) return false;
  if (/[?#]/.test(p)) return false;
  return true;
}
const normPath = (p) => { let s = String(p || '/').split('#')[0].split('?')[0]; s = s.replace(/\/+$/,''); return s || '/'; };
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; } })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

// Pull internal links (path -> best anchor text) from a page.
function linksFrom(html, base, origin) {
  const out = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = safeUrl(m[1], base);
    if (!url || url.origin !== origin) continue;
    const path = normPath(url.pathname);
    if (!isContentPath(path)) continue;
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!out.has(path) || (text && !out.get(path))) out.set(path, text);
  }
  return out;
}

const titleCase = (seg) => seg.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
function labelFor(path, text) { return (text && text.length > 1) ? text : (path === '/' ? 'Home' : titleCase(path.split('/').filter(Boolean).pop() || 'Page')); }

// Build a 2-level nav tree grouped by the first path segment.
function buildTree(entries) {
  // entries: [{ path, title }]
  const groups = new Map(); // seg -> { path, title, children: [] }
  const top = [];
  for (const e of entries) {
    if (e.path === '/') continue;
    const segs = e.path.split('/').filter(Boolean);
    const g = segs[0];
    if (segs.length === 1) {
      // a top-level page; it may also head a group
      if (!groups.has(g)) groups.set(g, { path: e.path, title: e.title, children: [] });
      else { groups.get(g).path = e.path; if (e.title) groups.get(g).title = e.title; }
    } else {
      if (!groups.has(g)) groups.set(g, { path: '/' + g, title: titleCase(g), children: [] });
      groups.get(g).children.push({ path: e.path, title: e.title });
    }
  }
  for (const [, node] of groups) top.push(node);
  // Sort children alphabetically-ish by title; keep groups in discovery order.
  top.forEach((n) => n.children.sort((a, b) => a.title.localeCompare(b.title)));
  return top;
}

// --- content extraction -----------------------------------------------------
function extract(html, url) {
  const pick = (re) => (html.match(re) || [])[1] || '';
  const title = decodeEntities(pick(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    || pick(/<title[^>]*>([^<]+)<\/title>/i)).replace(/\s+/g, ' ').trim();
  const description = decodeEntities(pick(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i)
    || pick(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i)).replace(/\s+/g, ' ').trim();
  const headings = [];
  for (const m of html.matchAll(/<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (t && t.length <= 160) headings.push(`${m[1]}: ${t}`);
    if (headings.length >= 40) break;
  }
  // Body text: drop scripts/styles/nav/header/footer, then tags.
  const body = decodeEntities(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 6000);
  const images = [];
  for (const m of html.matchAll(/<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi)) {
    const u = safeUrl(m[1], url);
    if (!u || !/^https?:/.test(u.protocol)) continue;
    if (/sprite|icon|logo|pixel|spacer|blank|1x1|placeholder/i.test(u.pathname)) continue;
    if (!images.includes(u.toString())) images.push(u.toString());
    if (images.length >= 8) break;
  }
  return { title, description, headings, text: body, images };
}

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) { context.res = { status: 401, body: { error: 'Authentication required.' } }; return; }
  const slug = req.body && req.body.site;
  const phase = (req.body && req.body.phase) || 'discover';
  if (!slug) { context.res = { status: 400, body: { error: 'A site is required.' } }; return; }

  try {
    const site = await getSite(email, slug);
    if (!site) { context.res = { status: 404, body: { error: 'Site not found.' } }; return; }
    const startUrl = safeUrl((site.brief && site.brief.source && site.brief.source.url) || site.domain || '', 'https://x');
    if (!startUrl) { context.res = { status: 400, body: { status: 'no_url', error: 'This site has no source URL to crawl.' } }; return; }
    const origin = startUrl.origin;

    if (phase === 'discover') {
      const home = await fetchHtml(startUrl.toString());
      if (!home) { context.res = { status: 502, body: { status: 'unreachable', error: `Couldn't reach ${origin}.` } }; return; }
      const all = new Map([['/', 'Home'], ...linksFrom(home, startUrl.toString(), origin)]);
      // Widen coverage: fetch a few section landing pages and union their links.
      const seeds = [...all.keys()].filter((p) => p !== '/' && p.split('/').filter(Boolean).length === 1).slice(0, DISCOVER_SEED);
      const seedHtml = await Promise.all(seeds.map((p) => fetchHtml(origin + p)));
      seedHtml.forEach((h, i) => { if (h) for (const [p, t] of linksFrom(h, origin + seeds[i], origin)) if (!all.has(p) || !all.get(p)) all.set(p, t); });

      let entries = [...all.entries()].map(([path, text]) => ({ path, url: origin + (path === '/' ? '' : path), title: labelFor(path, text) })).slice(0, MAX_PAGES);
      const tree = buildTree(entries);
      await importStore.putUrlTree(slug, tree);
      await importStore.putIndex(slug, entries);
      context.res = { status: 200, body: { status: 'ok', total: entries.length, tree } };
      return;
    }

    // phase 'fetch'
    const index = await importStore.getIndex(slug);
    if (!index.length) { context.res = { status: 409, body: { status: 'no_index', error: 'Run discovery first.' } }; return; }
    const cursor = Math.max(0, parseInt((req.body && req.body.cursor) || 0, 10) || 0);
    const batch = index.slice(cursor, cursor + FETCH_BATCH);
    const results = await Promise.all(batch.map(async (e) => {
      const html = await fetchHtml(e.url);
      const content = html ? extract(html, e.url) : { title: e.title, description: '', headings: [], text: '', images: [] };
      await importStore.putPage(slug, { path: e.path, url: e.url, title: content.title || e.title, ...content });
      return { path: e.path, ok: !!html };
    }));
    const next = cursor + batch.length;
    context.res = { status: 200, body: { status: 'ok', total: index.length, cursor: next, fetched: results.filter((r) => r.ok).length, done: next >= index.length } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { status: 'error', error: 'Crawl failed.', detail: err.message } };
  }
};
