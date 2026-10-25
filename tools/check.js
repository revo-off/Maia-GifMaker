#!/usr/bin/env node
// Pre-build / pre-push check. Run it every time before building and pushing:
//
//   node tools/check.js          (or: npm run check)
//
// What it does
//   1. Rebuilds gifs/catalog.json from the gifs/ folder and stores each GIF's stats in it
//   2. Decodes every GIF: size, frame count, duration, delays, file size
//   3. Runs the real green-screen pipeline (key detection, tracking, keying) on every
//      GIF and flags: missing screen, tracking jumps, residual green, transparent-variant mismatch
//   4. Checks texts/*.json, local files referenced by index.html and JS syntax
//   5. Prints a report, writes tools/reports/report.md and one preview image per GIF
//      (tools/reports/<gif>.png: row 1 = keyed over a checkerboard, row 2 = tracked rectangle)
//
// Exit code 1 if something is broken (errors), 0 otherwise (warnings do not fail).

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REPORT_DIR = path.join(__dirname, 'reports');
const Keying = require('../src/js/keying.js');
const { GIF_DIR, readCatalog, buildCatalog, writeCatalog } = require('./build-catalog.js');

// ---- Output ------------------------------------------------------------------

const useColor = process.stdout.isTTY;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const C = { green: (s) => paint(32, s), yellow: (s) => paint(33, s), red: (s) => paint(31, s), dim: (s) => paint(2, s), bold: (s) => paint(1, s), cyan: (s) => paint(36, s) };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const lines = [];
const counts = { error: 0, warn: 0, ok: 0 };
const out = (s = '') => {
  lines.push(s);
  console.log(s);
};
const ok = (s) => { counts.ok++; out(`  ${C.green('✔')} ${s}`); };
const warn = (s) => { counts.warn++; out(`  ${C.yellow('⚠')} ${s}`); };
const err = (s) => { counts.error++; out(`  ${C.red('✖')} ${s}`); };
const info = (s) => out(`    ${C.dim(s)}`);
const title = (s) => { out(); out(C.bold(C.cyan(`■ ${s}`))); };

// ---- GIF decoding (same compositing as the app) --------------------------------

function loadGifuct() {
  const code = fs.readFileSync(path.join(ROOT, 'lib', 'gifuct-js.min.js'), 'utf8');
  vm.runInThisContext(`${code}\n;globalThis.gifuct = gifuct;`);
  return globalThis.gifuct;
}

function decodeGif(gifuct, file) {
  const buf = fs.readFileSync(file);
  const gif = gifuct.parseGIF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const raw = gifuct.decompressFrames(gif, true);
  const width = gif.lsd.width;
  const height = gif.lsd.height;
  const canvas = new Uint8ClampedArray(width * height * 4);
  const frames = [];
  const delays = [];
  let snapshot = null;

  const clearRect = (d) => {
    for (let y = d.top; y < d.top + d.height && y < height; y++) {
      canvas.fill(0, (y * width + d.left) * 4, (y * width + Math.min(width, d.left + d.width)) * 4);
    }
  };

  raw.forEach((f, i) => {
    if (i > 0) {
      const prev = raw[i - 1];
      if (prev.disposalType === 2) clearRect(prev.dims);
      else if (prev.disposalType === 3 && snapshot) canvas.set(snapshot);
    }
    snapshot = f.disposalType === 3 ? canvas.slice() : null;

    const d = f.dims;
    for (let y = 0; y < d.height; y++) {
      for (let x = 0; x < d.width; x++) {
        const s = (y * d.width + x) * 4;
        if (f.patch[s + 3] === 0) continue;
        const t = ((d.top + y) * width + d.left + x) * 4;
        canvas[t] = f.patch[s];
        canvas[t + 1] = f.patch[s + 1];
        canvas[t + 2] = f.patch[s + 2];
        canvas[t + 3] = f.patch[s + 3];
      }
    }
    frames.push({ data: canvas.slice(), width, height });
    delays.push(f.delay);
  });

  return { frames, delays, width, height, bytes: buf.length };
}

// ---- PNG (preview images) -------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawLine(img, w, h, x0, y0, x1, y1, color) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let s = 0; s <= steps; s++) {
    const x = Math.round(x0 + ((x1 - x0) * s) / steps);
    const y = Math.round(y0 + ((y1 - y0) * s) / steps);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = (y * w + x) * 4;
    img[i] = color[0];
    img[i + 1] = color[1];
    img[i + 2] = color[2];
    img[i + 3] = 255;
  }
}

