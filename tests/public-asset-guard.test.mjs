// tests/public-asset-guard.test.mjs — prevents internal documents and
// create-next-app leftovers from being (re)committed into public/.
//
// public/ is served from the website root: investor decks, internal docs,
// Office lock files, and unused scaffold SVGs must never live there.
// Legitimate generator sources live OUTSIDE the web root (arcflare-deck.cjs,
// arcflare-doc.cjs, generate-assets.js, docs/, scripts/) and are untouched.
//
// Run: node --test tests/public-asset-guard.test.mjs (no TS imports needed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const PUBLIC = path.join(ROOT, 'public');

const entries = () => new Set(readdirSync(PUBLIC));

// ── 1. No internal/private project documents served from the web root ────────
test('public/ contains no investor deck, internal docs, or Office temp files', () => {
  const files = entries();
  for (const name of files) {
    assert.ok(!/\.pptx?$/i.test(name), `public/${name} must not be served from the web root`);
    assert.ok(!/\.docx?$/i.test(name), `public/${name} must not be served from the web root`);
    assert.ok(!/^~\$/.test(name), `public/${name} is an Office lock file and must not be committed`);
  }
  assert.ok(!files.has('ArcFlare-Investor-Deck.pptx'));
  assert.ok(!files.has('ArcFlare-Documentation.docx'));
});

// ── 2. No create-next-app leftovers ──────────────────────────────────────────
test('public/ contains no unused scaffold SVGs or duplicate logos', () => {
  const files = entries();
  for (const leftover of ['next.svg', 'vercel.svg', 'file.svg', 'globe.svg', 'window.svg']) {
    assert.ok(!files.has(leftover), `public/${leftover} is an unused scaffold file`);
  }
  assert.ok(!files.has('arcflare-logo.png.png'), 'duplicate public/arcflare-logo.png.png must not exist');
  // The real logo stays.
  assert.ok(files.has('arcflare-logo.png'), 'the real public/arcflare-logo.png must be kept');
  // The embed widget is a live public asset (referenced by CheckoutWidget).
  assert.ok(files.has('embed.js'), 'public/embed.js is live and must be kept');
});

// ── 3. Docs config points at the real logo, not the deleted duplicate ───────
test('docs/docs.json references the real logo, never the deleted duplicate', () => {
  const docs = JSON.parse(readFileSync(path.join(ROOT, 'docs', 'docs.json'), 'utf8'));
  const text = JSON.stringify(docs);
  assert.ok(!text.includes('.png.png'), 'docs.json must not reference the deleted duplicate logo');
  assert.ok(text.includes('/arcflare-logo.png'), 'docs.json must reference the real public logo');
});
