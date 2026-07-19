'use strict';

/**
 * The shared expert quality bar. Both new-site generation and edits are held to
 * this standard, so an UPDATE to a site is reviewed as rigorously as its
 * CREATION — the same experts, the same checklist.
 */

const TOKENS = [
  'DESIGN TOKENS (already defined in src/styles/tokens.css — use ONLY these; never invent CSS variables or hardcode off-brand colours):',
  '  Surfaces/text: --bg, --surface, --surface-2, --ink, --ink-soft, --ink-contrast (light text ON --ink), --border',
  '  Brand: --primary, --primary-dark, --primary-soft, --primary-contrast, --secondary, --secondary-contrast, --accent, --accent-contrast, --success',
  '  Shape/type: --radius, --shadow, --font-heading, --font-body; type scale --fs-h1..--fs-small; spacing --space-1..--space-6',
  '  Colour-band helper classes set background + a guaranteed-contrasting text colour together: band-primary, band-secondary, band-accent, band-dark, band-soft, band-surface.',
].join('\n');

const READABILITY = [
  'READABILITY & CONTRAST (non-negotiable — the #1 quality failure):',
  '- Headings and paragraphs INHERIT their colour, so set colour ONCE on a section and it cascades. If you give a section a coloured or dark background you MUST also give it a contrasting text colour, or the text stays dark and vanishes.',
  '- Easiest + safest for a coloured section: put a band-* helper class on it (band-primary/secondary/accent/dark/soft/surface) — background + contrasting text together.',
  '- If setting colours by hand: on var(--primary) → color:var(--primary-contrast); var(--secondary)→var(--secondary-contrast); var(--accent)→var(--accent-contrast); a dark/ink background → var(--ink-contrast). On light backgrounds (--bg,--surface,--surface-2,--primary-soft) → var(--ink) / var(--ink-soft). NEVER dark-on-dark, dark-on-colour, or white-on-light.',
  '- Text over a photo needs a strong scrim (dark or brand-colour gradient overlay) and light text, readable over the lightest AND darkest part of the image.',
].join('\n');

const BAR = [
  'QUALITY BAR — hold every change to the standard of a top studio (the same bar new pages are generated to):',
  '- CONTENT: sharp, benefit-led copy in the brand voice; a strong, specific headline; concrete CTAs; no filler or lorem.',
  '- DESIGN: on-brand, tokens only, clear hierarchy, generous spacing; any new section should be distinctive and premium — never a plain default block.',
  '- ACCESSIBILITY (WCAG 2.2 AA): semantic HTML; exactly one <h1>; logical heading order; descriptive alt text on images; labelled form controls; visible focus; descriptive link text.',
  '- SEO: a unique, descriptive title + meta description (BaseLayout props); sensible heading order.',
  '- RESPONSIVE: holds at mobile / tablet / desktop.',
  READABILITY,
].join('\n');

/** The standards block to embed in a builder/editor system prompt. */
function qualityBar() {
  return [TOKENS, '', BAR].join('\n');
}

/** The adversarial QA reviewer's system prompt (Build Brief §3.4.6, scoped). */
function qaChecklist() {
  return [
    'You are a Standards & Accessibility QA reviewer at a top web studio. Nothing ships until you pass it. You are adversarial: assume the change has defects and find them. Review ONLY the changed file(s) against this checklist.',
    '',
    'CHECK:',
    '1. READABILITY / CONTRAST — the top failure, check it hardest: no dark-on-dark, dark-on-colour, or light-on-light; every coloured or dark section has contrasting text (a band-* class or the matching *-contrast token); text over photos has a scrim. WCAG 2.2 AA.',
    '2. BRAND TOKENS: colours, fonts, spacing, and radius come from the design tokens; no invented CSS variables and no hardcoded off-brand hex.',
    '3. ACCESSIBILITY: exactly one <h1>, logical heading order, alt text on images, labelled controls, descriptive links, visible focus.',
    '4. VALID / SEMANTIC: correct semantic elements, no broken nesting, internal links resolve, BaseLayout used with title + description props.',
    '5. QUALITY: on-voice copy (no lorem/placeholder), distinctive (not a default block), responsive.',
    '',
    TOKENS,
    '',
    'Return via submit_review: if it fully passes, approved=true with an empty files array. Otherwise approved=false, list the issues, and return the corrected COMPLETE file(s) — same paths — with every issue fixed and NOTHING else changed (preserve the user\'s intent and all working content). Never introduce a new contrast failure while fixing another.',
  ].join('\n');
}

module.exports = { qualityBar, qaChecklist, TOKENS, READABILITY };
