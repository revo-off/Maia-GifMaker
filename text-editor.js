(function () {
  'use strict';

  // Text editor: renders a template (texts/templates.json) + user text with a font
  // (texts/fonts.json) to a canvas, then hands it to the app as the background.

  const $ = (sel) => document.querySelector(sel);
  const modal = $('#text-modal');
  const btnOpen = $('#btn-edit-text');
  const templatesEl = $('#te-templates');
  const previewCanvas = $('#te-preview');
  const textArea = $('#te-text');
  const colorInput = $('#te-color');
  const fontTrigger = $('#te-font-trigger');
  const fontName = $('#te-font-name');
  const fontMenu = $('#te-font-menu');

  const RENDER_SCALE = 2;

  let templates = [];
  let fonts = [];
  let fontsReady = null;
  const doc = { templateId: null, text: 'texte', fontId: null, color: '#111111', images: [], sel: null };

  function fontById(id) {
    return fonts.find((f) => f.id === id) || null;
  }

  function cssFamily(idOrFamily) {
    const f = fontById(idOrFamily);
    return `"${f ? f.family : idOrFamily}"`;
  }

  async function loadJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.json();
  }

  // Fonts come either from Google Fonts ("google") or from a local file ("file")
  function loadFonts() {
    const jobs = fonts.map(async (f) => {
      const weights = f.weights && f.weights.length ? f.weights : [400];
      if (f.file) {
        await Promise.all(weights.map(async (w) => {
          const face = new FontFace(f.family, `url(${f.file})`, { weight: String(w) });
          document.fonts.add(await face.load());
        }));
      } else if (f.google) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?family=${f.google}&display=swap`;
        document.head.appendChild(link);
        await Promise.all(weights.map((w) => document.fonts.load(`${w} 40px "${f.family}"`)));
      }
    });
    return Promise.allSettled(jobs);
  }

  function drawHeart(c, cx, cy, size, color) {
    const s = size / 100;
    c.save();
    c.translate(cx - 50 * s, cy - 45 * s);
    c.scale(s, s);
    c.beginPath();
    c.moveTo(50, 90);
    c.bezierCurveTo(5, 58, -8, 30, 15, 12);
    c.bezierCurveTo(32, -1, 46, 8, 50, 24);
    c.bezierCurveTo(54, 8, 68, -1, 85, 12);
    c.bezierCurveTo(108, 30, 95, 58, 50, 90);
    c.closePath();
    c.fillStyle = color;
    c.fill();
    c.restore();
  }

  function roundRectPath(c, x, y, w, h, r) {
    c.beginPath();
    if (typeof c.roundRect === 'function') {
      c.roundRect(x, y, w, h, r);
    } else {
      c.rect(x, y, w, h);
    }
  }

  function wrapLines(c, text, maxW) {
    const out = [];
    text.split('\n').forEach((paragraph) => {
      if (paragraph.trim() === '') {
        out.push('');
        return;
      }
      let line = '';
      paragraph.split(/\s+/).filter(Boolean).forEach((word) => {
        const test = line ? `${line} ${word}` : word;
        if (!line || c.measureText(test).width <= maxW) {
          line = test;
        } else {
          out.push(line);
          line = word;
        }
      });
      out.push(line);
    });
    return out;
  }

  // Largest font size at which the wrapped text fits in the box
  function fitText(c, layer, text, family, weight) {
    const maxSize = layer.maxSize || 200;
    const minSize = layer.minSize || 20;
    const lineHeight = layer.lineHeight || 1.1;
    let size = maxSize;
    let lines = [];
    for (; size >= minSize; size -= 2) {
      c.font = `${weight} ${size}px ${family}`;
      lines = wrapLines(c, text, layer.w);
      const widest = Math.max(...lines.map((l) => c.measureText(l).width), 0);
      if (lines.length * size * lineHeight <= layer.h && widest <= layer.w) break;
    }
    size = Math.max(size, minSize);
    c.font = `${weight} ${size}px ${family}`;
    return { size, lines, lineHeight };
  }

  // Logical canvas = the green area of the GIF (same aspect ratio), template width as reference
  function canvasSize(tpl) {
    const green = window.GifMaker.getGreenSize();
    const aspect = green ? green.w / green.h : tpl.width / tpl.height;
    return { W: tpl.width, H: Math.round(tpl.width / aspect) };
  }

  function renderTemplate(tpl, canvas, scale) {
    const { W, H } = canvasSize(tpl);
    canvas.width = Math.round(W * scale);
    canvas.height = Math.round(H * scale);
    const c = canvas.getContext('2d');
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.clearRect(0, 0, W, H);
    if (tpl.background) { // null = transparent
      c.fillStyle = tpl.background;
      c.fillRect(0, 0, W, H);
    }

    // The template design is fitted (contain) and centered in the canvas
    const fit = Math.min(W / tpl.width, H / tpl.height);
    c.save();
    c.translate((W - tpl.width * fit) / 2, (H - tpl.height * fit) / 2);
    c.scale(fit, fit);
    tpl.layers.forEach((layer) => {
      c.save();
      if (layer.type === 'text') {
        // "@selected" follows the font (and bold) chosen by the user
        const following = layer.font === '@selected';
        const family = following ? cssFamily(doc.fontId || tpl.defaultFont) : cssFamily(layer.font);
        const weight = following ? 400 : (layer.weight || 400);
        c.font = `${weight} ${layer.size}px ${family}`;
        c.fillStyle = following ? doc.color : (layer.color || '#000');
        c.textAlign = layer.align || 'left';
        c.textBaseline = 'alphabetic';
        c.fillText(layer.text, layer.x, layer.y);
      } else if (layer.type === 'shape' && layer.shape === 'heart') {
        drawHeart(c, layer.x, layer.y, layer.size, layer.color || '#f33');
      } else if (layer.type === 'rect') {
        roundRectPath(c, layer.x, layer.y, layer.w, layer.h, layer.radius || 0);
        if (layer.fill) {
          c.fillStyle = layer.fill;
          c.fill();
        }
        if (layer.stroke) {
          c.strokeStyle = layer.stroke;
          c.lineWidth = layer.lineWidth || 4;
          c.stroke();
        }
      } else if (layer.type === 'input') {
        const family = cssFamily(doc.fontId || tpl.defaultFont);
        const weight = layer.weight || 400;
        const align = layer.align || 'center';
        const { size, lines, lineHeight } = fitText(c, layer, doc.text, family, weight);
        const blockH = lines.length * size * lineHeight;
        const top = layer.valign === 'top' ? layer.y
          : layer.valign === 'bottom' ? layer.y + layer.h - blockH
            : layer.y + (layer.h - blockH) / 2;
        const x = align === 'left' ? layer.x : align === 'right' ? layer.x + layer.w : layer.x + layer.w / 2;
        c.fillStyle = doc.color;
        c.textAlign = align;
        c.textBaseline = 'middle';
        lines.forEach((line, i) => {
          c.fillText(line, x, top + (i + 0.5) * size * lineHeight);
        });
      }
      c.restore();
    });
    c.restore();

    doc.images.forEach((im) => {
      c.save();
      c.imageSmoothingQuality = 'high';
      c.translate(im.cx, im.cy);
      c.rotate(im.rot);
      c.drawImage(im.img, -im.w / 2, -im.h / 2, im.w, im.h);
      c.restore();
    });
  }

  function currentTemplate() {
    return templates.find((t) => t.id === doc.templateId) || templates[0];
  }

  function renderThumbs() {
    Array.from(templatesEl.children).forEach((btn, i) => {
      const tpl = templates[i];
      const thumb = btn.querySelector('canvas');
      const full = document.createElement('canvas');
      renderTemplate(tpl, full, 0.5);
      thumb.height = Math.round(thumb.width * full.height / full.width);
      const c = thumb.getContext('2d');
      c.clearRect(0, 0, thumb.width, thumb.height);
      c.imageSmoothingQuality = 'high';
      c.drawImage(full, 0, 0, thumb.width, thumb.height);
    });
  }

  let rafId = 0;
  function refresh(thumbs = true) {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      if (templates.length === 0) return;
      renderTemplate(currentTemplate(), previewCanvas, 1);
      layoutOverlay();
      if (thumbs) renderThumbs();
    });
  }

  function syncToolbar() {
    colorInput.value = doc.color;
    const f = fontById(doc.fontId);
    fontName.textContent = f ? f.name : 'Police';
    fontName.style.fontFamily = f ? cssFamily(f.id) : '';
    templatesEl.querySelectorAll('.te-template').forEach((b) => {
      b.classList.toggle('active', b.dataset.id === doc.templateId);
    });
  }

  function buildTemplates() {
    templatesEl.innerHTML = '';
    templates.forEach((tpl) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'te-template';
      btn.dataset.id = tpl.id;
      const thumb = document.createElement('canvas');
      thumb.width = 120;
      thumb.height = Math.round(120 * tpl.height / tpl.width);
      const label = document.createElement('span');
      label.textContent = tpl.name;
      btn.append(thumb, label);
      btn.addEventListener('click', () => {
        doc.templateId = tpl.id;
        syncToolbar();
        refresh(false);
      });
      templatesEl.appendChild(btn);
    });
  }

  function buildFontMenu() {
    fontMenu.innerHTML = '';
    fonts.forEach((f) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'te-font-item';
      item.textContent = f.name;
      item.style.fontFamily = cssFamily(f.id);
      item.addEventListener('click', () => {
        doc.fontId = f.id;
        fontMenu.classList.add('hidden');
        syncToolbar();
        refresh();
      });
      fontMenu.appendChild(item);
    });
  }

  async function init() {
    try {
      [templates, fonts] = await Promise.all([
        loadJson('texts/templates.json'),
        loadJson('texts/fonts.json'),
      ]);
    } catch (err) {
      console.error('Text editor data error:', err);
      btnOpen.classList.add('hidden');
      return;
    }
    doc.templateId = templates[0].id;
    doc.fontId = templates[0].defaultFont || (fonts[0] && fonts[0].id);
    textArea.value = doc.text;
    buildTemplates();
    buildFontMenu();
    syncToolbar();
    fontsReady = loadFonts();
    fontsReady.then(() => refresh());
  }

  function syncCanvasHeight() {
    const { H } = canvasSize(currentTemplate());
    if (doc.lastH && doc.lastH !== H) {
      doc.images.forEach((im) => {
        im.cy *= H / doc.lastH;
      });
    }
    doc.lastH = H;
  }

  async function open() {
    syncCanvasHeight();
    modal.classList.remove('hidden');
    textArea.value = doc.text;
    syncToolbar();
    if (fontsReady) await fontsReady;
    refresh();
    textArea.focus();
  }

  function close() {
    modal.classList.add('hidden');
    fontMenu.classList.add('hidden');
  }

  function apply() {
    const out = document.createElement('canvas');
    renderTemplate(currentTemplate(), out, RENDER_SCALE);
    const preview = doc.text.replace(/\s+/g, ' ').trim().slice(0, 24);
    window.GifMaker.setBackgroundFromCanvas(out, `Texte : ${preview || '(vide)'}`);
    close();
  }

  textArea.addEventListener('input', () => {
    doc.text = textArea.value;
    refresh();
  });
  colorInput.addEventListener('input', () => {
    doc.color = colorInput.value;
    refresh();
  });
  fontTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    fontMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#te-font-picker')) fontMenu.classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) close();
  });

  // ---- Images placed on the text (move / resize / rotate) ----
  const overlay = $('#te-overlay');
  const box = $('#te-box');
  const rotateHandle = $('#te-rotate-handle');
  const imageInput = $('#te-image-input');
  const imageList = $('#te-image-list');
  const MIN_SIZE = 12;
  let scale = 1;
  let drag = null;
  let imageSeq = 0;

  function selectedImage() {
    return doc.images.find((im) => im.id === doc.sel) || null;
  }

  function layoutOverlay() {
    const tpl = currentTemplate();
    if (!tpl) return;
    const stage = $('#te-stage').getBoundingClientRect();
    const rect = previewCanvas.getBoundingClientRect();
    scale = rect.width / canvasSize(tpl).W || 1;
    overlay.style.left = (rect.left - stage.left) + 'px';
    overlay.style.top = (rect.top - stage.top) + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    layoutBox();
  }

  function layoutBox() {
    const im = selectedImage();
    box.classList.toggle('hidden', !im);
    if (!im) return;
    box.style.width = (im.w * scale) + 'px';
    box.style.height = (im.h * scale) + 'px';
    box.style.left = ((im.cx - im.w / 2) * scale) + 'px';
    box.style.top = ((im.cy - im.h / 2) * scale) + 'px';
    box.style.transform = `rotate(${im.rot}rad)`;
  }

  function renderImageList() {
    imageList.innerHTML = '';
    if (doc.images.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'te-hint';
      hint.textContent = "Aucune image. Cliquez sur une image dans l'aperçu pour la déplacer, la redimensionner ou la faire pivoter.";
      imageList.appendChild(hint);
      return;
    }
    doc.images.forEach((im) => {
      const chip = document.createElement('div');
      chip.className = 'te-chip' + (im.id === doc.sel ? ' active' : '');
      const thumb = document.createElement('img');
      thumb.src = im.img.src;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'te-chip-remove';
      remove.title = 'Supprimer';
      remove.textContent = '×';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        removeImage(im.id);
      });
      chip.append(thumb, remove);
      chip.addEventListener('click', () => selectImage(im.id));
      imageList.appendChild(chip);
    });
  }

  function selectImage(id) {
    doc.sel = id;
    renderImageList();
    layoutBox();
  }

  function removeImage(id) {
    doc.images = doc.images.filter((im) => im.id !== id);
    if (doc.sel === id) doc.sel = null;
    renderImageList();
    layoutBox();
    refresh();
  }

  function addImageFile(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const tpl = currentTemplate();
      const ratio = img.naturalWidth / img.naturalHeight;
      const { W, H } = canvasSize(tpl);
      let w = Math.min(img.naturalWidth, W * 0.35);
      let h = w / ratio;
      if (h > H * 0.5) {
        h = H * 0.5;
        w = h * ratio;
      }
      const im = { id: ++imageSeq, img, cx: W / 2, cy: H / 2, w, h, rot: 0 };
      doc.images.push(im);
      selectImage(im.id);
      refresh();
    };
    img.src = url;
  }

  // Topmost image under a point given in template coordinates
  function hitTest(px, py) {
    for (let i = doc.images.length - 1; i >= 0; i--) {
      const im = doc.images[i];
      const dx = px - im.cx;
      const dy = py - im.cy;
      const cos = Math.cos(im.rot);
      const sin = Math.sin(im.rot);
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;
      if (Math.abs(lx) <= im.w / 2 && Math.abs(ly) <= im.h / 2) return im;
    }
    return null;
  }

  function startDrag(mode, handle, e, im) {
    e.preventDefault();
    e.stopPropagation();
    drag = { mode, handle, id: im.id, startX: e.clientX, startY: e.clientY, t0: { ...im }, angle0: 0, center: null };
    if (mode === 'rotate') {
      const r = overlay.getBoundingClientRect();
      const sx = r.left + im.cx * scale;
      const sy = r.top + im.cy * scale;
      drag.angle0 = Math.atan2(e.clientY - sy, e.clientX - sx);
      drag.center = { x: sx, y: sy };
    }
  }

  function onMove(e) {
    if (!drag) return;
    const im = doc.images.find((x) => x.id === drag.id);
    if (!im) return;
    const t0 = drag.t0;
    const dx = (e.clientX - drag.startX) / scale;
    const dy = (e.clientY - drag.startY) / scale;

    if (drag.mode === 'move') {
      im.cx = t0.cx + dx;
      im.cy = t0.cy + dy;
    } else if (drag.mode === 'rotate') {
      const a = Math.atan2(e.clientY - drag.center.y, e.clientX - drag.center.x);
      let rot = t0.rot + (a - drag.angle0);
      if (e.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12);
      im.rot = rot;
    } else {
      // Resize in the image's own axes, the opposite side stays fixed
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
      const shiftX = sx * (newW - t0.w) / 2;
      const shiftY = sy * (newH - t0.h) / 2;
      im.w = newW;
      im.h = newH;
      im.cx = t0.cx + shiftX * cos - shiftY * sin;
      im.cy = t0.cy + shiftX * sin + shiftY * cos;
    }
    layoutBox();
    refresh(false);
  }

  overlay.addEventListener('pointerdown', (e) => {
    const r = overlay.getBoundingClientRect();
    const hit = hitTest((e.clientX - r.left) / scale, (e.clientY - r.top) / scale);
    if (!hit) {
      selectImage(null);
      return;
    }
    selectImage(hit.id);
    startDrag('move', null, e, hit);
  });
  box.addEventListener('pointerdown', (e) => {
    const im = selectedImage();
    if (!im || e.target.closest('.pe-handle') || e.target.closest('.pe-rotate-handle')) return;
    startDrag('move', null, e, im);
  });
  box.querySelectorAll('.pe-handle').forEach((el) => {
    el.addEventListener('pointerdown', (e) => {
      const im = selectedImage();
      if (im) startDrag('resize', el.dataset.h, e, im);
    });
  });
  rotateHandle.addEventListener('pointerdown', (e) => {
    const im = selectedImage();
    if (im) startDrag('rotate', null, e, im);
  });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', () => {
    if (drag) refresh();
    drag = null;
  });
  window.addEventListener('pointercancel', () => { drag = null; });
  window.addEventListener('resize', () => {
    if (!modal.classList.contains('hidden')) layoutOverlay();
  });

  $('#te-add-image').addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', () => {
    Array.from(imageInput.files).forEach(addImageFile);
    imageInput.value = '';
  });
  document.addEventListener('keydown', (e) => {
    if (modal.classList.contains('hidden') || !doc.sel) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target instanceof HTMLTextAreaElement)) {
      removeImage(doc.sel);
    }
  });

  btnOpen.addEventListener('click', open);
  $('#te-btn-close').addEventListener('click', close);
  $('#te-btn-cancel').addEventListener('click', close);
  $('#te-btn-apply').addEventListener('click', apply);

  init();
})();