function writePreview(name, frames, keyed, tracking) {
  const w = frames[0].width;
  const h = frames[0].height;
  const cols = 6;
  const tracked = tracking.map((t, i) => (t ? i : -1)).filter((i) => i >= 0);
  const pool = tracked.length >= cols ? tracked : frames.map((_, i) => i);
  const picks = Array.from({ length: cols }, (_, k) => pool[Math.floor((k / cols) * pool.length + pool.length / cols / 2)]);

  const W = w * cols;
  const H = h * 2;
  const img = new Uint8ClampedArray(W * H * 4);

  picks.forEach((fi, k) => {
    const src = frames[fi].data;
    const key = keyed[fi].data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        // row 1: keyed frame over a checkerboard
        const checker = ((x >> 3) + (y >> 3)) % 2 ? [255, 230, 0] : [200, 0, 160];
        const a = key[p + 3] / 255;
        const t1 = (y * W + k * w + x) * 4;
        for (let c = 0; c < 3; c++) img[t1 + c] = key[p + c] * a + checker[c] * (1 - a);
        img[t1 + 3] = 255;
        // row 2: original with the tracked rectangle
        const t2 = ((h + y) * W + k * w + x) * 4;
        img[t2] = src[p];
        img[t2 + 1] = src[p + 1];
        img[t2 + 2] = src[p + 2];
        img[t2 + 3] = 255;
      }
    }
    const t = tracking[fi];
    if (t) {
      const cos = Math.cos(t.angle);
      const sin = Math.sin(t.angle);
      const corner = (sx, sy) => [
        t.cx + (sx * t.w) / 2 * cos - (sy * t.h) / 2 * sin,
        t.cy + (sx * t.w) / 2 * sin + (sy * t.h) / 2 * cos,
      ];
      const pts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      const sub = new Uint8ClampedArray(img.buffer, 0, img.length);
      for (let e = 0; e < 4; e++) {
        const a = pts[e];
        const b = pts[(e + 1) % 4];
        drawLine(sub, W, H, a[0] + k * w, a[1] + h, b[0] + k * w, b[1] + h, [255, 40, 40]);
      }
    }
  });

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const file = path.join(REPORT_DIR, `${name}.png`);
  fs.writeFileSync(file, encodePng(img, W, H));
  return path.relative(ROOT, file);
}

// ---- Analysis -----------------------------------------------------------------

const fmtMs = (ms) => `${(ms / 1000).toFixed(2)} s`;
const fmtMB = (b) => `${(b / 1048576).toFixed(2)} Mo`;
const hex = ({ r, g, b }) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
const hexToRgb = (s) => ({ r: parseInt(s.slice(1, 3), 16), g: parseInt(s.slice(3, 5), 16), b: parseInt(s.slice(5, 7), 16) });

function ranges(flags, label) {
  const segs = [];
  let start = -1;
  flags.forEach((f, i) => {
    if (f && start < 0) start = i;
    if ((!f || i === flags.length - 1) && start >= 0) {
      const end = f && i === flags.length - 1 ? i : i - 1;
      segs.push(start === end ? `${start + 1}` : `${start + 1}→${end + 1}`);
      start = -1;
    }
  });
  return segs.length ? `${label} ${segs.join(', ')}` : '';
}

