(function () {
  'use strict';

  // "Effets" page: import any GIF / image, apply colour effects and lay overlay GIFs
  // (overlay/ folder) over it, then export an animated GIF.

  const $ = (s) => document.querySelector(s);

  // Output size of the imported file: square -> 200x200, otherwise fitted in 400x200 (never enlarged)
  function mainSize(W, H) {
    if (W === H) return [200, 200];
    const k = Math.min(1, 400 / W, 200 / H);
    return [Math.max(1, Math.round(W * k)), Math.max(1, Math.round(H * k))];
  }
  const MIN_SIZE = 8;
  const STATIC_HUE_MS = 2400; // length of the colour loop on a still image
  const STATIC_RAGE_MS = 800; // length of the shake loop on a still image
  const RAGE_STEP_MS = 50; // the shake jumps every step, like the reference GIF
  const RAGE_ZOOM = 0.94;
  const RAGE_KEEP = 0.25; // share of the original colours kept under the red (contrast)
  const RAGE_SHAKE = 0.03; // of the smallest side
  const SLICE_MS = 50; // a long frame is cut in steps of this size when something moves over it

  const upload = $('#fx-upload');
  const input = $('#fx-input');
  const uploadText = $('#fx-upload-text');
  const btnRemove = $('#fx-remove');
  const container = $('#canvas-container');
  const emptyState = $('#empty-state');
  const stage = $('#fx-stage');
  const canvas = $('#fx-canvas');
  const ctx = canvas.getContext('2d');
  const overlayEl = $('#fx-overlay');
  const box = $('#fx-box');
  const rotateHandle = $('#fx-rotate-handle');
  const playbackBar = $('#playback-bar');
  const btnPlay = $('#fx-play');
  const counter = $('#fx-counter');
  const progress = $('#fx-progress');
  const btnRender = $('#btn-fx-render');
  const layersSection = $('#section-layers');
  const layersEl = $('#fx-layers');

  const state = {
    main: null, // { frames: canvas[], delays: ms[], w, h, name }
    effects: { hue: false, gray: false, invert: false, mirror: false, rage: false },
    layers: [], // overlays: { id, name, frames, delays, total, cx, cy, w, h, rot, front }
    sel: null,
    playing: true,
    t: 0,
    lastNow: 0,
    lastKey: '',
    force: true,
    exportCancelled: false,
    activeGif: null,
    blobUrl: null,
  };
  let layerSeq = 0;
  let scale = 1; // css px per canvas px
  let drag = null;

  const work = document.createElement('canvas');
  const workCtx = work.getContext('2d', { willReadFrequently: true });

  // ---------- Decoding ----------

  function toCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  // Every frame fully composited (disposal handled), with its delay in ms
  function decodeGif(buffer, sizeFor) {
    const gif = gifuct.parseGIF(buffer);
    const raw = gifuct.decompressFrames(gif, true);
    const W = gif.lsd.width;
    const H = gif.lsd.height;
    const [ow, oh] = sizeFor ? sizeFor(W, H) : [W, H];

    const full = toCanvas(W, H);
    const fc = full.getContext('2d', { willReadFrequently: true });
    const patchCanvas = toCanvas(1, 1);
    const pc = patchCanvas.getContext('2d');
    const frames = [];
    const delays = [];
    let restore = null;

    raw.forEach((f) => {
      if (f.disposalType === 3) restore = fc.getImageData(0, 0, W, H);
      patchCanvas.width = f.dims.width;
      patchCanvas.height = f.dims.height;
      const id = pc.createImageData(f.dims.width, f.dims.height);
      id.data.set(f.patch);
      pc.putImageData(id, 0, 0);
      fc.drawImage(patchCanvas, f.dims.left, f.dims.top);

      const out = toCanvas(ow, oh);
      const oc = out.getContext('2d');
      oc.imageSmoothingQuality = 'high';
      oc.drawImage(full, 0, 0, ow, oh);
      frames.push(out);
      delays.push(!f.delay || f.delay <= 10 ? 100 : f.delay);

      if (f.disposalType === 2) fc.clearRect(f.dims.left, f.dims.top, f.dims.width, f.dims.height);
      else if (f.disposalType === 3 && restore) fc.putImageData(restore, 0, 0);
    });
    return { frames, delays, w: ow, h: oh };
  }

  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('image'));
      };
      img.src = url;
    });
  }

  async function decodeFile(blob, sizeFor) {
    const isGif = blob.type === 'image/gif' || /\.gif$/i.test(blob.name || '');
    if (isGif) {
      try {
        const res = decodeGif(await blob.arrayBuffer(), sizeFor);
        if (res.frames.length > 0) return res;
      } catch (e) {
        console.warn('GIF decode failed, falling back to a still image', e);
      }
    }
    const img = await loadImage(blob);
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const [ow, oh] = sizeFor ? sizeFor(W, H) : [W, H];
    const c = toCanvas(ow, oh);
    const cc = c.getContext('2d');
    cc.imageSmoothingQuality = 'high';
    cc.drawImage(img, 0, 0, c.width, c.height);
    return { frames: [c], delays: [100], w: c.width, h: c.height };
  }

  // ---------- Timeline ----------

  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const isAnimated = (m) => m && m.frames.length > 1;

  function loopMs() {
    const m = state.main;
    if (!m) return 0;
    if (isAnimated(m)) return sum(m.delays);
    const overlayMs = Math.max(0, ...state.layers.map((l) => (l.frames.length > 1 ? l.total : 0)));
    const own = Math.max(state.effects.hue ? STATIC_HUE_MS : 0, state.effects.rage ? STATIC_RAGE_MS : 0);
    return Math.max(own, overlayMs);
  }

  function indexAt(delays, t) {
    let rest = t;
    for (let i = 0; i < delays.length; i++) {
      if (rest < delays[i]) return i;
      rest -= delays[i];
    }
    return delays.length - 1;
  }

  function mainIndexAt(t) {
    const m = state.main;
    return isAnimated(m) ? indexAt(m.delays, t) : 0;
  }

  function layerIndexAt(l, t) {
    return l.frames.length > 1 ? indexAt(l.delays, t % l.total) : 0;
  }

  // ---------- Effects (pixel level, so they also work where canvas filters do not) ----------

  function applyEffects(imageData, t, T) {
    const { hue, gray, invert, mirror, rage } = state.effects;
    const d = imageData.data;
    const w = imageData.width;
    const h = imageData.height;

    if (mirror) {
      // The right half is copied, flipped, over the left half
      const px = new Uint32Array(d.buffer);
      const half = Math.floor(w / 2);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < half; x++) px[row + x] = px[row + w - 1 - x];
      }
    }

    let m = null;
    if (hue) {
      const a = (T > 0 ? (t / T) * 360 : 0) * (Math.PI / 180);
      const c = Math.cos(a);
      const s = Math.sin(a);
      m = [
        0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
        0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
        0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
      ];
    }

    if (!m && !gray && !invert && !rage) return;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i];
      let g = d[i + 1];
      let b = d[i + 2];
      if (gray) {
        r = g = b = 0.299 * r + 0.587 * g + 0.114 * b;
      }
      if (m) {
        const nr = m[0] * r + m[1] * g + m[2] * b;
        const ng = m[3] * r + m[4] * g + m[5] * b;
        const nb = m[6] * r + m[7] * g + m[8] * b;
        r = nr < 0 ? 0 : nr > 255 ? 255 : nr;
        g = ng < 0 ? 0 : ng > 255 ? 255 : ng;
        b = nb < 0 ? 0 : nb > 255 ? 255 : nb;
      }
      if (invert) {
        r = 255 - r;
        g = 255 - g;
        b = 255 - b;
      }
      if (rage) {
        // Vivid red: brightness drives the red channel, a little blue is kept for the magenta tones
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        const nr = l * 1.5 + 40;
        r = r * RAGE_KEEP + (nr > 255 ? 255 : nr) * (1 - RAGE_KEEP);
        g = g * RAGE_KEEP + l * 0.1 * (1 - RAGE_KEEP);
        b = b * RAGE_KEEP + b * 0.3 * (1 - RAGE_KEEP);
      }
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
    }
  }

  function anyEffect() {
    const e = state.effects;
    return e.hue || e.gray || e.invert || e.mirror || e.rage;
  }

  // Deterministic jitter in [-1, 1] for a shake step
  function jitter(step, salt) {
    const x = Math.sin(step * 12.9898 + salt * 78.233) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  }

  function drawLayer(c, l, t) {
    c.save();
    c.imageSmoothingQuality = 'high';
    c.translate(l.cx, l.cy);
    c.rotate(l.rot);
    c.drawImage(l.frames[layerIndexAt(l, t)], -l.w / 2, -l.h / 2, l.w, l.h);
    c.restore();
  }

  // Overlays behind, the (processed) imported file, overlays in front
  function renderAt(c, t, T) {
    const m = state.main;
    c.clearRect(0, 0, m.w, m.h);
    state.layers.filter((l) => !l.front).forEach((l) => drawLayer(c, l, t));

    const frame = m.frames[mainIndexAt(t)];
    if (anyEffect()) {
      if (work.width !== m.w || work.height !== m.h) {
        work.width = m.w;
        work.height = m.h;
      }
      workCtx.clearRect(0, 0, m.w, m.h);
      workCtx.drawImage(frame, 0, 0);
      const id = workCtx.getImageData(0, 0, m.w, m.h);
      applyEffects(id, t, T);
      workCtx.putImageData(id, 0, 0);
      if (state.effects.rage) {
        // Zoomed out, shaken frame by frame; what the frame no longer covers stays transparent
        const step = Math.floor(t / RAGE_STEP_MS);
        const amp = RAGE_SHAKE * Math.min(m.w, m.h);
        c.imageSmoothingQuality = 'high';
        c.drawImage(work, (m.w * (1 - RAGE_ZOOM)) / 2 + jitter(step, 1) * amp, (m.h * (1 - RAGE_ZOOM)) / 2 + jitter(step, 2) * amp, m.w * RAGE_ZOOM, m.h * RAGE_ZOOM);
      } else {
        c.drawImage(work, 0, 0);
      }
    } else {
      c.drawImage(frame, 0, 0);
    }

    state.layers.filter((l) => l.front).forEach((l) => drawLayer(c, l, t));
  }

  // ---------- Preview loop ----------

  function frameKey(t) {
    const parts = [mainIndexAt(t), state.layers.map((l) => layerIndexAt(l, t)).join(',')];
    if (state.effects.hue) parts.push(Math.round(t / 33));
    if (state.effects.rage) parts.push(Math.floor(t / RAGE_STEP_MS));
    return parts.join('|');
  }

  function tick(now) {
    requestAnimationFrame(tick);
    const m = state.main;
    if (!m) {
      state.lastNow = now;
      return;
    }
    const T = loopMs();
    if (state.playing && T > 0) {
      state.t = (state.t + (now - state.lastNow)) % T;
    }
    state.lastNow = now;

    const key = frameKey(state.t);
    if (!state.force && key === state.lastKey) return;
    state.force = false;
    state.lastKey = key;
    renderAt(ctx, state.t, T);

    const idx = mainIndexAt(state.t);
    counter.textContent = isAnimated(m) ? `${idx + 1} / ${m.frames.length}` : T > 0 ? `${(state.t / 1000).toFixed(1)} s` : 'Image';
    progress.style.width = (T > 0 ? (state.t / T) * 100 : 100) + '%';
  }

  function setPlaying(p) {
    state.playing = p;
    $('#fx-icon-play').classList.toggle('hidden', p);
    $('#fx-icon-pause').classList.toggle('hidden', !p);
  }

  // ---------- Layout ----------

  function layoutStage() {
    const m = state.main;
    if (!m) return;
    const area = $('#canvas-area').getBoundingClientRect();
    const maxW = Math.max(160, Math.min(area.width - 96, 900));
    const maxH = Math.max(160, area.height - 330);
    scale = Math.min(maxW / m.w, maxH / m.h);
    canvas.style.width = Math.round(m.w * scale) + 'px';
    canvas.style.height = Math.round(m.h * scale) + 'px';
    scale = Math.round(m.w * scale) / m.w;
    layoutBox();
  }

  function selected() {
    return state.layers.find((l) => l.id === state.sel) || null;
  }

  function layoutBox() {
    const l = selected();
    box.classList.toggle('hidden', !l);
    if (!l) return;
    box.style.width = l.w * scale + 'px';
    box.style.height = l.h * scale + 'px';
    box.style.left = (l.cx - l.w / 2) * scale + 'px';
    box.style.top = (l.cy - l.h / 2) * scale + 'px';
    box.style.transform = `rotate(${l.rot}rad)`;
  }

  // ---------- Main file ----------

  async function loadMain(file) {
    uploadText.textContent = 'Chargement...';
    try {
      const res = await decodeFile(file, mainSize);
      state.main = { ...res, name: file.name };
    } catch (e) {
      console.error(e);
      uploadText.textContent = "Impossible de lire ce fichier";
      return;
    }
    uploadText.textContent = file.name;
    btnRemove.classList.remove('hidden');
    emptyState.classList.add('hidden');
    stage.classList.remove('hidden');
    playbackBar.classList.remove('hidden');
    btnRender.classList.remove('hidden');

    // Overlays already placed keep their relative position on the new canvas
    state.layers.forEach((l) => fitLayer(l));
    state.t = 0;
    state.force = true;
    canvas.width = state.main.w;
    canvas.height = state.main.h;
    layoutStage();
    setPlaying(true);
  }

  function clearMain() {
    state.main = null;
    uploadText.textContent = 'Importer un GIF ou une image';
    btnRemove.classList.add('hidden');
    emptyState.classList.remove('hidden');
    stage.classList.add('hidden');
    playbackBar.classList.add('hidden');
    btnRender.classList.add('hidden');
    input.value = '';
  }

  // ---------- Overlays ----------

  function fitLayer(l) {
    const m = state.main;
    if (!m) return;
    const k = Math.min(m.w / l.srcW, m.h / l.srcH);
    l.w = l.srcW * k;
    l.h = l.srcH * k;
    l.cx = m.w / 2;
    l.cy = m.h / 2;
    l.rot = 0;
  }

  async function addOverlay(entry) {
    if (!state.main) {
      flash(upload);
      return;
    }
    let res;
    try {
      const resp = await fetch('overlay/' + entry.file);
      const blob = await resp.blob();
      blob.name = entry.file;
      res = await decodeFile(blob, null);
    } catch (e) {
      console.error('Overlay load failed', e);
      return;
    }
    const l = {
      id: ++layerSeq,
      name: entry.name,
      frames: res.frames,
      delays: res.delays,
      total: sum(res.delays),
      srcW: res.w,
      srcH: res.h,
      front: true,
    };
    fitLayer(l);
    state.layers.push(l);
    state.sel = l.id;
    state.force = true;
    renderLayers();
    layoutBox();
  }

  function removeLayer(id) {
    state.layers = state.layers.filter((l) => l.id !== id);
    if (state.sel === id) state.sel = null;
    state.force = true;
    renderLayers();
    layoutBox();
  }

  function selectLayer(id) {
    state.sel = id;
    renderLayers();
    layoutBox();
  }

  function renderLayers() {
    layersSection.classList.toggle('hidden', state.layers.length === 0);
    layersEl.innerHTML = '';
    state.layers.forEach((l) => {
      const row = document.createElement('div');
      row.className = 'fx-layer' + (l.id === state.sel ? ' active' : '');
      const name = document.createElement('span');
      name.className = 'fx-layer-name';
      name.textContent = l.name;
      const side = document.createElement('button');
      side.type = 'button';
      side.className = 'btn-micro';
      side.textContent = l.front ? 'Devant' : 'Derrière';
      side.title = "Placer l'overlay devant ou derrière le fichier importé";
      side.addEventListener('click', (e) => {
        e.stopPropagation();
        l.front = !l.front;
        state.force = true;
        renderLayers();
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-remove';
      del.title = 'Supprimer';
      del.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeLayer(l.id);
      });
      row.append(name, side, del);
      row.addEventListener('click', () => selectLayer(l.id));
      layersEl.appendChild(row);
    });
  }

  function flash(el) {
    el.classList.add('fx-flash');
    setTimeout(() => el.classList.remove('fx-flash'), 700);
  }

  async function buildOverlayGallery() {
    const gallery = $('#overlay-gallery');
    let entries = [];
    try {
      const resp = await fetch('overlay/catalog.json');
      entries = await resp.json();
    } catch (e) {
      console.error('overlay/catalog.json', e);
    }
    gallery.innerHTML = '';
    if (entries.length === 0) {
      gallery.innerHTML = '<div class="gallery-empty"><span>Aucun overlay (dossier overlay/)</span></div>';
      return;
    }
    entries.forEach((entry) => {
      const card = document.createElement('div');
      card.className = 'gif-card';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', 'Ajouter ' + entry.name);
      const img = document.createElement('img');
      img.src = 'overlay/' + entry.file;
      img.alt = entry.name;
      img.loading = 'lazy';
      const label = document.createElement('span');
      label.className = 'gif-card-label';
      label.textContent = entry.name;
      card.append(img, label);
      card.addEventListener('click', () => addOverlay(entry));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          addOverlay(entry);
        }
      });
      gallery.appendChild(card);
    });
  }

  // ---------- Overlay manipulation (move / resize / rotate) ----------

  function hitTest(px, py) {
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      const dx = px - l.cx;
      const dy = py - l.cy;
      const cos = Math.cos(-l.rot);
      const sin = Math.sin(-l.rot);
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      if (Math.abs(lx) <= l.w / 2 && Math.abs(ly) <= l.h / 2) return l;
    }
    return null;
  }

  function startDrag(mode, handle, e, l) {
    e.preventDefault();
    e.stopPropagation();
    drag = { mode, handle, id: l.id, startX: e.clientX, startY: e.clientY, t0: { ...l }, angle0: 0, center: null };
    if (mode === 'rotate') {
      const r = overlayEl.getBoundingClientRect();
      const sx = r.left + l.cx * scale;
      const sy = r.top + l.cy * scale;
      drag.angle0 = Math.atan2(e.clientY - sy, e.clientX - sx);
      drag.center = { x: sx, y: sy };
    }
  }

  function onMove(e) {
    if (!drag) return;
    const l = state.layers.find((x) => x.id === drag.id);
    if (!l) return;
    const t0 = drag.t0;
    const dx = (e.clientX - drag.startX) / scale;
    const dy = (e.clientY - drag.startY) / scale;

    if (drag.mode === 'move') {
      l.cx = t0.cx + dx;
      l.cy = t0.cy + dy;
    } else if (drag.mode === 'rotate') {
      const a = Math.atan2(e.clientY - drag.center.y, e.clientX - drag.center.x);
      let rot = t0.rot + (a - drag.angle0);
      if (e.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12);
      l.rot = rot;
    } else {
      // Resize in the overlay's own axes, the opposite side stays fixed
      const cos = Math.cos(t0.rot);
      const sin = Math.sin(t0.rot);
      const ldx = dx * cos + dy * sin;
      const ldy = -dx * sin + dy * cos;
      const hd = drag.handle;
      const sx = hd.includes('e') ? 1 : hd.includes('w') ? -1 : 0;
      const sy = hd.includes('s') ? 1 : hd.includes('n') ? -1 : 0;
      let newW = t0.w + sx * ldx;
      let newH = t0.h + sy * ldy;
      if (sx !== 0 && sy !== 0) {
        const k = Math.max(MIN_SIZE / t0.w, MIN_SIZE / t0.h, (newW / t0.w + newH / t0.h) / 2);
        newW = t0.w * k;
        newH = t0.h * k;
      }
      newW = Math.max(MIN_SIZE, newW);
      newH = Math.max(MIN_SIZE, newH);
      const shiftX = (sx * (newW - t0.w)) / 2;
      const shiftY = (sy * (newH - t0.h)) / 2;
      l.w = newW;
      l.h = newH;
      l.cx = t0.cx + shiftX * cos - shiftY * sin;
      l.cy = t0.cy + shiftX * sin + shiftY * cos;
    }
    state.force = true;
    layoutBox();
  }

  overlayEl.addEventListener('pointerdown', (e) => {
    const r = overlayEl.getBoundingClientRect();
    const hit = hitTest((e.clientX - r.left) / scale, (e.clientY - r.top) / scale);
    if (!hit) {
      selectLayer(null);
      return;
    }
    selectLayer(hit.id);
    startDrag('move', null, e, hit);
  });
  box.addEventListener('pointerdown', (e) => {
    const l = selected();
    if (!l || e.target.closest('.pe-handle') || e.target.closest('.pe-rotate-handle')) return;
    startDrag('move', null, e, l);
  });
  box.querySelectorAll('.pe-handle').forEach((el) => {
    el.addEventListener('pointerdown', (e) => {
      const l = selected();
      if (l) startDrag('resize', el.dataset.h, e, l);
    });
  });
  rotateHandle.addEventListener('pointerdown', (e) => {
    const l = selected();
    if (l) startDrag('rotate', null, e, l);
  });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', () => { drag = null; });
  window.addEventListener('pointercancel', () => { drag = null; });
  window.addEventListener('resize', layoutStage);
  document.addEventListener('keydown', (e) => {
    if (state.sel && (e.key === 'Delete' || e.key === 'Backspace')) removeLayer(state.sel);
  });

  // ---------- UI wiring ----------

  upload.addEventListener('click', (e) => {
    if (e.target.closest('#fx-remove')) return;
    input.click();
  });
  upload.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    if (input.files[0]) loadMain(input.files[0]);
  });
  btnRemove.addEventListener('click', (e) => {
    e.stopPropagation();
    clearMain();
  });
  ['dragover', 'dragenter'].forEach((ev) => $('#canvas-area').addEventListener(ev, (e) => {
    e.preventDefault();
    upload.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => $('#canvas-area').addEventListener(ev, () => upload.classList.remove('dragover')));
  $('#canvas-area').addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) loadMain(f);
  });

  document.querySelectorAll('.fx-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const k = chip.dataset.fx;
      state.effects[k] = !state.effects[k];
      chip.classList.toggle('active', state.effects[k]);
      chip.setAttribute('aria-pressed', String(state.effects[k]));
      if ((k === 'hue' || k === 'rage') && !isAnimated(state.main)) state.t = 0;
      state.force = true;
    });
  });

  btnPlay.addEventListener('click', () => setPlaying(!state.playing));

  // ---------- Export ----------

  const exportModal = $('#export-modal');
  const modalTitle = $('#modal-title');
  const modalSubtitle = $('#modal-subtitle');
  const modalActions = $('#modal-actions-done');
  const exportProgress = $('#export-progress');
  const exportPercent = $('#export-percent');
  const exportIcon = $('#export-icon');
  const btnDownload = $('#btn-download');

  function setProgress(pct) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    exportProgress.style.width = p + '%';
    exportPercent.textContent = p + '%';
  }

  function setIcon(done) {
    exportIcon.classList.toggle('done', done);
    exportIcon.innerHTML = done
      ? '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" /><polyline points="8 12 11 15 16 9" stroke-linecap="round" stroke-linejoin="round" /></svg>'
      : '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>';
  }

  // Output frames: { t, dur } — a long frame is cut in steps when something keeps moving over it
  function outputSteps(T) {
    const m = state.main;
    const moving = state.effects.hue || state.effects.rage || state.layers.some((l) => l.frames.length > 1);
    const steps = [];
    if (isAnimated(m)) {
      let t0 = 0;
      m.delays.forEach((dur) => {
        if (moving && dur > 120) {
          const n = Math.ceil(dur / SLICE_MS);
          for (let k = 0; k < n; k++) steps.push({ t: t0 + (dur / n) * k, dur: dur / n });
        } else {
          steps.push({ t: t0, dur });
        }
        t0 += dur;
      });
    } else if (T > 0) {
      const n = Math.ceil(T / SLICE_MS);
      for (let k = 0; k < n; k++) steps.push({ t: (T / n) * k, dur: T / n });
    } else {
      steps.push({ t: 0, dur: 100 });
    }
    return steps;
  }

  async function exportGif() {
    const m = state.main;
    if (!m) return;
    state.exportCancelled = false;
    exportModal.classList.remove('hidden');
    modalActions.classList.add('hidden');
    modalTitle.textContent = 'Génération du rendu...';
    modalSubtitle.textContent = 'Préparation des frames';
    setProgress(0);
    setIcon(false);

    const T = loopMs();
    const steps = outputSteps(T);
    const out = toCanvas(m.w, m.h);
    const oc = out.getContext('2d', { willReadFrequently: true });

    const rendered = [];
    const delays = [];
    let hasAlpha = false;
    let carry = 0;

    for (let n = 0; n < steps.length; n++) {
      if (state.exportCancelled) break;
      modalSubtitle.textContent = `Rendu de la frame ${n + 1} / ${steps.length}`;
      setProgress(((n + 1) / steps.length) * 50);

      renderAt(oc, steps[n].t, T);
      const id = oc.getImageData(0, 0, m.w, m.h);
      if (!hasAlpha) {
        const d = id.data;
        for (let p = 3; p < d.length; p += 4) {
          if (d[p] < 128) { hasAlpha = true; break; }
        }
      }
      rendered.push(id);

      // GIF delays are stored in 1/100 s: spread the rounding error so the total stays exact
      const wanted = steps[n].dur + carry;
      const cs = Math.max(2, Math.round(wanted / 10));
      carry = wanted - cs * 10;
      delays.push(cs * 10);
      await new Promise((r) => setTimeout(r, 0));
    }

    if (state.exportCancelled) {
      exportModal.classList.add('hidden');
      return;
    }

    modalSubtitle.textContent = 'Palette de couleurs...';
    await new Promise((r) => setTimeout(r, 0));
    const pal = Palette.build(rendered, hasAlpha);
    rendered.forEach((id) => Palette.quantize(id, pal));

    modalSubtitle.textContent = 'Encodage du GIF (qualité maximale)...';
    const gif = new GIF({
      workers: Math.min(8, Math.max(2, navigator.hardwareConcurrency || 2)),
      quality: 1,
      dither: false,
      globalPalette: pal.palette,
      width: m.w,
      height: m.h,
      transparent: hasAlpha ? (pal.key[0] << 16) | (pal.key[1] << 8) | pal.key[2] : null,
      workerScript: 'lib/gif.worker.js',
    });
    rendered.forEach((id, n) => gif.addFrame(id, { delay: delays[n] }));

    gif.on('progress', (p) => {
      if (!state.exportCancelled) setProgress(50 + p * 50);
    });
    gif.on('finished', (blob) => {
      if (state.exportCancelled) return;
      if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
      state.blobUrl = URL.createObjectURL(blob);
      btnDownload.href = state.blobUrl;
      modalActions.classList.remove('hidden');
      setIcon(true);
      modalTitle.textContent = 'Rendu terminé !';
      const total = delays.reduce((a, b) => a + b, 0);
      modalSubtitle.textContent = `${rendered.length} frames · ${(total / 1000).toFixed(2)} s · ${(blob.size / 1048576).toFixed(2)} Mo`;
      setProgress(100);
    });
    gif.render();
    state.activeGif = gif;
  }

  function closeExport() {
    state.exportCancelled = true;
    if (state.activeGif) {
      try { state.activeGif.abort(); } catch (e) { /* already finished */ }
      state.activeGif = null;
    }
    exportModal.classList.add('hidden');
  }

  btnRender.addEventListener('click', exportGif);
  $('#btn-close-export').addEventListener('click', closeExport);
  $('#export-modal .modal-backdrop').addEventListener('click', closeExport);

  buildOverlayGallery();
  requestAnimationFrame(tick);
})();
