(function () {
  'use strict';

  // Chroma keying + green-screen tracking, independent from the UI.
  // Works on ImageData-like objects ({ data, width, height }).
  //
  // - detectKey():   finds the key colour and a tolerance from the frames themselves
  // - makeKeyer():   distance in the chroma plane (Cb/Cr), robust to shadows and shades of green
  // - applyKey():    alpha matte with soft edges + green despill
  // - computeTracking(): per-frame minimum-area rotated rectangle of the biggest green region

  const LUMA_SLACK = 90;
  const DEFAULT_KEY = { r: 0, g: 255, b: 0 };
  const DEFAULT_TOLERANCE = 45;

  function ycc(r, g, b) {
    return {
      y: 0.299 * r + 0.587 * g + 0.114 * b,
      cb: 128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
      cr: 128 + 0.5 * r - 0.418688 * g - 0.081312 * b,
    };
  }

  function makeKeyer(key, tolerance) {
    const k = ycc(key.r, key.g, key.b);
    return {
      key,
      tolerance,
      dist(r, g, b) {
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        let d = Math.sqrt((cb - k.cb) * (cb - k.cb) + (cr - k.cr) * (cr - k.cr));
        const dy = Math.abs(y - k.y);
        if (dy > LUMA_SLACK) d += (dy - LUMA_SLACK) * 0.6;
        return d;
      },
    };
  }

  // ---- Automatic key detection -------------------------------------------

  function detectKey(frames, maxSamples = 12) {
    if (!frames || frames.length === 0) return null;

    const buckets = new Map(); // 4 bits per channel
    let greenish = 0;
    let total = 0;
    const step = Math.max(1, Math.floor(frames.length / maxSamples));

    for (let f = 0; f < frames.length; f += step) {
      const d = frames[f].data;
      for (let i = 0; i < d.length; i += 8) { // every 2nd pixel
        if (d[i + 3] < 200) continue;
        total++;
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        if (g < 90 || g < r * 1.25 || g < b * 1.25) continue;
        greenish++;
        const id = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        let bucket = buckets.get(id);
        if (!bucket) {
          bucket = { n: 0, r: 0, g: 0, b: 0 };
          buckets.set(id, bucket);
        }
        bucket.n++;
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
      }
    }

    if (greenish < total * 0.005) return null;

    // Best bucket, counting its direct neighbours so a gradient of greens wins as one
    let bestId = -1;
    let bestScore = 0;
    buckets.forEach((_, id) => {
      const r0 = id >> 8;
      const g0 = (id >> 4) & 15;
      const b0 = id & 15;
      let score = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dg = -1; dg <= 1; dg++) {
          for (let db = -1; db <= 1; db++) {
            const nb = buckets.get(((r0 + dr) << 8) | ((g0 + dg) << 4) | (b0 + db));
            if (nb) score += nb.n;
          }
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestId = id;
      }
    });
    if (bestId < 0) return null;

    const r0 = bestId >> 8;
    const g0 = (bestId >> 4) & 15;
    const b0 = bestId & 15;
    let n = 0;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dg = -1; dg <= 1; dg++) {
        for (let db = -1; db <= 1; db++) {
          const nb = buckets.get(((r0 + dr) << 8) | ((g0 + dg) << 4) | (b0 + db));
          if (nb) {
            n += nb.n;
            sr += nb.r;
            sg += nb.g;
            sb += nb.b;
          }
        }
      }
    }
    const color = { r: Math.round(sr / n), g: Math.round(sg / n), b: Math.round(sb / n) };

    // Tolerance: cover 95% of the pixels belonging to the screen, with a margin
    const keyer = makeKeyer(color, 0);
    const dists = [];
    for (let f = 0; f < frames.length; f += step * 2) {
      const d = frames[f].data;
      for (let i = 0; i < d.length; i += 16) {
        if (d[i + 3] < 200) continue;
        const dist = keyer.dist(d[i], d[i + 1], d[i + 2]);
        if (dist < 40) dists.push(dist);
      }
    }
    dists.sort((a, b) => a - b);
    const p95 = dists.length ? dists[Math.floor(dists.length * 0.95)] : 10;
    const tolerance = Math.round(Math.min(55, Math.max(22, p95 * 1.4 + 10)));

    return { color, tolerance, coverage: greenish / total };
  }

  // ---- Keying ------------------------------------------------------------

  // Yellow/olive-green tint: what a translucent green screen looks like once blended
  // with the footage underneath (fade-in of the screen). Skin, hair, grey and white
  // all have red >= green (or no green-over-blue excess), so they are left alone.
  function isScreenTint(r, g, b) {
    return g >= r - 8 && g - b > g * 0.18 + 6 && g > 35;
  }

  // Binary mask of the screen: close to the key colour, or tinted by it, with small holes filled
  function buildKeyMask(imageData, keyer) {
    const w = imageData.width;
    const h = imageData.height;
    const d = imageData.data;
    let mask = new Uint8Array(w * h);

    for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
      if (d[i + 3] < 50) continue;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      if (keyer.dist(r, g, b) < keyer.tolerance || isScreenTint(r, g, b)) mask[p] = 1;
    }

    // Fill speckles inside the screen (a pixel surrounded by screen is screen)
    for (let pass = 0; pass < 5; pass++) {
      const next = mask.slice();
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const p = y * w + x;
          if (mask[p]) continue;
          const n = mask[p - 1] + mask[p + 1] + mask[p - w] + mask[p + w]
            + mask[p - w - 1] + mask[p - w + 1] + mask[p + w - 1] + mask[p + w + 1];
          if (n >= 5) next[p] = 1;
        }
      }
      mask = next;
    }
    return mask;
  }

  // Feathers the edge of the alpha channel inwards (never spreads opacity onto keyed pixels,
  // which would bring the key colour back)
  function softenAlpha(imageData, radius) {
    const r = Math.round(radius);
    if (r <= 0) return imageData;
    const w = imageData.width;
    const h = imageData.height;
    const d = imageData.data;
    const orig = new Uint8Array(w * h);
    for (let p = 0; p < orig.length; p++) orig[p] = d[p * 4 + 3];

    let src = Float32Array.from(orig);
    let dst = new Float32Array(w * h);
    const size = r * 2 + 1;

    for (let iter = 0; iter < 2; iter++) {
      // horizontal
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let sum = 0;
        for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
        for (let x = 0; x < w; x++) {
          dst[row + x] = sum / size;
          sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
        }
      }
      // vertical
      src = dst;
      dst = new Float32Array(w * h);
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let y = -r; y <= r; y++) sum += src[Math.min(h - 1, Math.max(0, y)) * w + x];
        for (let y = 0; y < h; y++) {
          dst[y * w + x] = sum / size;
          sum += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
        }
      }
      src = dst;
      dst = new Float32Array(w * h);
    }

    for (let p = 0; p < orig.length; p++) {
      d[p * 4 + 3] = Math.min(orig[p], Math.round(src[p]));
    }
    return imageData;
  }

  function applyKey(imageData, keyer) {
    const d = imageData.data;
    const mask = buildKeyMask(imageData, keyer);
    const tol = keyer.tolerance;
    const soft = tol * 1.5;
    const spill = tol * 2.5;

    for (let p = 0, i = 0; i < d.length; p++, i += 4) {
      const a = d[i + 3];
      if (a === 0) continue;
      if (mask[p]) {
        d[i + 3] = 0;
        continue;
      }

      let g = d[i + 1];
      const dist = keyer.dist(d[i], g, d[i + 2]);
      if (dist < soft) {
        const t = (dist - tol) / (soft - tol);
        d[i + 3] = Math.round(a * t * t * (3 - 2 * t));
      }
      if (dist < spill) {
        const m = d[i] > d[i + 2] ? d[i] : d[i + 2];
        if (g > m) d[i + 1] = m;
      }
    }
    if (keyer.soften > 0) softenAlpha(imageData, keyer.soften);
    return imageData;
  }

  // ---- Tracking ----------------------------------------------------------

  function cross(o, a, b) {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }

  function convexHull(points) {
    points.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const lower = [];
    for (const p of points) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = points.length - 1; i >= 0; i--) {
      const p = points[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  // Biggest 4-connected region of a binary mask, returned as a new mask
  function largestComponent(mask, w, h) {
    const labels = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    let best = 0;
    let bestLabel = 0;
    let label = 0;

    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || labels[start]) continue;
      label++;
      let sp = 0;
      let count = 0;
      stack[sp++] = start;
      labels[start] = label;
      while (sp > 0) {
        const p = stack[--sp];
        count++;
        const x = p % w;
        const y = (p - x) / w;
        if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = label; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = label; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = label; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = label; stack[sp++] = p + w; }
      }
      if (count > best) {
        best = count;
        bestLabel = label;
      }
    }

    const out = new Uint8Array(w * h);
    if (bestLabel) {
      for (let i = 0; i < out.length; i++) out[i] = labels[i] === bestLabel ? 1 : 0;
    }
    return { mask: out, count: best };
  }

  function erode(mask, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!mask[p]) continue;
        const l = x === 0 || mask[p - 1];
        const r = x === w - 1 || mask[p + 1];
        const u = y === 0 || mask[p - w];
        const dn = y === h - 1 || mask[p + w];
        if (l && r && u && dn) out[p] = 1;
      }
    }
    return out;
  }

  // Minimum-area rectangle of the region (angles searched in [-45°, 45°])
  function fitRotatedRect(mask, w, h) {
    const pts = [];
    for (let y = 0; y < h; y++) {
      let first = -1;
      let last = -1;
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) {
          if (first < 0) first = x;
          last = x;
        }
      }
      if (first >= 0) {
        pts.push([first, y]);
        if (last !== first) pts.push([last, y]);
      }
    }
    const hull = convexHull(pts);
    if (hull.length === 0) return null;

    let best = null;
    for (let deg = -45; deg <= 45; deg += 0.5) {
      const th = (deg * Math.PI) / 180;
      const cos = Math.cos(th);
      const sin = Math.sin(th);
      let minU = Infinity;
      let maxU = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      for (const p of hull) {
        const u = p[0] * cos + p[1] * sin;
        const v = -p[0] * sin + p[1] * cos;
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
      const area = (maxU - minU + 1) * (maxV - minV + 1);
      // Small bias towards upright rectangles when areas are equal
      const score = area * (1 + Math.abs(deg) * 0.0005);
      if (!best || score < best.score) {
        const cu = (minU + maxU) / 2;
        const cv = (minV + maxV) / 2;
        best = {
          score,
          angle: th,
          w: maxU - minU + 1,
          h: maxV - minV + 1,
          cx: cu * cos - cv * sin,
          cy: cu * sin + cv * cos,
        };
      }
    }
    return best;
  }

  function computeTracking(frames, keyer) {
    if (!frames || frames.length === 0) return [];
    const w = frames[0].width;
    const h = frames[0].height;
    const PAD = 3; // erosion (2) + a touch of overlap so no green edge shows through
    const raw = [];

    for (const frame of frames) {
      const mask = buildKeyMask(frame, keyer);

      let region = largestComponent(erode(mask, w, h), w, h);
      if (region.count < 25) region = largestComponent(mask, w, h);
      if (region.count < 25) {
        raw.push(null);
        continue;
      }

      const rect = fitRotatedRect(region.mask, w, h);
      if (!rect) {
        raw.push(null);
        continue;
      }

      const pct = region.count / (w * h);
      const bw = rect.w + PAD;
      const bh = rect.h + PAD;
      const isFullScreen = pct >= 0.60 || (bw >= w * 0.90 && bh >= h * 0.80);

      raw.push(isFullScreen
        ? { count: region.count, pct, w, h, cx: w / 2, cy: h / 2, angle: 0, isFullScreen: true }
        : { count: region.count, pct, w: bw, h: bh, cx: rect.cx, cy: rect.cy, angle: rect.angle, isFullScreen: false });
    }

    // Temporal smoothing (angle kept continuous: a 90° jump means w/h swapped)
    const out = [];
    let prev = null;
    for (const cur of raw) {
      if (!cur) {
        out.push(null);
        prev = null;
        continue;
      }
      let item = { ...cur };
      if (prev && !cur.isFullScreen && !prev.isFullScreen) {
        if (item.angle - prev.angle > Math.PI / 4) {
          item.angle -= Math.PI / 2;
          [item.w, item.h] = [item.h, item.w];
        } else if (item.angle - prev.angle < -Math.PI / 4) {
          item.angle += Math.PI / 2;
          [item.w, item.h] = [item.h, item.w];
        }
        item = {
          ...item,
          cx: prev.cx * 0.25 + item.cx * 0.75,
          cy: prev.cy * 0.25 + item.cy * 0.75,
          w: prev.w * 0.25 + item.w * 0.75,
          h: prev.h * 0.25 + item.h * 0.75,
          angle: prev.angle * 0.25 + item.angle * 0.75,
        };
      }
      out.push(item);
      prev = item;
    }
    return out;
  }

  const api = {
    DEFAULT_KEY,
    DEFAULT_TOLERANCE,
    makeKeyer,
    detectKey,
    applyKey,
    softenAlpha,
    computeTracking,
  };

  // Browser: window.Keying. Node (tools/check.js): module.exports
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.Keying = api;
})();
