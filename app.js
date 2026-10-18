(function () {
  'use strict';

  const state = {
    catalog: [],
    selectedGifId: null,
    selectedEntry: null,
    transparentBackground: false,
    gifFrames: [],
    gifDelays: [],
    gifWidth: 0,
    gifHeight: 0,
    bgType: null,
    bgImage: null,
    bgGifFrames: [],
    bgGifDelays: [],
    bgGifWidth: 0,
    bgGifHeight: 0,
    bgCurrentFrame: 0,
    lastBgFrameTime: 0,
    playing: true,
    currentFrame: 0,
    animationId: null,
    lastFrameTime: 0,
    exportCancelled: false,
    trackingData: [],
    gsTrackingData: null,
    keyedFrames: [],
    // Transform overlay state
    overlayTransform: { x: 0, y: 0, w: 0, h: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    useOverlayTransform: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const canvas = $('#preview-canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
  const bgCanvas = document.createElement('canvas');
  const bgCtx = bgCanvas.getContext('2d');

  const gifGallery = $('#gif-gallery');
  const chkTransparent = $('#chk-transparent');
  const rowTransparent = $('#row-transparent');

  const uploadBg = $('#upload-bg');
  const inputBg = $('#input-bg');
  const bgInfo = $('#bg-info');
  const bgFilename = $('#bg-filename');

  const ctrlTolerance = $('#ctrl-tolerance');
  const ctrlChromaColor = $('#ctrl-chromacolor');
  const ctrlSpeed = $('#ctrl-speed');
  const ctrlBgSpeed = $('#ctrl-bg-speed');
  const groupBgSpeed = $('#group-bg-speed');
  const labelBgSpeed = $('#label-bg-speed');

  const playbackBar = $('#playback-bar');
  const btnPlay = $('#btn-play');
  const iconPlay = $('#icon-play');
  const iconPause = $('#icon-pause');
  const frameCounter = $('#frame-counter');
  const progressBar = $('#progress-bar');

  const exportArea = $('#export-area');
  const btnExport = $('#btn-export');
  const exportModal = $('#export-modal');
  const exportProgress = $('#export-progress');
  const exportPercent = $('#export-percent');
  const modalTitle = $('#modal-title');
  const modalSubtitle = $('#modal-subtitle');
  const btnCancelExport = $('#btn-cancel-export');
  const btnDownload = $('#btn-download');
  const btnCloseExport = $('#btn-close-export');
  const btnFinishExport = $('#btn-finish-export');
  const modalActionsDone = $('#modal-actions-done');
  const exportModalIcon = $('#export-modal .modal-icon');
  const exportModalBackdrop = $('#export-modal .modal-backdrop');

  const groupBgStartFrame = $('#group-bg-start-frame');
  const ctrlBgStartFrame = $('#ctrl-bg-start-frame');
  const valBgStartFrame = $('#val-bg-start-frame');
  const btnUseCurrentFrame = $('#btn-use-current-frame');
  const ctrlBgBeforeStart = $('#ctrl-bg-before-start');

  const emptyState = $('#empty-state');
  const loadingModal = $('#loading-modal');
  const loadingSubtitle = $('#loading-subtitle');

  function updateBgStartFrameLimits() {
    if (!ctrlBgStartFrame) return;
    const total = state.gifFrames.length || 1;
    ctrlBgStartFrame.max = total;
    let val = parseInt(ctrlBgStartFrame.value, 10) || 1;
    if (val > total) {
      val = 1;
      ctrlBgStartFrame.value = 1;
    }
    if (valBgStartFrame) {
      valBgStartFrame.textContent = `Frame ${val} / ${total}`;
    }
  }

  function hexToRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return { r, g, b };
  }

  function showLoading(text = 'Traitement du GIF...') {
    if (loadingSubtitle) loadingSubtitle.textContent = text;
    loadingModal.classList.remove('hidden');
  }

  function hideLoading() {
    loadingModal.classList.add('hidden');
  }

  function colorDistance(r1, g1, b1, r2, g2, b2) {
    return Math.sqrt(
      (r1 - r2) ** 2 +
      (g1 - g2) ** 2 +
      (b1 - b2) ** 2
    );
  }

  async function decodeGif(arrayBuffer) {
    const gif = gifuct.parseGIF(arrayBuffer);
    const rawFrames = gifuct.decompressFrames(gif, true);

    const width = rawFrames[0].dims.width || gif.lsd.width;
    const height = rawFrames[0].dims.height || gif.lsd.height;

    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = width;
    fullCanvas.height = height;
    const fullCtx = fullCanvas.getContext('2d');

    const frames = [];
    const delays = [];

    for (let i = 0; i < rawFrames.length; i++) {
      const frame = rawFrames[i];
      const dims = frame.dims;

      const patchCanvas = document.createElement('canvas');
      patchCanvas.width = dims.width;
      patchCanvas.height = dims.height;
      const patchCtx = patchCanvas.getContext('2d');
      const patchData = patchCtx.createImageData(dims.width, dims.height);
      patchData.data.set(frame.patch);
      patchCtx.putImageData(patchData, 0, 0);

      if (i > 0) {
        const prevFrame = rawFrames[i - 1];
        if (prevFrame.disposalType === 2) {
          const pd = prevFrame.dims;
          fullCtx.clearRect(pd.left, pd.top, pd.width, pd.height);
        }
      }

      fullCtx.drawImage(patchCanvas, dims.left, dims.top);

      const fullImageData = fullCtx.getImageData(0, 0, width, height);
      frames.push(fullImageData);
      delays.push(frame.delay || 100);
    }

    return { frames, delays, width, height };
  }

  async function loadGifFromUrl(url) {
    showLoading('Chargement et décodage du GIF...');

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
      await updateTracking();

      canvas.width = width;
      canvas.height = height;
      tempCanvas.width = width;
      tempCanvas.height = height;
      bgCanvas.width = width;
      bgCanvas.height = height;

      emptyState.classList.add('hidden');
      canvas.classList.add('active');
      playbackBar.classList.remove('hidden');
      exportArea.classList.remove('hidden');

      frameCounter.textContent = `1 / ${frames.length}`;
      updateBgStartFrameLimits();
      if (state.bgType && groupBgStartFrame) {
        groupBgStartFrame.classList.remove('hidden');
      }

      // Show frame strip section
      const sectionFramesEl = document.querySelector('#section-frames');
      if (sectionFramesEl) sectionFramesEl.classList.remove('hidden');
      // Reset overlay on new GIF
      state.useOverlayTransform = false;
      const overlayEl = document.querySelector('#transform-overlay');
      if (overlayEl) {
        overlayEl.classList.add('hidden');
        overlayEl.classList.remove('active');
      }
      // renderFrameStrip is defined later in the IIFE — call via setTimeout
      setTimeout(() => { if (typeof renderFrameStrip === 'function') renderFrameStrip(); }, 0);

      state.playing = true;
      updatePlayButton();
      startAnimation();
    } catch (err) {
      console.error('GIF decode error:', err);
      alert('Erreur lors du chargement du GIF. Veuillez réessayer.');
    } finally {
      hideLoading();
    }

  }

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
    const useTransparent = Boolean(transparent && entry && entry.transparent === true);
    return useTransparent ? baseName : (entry.file.startsWith('gs') ? entry.file : 'gs' + baseName);
  }

  async function selectGif(entry) {
    const prev = gifGallery.querySelector('.gif-card.selected');
    if (prev) prev.classList.remove('selected');

    if (state.selectedGifId !== entry.id) {
      state.gsTrackingData = null;
      state.trackingData = [];
      state.keyedFrames = [];
    }

    state.selectedGifId = entry.id;
    state.selectedEntry = entry;
    const card = gifGallery.querySelector(`[data-id="${entry.id}"]`);
    if (card) card.classList.add('selected');

    const hasTransparent = Boolean(entry && entry.transparent === true);
    if (rowTransparent) {
      if (hasTransparent) {
        rowTransparent.classList.remove('hidden');
      } else {
        rowTransparent.classList.add('hidden');
        if (chkTransparent) chkTransparent.checked = false;
        state.transparentBackground = false;
      }
    }

    const isTransparent = hasTransparent && chkTransparent ? chkTransparent.checked : false;
    state.transparentBackground = isTransparent;
    const filename = getGifFilename(entry, isTransparent);
    await loadGifFromUrl(`gifs/${filename}`);
  }

  async function loadBackground(file) {
    const type = file.type;

    if (type === 'image/gif') {
      showLoading('Décodage du GIF d\'arrière-plan...');
      try {
        const buffer = await file.arrayBuffer();
        const { frames, delays, width, height } = await decodeGif(buffer);
        state.bgType = 'gif';
        state.bgGifFrames = frames;
        state.bgGifDelays = delays;
        state.bgGifWidth = width;
        state.bgGifHeight = height;
        state.bgCurrentFrame = 0;
        state.lastBgFrameTime = performance.now();
        state.bgImage = null;
        groupBgSpeed.classList.remove('hidden');
        labelBgSpeed.textContent = 'Vitesse GIF arrière-plan';
        if (groupBgStartFrame) groupBgStartFrame.classList.remove('hidden');
        updateBgStartFrameLimits();
      } catch (err) {
        console.error('BG GIF decode error:', err);
        alert('Erreur lors du décodage du GIF d\'arrière-plan.');
      } finally {
        hideLoading();
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
      video.playbackRate = parseFloat(ctrlBgSpeed.value) || 1.0;
      video.play();
      state.bgImage = video;
      state.bgGifFrames = [];
      groupBgSpeed.classList.remove('hidden');
      labelBgSpeed.textContent = 'Vitesse vidéo arrière-plan';
      if (groupBgStartFrame) groupBgStartFrame.classList.remove('hidden');
      updateBgStartFrameLimits();
    } else if (type.startsWith('image/')) {
      state.bgType = 'image';
      const img = new Image();
      img.src = URL.createObjectURL(file);
      await new Promise((resolve) => {
        img.onload = resolve;
      });
      state.bgImage = img;
      state.bgGifFrames = [];
      groupBgSpeed.classList.add('hidden');
      if (groupBgStartFrame) groupBgStartFrame.classList.remove('hidden');
      updateBgStartFrameLimits();
    }

    bgInfo.classList.remove('hidden');
    uploadBg.classList.add('hidden');
    bgFilename.textContent = file.name;
    if (!state.playing && state.gifFrames.length > 0) {
      compositeFrame(state.currentFrame);
    }
  }

  function computeTrackingData(frames, chromaColor, tolerance) {
    if (!frames || frames.length === 0) return [];

    const w = frames[0].width;
    const h = frames[0].height;
    const rawBoxes = [];
    for (let f = 0; f < frames.length; f++) {
      const frame = frames[f];
      const data = frame.data;

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
        let cx = sumX / count;
        let cy = sumY / count;
        let boxW = maxX - minX + 1;
        let boxH = maxY - minY + 1;

        let m20 = 0, m02 = 0, m11 = 0;
        for (let p = 0; p < pts.length; p += 2) {
          const dx = pts[p] - cx;
          const dy = pts[p + 1] - cy;
          m20 += dx * dx;
          m02 += dy * dy;
          m11 += dx * dy;
        }
        let angle = 0.5 * Math.atan2(2 * m11, m20 - m02);

        const pct = count / (w * h);
        const fullScreenT = Math.max(0, Math.min(1, (pct - 0.25) / 0.35));
        if (fullScreenT > 0) {
          angle = angle * (1 - fullScreenT);
          cx = cx * (1 - fullScreenT) + (w / 2) * fullScreenT;
          cy = cy * (1 - fullScreenT) + (h / 2) * fullScreenT;
          boxW = boxW * (1 - fullScreenT) + w * fullScreenT;
          boxH = boxH * (1 - fullScreenT) + h * fullScreenT;
        }

        const isFullScreen = pct >= 0.60 || (boxW >= w * 0.90 && boxH >= h * 0.80);
        if (isFullScreen) {
          boxW = w;
          boxH = h;
          cx = w / 2;
          cy = h / 2;
          angle = 0;
        }

        rawBoxes.push({
          count,
          pct,
          minX,
          maxX,
          minY,
          maxY,
          w: boxW,
          h: boxH,
          cx,
          cy,
          angle,
          isFullScreen,
        });
      }
    }

    const smoothed = [];
    let prev = null;
    for (let i = 0; i < rawBoxes.length; i++) {
      const cur = rawBoxes[i];
      if (!cur) {
        smoothed.push(null);
        prev = null;
        continue;
      }
      if (cur.isFullScreen) {
        const fullItem = { ...cur, cx: w / 2, cy: h / 2, w: w, h: h, angle: 0 };
        smoothed.push(fullItem);
        prev = fullItem;
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
      const boxW = prev.w * 0.2 + cur.w * 0.8;
      const boxH = prev.h * 0.2 + cur.h * 0.8;

      const item = {
        ...cur,
        cx,
        cy,
        w: boxW,
        h: boxH,
        angle,
      };
      smoothed.push(item);
      prev = item;
    }

    return smoothed;
  }

  function mapGsTrackingToFrames(gsTrack, targetCount) {
    if (!gsTrack || gsTrack.length === 0) return [];
    const res = [];
    for (let i = 0; i < targetCount; i++) {
      const ratio = targetCount > 1 ? i / (targetCount - 1) : 0;
      const gsIndex = Math.min(gsTrack.length - 1, Math.max(0, Math.round(ratio * (gsTrack.length - 1))));
      const item = gsTrack[gsIndex];
      res.push(item ? { ...item } : null);
    }
    return res;
  }

  async function updateTracking() {
    if (state.gifFrames.length === 0) return;
    state.keyedFrames = [];
    const tolerance = parseFloat(ctrlTolerance.value);
    const chromaColor = hexToRgb(ctrlChromaColor.value);

    if (state.transparentBackground) {
      if (!state.gsTrackingData || state.gsTrackingData.length === 0) {
        const entry = state.selectedEntry || (state.catalog.length > 0 ? (state.catalog.find(e => e.id === state.selectedGifId) || state.catalog[0]) : null);
        if (entry) {
          const gsFilename = getGifFilename(entry, false);
          try {
            const res = await fetch(`gifs/${gsFilename}`);
            if (res.ok) {
              const buf = await res.arrayBuffer();
              const { frames } = await decodeGif(buf);
              state.gsTrackingData = computeTrackingData(frames, chromaColor, tolerance);
            }
          } catch (e) {
            console.error('Failed to load GS tracking data:', e);
          }
        }
      }
      state.trackingData = mapGsTrackingToFrames(state.gsTrackingData, state.gifFrames.length);
    } else {
      state.gsTrackingData = computeTrackingData(state.gifFrames, chromaColor, tolerance);
      state.trackingData = state.gsTrackingData;
    }
  }

  function drawBackground(targetCtx, w, h, frameIndex, isExport, exportTimeMs) {
    if (!state.bgType) return;

    let bgSource = null;
    let bgW = w;
    let bgH = h;
    const bgSpeed = parseFloat(ctrlBgSpeed.value) || 1.0;
    const mainSpeed = parseFloat(ctrlSpeed.value) || 1.0;
    const startFrame = parseInt(ctrlBgStartFrame ? ctrlBgStartFrame.value : '1', 10) || 1;
    const startIndex = Math.max(0, startFrame - 1);
    const beforeStart = ctrlBgBeforeStart ? ctrlBgBeforeStart.value : 'hide';
    const totalMainFrames = state.gifFrames.length || 1;

    if (state.bgType === 'image' && state.bgImage) {
      if (frameIndex < startIndex && beforeStart === 'hide') {
        return;
      }
      bgSource = state.bgImage;
      bgW = state.bgImage.naturalWidth || state.bgImage.width;
      bgH = state.bgImage.naturalHeight || state.bgImage.height;
    } else if (state.bgType === 'video' && state.bgImage) {
      if (frameIndex < startIndex && beforeStart === 'hide') {
        return;
      }
      let relFrame = 0;
      if (frameIndex < startIndex) {
        if (beforeStart === 'freeze') {
          relFrame = 0;
        } else if (beforeStart === 'loop') {
          relFrame = (frameIndex - startIndex + totalMainFrames) % totalMainFrames;
        }
      } else {
        relFrame = frameIndex - startIndex;
      }

      if (state.bgImage.duration) {
        const secPerMainFrame = (1 / 24) / mainSpeed;
        const videoTime = (relFrame * secPerMainFrame) * bgSpeed;
        state.bgImage.currentTime = videoTime % state.bgImage.duration;
      }
      bgSource = state.bgImage;
      bgW = state.bgImage.videoWidth;
      bgH = state.bgImage.videoHeight;
    } else if (state.bgType === 'gif' && state.bgGifFrames.length > 0) {
      if (frameIndex < startIndex && beforeStart === 'hide') {
        return;
      }

      let bgFrameIdx = 0;
      if (frameIndex < startIndex) {
        if (beforeStart === 'freeze') {
          bgFrameIdx = 0;
        } else if (beforeStart === 'loop') {
          const relFrame = (frameIndex - startIndex + totalMainFrames) % totalMainFrames;
          const bgFramesElapsed = relFrame * (bgSpeed / mainSpeed);
          bgFrameIdx = Math.floor(bgFramesElapsed) % state.bgGifFrames.length;
        }
      } else {
        const relFrame = frameIndex - startIndex;
        const bgFramesElapsed = relFrame * (bgSpeed / mainSpeed);
        bgFrameIdx = Math.floor(bgFramesElapsed) % state.bgGifFrames.length;
      }

      bgCanvas.width = state.bgGifWidth;
      bgCanvas.height = state.bgGifHeight;
      bgCtx.putImageData(state.bgGifFrames[bgFrameIdx], 0, 0);
      bgSource = bgCanvas;
      bgW = state.bgGifWidth;
      bgH = state.bgGifHeight;
    }

    if (!bgSource || bgW === 0 || bgH === 0) return;

    // If user has manually placed overlay, use that transform instead of tracking
    if (state.useOverlayTransform) {
      const ot = state.overlayTransform;
      targetCtx.save();
      targetCtx.translate(ot.x + ot.w / 2, ot.y + ot.h / 2);
      if (ot.rotation) targetCtx.rotate(ot.rotation);
      targetCtx.scale(ot.scaleX, ot.scaleY);
      targetCtx.drawImage(bgSource, -ot.w / 2, -ot.h / 2, ot.w, ot.h);
      targetCtx.restore();
      return;
    }

    const bbox = state.trackingData && state.trackingData[frameIndex];
    if (!bbox) return;

    const isFull = Boolean(bbox.isFullScreen || (bbox.w >= w * 0.95 && bbox.h >= h * 0.85) || (bbox.pct && bbox.pct >= 0.60));
    const cardW = isFull ? w : bbox.w;
    const cardH = isFull ? h : bbox.h;
    const cx = isFull ? (w / 2) : bbox.cx;
    const cy = isFull ? (h / 2) : bbox.cy;
    const angle = isFull ? 0 : (bbox.angle || 0);

    targetCtx.save();
    targetCtx.translate(cx, cy);
    if (angle) {
      targetCtx.rotate(angle);
    }

    if (!isFull) {
      targetCtx.beginPath();
      const cornerRadius = (cardW >= w * 0.75 || cardH >= h * 0.75) ? 0 : 3;
      if (typeof targetCtx.roundRect === 'function' && cornerRadius > 0) {
        targetCtx.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, cornerRadius);
      } else {
        targetCtx.rect(-cardW / 2, -cardH / 2, cardW, cardH);
      }
      targetCtx.clip();
    }

    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const targetW = cardW * cos + cardH * sin;
    const targetH = cardW * sin + cardH * cos;
    const coverScale = Math.max(targetW / bgW, targetH / bgH);
    const drawW = bgW * coverScale;
    const drawH = bgH * coverScale;

    targetCtx.drawImage(bgSource, -drawW / 2, -drawH / 2, drawW, drawH);
    targetCtx.restore();
  }

  function getKeyedFrameCanvas(frameIndex) {
    if (state.keyedFrames[frameIndex]) {
      return state.keyedFrames[frameIndex];
    }

    const frame = state.gifFrames[frameIndex];
    const w = state.gifWidth;
    const h = state.gifHeight;
    const tolerance = parseFloat(ctrlTolerance.value);
    const chromaColor = hexToRgb(ctrlChromaColor.value);

    const kCanvas = document.createElement('canvas');
    kCanvas.width = w;
    kCanvas.height = h;
    const kCtx = kCanvas.getContext('2d');
    kCtx.putImageData(frame, 0, 0);

    const frameData = kCtx.getImageData(0, 0, w, h);
    const data = frameData.data;

    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a === 0) continue;

      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const dist = colorDistance(r, g, b, chromaColor.r, chromaColor.g, chromaColor.b);

      if (dist < tolerance) {
        data[i + 3] = 0;
      } else if (dist < tolerance * 1.4) {
        const blend = (dist - tolerance) / (tolerance * 0.4);
        data[i + 3] = Math.round(a * Math.min(1, blend));
      }
    }

    kCtx.putImageData(frameData, 0, 0);
    state.keyedFrames[frameIndex] = kCanvas;
    return kCanvas;
  }

  function compositeFrame(frameIndex) {
    if (state.gifFrames.length === 0) return;

    const frame = state.gifFrames[frameIndex];
    const w = state.gifWidth;
    const h = state.gifHeight;

    ctx.clearRect(0, 0, w, h);

    if (state.transparentBackground) {
      tempCtx.clearRect(0, 0, w, h);
      tempCtx.putImageData(frame, 0, 0);
      ctx.drawImage(tempCanvas, 0, 0);

      drawBackground(ctx, w, h, frameIndex);
    } else {
      drawBackground(ctx, w, h, frameIndex);
      const keyed = getKeyedFrameCanvas(frameIndex);
      ctx.drawImage(keyed, 0, 0);
    }
  }

  function startAnimation() {
    stopAnimation();
    state.lastFrameTime = performance.now();
    state.lastBgFrameTime = performance.now();
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
      compositeFrame(state.currentFrame);
      return;
    }

    const now = performance.now();
    const speed = parseFloat(ctrlSpeed.value) || 1.0;
    // Use per-frame delay from gifDelays, falling back to 100ms
    const currentDelay = (state.gifDelays[state.currentFrame] || 100) / speed;

    let frameChanged = false;
    if (now - state.lastFrameTime >= currentDelay) {
      state.currentFrame = (state.currentFrame + 1) % state.gifFrames.length;
      state.lastFrameTime = now;
      frameChanged = true;
    }

    if (frameChanged || state.bgType === 'video') {
      compositeFrame(state.currentFrame);
      frameCounter.textContent = `${state.currentFrame + 1} / ${state.gifFrames.length}`;
      const progress = ((state.currentFrame + 1) / state.gifFrames.length) * 100;
      progressBar.style.width = progress + '%';
      updateActiveFrameCard(state.currentFrame);
    }

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

  async function exportGif() {
    if (state.gifFrames.length === 0) return;

    state.exportCancelled = false;
    exportModal.classList.remove('hidden');
    if (modalActionsDone) modalActionsDone.classList.add('hidden');
    modalTitle.textContent = 'Exportation en cours...';
    modalSubtitle.textContent = 'Préparation des frames';
    exportProgress.style.width = '0%';
    exportPercent.textContent = '0%';

    if (exportModalIcon) {
      exportModalIcon.classList.remove('done');
      exportModalIcon.innerHTML = `
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
      `;
    }

    const w = state.gifWidth;
    const h = state.gifHeight;
    const speed = parseFloat(ctrlSpeed.value) || 1.0;
    const numWorkers = Math.min(4, Math.max(2, navigator.hardwareConcurrency || 2));

    const gif = new GIF({
      workers: numWorkers,
      quality: 2,
      dither: 'FloydSteinberg-serpentine',
      width: w,
      height: h,
      workerScript: 'lib/gif.worker.js',
    });

    const renderCanvas = document.createElement('canvas');
    renderCanvas.width = w;
    renderCanvas.height = h;
    const renderCtx = renderCanvas.getContext('2d', { willReadFrequently: true });
    const renderTemp = document.createElement('canvas');
    renderTemp.width = w;
    renderTemp.height = h;
    const renderTempCtx = renderTemp.getContext('2d', { willReadFrequently: true });

    let currentExportTimeMs = 0;
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

      const frame = state.gifFrames[i];
      const tolerance = parseFloat(ctrlTolerance.value);
      const chromaColor = hexToRgb(ctrlChromaColor.value);

      renderCtx.clearRect(0, 0, w, h);

      if (state.transparentBackground) {
        renderTempCtx.clearRect(0, 0, w, h);
        renderTempCtx.putImageData(frame, 0, 0);
        renderCtx.drawImage(renderTemp, 0, 0);

        drawBackground(renderCtx, w, h, i, true, currentExportTimeMs);
      } else {
        drawBackground(renderCtx, w, h, i, true, currentExportTimeMs);
        const keyed = getKeyedFrameCanvas(i);
        renderCtx.drawImage(keyed, 0, 0);
      }

      const delay = Math.max(20, Math.round((state.gifDelays[i] || 100) / speed));
      currentExportTimeMs += delay;
      gif.addFrame(renderCtx, { copy: true, delay });

      await new Promise((r) => setTimeout(r, 0));
    }

    modalSubtitle.textContent = 'Encodage du GIF...';

    gif.on('finished', (blob) => {
      if (state.exportCancelled) return;

      if (state.exportBlobUrl) {
        URL.revokeObjectURL(state.exportBlobUrl);
      }
      state.exportBlobUrl = URL.createObjectURL(blob);
      btnDownload.href = state.exportBlobUrl;
      if (modalActionsDone) modalActionsDone.classList.remove('hidden');

      if (exportModalIcon) {
        exportModalIcon.classList.add('done');
        exportModalIcon.innerHTML = `
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="8 12 11 15 16 9" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        `;
      }
      modalTitle.textContent = 'Exportation terminée !';
      const sizeMB = (blob.size / (1024 * 1024)).toFixed(2);
      modalSubtitle.textContent = `Taille: ${sizeMB} Mo`;
      exportProgress.style.width = '100%';
      exportPercent.textContent = '100%';
    });

    gif.render();
  }

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
    state.bgCurrentFrame = 0;
    bgInfo.classList.add('hidden');
    uploadBg.classList.remove('hidden');
    // Use live query in case the input was cloned
    const bgInputEl = document.querySelector('#input-bg');
    if (bgInputEl) bgInputEl.value = '';
    groupBgSpeed.classList.add('hidden');
    ctrlBgSpeed.value = 1;
    $('#val-bg-speed').textContent = '1.0x';
    if (groupBgStartFrame) groupBgStartFrame.classList.add('hidden');
    if (ctrlBgStartFrame) ctrlBgStartFrame.value = 1;
    updateBgStartFrameLimits();
    setBeforeStartOption('hide');
    if (!state.playing && state.gifFrames.length > 0) {
      compositeFrame(state.currentFrame);
    }
  });


  btnPlay.addEventListener('click', () => {
    state.playing = !state.playing;
    updatePlayButton();
    if (state.playing) {
      startAnimation();
    }
  });

  $('.progress-bar-container').addEventListener('click', (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    state.currentFrame = Math.floor(ratio * state.gifFrames.length);
    compositeFrame(state.currentFrame);
    frameCounter.textContent = `${state.currentFrame + 1} / ${state.gifFrames.length}`;
    progressBar.style.width = `${((state.currentFrame + 1) / state.gifFrames.length) * 100}%`;
  });

  const controlMappings = [
    { ctrl: ctrlTolerance, valId: 'val-tolerance', format: (v) => v },
    { ctrl: ctrlSpeed, valId: 'val-speed', format: (v) => parseFloat(v).toFixed(1) + 'x' },
    { ctrl: ctrlBgSpeed, valId: 'val-bg-speed', format: (v) => parseFloat(v).toFixed(1) + 'x' },
  ];

  controlMappings.forEach(({ ctrl, valId, format }) => {
    ctrl.addEventListener('input', async () => {
      $(`#${valId}`).textContent = format(ctrl.value);
      if (ctrl === ctrlTolerance) {
        await updateTracking();
      }
      if (ctrl === ctrlBgSpeed && state.bgType === 'video' && state.bgImage) {
        state.bgImage.playbackRate = parseFloat(ctrlBgSpeed.value) || 1.0;
      }
      if (!state.playing && state.gifFrames.length > 0) {
        compositeFrame(state.currentFrame);
      }
    });
  });

  ctrlChromaColor.addEventListener('input', async () => {
    $('#val-chromacolor').textContent = ctrlChromaColor.value;
    await updateTracking();
    if (!state.playing && state.gifFrames.length > 0) {
      compositeFrame(state.currentFrame);
    }
  });

  function closeExportModal() {
    if (modalActionsDone && modalActionsDone.classList.contains('hidden')) {
      state.exportCancelled = true;
    }
    exportModal.classList.add('hidden');
  }

  btnExport.addEventListener('click', exportGif);
  if (btnCancelExport) btnCancelExport.addEventListener('click', closeExportModal);
  if (btnFinishExport) btnFinishExport.addEventListener('click', closeExportModal);
  if (btnCloseExport) btnCloseExport.addEventListener('click', closeExportModal);
  if (exportModalBackdrop) exportModalBackdrop.addEventListener('click', closeExportModal);

  if (ctrlBgStartFrame) {
    ctrlBgStartFrame.addEventListener('input', () => {
      updateBgStartFrameLimits();
      if (!state.playing && state.gifFrames.length > 0) {
        compositeFrame(state.currentFrame);
      }
    });
  }

  if (ctrlBgBeforeStart) {
    ctrlBgBeforeStart.addEventListener('change', () => {
      if (!state.playing && state.gifFrames.length > 0) {
        compositeFrame(state.currentFrame);
      }
    });
  }

  const dropdownBeforeStart = $('#dropdown-bg-before-start');
  const dropdownTriggerBeforeStart = $('#dropdown-trigger-before-start');
  const dropdownMenuBeforeStart = $('#dropdown-menu-before-start');
  const triggerIconBeforeStart = $('#trigger-icon-before-start');
  const triggerLabelBeforeStart = $('#trigger-label-before-start');

  const optionDetails = {
    hide: {
      label: 'Masquer',
      icon: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
    },
    freeze: {
      label: 'Figer frame 1',
      icon: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
    },
    loop: {
      label: 'Boucler',
      icon: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`
    }
  };

  function setBeforeStartOption(val) {
    if (!optionDetails[val]) return;
    if (ctrlBgBeforeStart && ctrlBgBeforeStart.value !== val) {
      ctrlBgBeforeStart.value = val;
      ctrlBgBeforeStart.dispatchEvent(new Event('change'));
    }
    if (triggerLabelBeforeStart) triggerLabelBeforeStart.textContent = optionDetails[val].label;
    if (triggerIconBeforeStart) triggerIconBeforeStart.innerHTML = optionDetails[val].icon;

    if (dropdownMenuBeforeStart) {
      dropdownMenuBeforeStart.querySelectorAll('.dropdown-item').forEach((item) => {
        const isSelected = item.dataset.value === val;
        item.classList.toggle('selected', isSelected);
        item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      });
    }
  }

  if (dropdownTriggerBeforeStart && dropdownMenuBeforeStart) {
    dropdownTriggerBeforeStart.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = !dropdownMenuBeforeStart.classList.contains('hidden');
      if (isOpen) {
        dropdownMenuBeforeStart.classList.add('hidden');
        dropdownTriggerBeforeStart.classList.remove('open');
        dropdownTriggerBeforeStart.setAttribute('aria-expanded', 'false');
      } else {
        dropdownMenuBeforeStart.classList.remove('hidden');
        dropdownTriggerBeforeStart.classList.add('open');
        dropdownTriggerBeforeStart.setAttribute('aria-expanded', 'true');
      }
    });

    dropdownMenuBeforeStart.querySelectorAll('.dropdown-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = item.dataset.value;
        setBeforeStartOption(val);
        dropdownMenuBeforeStart.classList.add('hidden');
        dropdownTriggerBeforeStart.classList.remove('open');
        dropdownTriggerBeforeStart.setAttribute('aria-expanded', 'false');
      });
    });

    document.addEventListener('click', (e) => {
      if (!dropdownBeforeStart || !dropdownBeforeStart.contains(e.target)) {
        if (!dropdownMenuBeforeStart.classList.contains('hidden')) {
          dropdownMenuBeforeStart.classList.add('hidden');
          dropdownTriggerBeforeStart.classList.remove('open');
          dropdownTriggerBeforeStart.setAttribute('aria-expanded', 'false');
        }
      }
    });
  }

  if (btnUseCurrentFrame) {
    btnUseCurrentFrame.addEventListener('click', () => {
      if (state.gifFrames.length > 0) {
        ctrlBgStartFrame.value = state.currentFrame + 1;
        updateBgStartFrameLimits();
        if (!state.playing) {
          compositeFrame(state.currentFrame);
        }
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (dropdownMenuBeforeStart && !dropdownMenuBeforeStart.classList.contains('hidden')) {
        dropdownMenuBeforeStart.classList.add('hidden');
        dropdownTriggerBeforeStart.classList.remove('open');
        dropdownTriggerBeforeStart.setAttribute('aria-expanded', 'false');
        return;
      }
      if (!exportModal.classList.contains('hidden')) {
        closeExportModal();
      }
    }
  });

  if (chkTransparent) {
    chkTransparent.addEventListener('change', async () => {
      const entry = state.selectedEntry || (state.catalog.length > 0 ? (state.catalog.find(e => e.id === state.selectedGifId) || null) : null);
      if (entry && entry.transparent === true) {
        state.transparentBackground = chkTransparent.checked;
        state.selectedEntry = entry;
        const filename = getGifFilename(entry, chkTransparent.checked);
        await loadGifFromUrl(`gifs/${filename}`);
      } else {
        chkTransparent.checked = false;
        state.transparentBackground = false;
        if (rowTransparent) rowTransparent.classList.add('hidden');
      }
    });
  }

  // ---- Frame Strip ----
  const sectionFrames = $('#section-frames');
  const framesStrip = $('#frames-strip');
  const framesCount = $('#frames-count');
  const bulkDelayInput = $('#bulk-delay-input');
  const btnBulkApply = $('#btn-bulk-apply');

  function renderFrameStrip() {
    if (!framesStrip) return;
    framesStrip.innerHTML = '';
    if (state.gifFrames.length === 0) return;

    const THUMB_W = 64;
    const THUMB_H = Math.round(THUMB_W * (state.gifHeight / state.gifWidth)) || 48;

    // Render each frame thumbnail asynchronously
    state.gifFrames.forEach((frame, i) => {
      const card = document.createElement('div');
      card.className = 'frame-card' + (i === state.currentFrame ? ' active-frame' : '');
      card.dataset.frameIndex = i;

      const numEl = document.createElement('span');
      numEl.className = 'frame-num';
      numEl.textContent = i + 1;

      // Thumbnail canvas
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = THUMB_W;
      thumbCanvas.height = THUMB_H;
      thumbCanvas.className = 'frame-thumb';
      const tCtx = thumbCanvas.getContext('2d');

      // Draw scaled-down frame
      const tmpC = document.createElement('canvas');
      tmpC.width = state.gifWidth;
      tmpC.height = state.gifHeight;
      tmpC.getContext('2d').putImageData(frame, 0, 0);
      tCtx.drawImage(tmpC, 0, 0, THUMB_W, THUMB_H);

      // Delay row
      const delayRow = document.createElement('div');
      delayRow.className = 'frame-delay-row';

      const delayLabel = document.createElement('span');
      delayLabel.className = 'frame-delay-label';
      delayLabel.textContent = 'ms';

      const delayInput = document.createElement('input');
      delayInput.type = 'number';
      delayInput.className = 'frame-delay-input';
      delayInput.min = 10;
      delayInput.max = 9999;
      delayInput.value = state.gifDelays[i] || 100;
      delayInput.title = `Delay frame ${i + 1}`;
      delayInput.dataset.frameIndex = i;

      delayInput.addEventListener('change', () => {
        const val = Math.max(10, Math.min(9999, parseInt(delayInput.value) || 100));
        delayInput.value = val;
        state.gifDelays[i] = val;
        // Reset cached keyed frames since timing changed (not strictly needed but safe)
      });

      delayInput.addEventListener('focus', () => {
        state.playing = false;
        state.currentFrame = i;
        updatePlayButton();
        compositeFrame(i);
        updateActiveFrameCard(i);
      });

      delayRow.appendChild(delayInput);
      delayRow.appendChild(delayLabel);

      card.appendChild(numEl);
      card.appendChild(thumbCanvas);
      card.appendChild(delayRow);
      framesStrip.appendChild(card);
    });

    if (framesCount) framesCount.textContent = `${state.gifFrames.length} frames`;
  }

  function updateActiveFrameCard(idx) {
    if (!framesStrip) return;
    framesStrip.querySelectorAll('.frame-card').forEach((card) => {
      card.classList.toggle('active-frame', parseInt(card.dataset.frameIndex) === idx);
    });
  }

  if (btnBulkApply) {
    btnBulkApply.addEventListener('click', () => {
      const val = Math.max(10, Math.min(9999, parseInt(bulkDelayInput.value) || 0));
      if (!val) return;
      state.gifDelays = state.gifDelays.map(() => val);
      // Update all inputs in strip
      framesStrip.querySelectorAll('.frame-delay-input').forEach((inp) => {
        inp.value = val;
      });
    });
  }

  // ---- Transform Overlay ----
  const transformOverlay = $('#transform-overlay');
  const transformBox = $('#transform-box');
  const transformRotateHandle = $('#t-rotate-handle');

  function getCanvasRect() {
    return canvas.getBoundingClientRect();
  }

  function canvasCoordsToPixel(clientX, clientY) {
    const rect = getCanvasRect();
    const scaleX = state.gifWidth / rect.width;
    const scaleY = state.gifHeight / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  function applyOverlayBoxCSS() {
    if (!transformBox || !canvas) return;
    const canvasRect = getCanvasRect();
    const containerRect = canvas.parentElement.getBoundingClientRect();

    const ot = state.overlayTransform;
    const scaleFactorX = canvasRect.width / state.gifWidth;
    const scaleFactorY = canvasRect.height / state.gifHeight;

    const left = (canvasRect.left - containerRect.left) + ot.x * scaleFactorX;
    const top  = (canvasRect.top  - containerRect.top)  + ot.y * scaleFactorY;
    const boxW = ot.w * scaleFactorX * ot.scaleX;
    const boxH = ot.h * scaleFactorY * ot.scaleY;

    transformBox.style.left     = left + 'px';
    transformBox.style.top      = top + 'px';
    transformBox.style.width    = boxW + 'px';
    transformBox.style.height   = boxH + 'px';
    transformBox.style.transform = `rotate(${ot.rotation}rad)`;
  }

  function initOverlayFromBg() {
    if (!state.bgType) return;
    let srcW = state.gifWidth;
    let srcH = state.gifHeight;
    if (state.bgType === 'image' && state.bgImage) {
      srcW = state.bgImage.naturalWidth || state.bgImage.width;
      srcH = state.bgImage.naturalHeight || state.bgImage.height;
    } else if (state.bgType === 'video' && state.bgImage) {
      srcW = state.bgImage.videoWidth || state.gifWidth;
      srcH = state.bgImage.videoHeight || state.gifHeight;
    } else if (state.bgType === 'gif') {
      srcW = state.bgGifWidth;
      srcH = state.bgGifHeight;
    }
    if (!srcW || !srcH) return;

    const gW = state.gifWidth;
    const gH = state.gifHeight;
    // Fit bg source into GIF canvas, centered
    const cover = Math.max(gW / srcW, gH / srcH);
    const fW = srcW * cover;
    const fH = srcH * cover;

    state.overlayTransform = {
      x: (gW - fW) / 2,
      y: (gH - fH) / 2,
      w: fW,
      h: fH,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    };
    state.useOverlayTransform = true;
    applyOverlayBoxCSS();
    transformOverlay.classList.remove('hidden');
    transformOverlay.classList.add('active');
  }

  function setupTransformOverlay() {
    if (!transformBox || !transformOverlay) return;

    let dragging = false;
    let dragStartX = 0, dragStartY = 0;
    let dragStartOT = null;

    // Move (drag box itself)
    transformBox.addEventListener('pointerdown', (e) => {
      // Only handle direct clicks on the box (not handles)
      if (e.target.classList.contains('t-handle') || e.target.closest('.t-rotate-handle')) return;
      e.preventDefault();
      dragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragStartOT = { ...state.overlayTransform };
      transformBox.setPointerCapture(e.pointerId);
    });

    transformBox.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const canvasRect = getCanvasRect();
      const scaleFactorX = state.gifWidth / canvasRect.width;
      const scaleFactorY = state.gifHeight / canvasRect.height;
      const dx = (e.clientX - dragStartX) * scaleFactorX;
      const dy = (e.clientY - dragStartY) * scaleFactorY;
      state.overlayTransform.x = dragStartOT.x + dx;
      state.overlayTransform.y = dragStartOT.y + dy;
      applyOverlayBoxCSS();
      if (!state.playing) compositeFrame(state.currentFrame);
    });

    transformBox.addEventListener('pointerup', () => { dragging = false; });

    // Scale handles
    transformBox.querySelectorAll('.t-handle').forEach((handle) => {
      let resizing = false;
      let resStartX = 0, resStartY = 0;
      let resStartOT = null;
      const hType = handle.dataset.handle;

      handle.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        resizing = true;
        resStartX = e.clientX;
        resStartY = e.clientY;
        resStartOT = { ...state.overlayTransform };
        handle.setPointerCapture(e.pointerId);
      });

      handle.addEventListener('pointermove', (e) => {
        if (!resizing) return;
        const canvasRect = getCanvasRect();
        const sfX = state.gifWidth / canvasRect.width;
        const sfY = state.gifHeight / canvasRect.height;
        const dx = (e.clientX - resStartX) * sfX;
        const dy = (e.clientY - resStartY) * sfY;

        const ot = state.overlayTransform;
        const orig = resStartOT;

        if (hType === 'se') {
          ot.w = Math.max(20, orig.w + dx);
          ot.h = Math.max(20, orig.h + dy);
        } else if (hType === 'nw') {
          const newW = Math.max(20, orig.w - dx);
          const newH = Math.max(20, orig.h - dy);
          ot.x = orig.x + (orig.w - newW);
          ot.y = orig.y + (orig.h - newH);
          ot.w = newW;
          ot.h = newH;
        } else if (hType === 'ne') {
          const newH = Math.max(20, orig.h - dy);
          ot.y = orig.y + (orig.h - newH);
          ot.w = Math.max(20, orig.w + dx);
          ot.h = newH;
        } else if (hType === 'sw') {
          const newW = Math.max(20, orig.w - dx);
          ot.x = orig.x + (orig.w - newW);
          ot.w = newW;
          ot.h = Math.max(20, orig.h + dy);
        } else if (hType === 'e') {
          ot.w = Math.max(20, orig.w + dx);
        } else if (hType === 'w') {
          const newW = Math.max(20, orig.w - dx);
          ot.x = orig.x + (orig.w - newW);
          ot.w = newW;
        } else if (hType === 's') {
          ot.h = Math.max(20, orig.h + dy);
        } else if (hType === 'n') {
          const newH = Math.max(20, orig.h - dy);
          ot.y = orig.y + (orig.h - newH);
          ot.h = newH;
        }

        applyOverlayBoxCSS();
        if (!state.playing) compositeFrame(state.currentFrame);
      });

      handle.addEventListener('pointerup', () => { resizing = false; });
    });

    // Rotation handle
    if (transformRotateHandle) {
      let rotating = false;
      let rotCenter = { x: 0, y: 0 };
      let rotStartAngle = 0;
      let rotStartOTAngle = 0;

      transformRotateHandle.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        rotating = true;
        const canvasRect = getCanvasRect();
        const sfX = state.gifWidth / canvasRect.width;
        const sfY = state.gifHeight / canvasRect.height;
        const containerRect = canvas.parentElement.getBoundingClientRect();
        const ot = state.overlayTransform;
        // Center of box in screen coords
        rotCenter.x = canvasRect.left + (ot.x + ot.w / 2) / sfX;
        rotCenter.y = canvasRect.top  + (ot.y + ot.h / 2) / sfY;
        rotStartAngle = Math.atan2(e.clientY - rotCenter.y, e.clientX - rotCenter.x);
        rotStartOTAngle = ot.rotation;
        transformRotateHandle.setPointerCapture(e.pointerId);
      });

      transformRotateHandle.addEventListener('pointermove', (e) => {
        if (!rotating) return;
        const angle = Math.atan2(e.clientY - rotCenter.y, e.clientX - rotCenter.x);
        state.overlayTransform.rotation = rotStartOTAngle + (angle - rotStartAngle);
        applyOverlayBoxCSS();
        if (!state.playing) compositeFrame(state.currentFrame);
      });

      transformRotateHandle.addEventListener('pointerup', () => { rotating = false; });
    }

    // Reset button
    const resetBtn = document.createElement('button');
    resetBtn.id = 'transform-reset-btn';
    resetBtn.textContent = '⟳ Réinitialiser';
    resetBtn.title = 'Réinitialiser la position';
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.useOverlayTransform = false;
      initOverlayFromBg();
      compositeFrame(state.currentFrame);
    });
    transformBox.appendChild(resetBtn);
  }

  setupTransformOverlay();

  // Wire up the upload zone to also init the overlay after BG loads
  async function loadBackgroundWrapped(file) {
    await loadBackground(file);
    // After BG loaded, init overlay (GIF must also be selected)
    if (state.gifFrames.length > 0) {
      initOverlayFromBg();
    }
  }

  // Replace the original setupUpload(uploadBg, inputBg, loadBackground) with the wrapped version
  // by cloning the input element to remove old listeners and re-registering
  const newInputBg = inputBg.cloneNode(true);
  inputBg.parentNode.replaceChild(newInputBg, inputBg);
  setupUpload(uploadBg, newInputBg, loadBackgroundWrapped);

  // When BG is removed, hide overlay
  document.querySelector('#btn-remove-bg').addEventListener('click', () => {
    if (transformOverlay) {
      transformOverlay.classList.add('hidden');
      transformOverlay.classList.remove('active');
    }
    state.useOverlayTransform = false;
  }, { capture: true });

  // When window resizes, refresh overlay CSS positions
  window.addEventListener('resize', () => {
    if (state.useOverlayTransform) applyOverlayBoxCSS();
  });


  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  document.addEventListener('pointerdown', (e) => {
    const ripple = document.createElement('div');
    ripple.className = 'water-ripple';
    ripple.style.left = `${e.clientX}px`;
    ripple.style.top = `${e.clientY}px`;
    document.body.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  });

  loadCatalog();
})();
