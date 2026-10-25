#!/usr/bin/env node
// Regenerates gifs/catalog.json from the files in gifs/.
//
//   node tools/build-catalog.js
//
// (tools/check.js does this too, and also analyses every GIF: prefer `npm run check`.)
//
// Convention:
//   gs<Name>.gif  green-screen version (required, this is what is tracked / keyed)
//   <Name>.gif    optional version with a transparent screen -> enables "Fond transparent"
//
// The key colour and tolerance are detected automatically in the browser. To force
// them for a given GIF, add "chroma": "#2ec74e" and/or "tolerance": 30 to its entry in
// catalog.json: existing entries are kept (name, chroma, tolerance...) when you re-run this.

const fs = require('fs');
const path = require('path');

const GIF_DIR = path.join(__dirname, '..', 'gifs');
const CATALOG_PATH = path.join(GIF_DIR, 'catalog.json');

function readCatalog() {
  return fs.existsSync(CATALOG_PATH) ? JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')) : [];
}

// Returns the new entries (not written): existing fields of an entry are always kept
function buildCatalog() {
  const files = new Set(fs.readdirSync(GIF_DIR).filter((f) => f.toLowerCase().endsWith('.gif')));
  const previousById = new Map(readCatalog().map((e) => [e.id, e]));

  return [...files]
    .filter((f) => f.startsWith('gs'))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => {
      const id = path.basename(file, '.gif');
      const base = file.slice(2);
      const old = previousById.get(id) || {};
      return {
        ...old,
        id,
        name: old.name || path.basename(base, '.gif'),
        file,
        thumbnail: file,
        transparent: files.has(base),
      };
    });
}

function writeCatalog(entries) {
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(entries, null, 2) + '\n');
}

module.exports = { GIF_DIR, CATALOG_PATH, readCatalog, buildCatalog, writeCatalog };

if (require.main === module) {
  const entries = buildCatalog();
  writeCatalog(entries);
  console.log(`${entries.length} GIF(s) in catalog:`);
  entries.forEach((e) => console.log(`  - ${e.name}${e.transparent ? ' (+ transparent)' : ''}`));
}
