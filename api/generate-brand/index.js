/**
 * generate-brand — POST /api/generate-brand  (auth-gated)
 *   { mode: 'import'|'blank', url?, org?, mission?, offers?[], goal? }
 *
 * The front of the Studio (Build Brief §3.1): the Brand Extraction agent
 * (import path) scans the URL for real brand signals, then the Senior Brand
 * Designer agent (§3.4.1) produces a complete, production-ready brand system.
 * We compute WCAG 2.2 AA contrast ratios server-side — the quality bar is a
 * real check, not a static label.
 *
 * Returns { status:'ok', brand, rationale, a11y } shaped for the wizard's
 * Step 2 (core/accents/semantic/neutral swatches).
 */

const { Anthropic } = require('@anthropic-ai/sdk');
const { getBearerToken, validateSessionEmail, isEmailAllowed } = require('../shared/auth');
const { ratio, passesAA, bestTextOn } = require('../lib/contrast');

const BRAND_TOOL = {
  name: 'submit_brand',
  description: 'Return the complete brand system.',
  input_schema: {
    type: 'object',
    properties: {
      rationale: { type: 'string', description: 'One or two sentences a non-designer understands, explaining the palette.' },
      colors: {
        type: 'object',
        properties: {
          core: { type: 'array', items: swatch(), description: '2–3 core colors: primary, secondary, surface.' },
          accents: { type: 'array', items: swatch(), description: '1–3 accent/highlight colors that complete the brand.' },
          semantic: { type: 'array', items: swatch(), description: 'success, warning, error, info.' },
          neutral: { type: 'array', items: swatch(), description: '5–7 ink→paper neutrals.' },
        },
        required: ['core', 'accents', 'semantic', 'neutral'],
      },
      typography: {
        type: 'object',
        properties: { heading: { type: 'string' }, body: { type: 'string' } },
        required: ['heading', 'body'],
      },
      voice: { type: 'array', items: { type: 'string' }, description: '3–5 tone adjectives.' },
      content: {
        type: 'object',
        description: 'On IMPORT, extract the org identity from the scanned page (verbatim facts; do not invent). Omit/empty on blank mode.',
        properties: {
          org_name: { type: 'string', description: "The organization's name." },
          mission: { type: 'string', description: 'A one-to-two sentence mission/summary of what they do and who for.' },
          offers: { type: 'array', items: { type: 'string' }, description: 'Their main programs/services/offerings (short labels).' },
        },
      },
    },
    required: ['rationale', 'colors', 'typography', 'voice'],
  },
};
function swatch() {
  return { type: 'object', properties: { name: { type: 'string' }, hex: { type: 'string', description: '#RRGGBB' } }, required: ['name', 'hex'] };
}

function systemPrompt() {
  return [
    'You are a senior brand designer with 15+ years building identity systems for mission-driven organizations. You turn a partial or extracted brand into a complete, production-ready design system that looks considered and premium.',
    '',
    'Produce a COMPLETE color system: CORE (2–3; on import preserve the real primary/secondary unless they fail contrast), AI ACCENTS (1–3 harmonious additions the brand is missing), SEMANTIC (success/warning/error/info, on-brand but unmistakable), and NEUTRALS (5–7 ink→paper ramp tuned to the core temperature). Also a heading/body type pairing and 3–5 voice adjectives.',
    '',
    'HARD STANDARD — ACCESSIBILITY (non-negotiable): every foreground/background pairing the site will use must pass WCAG 2.2 AA (4.5:1 normal text, 3:1 large text/UI). Choose colors that pass; do not ship a failing pairing.',
    '',
    'On IMPORT, also extract the organization name, a concise mission/summary, and their main offerings from the scanned page — as `content` — preserving real facts exactly (never invent). On blank mode, leave `content` empty.',
    '',
    'Every hex must be #RRGGBB. Name things clearly — this is shown to the client and saved to their Brand Guidelines. Return via the submit_brand tool only.',
  ].join('\n');
}

// --- URL scan (Brand Extraction agent input) --------------------------------
function isSafeUrl(u) {
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u);
    if (!/^https?:$/.test(url.protocol)) return null;
    const h = url.hostname;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[::1\])/i.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return null;
    return url.toString();
  } catch { return null; }
}

