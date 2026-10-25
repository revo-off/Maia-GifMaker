#!/usr/bin/env node
// Regenerates gifs/catalog.json from the files in gifs/.
//
//   node tools/build-catalog.js
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

const dir = path.join(__dirname, '..', 'gifs');
const catalogPath = path.join(dir, 'catalog.json');

const files = new Set(fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.gif')));
const previous = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, 'utf8')) : [];
const previousById = new Map(previous.map((e) => [e.id, e]));

const entries = [...files]
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

fs.writeFileSync(catalogPath, JSON.stringify(entries, null, 2) + '\n');
console.log(`${entries.length} GIF(s) in catalog:`);
entries.forEach((e) => console.log(`  - ${e.name}${e.transparent ? ' (+ transparent)' : ''}`));