function analyseGreenScreen(gifuct, entry, before) {
  const file = path.join(GIF_DIR, entry.file);
  const gif = decodeGif(gifuct, file);
  const { frames, delays } = gif;
  const total = delays.reduce((a, b) => a + b, 0);

  out(C.bold(`  ${entry.name}`) + C.dim(`  (${entry.file})`));

  // Size / length / status
  ok(`${gif.width}×${gif.height} px, ${frames.length} frames, ${fmtMs(total)} (${(frames.length / (total / 1000)).toFixed(1)} fps moyen), ${fmtMB(gif.bytes)}`);
  if (before && before.frames && before.frames !== frames.length) {
    warn(`longueur modifiée depuis le dernier check : ${before.frames} → ${frames.length} frames (${fmtMs(before.durationMs)} → ${fmtMs(total)})`);
  }
  const fast = delays.filter((d) => d <= 10).length;
  if (fast > 0) warn(`${fast} frame(s) avec un délai ≤ 10 ms : les navigateurs (et l'app) les jouent à 100 ms`);
  const longest = Math.max(...delays);
  if (longest >= 1000) info(`délai le plus long : ${longest} ms (frame ${delays.indexOf(longest) + 1}), pris en compte tel quel`);
  if (gif.bytes > 8 * 1048576) warn(`fichier lourd (${fmtMB(gif.bytes)}) : le chargement sera lent`);
  if (frames.length > 400) warn(`${frames.length} frames : l'export sera long`);

  // Key detection
  const detected = Keying.detectKey(frames);
  let color = entry.chroma ? hexToRgb(entry.chroma) : null;
  let tolerance = entry.tolerance ? Number(entry.tolerance) : null;
  if (!color || !tolerance) {
    if (!detected) {
      err('aucun fond vert détecté dans ce GIF');
      return { gif, summary: null };
    }
    color = color || detected.color;
    tolerance = tolerance || detected.tolerance;
  }
  const source = entry.chroma || entry.tolerance ? 'catalog.json' : 'auto';
  ok(`couleur clé ${hex(color)}, tolérance ${tolerance} (${source}${detected ? `, ${(detected.coverage * 100).toFixed(0)} % de pixels verts` : ''})`);

  // Tracking
  const keyer = Keying.makeKeyer(color, tolerance);
  const tracking = Keying.computeTracking(frames, keyer);
  const tracked = tracking.filter(Boolean);
  const full = tracked.filter((t) => t.isFullScreen).length;

  if (tracked.length === 0) {
    err('le suivi ne trouve l’écran vert sur aucune frame');
  } else {
    ok(`écran vert suivi sur ${tracked.length}/${frames.length} frames (${((tracked.length / frames.length) * 100).toFixed(0)} %), dont ${full} plein cadre`);
    info(ranges(tracking.map(Boolean), 'écran présent :') + '   ' + ranges(tracking.map((t) => !t), 'absent :'));
  }

  // Tracking jumps (flicker of the incrustation)
  const jumps = [];
  for (let i = 1; i < tracking.length; i++) {
    const a = tracking[i - 1];
    const b = tracking[i];
    if (!a || !b || a.isFullScreen || b.isFullScreen) continue;
    const size = Math.max(a.w, a.h);
    const move = Math.hypot(a.cx - b.cx, a.cy - b.cy);
    const grow = Math.abs(b.w * b.h - a.w * a.h) / (a.w * a.h);
    if (move > size * 0.35 || grow > 0.5) jumps.push(i + 1);
  }
  const trackedCount = Math.max(1, tracked.length);
  if (jumps.length === 0) ok('suivi stable (aucun saut brusque)');
  else if (jumps.length / trackedCount > 0.05) warn(`suivi instable : ${jumps.length} sauts brusques (frames ${jumps.slice(0, 8).join(', ')}${jumps.length > 8 ? '…' : ''})`);
  else info(`${jumps.length} saut(s) isolé(s) : frames ${jumps.join(', ')}`);

  // Keying quality
  const keyed = frames.map((f) => {
    const copy = { data: f.data.slice(), width: f.width, height: f.height };
    keyer.soften = 0;
    return Keying.applyKey(copy, keyer);
  });
  let spillFrames = [];
  let worst = 0;
  keyed.forEach((f, i) => {
    let n = 0;
    const d = f.data;
    for (let p = 0; p < d.length; p += 4) {
      if (d[p + 3] > 200 && d[p + 1] > 90 && d[p + 1] > d[p] * 1.25 && d[p + 1] > d[p + 2] * 1.25) n++;
    }
    const limit = Math.max(30, Math.round(f.width * f.height * 0.002));
    if (n > limit) spillFrames.push(i + 1);
    worst = Math.max(worst, n);
  });
  if (tracked.length > 0) {
    if (spillFrames.length === 0) ok(`détourage propre (pas de vert résiduel, max ${worst} px)`);
    else warn(`vert résiduel après détourage sur ${spillFrames.length} frame(s) (ex. ${spillFrames.slice(0, 6).join(', ')}) : ajuste la tolérance dans catalog.json`);
  }

  // Irregular screen (strong occlusion)
  const irregular = tracking.map((t) => (t && !t.isFullScreen && t.count / (t.w * t.h) < 0.45 ? 1 : 0)).reduce((a, b) => a + b, 0);
  if (irregular > tracked.length * 0.2) info(`${irregular} frames où l'écran est très masqué (rectangle peu rempli) : normal si des mains passent devant`);

  const preview = writePreview(path.basename(entry.file, '.gif'), frames, keyed, tracking);
  info(`aperçu visuel : ${preview}`);

  return {
    gif,
    keyed,
    tracking,
    summary: { frames: frames.length, durationMs: total, width: gif.width, height: gif.height },
  };
}

