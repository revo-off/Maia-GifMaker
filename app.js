/* ========================================
   Maia GifMaker — Application Logic
   Green Screen GIF Compositing Tool
   ======================================== */

(function () {
  'use strict';

  // ── State ──
  const state = {
    catalog: [],          // GIF catalog entries
    selectedGifId: null,  // Currently selected GIF id
    selectedEntry: null,  // Currently selected catalog entry
    transparentBackground: false, // Whether transparent background version is selected
    gifFrames: [],        // Decoded GIF frames (ImageData[])
    gifDelays: [],        // Frame delays in ms
    gifWidth: 0,
    gifHeight: 0,
    bgType: null,         // 'image' | 'video' | 'gif'
    bgImage: null,        // HTMLImageElement or HTMLVideoElement
    bgGifFrames: [],      // If bg is a GIF
    bgGifDelays: [],
    bgGifWidth: 0,
    bgGifHeight: 0,
    playing: true,
    currentFrame: 0,
    animationId: null,
    lastFrameTime: 0,
    exportCancelled: false,
    trackingData: [],     // Computed green screen bounding boxes and angles
  };

  // ── DOM Elements ──
  const $ = (sel) => document.querySelector(sel);
  const canvas = $('#preview-canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
  const bgCanvas = document.createElement('canvas');
  const bgCtx = bgCanvas.getContext('2d');

  // Gallery & Options
  const gifGallery = $('#gif-gallery');
  const chkTransparent = $('#chk-transparent');

  // Upload elements (background only)
  const uploadBg = $('#upload-bg');
  const inputBg = $('#input-bg');
  const bgInfo = $('#bg-info');
  const bgFilename = $('#bg-filename');

  // Controls
  const ctrlTolerance = $('#ctrl-tolerance');
  const ctrlChromaColor = $('#ctrl-chromacolor');
  const ctrlSpeed = $('#ctrl-speed');
  const ctrlQuality = $('#ctrl-quality');

  // Playback
  const playbackBar = $('#playback-bar');
  const btnPlay = $('#btn-play');
  const iconPlay = $('#icon-play');
  const iconPause = $('#icon-pause');
  const frameCounter = $('#frame-counter');
  const progressBar = $('#progress-bar');

  // Export
  const exportArea = $('#export-area');
  const btnExport = $('#btn-export');
  const exportModal = $('#export-modal');
  const exportProgress = $('#export-progress');
  const exportPercent = $('#export-percent');
  const modalTitle = $('#modal-title');
  const modalSubtitle = $('#modal-subtitle');
  const btnCancelExport = $('#btn-cancel-export');
  const btnDownload = $('#btn-download');

  // Others
  const emptyState = $('#empty-state');
  const loadingOverlay = $('#loading-overlay');
  const btnReset = $('#btn-reset');

  // ── Helpers ──
  function hexToRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return { r, g, b };
  }

  function colorDistance(r1, g1, b1, r2, g2, b2) {
    return Math.sqrt(
      (r1 - r2) ** 2 +
      (g1 - g2) ** 2 +
      (b1 - b2) ** 2
    );
  }

  // ── GIF Decoding ──
  async function decodeGif(arrayBuffer) {
    const gif = gifuct.parseGIF(arrayBuffer);
    const rawFrames = gifuct.decompressFrames(gif, true);

    const width = rawFrames[0].dims.width || gif.lsd.width;
    const height = rawFrames[0].dims.height || gif.lsd.height;

    // Use a full-size canvas to build complete frames
    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = width;
    fullCanvas.height = height;
    const fullCtx = fullCanvas.getContext('2d');

    const frames = [];
    const delays = [];

    for (let i = 0; i < rawFrames.length; i++) {
      const frame = rawFrames[i];
      const dims = frame.dims;

      // Create a temporary canvas for this frame's patch
      const patchCanvas = document.createElement('canvas');
      patchCanvas.width = dims.width;
      patchCanvas.height = dims.height;
      const patchCtx = patchCanvas.getContext('2d');
      const patchData = patchCtx.createImageData(dims.width, dims.height);
      patchData.data.set(frame.patch);
      patchCtx.putImageData(patchData, 0, 0);

      // Handle disposal
      if (i > 0) {
        const prevFrame = rawFrames[i - 1];
        if (prevFrame.disposalType === 2) {
          // Restore to background: clear only the previous frame area
          const pd = prevFrame.dims;
          fullCtx.clearRect(pd.left, pd.top, pd.width, pd.height);
        }
      }

      // Draw patch onto full canvas
      fullCtx.drawImage(patchCanvas, dims.left, dims.top);

      // Capture the full frame
      const fullImageData = fullCtx.getImageData(0, 0, width, height);
      frames.push(fullImageData);
      delays.push(frame.delay || 100);
    }

    return { frames, delays, width, height };
  }

  // ── GIF Loading (from URL) ──
  async function loadGifFromUrl(url) {
    loadingOverlay.classList.remove('hidden');

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Failed to fetch GIF');
      const buffer = await response.arrayBuffer();
      const { frames, delays, width, height } = await decodeGif(buffer);

      state.gifFrames = frames;
      state.gifDelays = delays;
      state.gifWidth = width;
      state.gifHeight = height;
      state.currentFrame = 0;
      updateTracking();

      canvas.width = width;
      canvas.height = height;
      tempCanvas.width = width;
      tempCanvas.height = height;
      bgCanvas.width = width;
      bgCanvas.height = height;

      // Update UI
      emptyState.classList.add('hidden');
      canvas.classList.add('active');
      playbackBar.classList.remove('hidden');
      exportArea.classList.remove('hidden');

      frameCounter.textContent = `1 / ${frames.length}`;

      // Start playback
      state.playing = true;
      updatePlayButton();
      startAnimation();
    } catch (err) {
      console.error('GIF decode error:', err);
      alert('Erreur lors du chargement du GIF. Veuillez réessayer.');
    } finally {
      loadingOverlay.classList.add('hidden');
    }
  }

  // ── Catalog & Gallery ──
  async function loadCatalog() {
    try {
      const response = await fetch('gifs/catalog.json');
      if (!response.ok) throw new Error('Catalog not found');
      state.catalog = await response.json();
      renderGallery();
    } catch (err) {
      console.error('Catalog load error:', err);
      gifGallery.innerHTML = '<div class="gallery-empty">Aucun GIF disponible</div>';
    }
  }

  function renderGallery() {
    gifGallery.innerHTML = '';

    if (state.catalog.length === 0) {
      gifGallery.innerHTML = '<div class="gallery-empty">Aucun GIF disponible</div>';
      return;
    }

    state.catalog.forEach((entry) => {
      const card = document.createElement('div');
      card.className = 'gif-card';
      card.dataset.id = entry.id;
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', entry.name);

      if (state.selectedGifId === entry.id) {
        card.classList.add('selected');
      }

      const img = document.createElement('img');
      img.src = `gifs/${entry.thumbnail}`;
      img.alt = entry.name;
      img.loading = 'lazy';

      const label = document.createElement('span');
      label.className = 'gif-card-label';
      label.textContent = entry.name;

      card.appendChild(img);
      card.appendChild(label);

      card.addEventListener('click', () => selectGif(entry));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectGif(entry);
        }
      });

      gifGallery.appendChild(card);
    });
  }

  function getGifFilename(entry, transparent) {
    if (!entry) return null;
    const baseName = entry.file.replace(/^gs/, '');
    return transparent ? baseName : (entry.file.startsWith('gs') ? entry.file : 'gs' + baseName);
  }

  async function selectGif(entry) {
    // Deselect previous
    const prev = gifGallery.querySelector('.gif-card.selected');
    if (prev) prev.classList.remove('selected');

    // Select new
    state.selectedGifId = entry.id;
    state.selectedEntry = entry;
    const card = gifGallery.querySelector(`[data-id="${entry.id}"]`);
    if (card) card.classList.add('selected');

    // Load the GIF (with or without 'gs' according to Fond transparent checkbox)
    const isTransparent = chkTransparent ? chkTransparent.checked : false;
    const filename = getGifFilename(entry, isTransparent);
    await loadGifFromUrl(`gifs/${filename}`);
  }

  // ── Background Loading ──
  async function loadBackground(file) {
    const type = file.type;

    if (type === 'image/gif') {
      // Decode GIF background
      loadingOverlay.classList.remove('hidden');
      try {
        const buffer = await file.arrayBuffer();
        const { frames, delays, width, height } = await decodeGif(buffer);
        state.bgType = 'gif';
        state.bgGifFrames = frames;
        state.bgGifDelays = delays;
        state.bgGifWidth = width;
        state.bgGifHeight = height;
        state.bgImage = null;
      } catch (err) {
        console.error('BG GIF decode error:', err);
        alert('Erreur lors du décodage du GIF d\'arrière-plan.');
      } finally {
        loadingOverlay.classList.add('hidden');
      }
    } else if (type.startsWith('video/')) {
      state.bgType = 'video';
      const video = document.createElement('video');
      video.src = URL.createObjectURL(file);
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = 'auto';
      await new Promise((resolve) => {
        video.onloadeddata = resolve;
        video.load();
      });
      video.play();
      state.bgImage = video;
      state.bgGifFrames = [];
    } else if (type.startsWith('image/')) {
      state.bgType = 'image';
      const img = new Image();
      img.src = URL.createObjectURL(file);
      await new Promise((resolve) => {
        img.onload = resolve;
      });
      state.bgImage = img;
      state.bgGifFrames = [];
    }

    bgInfo.classList.remove('hidden');
    uploadBg.classList.add('hidden');
    bgFilename.textContent = file.name;
  }

  // ── Auto-Tracking & Compositing ──
  function computeTrackingData(frames, chromaColor, tolerance) {
    if (!frames || frames.length === 0) return [];

    const rawBoxes = [];
    for (let f = 0; f < frames.length; f++) {
      const frame = frames[f];
      const data = frame.data;
      const w = frame.width;
      const h = frame.height;

      let count = 0;
      let sumX = 0, sumY = 0;
      let minX = w, maxX = -1, minY = h, maxY = -1;
      const pts = [];

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = (y * w + x) * 4;
          const a = data[idx + 3];
          if (a < 50) continue;

          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          const dist = colorDistance(r, g, b, chromaColor.r, chromaColor.g, chromaColor.b);

          if (dist < tolerance) {
            count++;
            sumX += x;
            sumY += y;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            pts.push(x, y);
          }
        }
      }

      if (count < 25) {
        rawBoxes.push(null);
      } else {
        const cx = sumX / count;
        const cy = sumY / count;
        const boxW = maxX - minX + 1;
        const boxH = maxY - minY + 1;

        // Calculate orientation angle using central moments
        let m20 = 0, m02 = 0, m11 = 0;
        for (let p = 0; p < pts.length; p += 2) {
          const dx = pts[p] - cx;
          const dy = pts[p + 1] - cy;
          m20 += dx * dx;
          m02 += dy * dy;
          m11 += dx * dy;
        }
        const angle = 0.5 * Math.atan2(2 * m11, m20 - m02);

        rawBoxes.push({
          count,
          minX,
          maxX,
          minY,
          maxY,
          w: boxW,
          h: boxH,
          cx,
          cy,
          angle,
        });
      }
    }

    // Smoothing pass to eliminate jitter across adjacent frames
    const smoothed = [];
    let prev = null;
    for (let i = 0; i < rawBoxes.length; i++) {
      const cur = rawBoxes[i];
      if (!cur) {
        smoothed.push(null);
        prev = null;
        continue;
      }
      if (!prev) {
        smoothed.push({ ...cur });
        prev = cur;
        continue;
      }

      const weight = Math.min(1, cur.count / 800);
      const angle = prev.angle + weight * (cur.angle - prev.angle);
      const cx = prev.cx * 0.2 + cur.cx * 0.8;
      const cy = prev.cy * 0.2 + cur.cy * 0.8;
      const w = prev.w * 0.2 + cur.w * 0.8;
      const h = prev.h * 0.2 + cur.h * 0.8;

      const item = {
        ...cur,
        cx,
        cy,
        w,
        h,
        angle,
      };
      smoothed.push(item);
      prev = item;
    }

    return smoothed;
  }

  function updateTracking() {
    if (state.gifFrames.length === 0) return;
    const tolerance = parseFloat(ctrlTolerance.value);
    const chromaColor = hexToRgb(ctrlChromaColor.value);
    state.trackingData = computeTrackingData(state.gifFrames, chromaColor, tolerance);
  }

  function drawBackground(targetCtx, w, h, frameIndex) {
    if (!state.bgType) return;

    let bgSource = null;
    let bgW = w;
    let bgH = h;

    if (state.bgType === 'image' && state.bgImage) {
      bgSource = state.bgImage;
      bgW = state.bgImage.naturalWidth || state.bgImage.width;
      bgH = state.bgImage.naturalHeight || state.bgImage.height;
    } else if (state.bgType === 'video' && state.bgImage) {
      bgSource = state.bgImage;
      bgW = state.bgImage.videoWidth;
      bgH = state.bgImage.videoHeight;
    } else if (state.bgType === 'gif' && state.bgGifFrames.length > 0) {
      const bgFrameIdx = frameIndex % state.bgGifFrames.length;
      bgCanvas.width = state.bgGifWidth;
      bgCanvas.height = state.bgGifHeight;
      bgCtx.putImageData(state.bgGifFrames[bgFrameIdx], 0, 0);
      bgSource = bgCanvas;
      bgW = state.bgGifWidth;
      bgH = state.bgGifHeight;
    }

    if (!bgSource || bgW === 0 || bgH === 0) return;

    targetCtx.save();

    // Track and scale to the green screen card
    const bbox = state.trackingData && state.trackingData[frameIndex];
    if (!bbox) {
      targetCtx.restore();
      return;
    }

    // Clip strictly to green screen bounding box (with slight margin for smooth edge blending)
    targetCtx.beginPath();
    targetCtx.rect(bbox.minX - 1, bbox.minY - 1, bbox.w + 2, bbox.h + 2);
    targetCtx.clip();

    // Center and rotate to match the green screen orientation
    targetCtx.translate(bbox.cx, bbox.cy);
    if (bbox.angle) {
      targetCtx.rotate(bbox.angle);
    }

    // Scale to cover the green screen area
    const cos = Math.abs(Math.cos(bbox.angle || 0));
    const sin = Math.abs(Math.sin(bbox.angle || 0));
    const targetW = bbox.w * cos + bbox.h * sin;
    const targetH = bbox.w * sin + bbox.h * cos;
    const coverScale = Math.max(targetW / bgW, targetH / bgH);
    const drawW = bgW * coverScale;
    const drawH = bgH * coverScale;

    targetCtx.drawImage(bgSource, -drawW / 2, -drawH / 2, drawW, drawH);
    targetCtx.restore();
  }

  function compositeFrame(frameIndex) {
    if (state.gifFrames.length === 0) return;

    const frame = state.gifFrames[frameIndex];
    const w = state.gifWidth;
    const h = state.gifHeight;

    const tolerance = parseFloat(ctrlTolerance.value);
    const chromaColor = hexToRgb(ctrlChromaColor.value);

    // Clear canvas
    ctx.clearRect(0, 0, w, h);

    // Draw background
    drawBackground(ctx, w, h, frameIndex);

    // Apply chroma key: make green pixels transparent
    tempCtx.clearRect(0, 0, w, h);
    tempCtx.putImageData(frame, 0, 0);

    // Get the frame pixel data for chroma keying
    const frameData = tempCtx.getImageData(0, 0, w, h);
    const data = frameData.data;

    // Apply chroma key: make green pixels transparent
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      if (a === 0) continue;

      const dist = colorDistance(r, g, b, chromaColor.r, chromaColor.g, chromaColor.b);

      if (dist < tolerance) {
        data[i + 3] = 0;
      } else if (dist < tolerance * 1.4) {
        const blend = (dist - tolerance) / (tolerance * 0.4);
        data[i + 3] = Math.round(a * Math.min(1, blend));
      }
    }

    tempCtx.putImageData(frameData, 0, 0);

    // Draw chroma-keyed frame on top of background
    ctx.drawImage(tempCanvas, 0, 0);
  }

  // ── Animation Loop ──
  function startAnimation() {
    stopAnimation();
    state.lastFrameTime = performance.now();
    animate();
  }

  function stopAnimation() {
    if (state.animationId) {
      cancelAnimationFrame(state.animationId);
      state.animationId = null;
    }
  }

  function animate() {
    if (!state.playing || state.gifFrames.length === 0) {
      // Still render current frame
      compositeFrame(state.currentFrame);
      return;
    }

    const now = performance.now();
    const speed = parseFloat(ctrlSpeed.value);
    const delay = (state.gifDelays[state.currentFrame] || 100) / speed;

    if (now - state.lastFrameTime >= delay) {
      state.currentFrame = (state.currentFrame + 1) % state.gifFrames.length;
      state.lastFrameTime = now;
    }

    compositeFrame(state.currentFrame);

    // Update UI
    frameCounter.textContent = `${state.currentFrame + 1} / ${state.gifFrames.length}`;
    const progress = ((state.currentFrame + 1) / state.gifFrames.length) * 100;
    progressBar.style.width = progress + '%';

    state.animationId = requestAnimationFrame(animate);
  }

  function updatePlayButton() {
    if (state.playing) {
      iconPlay.classList.add('hidden');
      iconPause.classList.remove('hidden');
    } else {
      iconPlay.classList.remove('hidden');
      iconPause.classList.add('hidden');
    }
  }

  // ── Export ──
  async function exportGif() {
    if (state.gifFrames.length === 0) return;

    state.exportCancelled = false;
    exportModal.classList.remove('hidden');
    btnDownload.classList.add('hidden');
    btnCancelExport.classList.remove('hidden');
    modalTitle.textContent = 'Exportation en cours...';
    modalSubtitle.textContent = 'Préparation des frames';
    exportProgress.style.width = '0%';
    exportPercent.textContent = '0%';

    // Reset modal icon animation
    const modalIcon = $('.modal-icon');
    modalIcon.classList.remove('done');

    const w = state.gifWidth;
    const h = state.gifHeight;
    const quality = parseInt(ctrlQuality.value);
    const speed = parseFloat(ctrlSpeed.value);

    // Create GIF encoder
    const gif = new GIF({
      workers: 2,
      quality: quality,
      width: w,
      height: h,
      workerScript: 'lib/gif.worker.js',
    });

    // Render each frame
    const renderCanvas = document.createElement('canvas');
    renderCanvas.width = w;
    renderCanvas.height = h;
    const renderCtx = renderCanvas.getContext('2d', { willReadFrequently: true });
    const renderTemp = document.createElement('canvas');
    renderTemp.width = w;
    renderTemp.height = h;
    const renderTempCtx = renderTemp.getContext('2d', { willReadFrequently: true });
    const renderBg = document.createElement('canvas');
    const renderBgCtx = renderBg.getContext('2d');

    for (let i = 0; i < state.gifFrames.length; i++) {
      if (state.exportCancelled) {
        gif.abort();
        exportModal.classList.add('hidden');
        return;
      }

      const pct = Math.round(((i + 1) / state.gifFrames.length) * 100);
      modalSubtitle.textContent = `Frame ${i + 1} / ${state.gifFrames.length}`;
      exportProgress.style.width = pct + '%';
      exportPercent.textContent = pct + '%';

      // Render frame to export canvas
      const frame = state.gifFrames[i];
      const tolerance = parseFloat(ctrlTolerance.value);
      const chromaColor = hexToRgb(ctrlChromaColor.value);

      renderCtx.clearRect(0, 0, w, h);

      // Draw background
      drawBackground(renderCtx, w, h, i);

      // Chroma key
      renderTempCtx.clearRect(0, 0, w, h);
      renderTempCtx.putImageData(frame, 0, 0);
      const frameData = renderTempCtx.getImageData(0, 0, w, h);
      const data = frameData.data;

      for (let j = 0; j < data.length; j += 4) {
        const r = data[j];
        const g = data[j + 1];
        const b = data[j + 2];
        const a = data[j + 3];
        if (a === 0) continue;

        const dist = colorDistance(r, g, b, chromaColor.r, chromaColor.g, chromaColor.b);
        if (dist < tolerance) {
          data[j + 3] = 0;
        } else if (dist < tolerance * 1.4) {
          const blend = (dist - tolerance) / (tolerance * 0.4);
          data[j + 3] = Math.round(a * Math.min(1, blend));
        }
      }

      renderTempCtx.putImageData(frameData, 0, 0);
      renderCtx.drawImage(renderTemp, 0, 0);

      const delay = (state.gifDelays[i] || 100) / speed;
      gif.addFrame(renderCtx, { copy: true, delay: Math.max(20, Math.round(delay)) });

      // Yield to keep UI responsive
      await new Promise((r) => setTimeout(r, 0));
    }

    // Render
    modalSubtitle.textContent = 'Encodage du GIF...';

    gif.on('finished', (blob) => {
      if (state.exportCancelled) return;

      const url = URL.createObjectURL(blob);
      btnDownload.href = url;
      btnDownload.classList.remove('hidden');
      btnCancelExport.classList.add('hidden');

      modalIcon.classList.add('done');
      modalTitle.textContent = 'Exportation terminée !';
      const sizeMB = (blob.size / (1024 * 1024)).toFixed(2);
      modalSubtitle.textContent = `Taille: ${sizeMB} Mo`;
      exportProgress.style.width = '100%';
      exportPercent.textContent = '100%';
    });

    gif.render();
  }

  // ── Event Handlers ──

  // Background upload
  function setupUpload(zone, input, handler) {
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });

    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handler(file);
    });

    // Drag & Drop
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    });

    zone.addEventListener('dragleave', () => {
      zone.classList.remove('dragover');
    });

    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) handler(file);
    });
  }

  setupUpload(uploadBg, inputBg, loadBackground);

  $('#btn-remove-bg').addEventListener('click', () => {
    if (state.bgType === 'video' && state.bgImage) {
      state.bgImage.pause();
      URL.revokeObjectURL(state.bgImage.src);
    }
    state.bgType = null;
    state.bgImage = null;
    state.bgGifFrames = [];
    bgInfo.classList.add('hidden');
    uploadBg.classList.remove('hidden');
    inputBg.value = '';
  });

  // Play/Pause
  btnPlay.addEventListener('click', () => {
    state.playing = !state.playing;
    updatePlayButton();
    if (state.playing) {
      startAnimation();
    }
  });

  // Progress bar click
  $('.progress-bar-container').addEventListener('click', (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    state.currentFrame = Math.floor(ratio * state.gifFrames.length);
    compositeFrame(state.currentFrame);
  });

  // Controls - update value displays
  const controlMappings = [
    { ctrl: ctrlTolerance, valId: 'val-tolerance', format: (v) => v },
    { ctrl: ctrlSpeed, valId: 'val-speed', format: (v) => parseFloat(v).toFixed(1) + 'x' },
    { ctrl: ctrlQuality, valId: 'val-quality', format: (v) => v },
  ];

  controlMappings.forEach(({ ctrl, valId, format }) => {
    ctrl.addEventListener('input', () => {
      $(`#${valId}`).textContent = format(ctrl.value);
      if (ctrl === ctrlTolerance) {
        updateTracking();
      }
      // Re-render current frame if paused
      if (!state.playing && state.gifFrames.length > 0) {
        compositeFrame(state.currentFrame);
      }
    });
  });

  ctrlChromaColor.addEventListener('input', () => {
    $('#val-chromacolor').textContent = ctrlChromaColor.value;
    updateTracking();
    if (!state.playing && state.gifFrames.length > 0) {
      compositeFrame(state.currentFrame);
    }
  });

  // Export
  btnExport.addEventListener('click', exportGif);

  btnCancelExport.addEventListener('click', () => {
    state.exportCancelled = true;
    exportModal.classList.add('hidden');
  });

  // Close modal by clicking backdrop
  $('.modal-backdrop').addEventListener('click', () => {
    if (btnDownload.classList.contains('hidden')) {
      // Export in progress, cancel it
      state.exportCancelled = true;
    }
    exportModal.classList.add('hidden');
  });

  // Transparent Background Toggle
  if (chkTransparent) {
    chkTransparent.addEventListener('change', async () => {
      state.transparentBackground = chkTransparent.checked;
      const entry = state.selectedEntry || (state.catalog.length > 0 ? (state.catalog.find(e => e.id === state.selectedGifId) || state.catalog[0]) : null);
      if (entry) {
        state.selectedEntry = entry;
        const filename = getGifFilename(entry, chkTransparent.checked);
        await loadGifFromUrl(`gifs/${filename}`);
      }
    });
  }

  // Reset
  btnReset.addEventListener('click', () => {
    stopAnimation();

    // Reset GIF selection
    state.selectedGifId = null;
    state.selectedEntry = null;
    state.transparentBackground = false;
    if (chkTransparent) chkTransparent.checked = false;
    state.gifFrames = [];
    state.gifDelays = [];
    state.currentFrame = 0;
    state.trackingData = [];
    canvas.classList.remove('active');
    emptyState.classList.remove('hidden');
    playbackBar.classList.add('hidden');
    exportArea.classList.add('hidden');

    // Deselect gallery cards
    const selected = gifGallery.querySelector('.gif-card.selected');
    if (selected) selected.classList.remove('selected');

    // Reset BG
    if (state.bgType === 'video' && state.bgImage) {
      state.bgImage.pause();
      URL.revokeObjectURL(state.bgImage.src);
    }
    state.bgType = null;
    state.bgImage = null;
    state.bgGifFrames = [];
    bgInfo.classList.add('hidden');
    uploadBg.classList.remove('hidden');
    inputBg.value = '';

    // Reset controls
    ctrlTolerance.value = 100;
    ctrlChromaColor.value = '#00ff00';
    ctrlSpeed.value = 1;
    ctrlQuality.value = 10;

    // Reset labels
    $('#val-tolerance').textContent = '100';
    $('#val-chromacolor').textContent = '#00ff00';
    $('#val-speed').textContent = '1.0x';
    $('#val-quality').textContent = '10';

    ctx.clearRect(0, 0, canvas.width, canvas.height);
  });

  // ── Prevent default drag on page ──
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  // ── Initialize: Load Catalog ──
  loadCatalog();

})();
