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
    // Per-frame data (parallel to gifFrames)
    // frameTransforms[i]: null (auto tracking) or { cx, cy, w, h, rot } = placement of the overlay image
    frameTransforms: [],
    frameDisabled: [],
    frameSrc: [],
    srcCount: 0,
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

  const btnRender = $('#btn-render');
  const btnAdjustPos = $('#btn-adjust-pos');
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

    const width = gif.lsd.width || rawFrames[0].dims.width;
    const height = gif.lsd.height || rawFrames[0].dims.height;

    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = width;
    fullCanvas.height = height;
    const fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });

    const frames = [];
    const delays = [];
    let restoreSnapshot = null;

    for (let i = 0; i < rawFrames.length; i++) {
      const frame = rawFrames[i];
      const dims = frame.dims;

      if (i > 0 && rawFrames[i - 1].disposalType === 3 && restoreSnapshot) {
        fullCtx.putImageData(restoreSnapshot, 0, 0);
      }
      restoreSnapshot = frame.disposalType === 3 ? fullCtx.getImageData(0, 0, width, height) : null;

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
      state.frameTransforms = frames.map(() => null);
      state.frameDisabled = frames.map(() => false);
      state.frameSrc = frames.map((_, k) => k);
      state.srcCount = frames.length;
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
      btnRender.classList.remove('hidden');
      updateAdjustButton();

      frameCounter.textContent = `1 / ${frames.length}`;
      updateBgStartFrameLimits();
      if (state.bgType && groupBgStartFrame) {
        groupBgStartFrame.classList.remove('hidden');
      }

      // Show frame strip section
      const sectionFramesEl = document.querySelector('#section-frames');
      if (sectionFramesEl) sectionFramesEl.classList.remove('hidden');
      renderFrameStrip();

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
      // The video is driven frame by frame (currentTime), never free-running
      video.pause();
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
    state.frameTransforms = state.frameTransforms.map(() => null);
    updateAdjustButton();
    if (!state.playing && state.gifFrames.length > 0) {
      compositeFrame(state.currentFrame);
    }
  }

  function updateAdjustButton() {
    const ready = Boolean(state.bgType) && state.gifFrames.length > 0;
    btnAdjustPos.classList.toggle('hidden', !ready);
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

  function mapGsTrackingToFrames(gsTrack, frameSrc, srcCount) {
    if (!gsTrack || gsTrack.length === 0) return [];
    const res = [];
    for (let i = 0; i < frameSrc.length; i++) {
      const ratio = srcCount > 1 ? frameSrc[i] / (srcCount - 1) : 0;
      const gsIndex = Math.min(gsTrack.length - 1, Math.max(0, Math.round(ratio * (gsTrack.length - 1))));
      const item = gsTrack[gsIndex];
      res.push(item ? { ...item } : null);
    }
    return res;
  }

  async function updateTracking(force = false) {
    if (state.gifFrames.length === 0) return;
    state.keyedFrames = [];
    if (force) state.gsTrackingData = null;
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
      state.trackingData = mapGsTrackingToFrames(state.gsTrackingData, state.frameSrc, state.srcCount);
    } else {
      const tracked = computeTrackingData(state.gifFrames, chromaColor, tolerance);
      // Only an unedited frame list can serve as reference for the transparent variant
      const unedited = state.frameSrc.length === state.srcCount && state.frameSrc.every((s, k) => s === k);
      state.gsTrackingData = unedited ? tracked : null;
      state.trackingData = tracked.slice();
    }
  }

  // Position of the background in its own timeline (-1 = hidden at this frame)
  function bgTimeline(frameIndex) {
    const startFrame = parseInt(ctrlBgStartFrame ? ctrlBgStartFrame.value : '1', 10) || 1;
    const startIndex = Math.max(0, startFrame - 1);
    const beforeStart = ctrlBgBeforeStart ? ctrlBgBeforeStart.value : 'hide';
    const total = state.gifFrames.length || 1;

    if (frameIndex >= startIndex) return frameIndex - startIndex;
    if (beforeStart === 'hide') return -1;
    if (beforeStart === 'freeze') return 0;
    return (frameIndex - startIndex + total) % total;
  }

  function bgVideoTime(relFrame) {
    const video = state.bgImage;
    const bgSpeed = parseFloat(ctrlBgSpeed.value) || 1.0;
    const mainSpeed = parseFloat(ctrlSpeed.value) || 1.0;
    const secPerMainFrame = (1 / 24) / mainSpeed;
    return ((relFrame * secPerMainFrame) * bgSpeed) % video.duration;
  }

  // Seek the background video and wait until the frame is really decoded (export / editor)
  async function seekBgVideo(frameIndex) {
    if (state.bgType !== 'video' || !state.bgImage || !state.bgImage.duration) return;
    const rel = bgTimeline(frameIndex);
    if (rel < 0) return;
    const video = state.bgImage;
    const t = bgVideoTime(rel);
    if (!video.seeking && Math.abs(video.currentTime - t) < 0.001) return;
    await new Promise((resolve) => {
      const done = () => {
        video.removeEventListener('seeked', done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 1500);
      video.addEventListener('seeked', done);
      video.currentTime = t;
    });
  }

  function resolveBackground(frameIndex, isExport) {
    if (!state.bgType) return null;
    const rel = bgTimeline(frameIndex);
    if (rel < 0) return null;

    if (state.bgType === 'image' && state.bgImage) {
      return {
        source: state.bgImage,
        bgW: state.bgImage.naturalWidth || state.bgImage.width,
        bgH: state.bgImage.naturalHeight || state.bgImage.height,
      };
    }

    if (state.bgType === 'video' && state.bgImage) {
      if (!isExport && state.bgImage.duration) {
        state.bgImage.currentTime = bgVideoTime(rel);
      }
      return { source: state.bgImage, bgW: state.bgImage.videoWidth, bgH: state.bgImage.videoHeight };
    }

    if (state.bgType === 'gif' && state.bgGifFrames.length > 0) {
      const bgSpeed = parseFloat(ctrlBgSpeed.value) || 1.0;
      const mainSpeed = parseFloat(ctrlSpeed.value) || 1.0;
      const idx = Math.floor(rel * (bgSpeed / mainSpeed)) % state.bgGifFrames.length;
      if (bgCanvas.width !== state.bgGifWidth || bgCanvas.height !== state.bgGifHeight) {
        bgCanvas.width = state.bgGifWidth;
        bgCanvas.height = state.bgGifHeight;
      }
      bgCtx.putImageData(state.bgGifFrames[idx], 0, 0);
      return { source: bgCanvas, bgW: state.bgGifWidth, bgH: state.bgGifHeight };
    }

    return null;
  }

  // Placement of the overlay image as computed by the automatic tracking
  function autoPlacement(frameIndex, w, h, bgW, bgH) {
    const bbox = state.trackingData && state.trackingData[frameIndex];
    if (!bbox) return null;

    const isFull = Boolean(bbox.isFullScreen || (bbox.w >= w * 0.95 && bbox.h >= h * 0.85) || (bbox.pct && bbox.pct >= 0.60));
    const cardW = isFull ? w : bbox.w;
    const cardH = isFull ? h : bbox.h;
    const angle = isFull ? 0 : (bbox.angle || 0);

    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const coverScale = Math.max((cardW * cos + cardH * sin) / bgW, (cardW * sin + cardH * cos) / bgH);

    return {
      cx: isFull ? w / 2 : bbox.cx,
      cy: isFull ? h / 2 : bbox.cy,
      rot: angle,
      w: bgW * coverScale,
      h: bgH * coverScale,
      cardW,
      cardH,
      isFull,
    };
  }

  // ftOverride: undefined = use the stored transform, null = force tracking, object = explicit transform
  function drawBackground(targetCtx, w, h, frameIndex, isExport, ftOverride) {
    const info = resolveBackground(frameIndex, isExport);
    if (!info || !info.bgW || !info.bgH) return;

    const { source: bgSource, bgW, bgH } = info;
    const ft = ftOverride !== undefined ? ftOverride : state.frameTransforms[frameIndex];

    if (ft) {
      targetCtx.save();
      // Manual placement is unclipped: with a transparent GIF the image goes behind it
      if (state.transparentBackground) targetCtx.globalCompositeOperation = 'destination-over';
      targetCtx.translate(ft.cx, ft.cy);
      if (ft.rot) targetCtx.rotate(ft.rot);
      targetCtx.drawImage(bgSource, -ft.w / 2, -ft.h / 2, ft.w, ft.h);
      targetCtx.restore();
      return;
    }

    const p = autoPlacement(frameIndex, w, h, bgW, bgH);
    if (!p) return;

    targetCtx.save();
    targetCtx.translate(p.cx, p.cy);
    if (p.rot) targetCtx.rotate(p.rot);

    if (!p.isFull) {
      targetCtx.beginPath();
      const cornerRadius = (p.cardW >= w * 0.75 || p.cardH >= h * 0.75) ? 0 : 3;
      if (typeof targetCtx.roundRect === 'function' && cornerRadius > 0) {
        targetCtx.roundRect(-p.cardW / 2, -p.cardH / 2, p.cardW, p.cardH, cornerRadius);
      } else {
        targetCtx.rect(-p.cardW / 2, -p.cardH / 2, p.cardW, p.cardH);
      }
      targetCtx.clip();
    }

    targetCtx.drawImage(bgSource, -p.w / 2, -p.h / 2, p.w, p.h);
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

  // Draws frame `frameIndex` (background + keyed GIF) on targetCtx at the GIF's native size
  function paintFrame(targetCtx, scratch, frameIndex, isExport, ftOverride) {
    const w = state.gifWidth;
    const h = state.gifHeight;

    targetCtx.imageSmoothingEnabled = true;
    targetCtx.imageSmoothingQuality = 'high';
    targetCtx.clearRect(0, 0, w, h);

    if (state.transparentBackground) {
      const scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
      scratchCtx.clearRect(0, 0, w, h);
      scratchCtx.putImageData(state.gifFrames[frameIndex], 0, 0);
      targetCtx.drawImage(scratch, 0, 0);
      drawBackground(targetCtx, w, h, frameIndex, isExport, ftOverride);
    } else {
      drawBackground(targetCtx, w, h, frameIndex, isExport, ftOverride);
      targetCtx.drawImage(getKeyedFrameCanvas(frameIndex), 0, 0);
    }
  }

  function compositeFrame(frameIndex) {
    if (state.gifFrames.length === 0) return;
    paintFrame(ctx, tempCanvas, frameIndex, false);
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

  function nextActiveFrame(from) {
    const n = state.gifFrames.length;
    for (let k = 1; k <= n; k++) {
      const idx = (from + k) % n;
      if (!state.frameDisabled[idx]) return idx;
    }
    return from;
  }

  function animate() {
    if (!state.playing || state.gifFrames.length === 0) {
      compositeFrame(state.currentFrame);
      return;
    }

    const now = performance.now();
    const speed = parseFloat(ctrlSpeed.value) || 1.0;
    const currentDelay = (state.gifDelays[state.currentFrame] || 100) / speed;

    let frameChanged = false;
    if (now - state.lastFrameTime >= currentDelay) {
      state.currentFrame = nextActiveFrame(state.currentFrame);
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

  const EXPORT_TRANSPARENT_KEY = 0xFE01FD;

  function setExportIcon(done) {
    if (!exportModalIcon) return;
    exportModalIcon.classList.toggle('done', done);
    exportModalIcon.innerHTML = done
      ? `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" />
          <polyline points="8 12 11 15 16 9" stroke-linecap="round" stroke-linejoin="round" />
        </svg>`
      : `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>`;
  }

  function setExportProgress(pct) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    exportProgress.style.width = p + '%';
    exportPercent.textContent = p + '%';
  }

  async function exportGif() {
    const indices = [];
    for (let i = 0; i < state.gifFrames.length; i++) {
      if (!state.frameDisabled[i]) indices.push(i);
    }
    if (indices.length === 0) {
      alert('Toutes les frames sont désactivées : rien à générer.');
      return;
    }

    state.exportCancelled = false;
    exportModal.classList.remove('hidden');
    if (modalActionsDone) modalActionsDone.classList.add('hidden');
    modalTitle.textContent = 'Génération du rendu...';
    modalSubtitle.textContent = 'Préparation des frames';
    setExportProgress(0);
    setExportIcon(false);

    const w = state.gifWidth;
    const h = state.gifHeight;
    const speed = parseFloat(ctrlSpeed.value) || 1.0;

    const renderCanvas = document.createElement('canvas');
    renderCanvas.width = w;
    renderCanvas.height = h;
    const renderCtx = renderCanvas.getContext('2d', { willReadFrequently: true });
    const renderTemp = document.createElement('canvas');
    renderTemp.width = w;
    renderTemp.height = h;

    // The preview must not fight with the export over the background video
    const wasPlaying = state.playing;
    if (wasPlaying) {
      state.playing = false;
      updatePlayButton();
    }

    // Phase 1: render every active frame at full quality
    const rendered = [];
    const delays = [];
    let hasAlpha = false;
    let carry = 0;

    for (let n = 0; n < indices.length; n++) {
      if (state.exportCancelled) break;
      const i = indices[n];

      modalSubtitle.textContent = `Rendu de la frame ${n + 1} / ${indices.length}`;
      setExportProgress(((n + 1) / indices.length) * 50);

      await seekBgVideo(i);
      paintFrame(renderCtx, renderTemp, i, true);
      const imageData = renderCtx.getImageData(0, 0, w, h);

      if (!hasAlpha) {
        const d = imageData.data;
        for (let p = 3; p < d.length; p += 4) {
          if (d[p] < 128) { hasAlpha = true; break; }
        }
      }
      rendered.push(imageData);

      // GIF delays are stored in 1/100 s: spread the rounding error so total duration stays exact
      const wanted = (state.gifDelays[i] || 100) / speed + carry;
      const cs = Math.max(2, Math.round(wanted / 10));
      carry = wanted - cs * 10;
      delays.push(cs * 10);

      await new Promise((r) => setTimeout(r, 0));
    }

    if (wasPlaying) {
      state.playing = true;
      updatePlayButton();
      startAnimation();
    }

    if (state.exportCancelled) {
      exportModal.classList.add('hidden');
      return;
    }

    // Binary transparency: every non-opaque pixel gets the reserved key colour
    if (hasAlpha) {
      const kr = (EXPORT_TRANSPARENT_KEY >> 16) & 255;
      const kg = (EXPORT_TRANSPARENT_KEY >> 8) & 255;
      const kb = EXPORT_TRANSPARENT_KEY & 255;
      for (const imageData of rendered) {
        const d = imageData.data;
        for (let p = 0; p < d.length; p += 4) {
          if (d[p + 3] < 128) {
            d[p] = kr; d[p + 1] = kg; d[p + 2] = kb;
          }
          d[p + 3] = 255;
        }
      }
    }

    modalSubtitle.textContent = 'Encodage du GIF (qualité maximale)...';

    const gif = new GIF({
      workers: Math.min(8, Math.max(2, navigator.hardwareConcurrency || 2)),
      quality: 1,
      dither: 'FloydSteinberg-serpentine',
      width: w,
      height: h,
      transparent: hasAlpha ? EXPORT_TRANSPARENT_KEY : null,
      workerScript: 'lib/gif.worker.js',
    });

    rendered.forEach((imageData, n) => gif.addFrame(imageData, { delay: delays[n] }));

    gif.on('progress', (p) => {
      if (state.exportCancelled) return;
      setExportProgress(50 + p * 50);
    });

    gif.on('finished', (blob) => {
      if (state.exportCancelled) return;

      if (state.exportBlobUrl) {
        URL.revokeObjectURL(state.exportBlobUrl);
      }
      state.exportBlobUrl = URL.createObjectURL(blob);
      btnDownload.href = state.exportBlobUrl;
      if (modalActionsDone) modalActionsDone.classList.remove('hidden');

      setExportIcon(true);
      modalTitle.textContent = 'Rendu terminé !';
      const sizeMB = (blob.size / (1024 * 1024)).toFixed(2);
      modalSubtitle.textContent = `${indices.length} frames · ${sizeMB} Mo`;
      setExportProgress(100);
    });

    gif.render();
    state.activeGif = gif;
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
    state.frameTransforms = state.frameTransforms.map(() => null);
    updateAdjustButton();
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
        await updateTracking(true);
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
    await updateTracking(true);
    if (!state.playing && state.gifFrames.length > 0) {
      compositeFrame(state.currentFrame);
    }
  });

  function closeExportModal() {
    if (modalActionsDone && modalActionsDone.classList.contains('hidden')) {
      state.exportCancelled = true;
      if (state.activeGif) {
        state.activeGif.abort();
        state.activeGif = null;
      }
    }
    exportModal.classList.add('hidden');
  }

  btnRender.addEventListener('click', exportGif);
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

  const ICON_COPY = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const ICON_TRASH = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
  const ICON_RESTORE = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';

  function updateFramesCount() {
    if (!framesCount) return;
    const total = state.gifFrames.length;
    const active = state.frameDisabled.filter((d) => !d).length;
    framesCount.textContent = active === total ? `${total} frames` : `${active} / ${total} frames`;
  }

  function showFrame(i) {
    state.playing = false;
    state.currentFrame = i;
    updatePlayButton();
    compositeFrame(i);
    frameCounter.textContent = `${i + 1} / ${state.gifFrames.length}`;
    progressBar.style.width = `${((i + 1) / state.gifFrames.length) * 100}%`;
    updateActiveFrameCard(i);
  }

  function duplicateFrame(i) {
    const at = i + 1;
    const oldLen = state.gifFrames.length;
    state.keyedFrames.length = oldLen;
    state.gifFrames.splice(at, 0, state.gifFrames[i]);
    state.gifDelays.splice(at, 0, state.gifDelays[i]);
    state.frameSrc.splice(at, 0, state.frameSrc[i]);
    state.frameDisabled.splice(at, 0, state.frameDisabled[i]);
    state.frameTransforms.splice(at, 0, state.frameTransforms[i] ? { ...state.frameTransforms[i] } : null);
    state.trackingData.splice(at, 0, state.trackingData[i] ? { ...state.trackingData[i] } : null);
    state.keyedFrames.splice(at, 0, state.keyedFrames[i]);
    renderFrameStrip();
    showFrame(at);
    const card = framesStrip.querySelector(`[data-frame-index="${at}"]`);
    if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function toggleFrame(i) {
    state.frameDisabled[i] = !state.frameDisabled[i];
    const card = framesStrip.querySelector(`[data-frame-index="${i}"]`);
    if (card) applyDisabledLook(card, state.frameDisabled[i]);
    updateFramesCount();
  }

  function applyDisabledLook(card, disabled) {
    card.classList.toggle('disabled', disabled);
    const btn = card.querySelector('.frame-btn-delete');
    if (btn) {
      btn.innerHTML = disabled ? ICON_RESTORE : ICON_TRASH;
      btn.title = disabled ? 'Réactiver la frame' : 'Désactiver la frame (exclue du rendu)';
    }
  }

  function makeFrameButton(className, icon, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `frame-btn ${className}`;
    btn.innerHTML = icon;
    btn.title = title;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  function renderFrameStrip() {
    if (!framesStrip) return;
    framesStrip.innerHTML = '';
    if (state.gifFrames.length === 0) return;

    const THUMB_W = 64;
    const THUMB_H = Math.round(THUMB_W * (state.gifHeight / state.gifWidth)) || 48;

    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = state.gifWidth;
    srcCanvas.height = state.gifHeight;
    const srcCtx = srcCanvas.getContext('2d');

    state.gifFrames.forEach((frame, i) => {
      const card = document.createElement('div');
      card.className = 'frame-card' + (i === state.currentFrame ? ' active-frame' : '');
      card.dataset.frameIndex = i;

      const numEl = document.createElement('span');
      numEl.className = 'frame-num';
      numEl.textContent = i + 1;

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = THUMB_W;
      thumbCanvas.height = THUMB_H;
      thumbCanvas.className = 'frame-thumb';
      const tCtx = thumbCanvas.getContext('2d');
      tCtx.imageSmoothingQuality = 'high';
      srcCtx.putImageData(frame, 0, 0);
      tCtx.drawImage(srcCanvas, 0, 0, THUMB_W, THUMB_H);
      thumbCanvas.addEventListener('click', () => showFrame(i));

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
      });

      delayInput.addEventListener('focus', () => showFrame(i));

      delayRow.appendChild(delayInput);
      delayRow.appendChild(delayLabel);

      const actions = document.createElement('div');
      actions.className = 'frame-actions';
      actions.appendChild(makeFrameButton('frame-btn-copy', ICON_COPY, 'Dupliquer la frame (copie juste après)', () => duplicateFrame(i)));
      actions.appendChild(makeFrameButton('frame-btn-delete', ICON_TRASH, '', () => toggleFrame(i)));

      card.appendChild(numEl);
      card.appendChild(thumbCanvas);
      card.appendChild(delayRow);
      card.appendChild(actions);
      applyDisabledLook(card, state.frameDisabled[i]);
      framesStrip.appendChild(card);
    });

    updateFramesCount();
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
      framesStrip.querySelectorAll('.frame-delay-input').forEach((inp) => {
        inp.value = val;
      });
    });
  }


  // ---- Position editor (per-frame placement of the overlay image) ----
  const peModal = $('#pos-editor-modal');
  const peCanvas = $('#pe-canvas');
  const peCtx = peCanvas.getContext('2d', { willReadFrequently: true });
  const peArea = $('#pe-canvas-area');
  const peOverlay = $('#pe-overlay');
  const peBox = $('#pe-box');
  const peRotateHandle = $('#pe-rotate-handle');
  const peStrip = $('#pe-strip');
  const peFrameLabel = $('#pe-frame-label');
  const peStatus = $('#pe-status');
  const peInputs = {
    x: $('#pe-x'),
    y: $('#pe-y'),
    w: $('#pe-w'),
    h: $('#pe-h'),
    rot: $('#pe-rot'),
  };
  const peLockRatio = $('#pe-lock-ratio');
  const peScratch = document.createElement('canvas');
  const peThumbSrc = document.createElement('canvas');
  const peThumbSrcCtx = peThumbSrc.getContext('2d', { willReadFrequently: true });

  const pe = {
    open: false,
    wasPlaying: false,
    draft: [],
    index: 0,
    scale: 1,
    drag: null,
    token: 0,
    renderPending: false,
    queue: Promise.resolve(),
  };

  const PE_MIN_SIZE = 8;

  function bgDimensions() {
    if (state.bgType === 'image' && state.bgImage) {
      return { w: state.bgImage.naturalWidth || state.bgImage.width, h: state.bgImage.naturalHeight || state.bgImage.height };
    }
    if (state.bgType === 'video' && state.bgImage) {
      return { w: state.bgImage.videoWidth, h: state.bgImage.videoHeight };
    }
    if (state.bgType === 'gif') {
      return { w: state.bgGifWidth, h: state.bgGifHeight };
    }
    return null;
  }

  // Tracked placement of the overlay image (what the render does when nothing was edited)
  function autoTransform(i) {
    const d = bgDimensions();
    if (!d || !d.w || !d.h) return null;
    const gw = state.gifWidth;
    const gh = state.gifHeight;
    const p = autoPlacement(i, gw, gh, d.w, d.h);
    if (p) return { cx: p.cx, cy: p.cy, w: p.w, h: p.h, rot: p.rot };
    const cover = Math.max(gw / d.w, gh / d.h);
    return { cx: gw / 2, cy: gh / 2, w: d.w * cover, h: d.h * cover, rot: 0 };
  }

  function peTransform(i) {
    return pe.draft[i] || autoTransform(i);
  }

  function peEdit(mutate) {
    const i = pe.index;
    const t = pe.draft[i] ? pe.draft[i] : { ...peTransform(i) };
    mutate(t);
    pe.draft[i] = t;
    peAfterChange();
  }

  function peAfterChange() {
    peLayoutBox();
    peSyncInputs();
    peRequestRender();
    peUpdateStatus();
    const thumb = peStrip.children[pe.index];
    if (thumb) thumb.classList.toggle('edited', Boolean(pe.draft[pe.index]));
  }

  function peLayoutOverlay() {
    // Fill as much of the editing area as possible (upscaling small GIFs)
    const pad = 64;
    const fit = Math.min(
      (peArea.clientWidth - pad * 2) / state.gifWidth,
      (peArea.clientHeight - pad * 2) / state.gifHeight
    );
    if (fit > 0) {
      peCanvas.style.width = Math.floor(state.gifWidth * fit) + 'px';
      peCanvas.style.height = Math.floor(state.gifHeight * fit) + 'px';
    }
    const canvasRect = peCanvas.getBoundingClientRect();
    const areaRect = peArea.getBoundingClientRect();
    pe.scale = canvasRect.width / state.gifWidth || 1;
    peOverlay.style.left = (canvasRect.left - areaRect.left) + 'px';
    peOverlay.style.top = (canvasRect.top - areaRect.top) + 'px';
    peOverlay.style.width = canvasRect.width + 'px';
    peOverlay.style.height = canvasRect.height + 'px';
    peLayoutBox();
  }

  function peLayoutBox() {
    const t = peTransform(pe.index);
    if (!t) return;
    const s = pe.scale;
    peBox.style.width = (t.w * s) + 'px';
    peBox.style.height = (t.h * s) + 'px';
    peBox.style.left = ((t.cx - t.w / 2) * s) + 'px';
    peBox.style.top = ((t.cy - t.h / 2) * s) + 'px';
    peBox.style.transform = `rotate(${t.rot}rad)`;
  }

  function normalizeDeg(rad) {
    const deg = (rad * 180) / Math.PI;
    return ((deg + 180) % 360 + 360) % 360 - 180;
  }

  function peSyncInputs() {
    const t = peTransform(pe.index);
    if (!t) return;
    const values = {
      x: Math.round(t.cx),
      y: Math.round(t.cy),
      w: Math.round(t.w),
      h: Math.round(t.h),
      rot: Math.round(normalizeDeg(t.rot) * 10) / 10,
    };
    Object.keys(peInputs).forEach((key) => {
      if (document.activeElement !== peInputs[key]) peInputs[key].value = values[key];
    });
  }

  function peUpdateStatus() {
    const manual = pe.draft.filter(Boolean).length;
    peStatus.textContent = manual === 0
      ? 'Aucune transformation manuelle (suivi automatique)'
      : `${manual} frame${manual > 1 ? 's' : ''} ajustée${manual > 1 ? 's' : ''} manuellement`;
  }

  // Rendering of the big canvas (and the thumb of the current frame)
  function peRequestRender() {
    if (pe.renderPending) return;
    pe.renderPending = true;
    requestAnimationFrame(() => {
      pe.renderPending = false;
      if (!pe.open) return;
      const run = async () => {
        const i = pe.index;
        await seekBgVideo(i);
        if (!pe.open || i !== pe.index) return;
        paintFrame(peCtx, peScratch, i, true, peTransform(i));
        peDrawThumb(i, peCanvas);
      };
      if (state.bgType === 'video') {
        pe.queue = pe.queue.then(run);
      } else {
        run();
      }
    });
  }

  function peDrawThumb(i, source) {
    const card = peStrip.children[i];
    if (!card) return;
    const thumb = card.querySelector('canvas');
    const tCtx = thumb.getContext('2d');
    tCtx.imageSmoothingQuality = 'high';
    tCtx.clearRect(0, 0, thumb.width, thumb.height);
    tCtx.drawImage(source, 0, 0, thumb.width, thumb.height);
  }

  async function peRenderAllThumbs(token) {
    peThumbSrc.width = state.gifWidth;
    peThumbSrc.height = state.gifHeight;
    for (let i = 0; i < state.gifFrames.length; i++) {
      if (token !== pe.token) return;
      await seekBgVideo(i);
      if (token !== pe.token) return;
      paintFrame(peThumbSrcCtx, peScratch, i, true, peTransform(i));
      peDrawThumb(i, peThumbSrc);
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
    if (token === pe.token) peRequestRender();
  }

  function peBuildStrip() {
    peStrip.innerHTML = '';
    const THUMB_W = 112;
    const THUMB_H = Math.round(THUMB_W * (state.gifHeight / state.gifWidth)) || 63;
    state.gifFrames.forEach((_, i) => {
      const card = document.createElement('div');
      card.className = 'pe-thumb'
        + (state.frameDisabled[i] ? ' disabled' : '')
        + (pe.draft[i] ? ' edited' : '');
      const canvasEl = document.createElement('canvas');
      canvasEl.width = THUMB_W;
      canvasEl.height = THUMB_H;
      const label = document.createElement('span');
      label.textContent = i + 1;
      card.appendChild(canvasEl);
      card.appendChild(label);
      card.addEventListener('click', () => peSelectFrame(i));
      peStrip.appendChild(card);
    });
  }

  function peSelectFrame(i) {
    const n = state.gifFrames.length;
    pe.index = Math.max(0, Math.min(n - 1, i));
    Array.from(peStrip.children).forEach((card, k) => card.classList.toggle('active', k === pe.index));
    const active = peStrip.children[pe.index];
    if (active) active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    peFrameLabel.textContent = `Frame ${pe.index + 1} / ${n}`;
    peLayoutBox();
    peSyncInputs();
    peRequestRender();
  }

  function openPosEditor() {
    if (!state.bgType || state.gifFrames.length === 0) return;
    pe.open = true;
    pe.wasPlaying = state.playing;
    if (state.playing) {
      state.playing = false;
      updatePlayButton();
    }
    pe.draft = state.frameTransforms.map((t) => (t ? { ...t } : null));
    pe.token++;

    peCanvas.width = state.gifWidth;
    peCanvas.height = state.gifHeight;
    peScratch.width = state.gifWidth;
    peScratch.height = state.gifHeight;

    peModal.classList.remove('hidden');
    peBuildStrip();
    peUpdateStatus();
    // Layout needs the modal to be visible
    requestAnimationFrame(() => {
      peLayoutOverlay();
      peSelectFrame(state.currentFrame);
      peRenderAllThumbs(pe.token);
    });
  }

  function closePosEditor() {
    if (!pe.open) return;
    pe.open = false;
    pe.token++;
    pe.drag = null;
    peModal.classList.add('hidden');
    showFrame(pe.index);
    if (pe.wasPlaying) {
      state.playing = true;
      updatePlayButton();
      startAnimation();
    }
  }

  function commitPosEditor() {
    state.frameTransforms = pe.draft.map((t) => (t ? { ...t } : null));
    closePosEditor();
    exportGif();
  }

  // Pointer interaction on the box
  function peStartDrag(mode, handle, e) {
    e.preventDefault();
    e.stopPropagation();
    const t = { ...peTransform(pe.index) };
    pe.drag = { mode, handle, startX: e.clientX, startY: e.clientY, t0: t, angle0: 0, center: null };
    if (mode === 'rotate') {
      const r = peOverlay.getBoundingClientRect();
      const sx = r.left + t.cx * pe.scale;
      const sy = r.top + t.cy * pe.scale;
      pe.drag.angle0 = Math.atan2(e.clientY - sy, e.clientX - sx);
      pe.drag.center = { x: sx, y: sy };
    }
  }

  function peOnPointerMove(e) {
    const d = pe.drag;
    if (!d) return;
    const s = pe.scale;
    const dx = (e.clientX - d.startX) / s;
    const dy = (e.clientY - d.startY) / s;
    const t0 = d.t0;

    if (d.mode === 'move') {
      peEdit((t) => {
        t.cx = t0.cx + dx;
        t.cy = t0.cy + dy;
      });
      return;
    }

    if (d.mode === 'rotate') {
      const a = Math.atan2(e.clientY - d.center.y, e.clientX - d.center.x);
      peEdit((t) => {
        let rot = t0.rot + (a - d.angle0);
        if (e.shiftKey) {
          const step = Math.PI / 12;
          rot = Math.round(rot / step) * step;
        }
        t.rot = rot;
      });
      return;
    }

    // Resize in the box's own (rotated) axes, the opposite side stays fixed
    const cos = Math.cos(t0.rot);
    const sin = Math.sin(t0.rot);
    const ldx = dx * cos + dy * sin;
    const ldy = -dx * sin + dy * cos;
    const hd = d.handle;
    const sx = hd.includes('e') ? 1 : hd.includes('w') ? -1 : 0;
    const sy = hd.includes('s') ? 1 : hd.includes('n') ? -1 : 0;

    let newW = t0.w + sx * ldx;
    let newH = t0.h + sy * ldy;

    if (sx !== 0 && sy !== 0 && peLockRatio.checked) {
      const k = Math.max(PE_MIN_SIZE / t0.w, PE_MIN_SIZE / t0.h, (newW / t0.w + newH / t0.h) / 2);
      newW = t0.w * k;
      newH = t0.h * k;
    }
    newW = Math.max(PE_MIN_SIZE, newW);
    newH = Math.max(PE_MIN_SIZE, newH);

    const shiftX = sx * (newW - t0.w) / 2;
    const shiftY = sy * (newH - t0.h) / 2;
    peEdit((t) => {
      t.w = newW;
      t.h = newH;
      t.cx = t0.cx + shiftX * cos - shiftY * sin;
      t.cy = t0.cy + shiftX * sin + shiftY * cos;
    });
  }

  function peEndDrag() {
    pe.drag = null;
  }

  peBox.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.pe-handle') || e.target.closest('.pe-rotate-handle')) return;
    peStartDrag('move', null, e);
  });
  peBox.querySelectorAll('.pe-handle').forEach((el) => {
    el.addEventListener('pointerdown', (e) => peStartDrag('resize', el.dataset.h, e));
  });
  peRotateHandle.addEventListener('pointerdown', (e) => peStartDrag('rotate', null, e));
  window.addEventListener('pointermove', peOnPointerMove);
  window.addEventListener('pointerup', peEndDrag);
  window.addEventListener('pointercancel', peEndDrag);
  window.addEventListener('resize', () => {
    if (pe.open) peLayoutOverlay();
  });

  // Numeric fields
  Object.entries(peInputs).forEach(([key, input]) => {
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v)) return;
      peEdit((t) => {
        if (key === 'x') t.cx = v;
        else if (key === 'y') t.cy = v;
        else if (key === 'rot') t.rot = (v * Math.PI) / 180;
        else if (key === 'w') {
          const ratio = t.h / t.w;
          t.w = Math.max(PE_MIN_SIZE, v);
          if (peLockRatio.checked) t.h = Math.max(PE_MIN_SIZE, t.w * ratio);
        } else if (key === 'h') {
          const ratio = t.w / t.h;
          t.h = Math.max(PE_MIN_SIZE, v);
          if (peLockRatio.checked) t.w = Math.max(PE_MIN_SIZE, t.h * ratio);
        }
      });
    });
    input.addEventListener('blur', peSyncInputs);
  });

  $('#pe-btn-reset').addEventListener('click', () => {
    pe.draft[pe.index] = null;
    peAfterChange();
  });

  $('#pe-btn-apply-all').addEventListener('click', () => {
    const t = peTransform(pe.index);
    if (!t) return;
    pe.draft = state.gifFrames.map(() => ({ ...t }));
    Array.from(peStrip.children).forEach((card) => card.classList.add('edited'));
    peAfterChange();
    pe.token++;
    peRenderAllThumbs(pe.token);
  });

  $('#pe-btn-apply-frame').addEventListener('click', () => {
    // Freeze the current placement for this frame, then move on to the next one
    if (!pe.draft[pe.index]) pe.draft[pe.index] = { ...peTransform(pe.index) };
    const card = peStrip.children[pe.index];
    if (card) card.classList.add('edited');
    peUpdateStatus();
    if (pe.index < state.gifFrames.length - 1) peSelectFrame(pe.index + 1);
  });

  $('#pe-strip-prev').addEventListener('click', () => peSelectFrame(pe.index - 1));
  $('#pe-strip-next').addEventListener('click', () => peSelectFrame(pe.index + 1));
  $('#pe-btn-close').addEventListener('click', closePosEditor);
  $('#pe-btn-cancel').addEventListener('click', closePosEditor);
  $('#pe-btn-done').addEventListener('click', commitPosEditor);
  btnAdjustPos.addEventListener('click', openPosEditor);

  document.addEventListener('keydown', (e) => {
    if (!pe.open) return;
    if (e.key === 'Escape') {
      closePosEditor();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      peSelectFrame(pe.index + (e.key === 'ArrowRight' ? 1 : -1));
    }
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
