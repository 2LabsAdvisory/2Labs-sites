'use strict';

/**
 * WCAG 2.2 contrast math. The brand quality bar (Build Brief §3.4.1) requires
 * REAL computed contrast ratios, not a static "AA" label — so we verify the
 * model's palette server-side rather than trusting it.
 */

function toRgb(hex) {
  const h = String(hex || '').trim().replace(/^#/, '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function relativeLuminance(hex) {
  const rgb = toRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two hex colors (1–21), or null if either is invalid. */
function ratio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la == null || lb == null) return null;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** Does this pairing pass WCAG AA? (4.5:1 normal text, 3:1 large text / UI.) */
function passesAA(a, b, { large = false } = {}) {
  const r = ratio(a, b);
  return r != null && r >= (large ? 3 : 4.5);
}

/** Pick black or white text for best contrast on a background. */
function bestTextOn(bgHex) {
  return (ratio('#FFFFFF', bgHex) || 0) >= (ratio('#1F242E', bgHex) || 0) ? '#FFFFFF' : '#1F242E';
}

module.exports = { toRgb, relativeLuminance, ratio, passesAA, bestTextOn };