async function scanSite(rawUrl) {
  const url = isSafeUrl(rawUrl);
  if (!url) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  let html = '';
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': '2LabsSites-BrandScan/1.0' } });
    if (!res.ok) return null;
    html = (await res.text()).slice(0, 400000);
  } catch { return null; } finally { clearTimeout(t); }

  const hexes = {};
  for (const m of html.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
    const hex = ('#' + m[1]).toUpperCase();
    hexes[hex] = (hexes[hex] || 0) + 1;
  }
  const colors = Object.entries(hexes).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([hex]) => hex);
  const fonts = [...new Set([...html.matchAll(/font-family:\s*([^;"'}]+)/gi)].map((m) => m[1].split(',')[0].replace(/['"]/g, '').trim()))].filter(Boolean).slice(0, 6);
  const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
  return { url, colors, fonts, title, text };
}

// --- Server-side WCAG verification ------------------------------------------
function verifyContrast(brand) {
  const core = brand.colors.core || [];
  const neutral = brand.colors.neutral || [];
  const ink = (neutral[0] || {}).hex || '#1F242E';
  const paper = (neutral[neutral.length - 1] || {}).hex || '#FFFFFF';
  const primary = (core[0] || {}).hex || '#1F242E';
  const checks = [
    { pair: 'Body text on page', fg: ink, bg: paper, large: false },
    { pair: 'Primary button label', fg: bestTextOn(primary), bg: primary, large: false },
  ];
  const report = checks.map((c) => ({ ...c, ratio: ratio(c.fg, c.bg), passes: passesAA(c.fg, c.bg, { large: c.large }) }));
  return { standard: 'WCAG 2.2 AA', passed: report.every((r) => r.passes), report };
}

module.exports = async function (context, req) {
  const email = await validateSessionEmail(getBearerToken(req));
  if (!email || !isEmailAllowed(email)) {
    context.res = { status: 401, body: { error: 'Authentication required.' } };
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    context.res = { status: 500, body: { error: 'Server is not configured.' } };
    return;
  }

  const b = req.body || {};
  const mode = b.mode === 'blank' ? 'blank' : b.mode === 'describe' ? 'describe' : 'import';
  try {
    let scan = null;
    if (mode === 'import' && b.url) scan = await scanSite(b.url);

    const lines = [`Mode: ${mode}.`, ''];
    if (scan) {
      lines.push(`Scanned ${scan.url}.`, `Page title: ${scan.title}`, `Colors observed (most frequent first): ${scan.colors.join(', ') || '(none found)'}`, `Fonts observed: ${scan.fonts.join(', ') || '(none found)'}`, `Page text (excerpt): ${scan.text}`, '', 'Preserve the real primary/secondary colors and fonts where they pass contrast; complete the system.');
    } else {
      lines.push(`Organization: ${b.org || '(unnamed)'}`, `Mission: ${b.mission || '(not given)'}`, `Offers: ${(Array.isArray(b.offers) ? b.offers : []).join(', ') || '(not given)'}`, `Primary goal: ${b.goal || '(not given)'}`);
      if (mode === 'describe') {
        if (b.archetype) lines.push(`Site type: ${b.archetype}`);
        if (b.description) lines.push(`What the user described: ${String(b.description).slice(0, 1200)}`);
        if (b.style_notes) lines.push(`Style notes from the user (honor these): ${b.style_notes}`);
        const insp = b.inspiration || {};
        const dir = [insp.palette_direction, insp.tone, insp.layout_direction].filter(Boolean).join(' · ');
        if (dir) lines.push(`IP-safe inspiration direction (mood/patterns only — never copy any specific brand): ${dir}`);
      }
      lines.push('', 'No existing site — design a fitting, trustworthy starter system for this organization and sector.');
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4000,
      thinking: { type: 'disabled' },
      system: systemPrompt(),
      tools: [BRAND_TOOL],
      tool_choice: { type: 'tool', name: 'submit_brand' },
      messages: [{ role: 'user', content: lines.join('\n') }],
    });

    const tool = (response.content || []).find((c) => c.type === 'tool_use' && c.name === 'submit_brand');
    if (!tool || !tool.input || !tool.input.colors) throw new Error('The brand designer returned no system.');
    const brand = tool.input;
    const a11y = verifyContrast(brand);

    context.res = {
      status: 200,
      body: { status: 'ok', mode, scanned: !!scan, brand, rationale: brand.rationale || '', a11y, content: brand.content || null },
    };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { status: 'error', error: 'Could not generate the brand.', detail: err.message } };
  }
};
