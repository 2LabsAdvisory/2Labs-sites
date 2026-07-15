'use strict';

/**
 * Renders an edited .astro source string to HTML in-process (live editor
 * preview, no git commit / SWA rebuild).
 *
 * Azure-safe design:
 *   - One warm Vite SSR server (Astro's pipeline), rooted at siteRoot() —
 *     the bundled api/_site copy in a deployed Function, or the repo root
 *     locally (see lib/siteConfig.js + scripts/bundle-site.js).
 *   - The draft is served as a Vite VIRTUAL MODULE positioned at the target
 *     file's real path, so its relative imports (BaseLayout, site-config, …)
 *     resolve — WITHOUT writing to disk. This matters because a deployed
 *     Function's filesystem is typically read-only (run-from-package), and
 *     node_modules still resolves via the read-only project location.
 *   - experimental_AstroContainer.renderToString() produces the HTML.
 *
 * Requires `astro`/`vite` in the Function's node_modules (see api/package.json)
 * and the project src/ tree present (bundled). Proven locally by
 * api/tests/container-render.test.js.
 */

const path = require('node:path');
const crypto = require('node:crypto');
const { siteRoot } = require('./siteConfig');

const PROJECT_ROOT = siteRoot();

// Draft id -> source. The Vite plugin serves these instead of reading disk.
const drafts = new Map();
let serverPromise = null;

async function getServer() {
  if (!serverPromise) {
    serverPromise = (async () => {
      const { getViteConfig } = await import('astro/config');
      const { createServer } = await import('vite');

      const draftLoader = {
        name: '2labs:draft-loader',
        enforce: 'pre',
        resolveId(id) {
          return drafts.has(id) ? id : null;
        },
        load(id) {
          return drafts.has(id) ? drafts.get(id) : null;
        },
      };

      const cfgFn = await getViteConfig({
        root: PROJECT_ROOT,
        server: { middlewareMode: true, hmr: false },
        appType: 'custom',
        logLevel: 'silent',
        plugins: [draftLoader],
      });
      const cfg = await cfgFn({ command: 'serve', mode: 'development' });
      return createServer(cfg);
    })();
  }
  return serverPromise;
}

/**
 * Render edited content for a repo-relative .astro path to HTML.
 * @param {string} repoRelPath e.g. 'src/pages/index.astro'
 * @param {string} content     the edited .astro source
 * @returns {Promise<string>}  rendered HTML
 */
async function renderDraft(repoRelPath, content) {
  const { experimental_AstroContainer: AstroContainer } = await import('astro/container');
  const server = await getServer();

  // A virtual .astro id living in the target file's real directory, so the
  // draft's relative imports resolve against the project. Never touches disk.
  const hash = crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
  const id = path.join(PROJECT_ROOT, path.dirname(repoRelPath), `__draft_${hash}__.astro`);
  drafts.set(id, content);

  try {
    const mod = await server.ssrLoadModule(id);
    const container = await AstroContainer.create();
    const html = await container.renderToString(mod.default);
    // The Container omits the <!DOCTYPE> prolog Astro normally adds; restore it.
    return /^\s*<html[\s>]/i.test(html) ? `<!DOCTYPE html>\n${html}` : html;
  } finally {
    drafts.delete(id);
    try {
      const m = server.moduleGraph.getModuleById(id);
      if (m) server.moduleGraph.invalidateModule(m);
    } catch {
      /* best-effort cache invalidation */
    }
  }
}

/** Close the warm server (used by tests so the process can exit). */
async function closeRenderer() {
  if (serverPromise) {
    const server = await serverPromise;
    await server.close();
    serverPromise = null;
  }
}

module.exports = { renderDraft, closeRenderer, PROJECT_ROOT };