function analyseTransparentVariant(gifuct, entry, gs) {
  const file = path.join(GIF_DIR, entry.file.slice(2));
  const t = decodeGif(gifuct, file);
  out(C.dim(`  ↳ version transparente : ${entry.file.slice(2)}`));

  if (t.width !== gs.gif.width || t.height !== gs.gif.height) err(`dimensions différentes (${t.width}×${t.height} au lieu de ${gs.gif.width}×${gs.gif.height})`);
  else ok('mêmes dimensions que la version fond vert');

  if (t.frames.length !== gs.gif.frames.length) {
    warn(`nombre de frames différent : ${t.frames.length} (transparent) ≠ ${gs.gif.frames.length} (fond vert) : le suivi de la version transparente sera approximatif (mis à l'échelle). Réexporte les deux versions avec la même durée si possible`);
    return;
  }
  ok(`même nombre de frames (${t.frames.length})`);

  const sumA = t.delays.reduce((a, b) => a + b, 0);
  const sumB = gs.gif.delays.reduce((a, b) => a + b, 0);
  if (Math.abs(sumA - sumB) > 200) warn(`durées différentes : ${fmtMs(sumA)} (transparent) vs ${fmtMs(sumB)} (fond vert)`);

  // Where the green screen is removed, the transparent version should be transparent too
  if (!gs.keyed) return;
  let match = 0;
  let screen = 0;
  gs.keyed.forEach((k, i) => {
    const a = k.data;
    const b = t.frames[i].data;
    for (let p = 3; p < a.length; p += 4) {
      if (a[p] === 0) {
        screen++;
        if (b[p] < 128) match++;
      }
    }
  });
  if (screen === 0) return;
  const ratio = match / screen;
  if (ratio >= 0.9) ok(`trou transparent cohérent avec l'écran vert (${(ratio * 100).toFixed(0)} %)`);
  else warn(`le trou transparent ne correspond qu'à ${(ratio * 100).toFixed(0)} % de l'écran vert : vérifie que les deux versions sont bien alignées`);
}

// ---- Project checks -------------------------------------------------------------

function checkCatalogFiles(entries) {
  const onDisk = fs.readdirSync(GIF_DIR).filter((f) => f.toLowerCase().endsWith('.gif'));
  const ids = new Set();
  entries.forEach((e) => {
    if (ids.has(e.id)) err(`id en double dans le catalogue : ${e.id}`);
    ids.add(e.id);
    ['file', 'thumbnail'].forEach((k) => {
      if (!fs.existsSync(path.join(GIF_DIR, e[k]))) err(`${e.name} : fichier manquant (${e[k]})`);
    });
  });
  const lone = onDisk.filter((f) => !f.startsWith('gs') && !onDisk.includes(`gs${f}`));
  lone.forEach((f) => warn(`${f} n'a pas de version fond vert (gs${f}) : ignoré par le catalogue`));
  if (entries.length === 0) err('aucun GIF dans le catalogue');
  else ok(`${entries.length} GIF(s) dans le catalogue, tous les fichiers existent`);
}

function checkTexts() {
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ROOT, 'texts', f), 'utf8'));
    } catch (e) {
      err(`texts/${f} : JSON invalide (${e.message})`);
      return null;
    }
  };
  const templates = read('templates.json');
  const fonts = read('fonts.json');
  if (!templates || !fonts) return;
  const fontIds = new Set(fonts.map((f) => f.id));

  fonts.forEach((f) => {
    if (f.file && !fs.existsSync(path.join(ROOT, f.file))) err(`police « ${f.name} » : fichier manquant (${f.file})`);
    if (!f.file && !f.google) err(`police « ${f.name} » : ni "file" ni "google"`);
  });
  templates.forEach((t) => {
    if (!fontIds.has(t.defaultFont)) err(`template « ${t.name} » : police par défaut inconnue (${t.defaultFont})`);
    (t.layers || []).forEach((l) => {
      if (l.type === 'text' && l.font !== '@selected' && !fontIds.has(l.font)) err(`template « ${t.name} » : police inconnue (${l.font})`);
    });
    if (!t.free && !(t.layers || []).some((l) => l.type === 'input')) warn(`template « ${t.name} » : aucune zone "input" (le texte de l'utilisateur ne s'affichera pas)`);
  });
  ok(`${templates.length} template(s) et ${fonts.length} police(s) valides`);
}

