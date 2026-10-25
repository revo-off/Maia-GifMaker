(function () {
  'use strict';

  // One shared 256-colour palette for the whole animation, built from every frame, plus a
  // position-fixed (ordered) dither. Compared with a palette per frame this removes the
  // colour flicker between frames, and compared with error diffusion the dither pattern
  // stays still wherever the picture stays still.
  //
  // Transparent pixels (alpha < 128) get a reserved key colour that is as far as possible
  // from every colour of the animation, so no real pixel can ever be mistaken for it.

  const BITS = 5;
  const SHIFT = 8 - BITS;
  const BINS = 1 << (BITS * 3);
  const LUT_BITS = 6;
  const LUT_SHIFT = 8 - LUT_BITS;

  // 8x8 Bayer matrix, values in [-0.5, 0.5)
  const BAYER = (() => {
    const m = [
      0, 32, 8, 40, 2, 34, 10, 42,
      48, 16, 56, 24, 50, 18, 58, 26,
      12, 44, 4, 36, 14, 46, 6, 38,
      60, 28, 52, 20, 62, 30, 54, 22,
      3, 35, 11, 43, 1, 33, 9, 41,
      51, 19, 59, 27, 49, 17, 57, 25,
      15, 47, 7, 39, 13, 45, 5, 37,
      63, 31, 55, 23, 61, 29, 53, 21,
    ];
    return m.map((v) => (v + 0.5) / 64 - 0.5);
  })();

  function histogram(frames, maxSamples = 600000) {
    const counts = new Uint32Array(BINS);
    let total = 0;
    for (const f of frames) total += f.width * f.height;
    const stride = Math.max(1, Math.floor(total / maxSamples));
    let opaque = 0;
    for (const f of frames) {
      const d = f.data;
      for (let p = 0; p < d.length; p += 4 * stride) {
        if (d[p + 3] < 128) continue;
        counts[((d[p] >> SHIFT) << (BITS * 2)) | ((d[p + 1] >> SHIFT) << BITS) | (d[p + 2] >> SHIFT)]++;
        opaque++;
      }
    }
    return { counts, opaque };
  }

  function binColor(id) {
    const mask = (1 << BITS) - 1;
    const half = 1 << (SHIFT - 1);
    return [
      ((id >> (BITS * 2)) << SHIFT) + half,
      (((id >> BITS) & mask) << SHIFT) + half,
      ((id & mask) << SHIFT) + half,
    ];
  }

  function medianCut(bins, target) {
    // bins: [{ c: [r,g,b], n }]
    const makeBox = (items) => {
      let min = [255, 255, 255];
      let max = [0, 0, 0];
      let n = 0;
      for (const it of items) {
        n += it.n;
        for (let k = 0; k < 3; k++) {
          if (it.c[k] < min[k]) min[k] = it.c[k];
          if (it.c[k] > max[k]) max[k] = it.c[k];
        }
      }
      const ranges = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
      const axis = ranges[0] >= ranges[1] && ranges[0] >= ranges[2] ? 0 : ranges[1] >= ranges[2] ? 1 : 2;
      return { items, n, axis, score: n * (ranges[axis] + 1) };
    };

    const boxes = [makeBox(bins)];
    while (boxes.length < target) {
      let bi = -1;
      let best = 0;
      boxes.forEach((b, i) => {
        if (b.items.length > 1 && b.score > best) {
          best = b.score;
          bi = i;
        }
      });
      if (bi < 0) break;
      const box = boxes[bi];
      const items = box.items.slice().sort((a, b) => a.c[box.axis] - b.c[box.axis]);
      let acc = 0;
      let cut = 1;
      for (let i = 0; i < items.length; i++) {
        acc += items[i].n;
        if (acc >= box.n / 2) {
          cut = Math.min(items.length - 1, Math.max(1, i + 1));
          break;
        }
      }
      boxes.splice(bi, 1, makeBox(items.slice(0, cut)), makeBox(items.slice(cut)));
    }

    return boxes.map((b) => {
      let r = 0;
      let g = 0;
      let bl = 0;
      for (const it of b.items) {
        r += it.c[0] * it.n;
        g += it.c[1] * it.n;
        bl += it.c[2] * it.n;
      }
      return [r / b.n, g / b.n, bl / b.n];
    });
  }

  function refine(colors, bins, iterations = 4) {
    for (let it = 0; it < iterations; it++) {
      const sums = colors.map(() => [0, 0, 0, 0]);
      for (const bin of bins) {
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < colors.length; i++) {
          const c = colors[i];
          const d = (c[0] - bin.c[0]) ** 2 + (c[1] - bin.c[1]) ** 2 + (c[2] - bin.c[2]) ** 2;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
        const s = sums[best];
        s[0] += bin.c[0] * bin.n;
        s[1] += bin.c[1] * bin.n;
        s[2] += bin.c[2] * bin.n;
        s[3] += bin.n;
      }
      colors = colors.map((c, i) => (sums[i][3] ? [sums[i][0] / sums[i][3], sums[i][1] / sums[i][3], sums[i][2] / sums[i][3]] : c));
    }
    return colors;
  }

  // Colour of a 6x6x6 grid that is the farthest from everything used by the animation
  function pickKeyColor(bins) {
    let best = [255, 0, 255];
    let bestD = -1;
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          let min = Infinity;
          for (const bin of bins) {
            const d = (bin.c[0] - r) ** 2 + (bin.c[1] - g) ** 2 + (bin.c[2] - b) ** 2;
            if (d < min) min = d;
            if (min <= bestD) break;
          }
          if (min > bestD) {
            bestD = min;
            best = [r, g, b];
          }
        }
      }
    }
    return best;
  }

  // frames: ImageData[] (RGBA, transparent where alpha < 128)
  function build(frames, withTransparency) {
    const { counts } = histogram(frames);
    const bins = [];
    for (let id = 0; id < BINS; id++) {
      if (counts[id]) bins.push({ c: binColor(id), n: counts[id] });
    }

    const size = withTransparency ? 255 : 256;
    let colors = bins.length ? medianCut(bins, size) : [[0, 0, 0]];
    colors = refine(colors, bins);
    colors = colors.map((c) => c.map((v) => Math.max(0, Math.min(255, Math.round(v)))));

    let keyIndex = -1;
    let key = null;
    if (withTransparency) {
      key = pickKeyColor(bins);
      keyIndex = colors.length;
      colors.push(key);
    }
    while (colors.length < 256) colors.push(colors[colors.length - 1]);

    // Nearest colour lookup (key excluded), indexed by 6 bits per channel
    const lut = new Uint8Array(1 << (LUT_BITS * 3));
    const realCount = withTransparency ? keyIndex : 256;
    const half = 1 << (LUT_SHIFT - 1);
    for (let id = 0; id < lut.length; id++) {
      const mask = (1 << LUT_BITS) - 1;
      const r = ((id >> (LUT_BITS * 2)) << LUT_SHIFT) + half;
      const g = (((id >> LUT_BITS) & mask) << LUT_SHIFT) + half;
      const b = ((id & mask) << LUT_SHIFT) + half;
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < realCount; i++) {
        const c = colors[i];
        const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      lut[id] = best;
    }

    const flat = [];
    colors.forEach((c) => flat.push(c[0], c[1], c[2]));
    return { palette: flat, colors, lut, keyIndex, key };
  }

  // Replaces every pixel by its palette colour (ordered dither), alpha becomes 255
  function quantize(imageData, pal, strength = 12) {
    const d = imageData.data;
    const w = imageData.width;
    const { lut, colors, key } = pal;
    for (let p = 0, i = 0; i < d.length; p++, i += 4) {
      if (d[i + 3] < 128) {
        d[i] = key[0];
        d[i + 1] = key[1];
        d[i + 2] = key[2];
        d[i + 3] = 255;
        continue;
      }
      const x = p % w;
      const y = (p - x) / w;
      const off = BAYER[((y & 7) << 3) | (x & 7)] * strength;
      let r = d[i] + off;
      let g = d[i + 1] + off;
      let b = d[i + 2] + off;
      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;
      const c = colors[lut[((r >> LUT_SHIFT) << (LUT_BITS * 2)) | ((g >> LUT_SHIFT) << LUT_BITS) | (b >> LUT_SHIFT)]];
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
    }
    return imageData;
  }

  window.Palette = { build, quantize };
})();
