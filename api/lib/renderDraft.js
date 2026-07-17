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
const { siteRoot, DEFAULT_SITE } = require('./siteConfig');

const PROJECT_ROOT = siteRoot(); // default site root — kept for tests/back-compat

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
async function renderDraft(primaryRelPath, primaryContent, overlayFiles = {}, siteId = DEFAULT_SITE) {
  const { experimental_AstroContainer: AstroContainer } = await import('astro/container');
  const { getViteConfig } = await import('astro/config');
  const { createServer } = await import('vite');

  const projectRoot = siteRoot(siteId); // render against THIS site's project

  // Overlay: absolute file path -> content. Primary overrides any same-path entry.
  const overlay = new Map();
  for (const [rel, content] of Object.entries(overlayFiles || {})) {
    overlay.set(path.join(projectRoot, rel), content);
  }
  overlay.set(path.join(projectRoot, primaryRelPath), primaryContent);

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
    root: projectRoot,
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'silent',
    plugins: [overlayPlugin],
  });
  const server = await createServer(await cfgFn({ command: 'serve', mode: 'development' }));

  try {
    const primaryAbs = path.join(projectRoot, primaryRelPath);
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

    // The Container emits hoisted component <script>s as
    // <script src="…/x.astro?astro&type=script…"> — a dev path that 404s in the
    // srcdoc preview iframe, so interactivity (accordions, menus, toggles) is
    // dead. Transform each to browser JS and inline it, matching the built site.
    html = await inlineHoistedScripts(server, html);

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

/**
 * Replace hoisted-script references (`<script src="…?astro&type=script…">`)
 * with the transformed browser JS inlined, so component `<script>` behavior
 * runs in the srcdoc preview. Plain DOM scripts inline cleanly; a script that
 * imports npm deps resolves to a dev path that won't load in the iframe — an
 * accepted limitation (the built site still bundles it correctly).
 */
async function inlineHoistedScripts(server, html) {
  const tagRe = /<script\b[^>]*\bsrc="([^"]*type=script[^"]*)"[^>]*><\/script>/gi;
  const raws = new Set();
  let m;
  while ((m = tagRe.exec(html))) raws.add(m[1]);
  if (raws.size === 0) return html;

  const codeByRaw = new Map();
  for (const raw of raws) {
    const id = raw.replace(/&amp;/g, '&'); // HTML-decode the attribute for Vite
    try {
      const res = await server.transformRequest(id, { ssr: false });
      if (res && res.code) codeByRaw.set(raw, res.code);
    } catch {
      /* leave the original tag if the module won't transform */
    }
  }
  return html.replace(tagRe, (tag, raw) => {
    const code = codeByRaw.get(raw);
    return code ? `<script type="module">\n${code}\n</script>` : tag;
  });
}

/** No-op now that each render uses its own server (kept for test compatibility). */
async function closeRenderer() {}

module.exports = { renderDraft, closeRenderer, PROJECT_ROOT };