function checkProjectFiles() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]).filter((r) => !/^(https?:|data:|mailto:)/.test(r));
  const missing = [...new Set(refs)].filter((r) => !fs.existsSync(path.join(ROOT, r)));
  if (missing.length) missing.forEach((m) => err(`index.html référence un fichier absent : ${m}`));
  else ok(`${new Set(refs).size} fichier(s) référencés par index.html existent`);

  const css = fs.readFileSync(path.join(ROOT, 'src', 'css', 'style.css'), 'utf8');
  const urls = [...css.matchAll(/url\('(?!data:)([^')]+)'\)/g)].map((m) => path.join(ROOT, 'src', 'css', m[1]));
  const badUrls = urls.filter((u) => !fs.existsSync(u));
  if (badUrls.length) badUrls.forEach((u) => err(`style.css référence un fichier absent : ${path.relative(ROOT, u)}`));

  const jsDir = path.join(ROOT, 'src', 'js');
  let bad = 0;
  fs.readdirSync(jsDir).filter((f) => f.endsWith('.js')).forEach((f) => {
    const r = spawnSync(process.execPath, ['--check', path.join(jsDir, f)], { encoding: 'utf8' });
    if (r.status !== 0) {
      bad++;
      err(`erreur de syntaxe dans src/js/${f}\n${r.stderr.split('\n').slice(0, 4).join('\n')}`);
    }
  });
  if (!bad) ok('syntaxe JavaScript valide');
}

// ---- Main ---------------------------------------------------------------------

function main() {
  out(C.bold('Maia GifMaker : vérification avant build / push'));
  out(C.dim(new Date().toLocaleString('fr-FR')));

  const gifuct = loadGifuct();
  const previous = new Map(readCatalog().map((e) => [e.id, e]));

  title('Catalogue');
  const entries = buildCatalog();
  checkCatalogFiles(entries);

  title('GIFs (taille, durée, fond vert)');
  const results = [];
  entries.forEach((entry) => {
    out();
    let res = null;
    try {
      res = analyseGreenScreen(gifuct, entry, previous.get(entry.id));
      if (entry.transparent && res.summary) analyseTransparentVariant(gifuct, entry, res);
    } catch (e) {
      err(`${entry.name} : analyse impossible (${e.message})`);
    }
    if (res && res.summary) Object.assign(entry, res.summary);
    results.push({ entry, res });
  });

  // Stats go into the catalog (kept in sync, handy for the app)
  const catalogOk = entries.every((e) => e.frames);
  if (catalogOk) writeCatalog(entries);

  title('Textes');
  checkTexts();

  title('Projet');
  checkProjectFiles();

  // Summary table
  title('Récapitulatif');
  const pad = (s, n) => String(s).padEnd(n);
  out(`  ${C.dim(pad('GIF', 16) + pad('Frames', 9) + pad('Durée', 10) + pad('Taille', 11) + 'Écran vert')}`);
  results.forEach(({ entry, res }) => {
    const s = res && res.summary;
    const tracked = res && res.tracking ? res.tracking.filter(Boolean).length : 0;
    out(`  ${pad(entry.name, 16)}${pad(s ? s.frames : '-', 9)}${pad(s ? fmtMs(s.durationMs) : '-', 10)}${pad(s ? `${s.width}×${s.height}` : '-', 11)}${s ? `${tracked}/${s.frames} frames` : C.red('erreur')}`);
  });

  out();
  const verdict = counts.error > 0
    ? C.red(C.bold(`✖ ${counts.error} erreur(s), ${counts.warn} avertissement(s) : ne pas push avant correction`))
    : counts.warn > 0
      ? C.yellow(C.bold(`⚠ OK avec ${counts.warn} avertissement(s) : relis-les, puis tu peux build et push`))
      : C.green(C.bold('✔ Tout est bon : tu peux build et push'));
  out(verdict);

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, 'report.md'), '```\n' + lines.map(strip).join('\n') + '\n```\n');
  process.exit(counts.error > 0 ? 1 : 0);
}

main();
