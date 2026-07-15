/**
 * site-metrics — GET /api/site-metrics?site=slug[&refresh=1]   (auth-gated)
 *
 * Returns Lighthouse health scores (Performance / SEO / Accessibility /
 * Best Practices) plus core web-vitals for a site's live URL, via the Google
 * PageSpeed Insights API. Results are cached per user+site in Blob Storage for
 * CACHE_TTL so the Overview loads instantly; ?refresh=1 forces a re-run.
 *
 * A site with no domain returns { status: 'not_published' } — nothing to score
 * until it's live. Search Console / GA4 tiles are stubbed in the UI and get
 * wired once per-site OAuth is connected.
 *
 * Optional app setting: PAGESPEED_API_KEY (raises the anonymous rate limit).
 */

const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { getSite } = require('../lib/siteRegistry');
const { getCached, putCached } = require('../lib/metricsStore');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

function siteUrl(domain) {
  const d = String(domain || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return d ? `https://${d}` : null;
}

async function runPageSpeed(url) {
  const params = new URLSearchParams({ url, strategy: 'mobile' });
  for (const c of ['performance', 'seo', 'accessibility', 'best-practices']) params.append('category', c);
  if (process.env.PAGESPEED_API_KEY) params.set('key', process.env.PAGESPEED_API_KEY);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55000);
  let res;
  try {
    res = await fetch(`${PSI_ENDPOINT}?${params.toString()}`, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let apiMsg = '';
    try { apiMsg = (JSON.parse(body).error || {}).message || ''; } catch (_) { /* non-JSON */ }
    const err = new Error(`PageSpeed HTTP ${res.status}`);
    if (res.status === 429) {
      err.detail = process.env.PAGESPEED_API_KEY
        ? 'PageSpeed daily quota reached. Try again later.'
        : 'PageSpeed rate limit reached — set a PAGESPEED_API_KEY app setting to raise the limit.';
    } else {
      err.detail = apiMsg ? apiMsg.slice(0, 200) : body.slice(0, 200);
    }
    throw err;
  }

  const data = await res.json();
  const lr = data.lighthouseResult || {};
  const cat = lr.categories || {};
  const pct = (c) => (c && typeof c.score === 'number' ? Math.round(c.score * 100) : null);
  const audit = (k) => (lr.audits && lr.audits[k] ? lr.audits[k].displayValue : null);

  return {
    url,
    strategy: 'mobile',
    scores: {
      performance: pct(cat.performance),
      seo: pct(cat.seo),
      accessibility: pct(cat.accessibility),
      bestPractices: pct(cat['best-practices']),
    },
    metrics: {
      lcp: audit('largest-contentful-paint'),
      cls: audit('cumulative-layout-shift'),
      fcp: audit('first-contentful-paint'),
      tbt: audit('total-blocking-time'),
      speedIndex: audit('speed-index'),
    },
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }

  const slug = (req.query && req.query.site) || (req.body && req.body.site);
  if (!slug) {
    context.res = { status: 400, body: { error: 'A site is required.' } };
    return;
  }

  try {
    const site = await getSite(email, slug);
    if (!site) {
      context.res = { status: 404, body: { error: 'Site not found.' } };
      return;
    }

    const url = siteUrl(site.domain);
    if (!url) {
      context.res = {
        status: 200,
        body: { status: 'not_published', message: 'Add a domain and publish this site to see analytics.' },
      };
      return;
    }

    const refresh = req.query && (req.query.refresh === '1' || req.query.refresh === 'true');
    if (!refresh) {
      const cached = await getCached(email, slug).catch(() => null);
      if (cached && cached.url === url && cached.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS) {
        context.res = { status: 200, body: { status: 'ok', cached: true, ...cached } };
        return;
      }
    }

    const result = await runPageSpeed(url);
    await putCached(email, slug, result).catch((e) => context.log.warn('metrics cache write failed:', e.message));
    context.res = { status: 200, body: { status: 'ok', cached: false, ...result } };
  } catch (err) {
    context.log.error(err);
    context.res = {
      status: 502,
      body: { status: 'error', error: 'Could not fetch analytics right now.', detail: err.detail || err.message },
    };
  }
};
