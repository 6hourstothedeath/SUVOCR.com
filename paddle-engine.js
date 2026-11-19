/* PaddleOCR PP-OCRv5 (DB-детектор + кириллический распознаватель) на onnxruntime-web.
 * Полностью в браузере: модели лежат в vendor/paddle, рантайм — vendor/ort.
 * Наружу отдаёт строки с координатами: [{ text, score, bbox:{x0,y0,x1,y1} }]
 */
'use strict';

const PaddleEngine = (() => {
  let det = null;
  let rec = null;
  let dict = null;
  let readyPromise = null;

  const CFG = {
    detUrl: 'vendor/paddle/det.onnx',
    recUrl: 'vendor/paddle/rec_cyr.onnx',
    dictUrl: 'vendor/paddle/dict.json',
    detSide: 960,      // длинная сторона для детектора
    recHeight: 48,     // высота строки для распознавателя
    detThreshold: 0.3,
    minLineHeight: 7,  // px, мельче — мусор
    minLineWidth: 14,
    padXRatio: 0.08,   // запас по горизонтали
    padYRatio: 0.7,    // по вертикали — компенсирует «узкую» карту детектора
    padPx: 1,
  };

  async function init() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      if (typeof ort === 'undefined') throw new Error('onnxruntime-web не загружен');

      ort.env.wasm.wasmPaths = new URL('vendor/ort/', document.baseURI).href;
      ort.env.wasm.numThreads = 1;      // без cross-origin isolation потоки недоступны
      ort.env.wasm.simd = true;
      ort.env.logLevel = 'error';

      const [d, r, dictData] = await Promise.all([
        ort.InferenceSession.create(CFG.detUrl, { executionProviders: ['wasm'] }),
        ort.InferenceSession.create(CFG.recUrl, { executionProviders: ['wasm'] }),
        fetch(CFG.dictUrl).then((res) => res.json()),
      ]);
      det = d;
      rec = r;
      dict = dictData;
      return true;
    })();
    return readyPromise;
  }

  /* ---------- вспомогательное ---------- */

  function toRgb(imageData) {
    const { data, width, height } = imageData;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
    }
    return rgb;
  }

  function resizeRgb(rgb, w, h, nw, nh) {
    const out = new Uint8Array(nw * nh * 3);
    for (let y = 0; y < nh; y++) {
      const sy = ((y + 0.5) * h) / nh - 0.5;
      const y0 = Math.max(0, Math.floor(sy));
      const y1 = Math.min(h - 1, y0 + 1);
      const wy = Math.min(1, Math.max(0, sy - y0));
      for (let x = 0; x < nw; x++) {
        const sx = ((x + 0.5) * w) / nw - 0.5;
        const x0 = Math.max(0, Math.floor(sx));
        const x1 = Math.min(w - 1, x0 + 1);
        const wx = Math.min(1, Math.max(0, sx - x0));
        const i00 = (y0 * w + x0) * 3, i01 = (y0 * w + x1) * 3;
        const i10 = (y1 * w + x0) * 3, i11 = (y1 * w + x1) * 3;
        const o = (y * nw + x) * 3;
        for (let c = 0; c < 3; c++) {
          const top = rgb[i00 + c] * (1 - wx) + rgb[i01 + c] * wx;
          const bot = rgb[i10 + c] * (1 - wx) + rgb[i11 + c] * wx;
          out[o + c] = top * (1 - wy) + bot * wy;
        }
      }
    }
    return out;
  }

  /* связные области на карте вероятностей → прямоугольники */
  function boxesFromMask(mask, w, h) {
    const seen = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    const boxes = [];

    for (let start = 0; start < w * h; start++) {
      if (!mask[start] || seen[start]) continue;
      let sp = 0;
      stack[sp++] = start;
      seen[start] = 1;
      let minX = w, maxX = -1, minY = h, maxY = -1, area = 0;

      while (sp) {
        const idx = stack[--sp];
        const x = idx % w;
        const y = (idx / w) | 0;
        area++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (mask[ni] && !seen[ni]) {
              seen[ni] = 1;
              stack[sp++] = ni;
            }
          }
        }
      }
      if (area < 20) continue;
      boxes.push({ x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 });
    }
    return boxes;
  }

  /* распознавание одной строки: crop → 48px → CTC */
  async function recognizeCrop(rgb, imgW, box) {
    const padX = Math.round((box.x1 - box.x0) * CFG.padXRatio) + CFG.padPx;
    const padY = Math.round((box.y1 - box.y0) * CFG.padYRatio) + CFG.padPx;
    const x0 = Math.max(0, box.x0 - padX);
    const y0 = Math.max(0, box.y0 - padY);
    const x1 = Math.min(imgW - 1, box.x1 + padX);
    const y1 = Math.min(Math.floor(rgb.length / 3 / imgW) - 1, box.y1 + padY);
    const cw = x1 - x0;
    const ch = y1 - y0;
    if (cw < 2 || ch < 2) return { text: '', score: 0 };

    const th = CFG.recHeight;
    const tw = Math.max(8, Math.round((cw / ch) * th));
    const input = new Float32Array(3 * th * tw);

    for (let y = 0; y < th; y++) {
      const sy = y0 + Math.min(ch - 1, Math.floor((y / th) * ch));
      for (let x = 0; x < tw; x++) {
        const sx = x0 + Math.min(cw - 1, Math.floor((x / tw) * cw));
        const si = (sy * imgW + sx) * 3;
        for (let c = 0; c < 3; c++) {
          const v = rgb[si + c] / 255;
          input[c * th * tw + y * tw + x] = (v - 0.5) / 0.5;
        }
      }
    }

    const feeds = { [rec.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, th, tw]) };
    const out = await rec.run(feeds);
    const logits = out[rec.outputNames[0]];
    const [, T, C] = logits.dims;
    const probs = logits.data;

    let text = '';
    let sum = 0;
    let cnt = 0;
    let prev = -1;
    for (let t = 0; t < T; t++) {
      let best = 0;
      let bestP = -Infinity;
      const base = t * C;
      for (let c = 0; c < C; c++) {
        const p = probs[base + c];
        if (p > bestP) { bestP = p; best = c; }
      }
      if (best !== prev && best > 0) {
        const ch2 = best - 1 < dict.length ? dict[best - 1] : ' ';
        text += ch2;
        sum += bestP;
        cnt++;
      }
      prev = best;
    }
    return { text, score: cnt ? sum / cnt : 0 };
  }

  /* ---------- основной вызов ---------- */

  async function recognizeCanvas(canvas) {
    await init();
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imgW = canvas.width;
    const imgH = canvas.height;
    const rgb = toRgb(ctx.getImageData(0, 0, imgW, imgH));

    // 1. детектор
    const scale = Math.min(1, CFG.detSide / Math.max(imgW, imgH));
    const dh = Math.max(32, Math.round((imgH * scale) / 32) * 32);
    const dw = Math.max(32, Math.round((imgW * scale) / 32) * 32);
    const small = resizeRgb(rgb, imgW, imgH, dw, dh);

    const detInput = new Float32Array(3 * dw * dh);
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const p = (y * dw + x) * 3;
        for (let c = 0; c < 3; c++) {
          const v = small[p + c] / 255;
          detInput[c * dh * dw + y * dw + x] = (v - mean[c]) / std[c];
        }
      }
    }

    const detOut = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', detInput, [1, 3, dh, dw]) });
    const prob = detOut[det.outputNames[0]];
    const [, , ph, pw] = prob.dims;
    const mask = new Uint8Array(pw * ph);
    for (let i = 0; i < pw * ph; i++) mask[i] = prob.data[i] > CFG.detThreshold ? 1 : 0;

    const kx = imgW / pw;
    const ky = imgH / ph;
    let boxes = boxesFromMask(mask, pw, ph).map((b) => ({
      x0: Math.round(b.x0 * kx),
      y0: Math.round(b.y0 * ky),
      x1: Math.round(b.x1 * kx),
      y1: Math.round(b.y1 * ky),
    }));

    boxes = boxes
      .filter((b) => (b.y1 - b.y0) >= CFG.minLineHeight && (b.x1 - b.x0) >= CFG.minLineWidth)
      .sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));

    // 2. построчное распознавание (по 4 строки параллельно — компромисс скорость/память)
    const lines = [];
    const CONCURRENCY = 4;
    for (let i = 0; i < boxes.length; i += CONCURRENCY) {
      const batch = boxes.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map((box) => recognizeCrop(rgb, imgW, box)));
      batch.forEach((box, idx) => {
        const r = results[idx];
        if (r.text.trim()) lines.push({ text: r.text, score: r.score, bbox: box });
      });
    }

    return {
      lines,
      width: imgW,
      height: imgH,
      meanScore: lines.length ? lines.reduce((s, l) => s + l.score, 0) / lines.length : 0,
    };
  }

  return { init, recognizeCanvas, CFG };
})();
