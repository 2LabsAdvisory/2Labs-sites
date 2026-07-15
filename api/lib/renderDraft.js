'use strict';

/**
 * Renders an edited .astro page to HTML in-process (live editor preview, no
 * git commit / SWA rebuild).
 *
 * Multi-file overlay: the page AND any other edited files (e.g. Header.astro
 * for navigation, a new component, a stylesheet) are served as Vite virtual
 * modules at their real paths, so a nav/layout edit shows in the preview —
 * not just the primary page. Files that aren't overlaid resolve from disk.
 *
 * Azure-safe: never writes to disk (deployed FS is read-only); node_modules
 * resolves via the bundled project location (siteRoot()). A fresh Vite server
 * per render keeps overlays correct with no stale module cache — the Claude
 * call dominates edit latency, so the ~few-hundred-ms boot is negligible.
 */

const path = require('node:path');
const { siteRoot } = require('./siteConfig');

const PROJECT_ROOT = siteRoot();

const stripQuery = (id) => {
  const i = id.indexOf('?');
  return i === -1 ? id : id.slice(0, i);
};

/**
 * @param {string} primaryRelPath e.g. 'src/pages/services.astro' (page to render)
 * @param {string} primaryContent the primary page's edited source
 * @param {Object<string,string>} overlayFiles other edited files (repoRelPath -> content),
 *        e.g. { 'src/components/Header.astro': '<updated nav>' }
 * @returns {Promise<string>} rendered HTML
 */
async function renderDraft(primaryRelPath, primaryContent, overlayFiles = {}) {
  const { experimental_AstroContainer: AstroContainer } = await import('astro/container');
  const { getViteConfig } = await import('astro/config');
  const { createServer } = await import('vite');

  // Overlay: absolute file path -> content. Primary overrides any same-path entry.
  const overlay = new Map();
  for (const [rel, content] of Object.entries(overlayFiles || {})) {
    overlay.set(path.join(PROJECT_ROOT, rel), content);
  }
  overlay.set(path.join(PROJECT_ROOT, primaryRelPath), primaryContent);

  const overlayPlugin = {
    name: '2labs:overlay',
    enforce: 'pre',
    resolveId(source, importer) {
      if (overlay.has(stripQuery(source))) return source;
      if (importer && (source.startsWith('./') || source.startsWith('../'))) {
        const abs = path.resolve(path.dirname(stripQuery(importer)), stripQuery(source));
        if (overlay.has(abs)) return abs + (source.includes('?') ? source.slice(source.indexOf('?')) : '');
      }
      return null;
    },
    load(id) {
      const abs = stripQuery(id);
      // Only serve the bare module; Astro derives ?astro&type=style/script from it.
      return id === abs && overlay.has(abs) ? overlay.get(abs) : null;
    },
  };

  const cfgFn = await getViteConfig({
    root: PROJECT_ROOT,
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'silent',
    plugins: [overlayPlugin],
  });
  const server = await createServer(await cfgFn({ command: 'serve', mode: 'development' }));

  try {
    const primaryAbs = path.join(PROJECT_ROOT, primaryRelPath);
    const mod = await server.ssrLoadModule(primaryAbs);
    const container = await AstroContainer.create();
    let html = await container.renderToString(mod.default);

    // The Container render omits imported CSS + scoped component styles.
    // Collect them from Vite's module graph (like Astro's dev server) so the
    // preview matches the built site.
    const css = await collectCss(server, primaryAbs);
    if (css) {
      const styleTag = `<style data-2labs-preview>\n${css}</style>`;
      html = html.includes('</head>') ? html.replace('</head>', `${styleTag}</head>`) : styleTag + html;
    }

    // The Container omits the <!DOCTYPE> prolog Astro normally adds; restore it.
    return /^\s*<html[\s>]/i.test(html) ? `<!DOCTYPE html>\n${html}` : html;
  } finally {
    await server.close();
  }
}

/** Collect CSS the Container render omits by walking the module graph. */
async function collectCss(server, entryId) {
  const entry = server.moduleGraph.getModuleById(entryId);
  if (!entry) return '';
  const seen = new Set();
  const cssIds = [];
  (function walk(m) {
    if (!m || seen.has(m.id)) return;
    seen.add(m.id);
    if (m.id && (m.id.endsWith('.css') || m.id.includes('lang.css') || m.id.includes('type=style'))) cssIds.push(m.id);
    for (const imp of m.importedModules) walk(imp);
  })(entry);

  let css = '';
  for (const cid of cssIds) {
    try {
      const direct = cid + (cid.includes('?') ? '&' : '?') + 'direct';
      const res = await server.transformRequest(direct, { ssr: false });
      if (res && res.code) css += res.code + '\n';
    } catch {
      /* skip a module that won't transform */
    }
  }
  return css;
}

/** No-op now that each render uses its own server (kept for test compatibility). */
async function closeRenderer() {}

module.exports = { renderDraft, closeRenderer, PROJECT_ROOT };
