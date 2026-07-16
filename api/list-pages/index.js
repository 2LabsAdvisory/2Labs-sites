/**
 * list-pages — GET /api/list-pages   (auth-gated)
 * Returns the client site's pages (disk + any draft-only pages) as
 * { route, file, label }, Home first, for the editor's page selector.
 */
const fs = require('node:fs');
const path = require('node:path');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { listDraftFiles, getDraftFile, isDeleted } = require('../lib/draftStore');
const { siteRoot, brand } = require('../lib/siteConfig');

const CLIENT_ID = brand.clientId;
// Builder-app pages never belong to a client site, but guard anyway.
const NON_PAGES = new Set(['src/pages/editor.astro', 'src/pages/dashboard.astro', 'src/pages/login.astro']);

function fileToRoute(file) {
  let p = file.replace(/^src\/pages\//, '').replace(/\.astro$/, '');
  if (p === 'index') return '/';
  if (p.endsWith('/index')) p = p.slice(0, -'/index'.length);
  return '/' + p;
}
function labelFor(route) {
  if (route === '/') return 'Home';
  const seg = route.replace(/\/+$/, '').split('/').pop();
  return seg.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }
  try {
    const set = new Set();
    const dir = path.join(siteRoot(), 'src/pages');
    if (fs.existsSync(dir)) {
      const walk = (d, rel) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const r = rel ? `${rel}/${f.name}` : f.name;
          if (f.isDirectory()) walk(path.join(d, f.name), r);
          else if (f.name.endsWith('.astro')) set.add(`src/pages/${r}`);
        }
      };
      walk(dir, '');
    }
    const deleted = new Set();
    for (const p of await listDraftFiles(CLIENT_ID)) {
      if (!p.startsWith('src/pages/') || !p.endsWith('.astro')) continue;
      if (isDeleted(await getDraftFile(CLIENT_ID, p))) deleted.add(p);
      else set.add(p);
    }

    const pages = [...set]
      .filter((f) => !NON_PAGES.has(f) && !deleted.has(f))
      .map((file) => { const route = fileToRoute(file); return { route, file, label: labelFor(route) }; })
      .sort((a, b) => (a.route === '/' ? -1 : b.route === '/' ? 1 : a.label.localeCompare(b.label)));

    context.res = { status: 200, body: { status: 'ok', pages } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: 'Could not list pages.', detail: err.message } };
  }
};
