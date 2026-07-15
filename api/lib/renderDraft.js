'use strict';

/**
 * Renders an edited .astro source string to HTML in-process, so the editor
 * can show a live preview without a git commit + SWA rebuild.
 *
 * Approach (proven ~4-100ms/render after a one-time ~600ms Vite boot):
 *   1. Keep a single warm Vite SSR server (Astro's own pipeline).
 *   2. Write the edited source to a content-hash-busted temp file NEXT TO the
 *      real path, so its relative imports (BaseLayout, site-config, …) resolve.
 *   3. ssrLoadModule() the temp file → the compiled Astro component.
 *   4. experimental_AstroContainer.renderToString() → full HTML.
 *
 * Requires `astro` (and its `vite`) to be available to the Function's Node
 * process AND the Astro project's src/ tree to be present on disk (so imports
 * resolve). See api/package.json + the deploy note — this is the piece to
 * validate in Azure's co-located Functions runtime.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Astro project root (repo root) — two levels up from api/lib.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

let serverPromise = null;

/** Lazily create + cache one warm Vite SSR server for the process. */
async function getServer() {
  if (!serverPromise) {
    serverPromise = (async () => {
      const { getViteConfig } = await import('astro/config');
      const { createServer } = await import('vite');
      const cfgFn = await getViteConfig({
        root: PROJECT_ROOT,
        server: { middlewareMode: true, hmr: false },
        appType: 'custom',
        logLevel: 'silent',
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

  const realDir = path.dirname(path.join(PROJECT_ROOT, repoRelPath));
  const hash = crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
  const tempPath = path.join(realDir, `.draft-${hash}.astro`);
  fs.writeFileSync(tempPath, content);

  try {
    const modUrl = '/' + path.relative(PROJECT_ROOT, tempPath).split(path.sep).join('/');
    const mod = await server.ssrLoadModule(modUrl);
    const container = await AstroContainer.create();
    const html = await container.renderToString(mod.default);
    // The Container renders <html>…</html> but omits the <!DOCTYPE> prolog
    // (Astro normally adds it in its page pipeline). Restore it for full docs
    // so the preview is a complete, standalone HTML document.
    return /^\s*<html[\s>]/i.test(html) ? `<!DOCTYPE html>\n${html}` : html;
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* best-effort cleanup */
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
