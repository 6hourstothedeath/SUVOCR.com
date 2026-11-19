/* OCR-блокнот — PWA для распознавания текста с фотографий.
 * Всё считается на телефоне: PaddleOCR (PP-OCRv5) в onnxruntime-web.
 * Проверка ошибок — внешние API (Яндекс.Спеллер / LanguageTool).
 */
'use strict';

/* ------------------------------------------------------------------ */
/* Настройки                                                           */
/* ------------------------------------------------------------------ */
const DEFAULTS = {
  langs: 'rus+eng',
  maxSide: 1800,
  speller: 'yandex',
  mail: 'auto',
  mailTo: 'itsmyocrbitches@gmail.com',
};

const settings = Object.assign({}, DEFAULTS, readJSON('ocr.settings') || {});

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function saveSettings() {
  try { localStorage.setItem('ocr.settings', JSON.stringify(settings)); } catch {}
}

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */
const $ = (sel) => document.querySelector(sel);
const el = {
  screenCapture: $('#screen-capture'),
  screenResult: $('#screen-result'),
  fileCamera: $('#fileCamera'),
  fileGallery: $('#fileGallery'),
  pageList: $('#pageList'),
  emptyHint: $('#emptyHint'),
  runBar: $('#runBar'),
  runCount: $('#runCount'),
  btnRun: $('#btnRun'),
  btnClear: $('#btnClear'),
  result: $('#result'),
  stats: $('#stats'),
  progressWrap: $('#progressWrap'),
  progressFill: $('#progressFill'),
  progressText: $('#progressText'),
  issuesPanel: $('#issuesPanel'),
  issuesList: $('#issuesList'),
  issuesTitle: $('#issuesTitle'),
  toast: $('#toast'),
  dlg: $('#dlgSettings'),
};

/* ------------------------------------------------------------------ */
/* Состояние                                                           */
/* ------------------------------------------------------------------ */
const state = {
  pages: [],       // { id, seq, name, blob, url, text, paragraphs, conf, status, error }
  busy: false,
  seq: 1,
  engineReady: false,
  issues: [],
};

/* ------------------------------------------------------------------ */
/* IndexedDB: сохраняем страницы между перезагрузками                  */
/* ------------------------------------------------------------------ */
const DB_NAME = 'ocr-notebook';
const DB_STORE = 'pages';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(page) {
  try {
    const db = await idbOpen();
    const rec = {
      id: page.id, seq: page.seq, name: page.name, blob: page.blob,
      text: page.text || '', paragraphs: page.paragraphs || [],
      conf: page.conf || 0, status: page.status || 'pending',
    };
    await new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(rec);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch (e) { console.warn('idb put', e); }
}
async function idbAll() {
  try {
    const db = await idbOpen();
    const rows = await new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const rq = tx.objectStore(DB_STORE).getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => rej(rq.error);
    });
    db.close();
    return rows;
  } catch (e) { console.warn('idb all', e); return []; }
}
async function idbDelete(id) {
  try {
    const db = await idbOpen();
    await new Promise((res) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(id);
      tx.oncomplete = res; tx.onerror = res;
    });
    db.close();
  } catch {}
}
async function idbClear() {
  try {
    const db = await idbOpen();
    await new Promise((res) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).clear();
      tx.oncomplete = res; tx.onerror = res;
    });
    db.close();
  } catch {}
}

/* ------------------------------------------------------------------ */
/* Утилиты                                                             */
/* ------------------------------------------------------------------ */
let toastTimer = null;
function toast(msg, isError = false) {
  el.toast.textContent = msg;
  el.toast.classList.toggle('err', !!isError);
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3200);
}

function showScreen(name) {
  el.screenCapture.classList.toggle('active', name === 'capture');
  el.screenResult.classList.toggle('active', name === 'result');
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function fmtSize(bytes) {
  if (!bytes) return '';
  return bytes > 1024 * 1024 ? (bytes / 1048576).toFixed(1) + ' МБ' : Math.round(bytes / 1024) + ' КБ';
}

/* ------------------------------------------------------------------ */
/* Добавление фотографий                                               */
/* ------------------------------------------------------------------ */
async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f && f.type && f.type.startsWith('image/'));
  if (!files.length) return;

  for (const file of files) {
    const page = {
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      seq: state.seq++,
      name: file.name || 'photo.jpg',
      blob: file,
      url: URL.createObjectURL(file),
      text: '',
      paragraphs: [],
      conf: 0,
      status: 'pending',
      error: '',
    };
    state.pages.push(page);
    idbPut(page);
  }
  renderPages();
  toast(`Добавлено: ${files.length} фото`);
}

function renderPages() {
  el.pageList.innerHTML = '';
  el.emptyHint.hidden = state.pages.length > 0;
  el.runBar.hidden = state.pages.length === 0;
  el.runCount.textContent = String(state.pages.length);

  const pending = state.pages.filter((p) => p.status !== 'done').length;
  el.btnRun.disabled = state.busy || pending === 0;
  el.btnRun.textContent = pending === 0 ? 'Текст готов — открыть' : `Распознать ${pending} стр.`;

  state.pages.forEach((page, index) => {
    const li = document.createElement('li');
    li.className = 'page-item';

    const img = document.createElement('img');
    img.src = page.url;
    img.alt = page.name;
    img.loading = 'lazy';

    const meta = document.createElement('div');
    meta.className = 'page-meta';
    const name = document.createElement('div');
    name.className = 'page-name';
    name.textContent = `${index + 1}. ${page.name}`;
    const sub = document.createElement('div');
    sub.className = 'page-sub';
    if (page.status === 'done') {
      sub.classList.add('ok');
      sub.textContent = `распознано · ${page.text.length} симв. · уверенность ${Math.round(page.conf)}%`;
    } else if (page.status === 'error') {
      sub.classList.add('err');
      sub.textContent = 'ошибка: ' + (page.error || 'не распознано');
    } else if (page.status === 'running') {
      sub.textContent = 'распознаётся…';
    } else {
      sub.textContent = fmtSize(page.blob.size) + ' · ждёт распознавания';
    }
    meta.append(name, sub);

    const btns = document.createElement('div');
    btns.className = 'page-btns';
    btns.innerHTML = `
      <button data-act="up" ${index === 0 ? 'disabled' : ''} aria-label="Выше">↑</button>
      <button data-act="down" ${index === state.pages.length - 1 ? 'disabled' : ''} aria-label="Ниже">↓</button>
      <button data-act="del" aria-label="Удалить">✕</button>`;
    btns.addEventListener('click', (ev) => {
      const act = ev.target?.dataset?.act;
      if (!act) return;
      if (act === 'up' && index > 0) swapPages(index, index - 1);
      if (act === 'down' && index < state.pages.length - 1) swapPages(index, index + 1);
      if (act === 'del') removePage(index);
    });

    li.append(img, meta, btns);
    el.pageList.appendChild(li);
  });
}

function swapPages(a, b) {
  const arr = state.pages;
  [arr[a], arr[b]] = [arr[b], arr[a]];
  arr.forEach((p, i) => { p.seq = i + 1; });
  arr.forEach((p) => idbPut(p));
  renderPages();
}

function removePage(index) {
  const [page] = state.pages.splice(index, 1);
  if (page) {
    URL.revokeObjectURL(page.url);
    idbDelete(page.id);
  }
  renderPages();
}

/* ------------------------------------------------------------------ */
/* Предобработка изображения (серый + растяжка контраста)              */
/* ------------------------------------------------------------------ */
async function preprocess(blob, maxSide) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    // Safari/старые движки
    bmp = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = URL.createObjectURL(blob);
    });
  }
  const srcW = bmp.width || bmp.naturalWidth;
  const srcH = bmp.height || bmp.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();

  const image = ctx.getImageData(0, 0, w, h);
  const px = image.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    const g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
    px[i] = px[i + 1] = px[i + 2] = g;
    hist[g]++;
  }
  const total = w * h;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.02) { hi = v; break; } }
  if (hi - lo < 24) { lo = 0; hi = 255; }
  const k = 255 / (hi - lo);
  for (let i = 0; i < px.length; i += 4) {
    let v = (px[i] - lo) * k;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function canvasToBlob(canvas, quality = 0.95) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

async function blobToCanvas(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  return canvas;
}

/* Выравнивание наклона делаем ПОСЛЕ поворота: на боком снимке оценка врёт */
function deskewCanvas(canvas) {
  const angle = estimateSkew(canvas);
  window.__lastSkew = angle;
  // мелкий наклон (до ~0.8°) детектор переносит сам, а лишний ресемплинг только мылит текст
  return Math.abs(angle) > 0.8 ? rotateCanvas(canvas, -angle) : canvas;
}

/* Оценка наклона страницы по проекции строк: перебираем углы и ищем максимум
 * дисперсии вертикальной проекции (текст выстраивается в ровные строки). */
function estimateSkew(canvas) {
  const W = 480;
  const H = Math.max(1, Math.round((canvas.height * W) / canvas.width));
  const small = document.createElement('canvas');
  small.width = W;
  small.height = H;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(canvas, 0, 0, W, H);
  const data = sctx.getImageData(0, 0, W, H).data;

  const bin = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) bin[i] = data[i * 4] < 140 ? 1 : 0;

  let best = { score: -1, angle: 0 };
  for (let a = -5; a <= 5.001; a += 0.5) {
    const t = Math.tan((a * Math.PI) / 180);
    const sums = new Float64Array(H);
    for (let x = 0; x < W; x++) {
      const dx = (x - W / 2) * t;
      for (let y = 0; y < H; y++) {
        const yy = (y + dx) | 0;
        if (yy >= 0 && yy < H && bin[yy * W + x]) sums[y]++;
      }
    }
    let mean = 0;
    for (let y = 0; y < H; y++) mean += sums[y];
    mean /= H;
    let score = 0;
    for (let y = 0; y < H; y++) {
      const d = sums[y] - mean;
      score += d * d;
    }
    if (score > best.score) best = { score, angle: a };
  }
  return best.angle;
}

function rotateCanvas(canvas, degrees) {
  const rad = (degrees * Math.PI) / 180;
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

/* Поворот готового снимка на 90/180/270 — телефон часто снимает «вверх ногами» */
async function rotateBlob(blob, degrees) {
  const bmp = await createImageBitmap(blob);
  const swap = degrees === 90 || degrees === 270;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? bmp.height : bmp.width;
  canvas.height = swap ? bmp.width : bmp.height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  if (bmp.close) bmp.close();
  return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
}

/* Быстрый «пробник» ориентации: распознаём уменьшенную копию в 0° и 180°
 * и выбираем вариант, где текст увереннее и его больше. Полный проход — один. */
function downscaleCanvas(canvas, side) {
  const scale = Math.min(1, side / Math.max(canvas.width, canvas.height));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(canvas.width * scale));
  out.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

/* поворот canvas на 90/180/270 с перестановкой сторон */
function rotateCanvasAny(canvas, degrees) {
  const swap = degrees === 90 || degrees === 270;
  const out = document.createElement('canvas');
  out.width = swap ? canvas.height : canvas.width;
  out.height = swap ? canvas.width : canvas.height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}

/* ------------------------------------------------------------------ */
/* OCR: PaddleOCR PP-OCRv5 (DB + кириллический распознаватель)          */
/* ------------------------------------------------------------------ */
function setProgress(ratio, text) {
  el.progressWrap.hidden = false;
  if (ratio == null) {
    el.progressFill.style.width = '';
  } else {
    el.progressFill.style.width = Math.round(ratio * 100) + '%';
  }
  if (text) el.progressText.textContent = text;
}

async function getEngine() {
  if (state.engineReady) return true;
  state.progressLabel = 'Загрузка движка';
  setProgress(0, 'Загрузка движка OCR (PaddleOCR)…');
  await PaddleEngine.init();
  state.engineReady = true;
  return true;
}

/* Какая сторона у страницы: гоняем уменьшенную копию и смотрим,
 * где текста больше и он увереннее. */
async function probeOrientation(canvas) {
  const small = downscaleCanvas(canvas, 720);
  const tried = [];
  let best = null;

  for (const degrees of [0, 180, 90, 270]) {
    if (best && best.score >= 90) break;
    state.progressLabel = `${state.progressLabel} · ориентация`;
    const target = degrees ? rotateCanvasAny(small, degrees) : small;
    const res = await PaddleEngine.recognizeCanvas(target);
    const letters = res.lines.reduce(
      (n, l) => n + (l.text.match(/[\p{L}\p{N}]/gu) || []).length, 0);
    const score = Math.round(letters * res.meanScore);
    tried.push({ deg: degrees, score });
    if (!best || score > best.score) best = { deg: degrees, score };
  }

  window.__probe = tried;
  return best.score >= 20 ? best.deg : 0;
}

function splitHeading(lines) {
  if (lines.length < 2) return [lines];
  const first = lines[0];
  const second = lines[1];
  if (first.length > 60) return [lines];
  if (/[.,;:!?…]$/.test(first)) return [lines];
  if (!/^[А-ЯЁA-Z0-9«"(]/.test(first)) return [lines];
  if (!/^[А-ЯЁA-Z0-9«"(]/.test(second)) return [lines];
  return [[first], lines.slice(1)];
}

/* Строки от детектора → абзацы по вертикальным разрывам */
function paragraphsFromLines(lines) {
  const items = (lines || [])
    .map((l) => ({
      text: String(l.text || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(),
      bbox: l.bbox,
    }))
    .filter((x) => x.text && x.bbox);

  if (!items.length) return [];
  items.sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));

  const heights = items.map((i) => i.bbox.y1 - i.bbox.y0).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 20;

  const groups = [];
  let cur = [];
  for (const item of items) {
    const prev = cur[cur.length - 1];
    if (prev && item.bbox.y0 - prev.bbox.y1 > medianH * 0.7) {
      groups.push(cur);
      cur = [];
    }
    cur.push(item);
  }
  if (cur.length) groups.push(cur);

  const paras = [];
  for (const group of groups) {
    for (const part of splitHeading(group.map((x) => x.text))) {
      if (part.length) paras.push({ lines: part, conf: 0 });
    }
  }
  return paras;
}

async function runOCR() {
  if (state.busy) return;
  const todo = state.pages.filter((p) => p.status !== 'done');
  if (!todo.length) { openResult(); return; }

  state.busy = true;
  renderPages();
  el.btnRun.disabled = true;
  el.progressWrap.hidden = false;
  setProgress(0, 'Подготовка…');

  try {
    await getEngine();
    let done = 0;

    for (const page of todo) {
      state.progressLabel = `Стр. ${done + 1} из ${todo.length}`;
      page.status = 'running';
      renderPages();
      try {
        let canvas = await preprocess(page.blob, Number(settings.maxSide) || 1800);

        const rotation = await probeOrientation(canvas);
        if (rotation) {
          state.progressLabel = `${state.progressLabel} · поворот ${rotation}°`;
          canvas = rotateCanvasAny(canvas, rotation);
        }
        canvas = deskewCanvas(canvas);

        setProgress((done + 0.5) / todo.length, `${state.progressLabel} · распознавание`);
        const result = await PaddleEngine.recognizeCanvas(canvas);

        page.paragraphs = paragraphsFromLines(result.lines);
        page.text = page.paragraphs.map((p) => p.lines.join('\n')).join('\n\n');
        page.conf = Math.round((result.meanScore || 0) * 100);
        page.status = page.text.trim() ? 'done' : 'error';
        if (!page.text.trim()) page.error = 'текст не найден';
      } catch (err) {
        console.error(err);
        page.status = 'error';
        page.error = String(err && err.message ? err.message : err).slice(0, 120);
      }
      idbPut(page);
      done++;
      setProgress(done / todo.length, `${done} из ${todo.length} готово`);
      renderPages();
    }

    el.progressWrap.hidden = true;
    const failed = state.pages.filter((p) => p.status === 'error').length;
    if (failed) toast(`Не удалось распознать страниц: ${failed}`, true);
    openResult();
  } catch (err) {
    console.error(err);
    el.progressWrap.hidden = true;
    toast('Ошибка OCR: ' + (err && err.message ? err.message : err), true);
  } finally {
    state.busy = false;
    renderPages();
  }
}

/* ------------------------------------------------------------------ */
/* Сборка текста: абзацы, склейка страниц                              */
/* ------------------------------------------------------------------ */
const TERMINAL = /[.!?…:;»"'”’)\]]$/;

function joinLines(lines) {
  let out = '';
  for (const raw of lines) {
    const line = String(raw).replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (!out) { out = line; continue; }
    if (/-$/.test(out) && /^[а-яёa-z]/i.test(line)) {
      out = out.slice(0, -1) + line;              // перенос слова: "кото-" + "рый"
    } else if (/[-–—]$/.test(out)) {
      out = out + line;
    } else {
      out = out + ' ' + line;
    }
  }
  return tidy(out);
}

function tidy(s) {
  return fixMixedAlphabet(s
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([(\[«"])\s+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim());
}

/* Латиница, похожая на кириллицу: частая ошибка OCR в режиме rus+eng */
const LAT2CYR = {
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
  a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', h: 'н',
};

function fixMixedAlphabet(text) {
  if (!/[А-Яа-яЁё]/.test(text) || !/[A-Za-z]/.test(text)) return text;
  let prevWord = '';
  return text.split(/(\s+)/).map((tok) => {
    if (!tok || /^\s+$/.test(tok)) return tok;
    const m = tok.match(/^([«"(\[]*)(.*?)([»".,;:!?)\]]*)$/);
    if (!m) { prevWord = tok; return tok; }
    const [, pre, core, post] = m;
    if (!core) return tok;

    let fixed = core;
    if (core.length === 1 && LAT2CYR[core]) {
      // одиночная латинская буква внутри русского текста — это почти всегда кириллица
      const sentenceStart = !prevWord || /[.!?…:]$/.test(prevWord);
      const cyr = LAT2CYR[core];
      fixed = sentenceStart ? cyr : cyr.toLowerCase();
    } else if (/[A-Za-z]/.test(core) && /[А-Яа-яЁё]/.test(core)) {
      const latin = core.replace(/[^A-Za-z]/g, '');
      const allLookalike = [...latin].every((ch) => LAT2CYR[ch]);
      const isAbbrev = core === core.toUpperCase() && latin.length > 1;
      if (allLookalike && !isAbbrev) {
        fixed = core.replace(/[A-Za-z]/g, (ch) => LAT2CYR[ch] || ch);
      }
    }
    prevWord = fixed + post;
    return pre + fixed + post;
  }).join('');
}

function continuesAcross(prevText, nextText) {
  const prev = prevText.trim();
  const next = nextText.trim();
  if (!prev || !next) return false;
  if (TERMINAL.test(prev)) return false;
  if (/[-–—]$/.test(prev)) return true;
  // продолжаем только если следующая страница начинается со строчной буквы
  return /^[а-яёa-z0-9(«"]/.test(next);
}

function joinAcross(prev, next) {
  const a = prev.trim();
  const b = next.trim();
  if (/[-–—]$/.test(a)) return tidy(a.slice(0, -1) + b);
  return tidy(a + ' ' + b);
}

function buildText() {
  const opts = {
    merge: $('#optMerge').checked,
    reflow: $('#optReflow').checked,
    blank: $('#optEmpty').checked,
    marks: $('#optPageMarks').checked,
  };

  const blocks = [];
  state.pages.forEach((page, index) => {
    if (!page.paragraphs || !page.paragraphs.length) return;
    page.paragraphs.forEach((p) => {
      const text = opts.reflow ? joinLines(p.lines) : p.lines.join('\n').trim();
      if (!text) return;
      blocks.push({ text, page: index + 1 });
    });
  });

  const merged = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    if (opts.merge && prev && continuesAcross(prev.text, b.text)) {
      prev.text = joinAcross(prev.text, b.text);
      prev.pages.add(b.page);
    } else {
      merged.push({ text: b.text, pages: new Set([b.page]) });
    }
  }

  const parts = [];
  let lastPage = 0;
  for (const m of merged) {
    const page = Math.min(...m.pages);
    if (opts.marks && page !== lastPage) {
      parts.push(`--- стр. ${page} ---`);
      lastPage = page;
    }
    parts.push(m.text);
  }
  const sep = opts.blank ? '\n\n' : '\n';
  const text = parts.join(sep).replace(/\n{3,}/g, '\n\n').trim();
  return { text, blocks: merged };
}

function rebuildText() {
  const { text, blocks } = buildText();
  el.result.value = text;
  const chars = text.length;
  const words = (text.match(/[A-Za-zА-Яа-яЁё0-9-]+/g) || []).length;
  const pages = state.pages.filter((p) => p.status === 'done').length;
  el.stats.textContent = `Страниц: ${pages} · абзацев: ${blocks.length} · слов: ${words} · символов: ${chars}`;
  return text;
}

/* ------------------------------------------------------------------ */
/* Проверка орфографии через API                                       */
/* ------------------------------------------------------------------ */
function chunkText(text, limit = 8000) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + limit);
    if (end < text.length) {
      const window = text.slice(start + limit - 600, end);
      const cut = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('. '),
        window.lastIndexOf('! '),
        window.lastIndexOf('? '),
        window.lastIndexOf('\n'),
      );
      if (cut > 0) end = start + limit - 600 + cut + 1;
    }
    chunks.push({ text: text.slice(start, end), base: start });
    start = end;
  }
  return chunks;
}

async function checkYandex(text) {
  const issues = [];
  for (const chunk of chunkText(text)) {
    const body = new URLSearchParams({
      text: chunk.text,
      lang: 'ru',
      format: 'plain',
      options: '518', // ignore digits, urls, emails, file names
    });
    const res = await fetch('https://speller.yandex.net/services/spellservice.json/checkText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error('Яндекс.Спеллер: HTTP ' + res.status);
    const rows = await res.json();
    for (const r of rows) {
      issues.push({
        start: chunk.base + r.pos,
        end: chunk.base + r.pos + r.len,
        word: r.word,
        replacements: (r.s || []).slice(0, 3),
        source: 'Яндекс',
        message: '',
      });
    }
  }
  return issues;
}

async function checkLanguageTool(text) {
  const issues = [];
  for (const chunk of chunkText(text, 18000)) {
    const body = new URLSearchParams({ text: chunk.text, language: 'ru-RU' });
    const res = await fetch('https://api.languagetool.org/v2/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error('LanguageTool: HTTP ' + res.status);
    const data = await res.json();
    for (const m of data.matches || []) {
      issues.push({
        start: chunk.base + m.offset,
        end: chunk.base + m.offset + m.length,
        word: chunk.text.substr(m.offset, m.length),
        replacements: (m.replacements || []).slice(0, 3).map((r) => r.value),
        source: 'LT',
        message: m.message || '',
      });
    }
  }
  return issues;
}

async function runSpellcheck() {
  const text = el.result.value;
  if (!text.trim()) { toast('Нет текста для проверки', true); return; }
  if (settings.speller === 'off') { toast('Проверка отключена в настройках', true); return; }
  if (!navigator.onLine) { toast('Нет интернета — проверка недоступна', true); return; }

  const btn = $('#btnSpell');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'Проверяю…';
  try {
    let issues = [];
    if (settings.speller === 'yandex' || settings.speller === 'both') {
      issues = issues.concat(await checkYandex(text));
    }
    if (settings.speller === 'languagetool' || settings.speller === 'both') {
      issues = issues.concat(await checkLanguageTool(text));
    }
    // убираем дубликаты по позиции
    const seen = new Set();
    issues = issues.filter((i) => {
      const key = i.start + ':' + i.end;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => a.start - b.start);

    state.issues = issues;
    renderIssues();
    toast(issues.length ? `Найдено: ${issues.length}` : 'Ошибок не найдено');
  } catch (err) {
    console.error(err);
    toast('Проверка не удалась: ' + (err.message || err), true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function contextOf(text, start, end) {
  const from = Math.max(0, start - 34);
  const to = Math.min(text.length, end + 34);
  let pre = text.slice(from, start).replace(/\n/g, ' ');
  let post = text.slice(end, to).replace(/\n/g, ' ');
  if (from > 0) pre = '…' + pre.replace(/^\S*\s?/, '');
  if (to < text.length) post = post.replace(/\s?\S*$/, '') + '…';
  const word = text.slice(start, end).replace(/\n/g, ' ');
  return { pre, word, post };
}

function renderIssues() {
  const text = el.result.value;
  el.issuesList.innerHTML = '';
  el.issuesPanel.hidden = state.issues.length === 0;
  el.issuesTitle.textContent = `Найдено: ${state.issues.length}`;

  state.issues.forEach((issue, idx) => {
    const li = document.createElement('li');
    li.className = 'issue';
    const { pre, word, post } = contextOf(text, issue.start, issue.end);

    const left = document.createElement('div');
    const line = document.createElement('div');
    line.innerHTML = `${escapeHtml(pre)}<b>${escapeHtml(word)}</b>${escapeHtml(post)}`;
    const ctx = document.createElement('div');
    ctx.className = 'ctx';
    ctx.textContent = (issue.source || '') + (issue.message ? ' · ' + issue.message : '');
    left.append(line, ctx);

    const right = document.createElement('div');
    right.className = 'fix';
    const variants = issue.replacements.length ? issue.replacements : ['удалить'];
    variants.forEach((rep) => {
      const b = document.createElement('button');
      b.textContent = rep;
      b.addEventListener('click', () => applyIssue(idx, rep));
      right.appendChild(b);
    });
    if (issue.replacements.length) {
      const skip = document.createElement('button');
      skip.textContent = 'оставить';
      skip.style.background = 'transparent';
      skip.style.color = 'var(--muted)';
      skip.style.borderColor = 'var(--line)';
      skip.addEventListener('click', () => {
        state.issues.splice(idx, 1);
        renderIssues();
      });
      right.appendChild(skip);
    }

    li.append(left, right);
    el.issuesList.appendChild(li);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function applyIssue(index, replacement) {
  const issue = state.issues[index];
  if (!issue) return;
  const value = el.result.value;
  const delta = replacement.length - (issue.end - issue.start);
  el.result.value = value.slice(0, issue.start) + replacement + value.slice(issue.end);

  state.issues.splice(index, 1);
  for (const other of state.issues) {
    if (other.start >= issue.end) {
      other.start += delta;
      other.end += delta;
    }
  }
  renderIssues();
}

function applyAllIssues() {
  const text = el.result.value;
  const sorted = state.issues
    .filter((i) => i.replacements.length)
    .sort((a, b) => b.start - a.start);
  let out = text;
  for (const issue of sorted) {
    out = out.slice(0, issue.start) + issue.replacements[0] + out.slice(issue.end);
  }
  el.result.value = out;
  state.issues = [];
  renderIssues();
  toast('Исправления применены');
}

/* ------------------------------------------------------------------ */
/* Отправка и экспорт                                                  */
/* ------------------------------------------------------------------ */
function safeName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `ocr-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
}

function currentText() {
  return el.result.value.trim();
}

async function shareToMail() {
  const text = currentText();
  if (!text) { toast('Нет текста', true); return; }

  // «авто»: короткий текст — письмом с заполненным адресатом, длинный — файлом
  const mode = settings.mail === 'auto'
    ? (text.length <= 4000 ? 'mailto' : 'share')
    : settings.mail;

  if (mode === 'mailto') {
    const to = encodeURIComponent(settings.mailTo || '');
    const subject = encodeURIComponent('Распознанный текст ' + new Date().toLocaleDateString('ru-RU'));
    const body = encodeURIComponent(text.slice(0, 4000));
    window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
    return;
  }

  const file = new File([text], safeName(), { type: 'text/plain;charset=utf-8' });
  const payload = { files: [file], title: 'Распознанный текст', text: text.slice(0, 300) };
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share(payload);
      toast('Отправлено');
    } else {
      downloadText(text);
      toast('Файл сохранён — прикрепите его в письме', false);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    downloadText(text);
    toast('Файл сохранён — прикрепите его в письме');
  }
}

function downloadText(text) {
  const blob = new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function copyText() {
  const text = currentText();
  if (!text) { toast('Нет текста', true); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast('Скопировано');
  } catch {
    el.result.select();
    document.execCommand('copy');
    toast('Скопировано');
  }
}

/* ------------------------------------------------------------------ */
/* Экран результата                                                    */
/* ------------------------------------------------------------------ */
function openResult() {
  const done = state.pages.filter((p) => p.status === 'done');
  if (!done.length) { toast('Сначала распознайте страницы', true); return; }
  rebuildText();
  showScreen('result');
  if (state.issues.length) renderIssues();
}

/* ------------------------------------------------------------------ */
/* Настройки                                                           */
/* ------------------------------------------------------------------ */
function openSettings() {
  $('#setMaxSide').value = String(settings.maxSide);
  $('#setSpeller').value = settings.speller;
  $('#setMail').value = settings.mail;
  $('#setMailTo').value = settings.mailTo || '';
  el.dlg.showModal();
}

function saveSettingsFromDialog() {
  const next = {
    maxSide: Number($('#setMaxSide').value),
    speller: $('#setSpeller').value,
    mail: $('#setMail').value,
    mailTo: $('#setMailTo').value.trim(),
  };
  Object.assign(settings, next);
  saveSettings();
  toast('Настройки сохранены');
}

/* ------------------------------------------------------------------ */
/* Инициализация                                                       */
/* ------------------------------------------------------------------ */
function bind() {
  el.fileCamera.addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  el.fileGallery.addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

  el.btnRun.addEventListener('click', () => {
    if (state.pages.every((p) => p.status === 'done')) openResult();
    else runOCR();
  });
  el.btnClear.addEventListener('click', async () => {
    if (!confirm('Удалить все страницы и текст?')) return;
    state.pages.forEach((p) => URL.revokeObjectURL(p.url));
    state.pages = [];
    state.issues = [];
    await idbClear();
    el.result.value = '';
    renderPages();
    showScreen('capture');
  });

  $('#btnBack').addEventListener('click', () => showScreen('capture'));
  $('#btnSpell').addEventListener('click', runSpellcheck);
  $('#btnShare').addEventListener('click', shareToMail);
  $('#btnCopy').addEventListener('click', copyText);
  $('#btnRebuild').addEventListener('click', rebuildText);
  $('#btnApplyAll').addEventListener('click', applyAllIssues);
  $('#btnCloseIssues').addEventListener('click', () => { el.issuesPanel.hidden = true; });

  ['#optMerge', '#optReflow', '#optEmpty', '#optPageMarks'].forEach((sel) => {
    $(sel).addEventListener('change', () => { if (el.screenResult.classList.contains('active')) rebuildText(); });
  });

  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnSaveSettings').addEventListener('click', saveSettingsFromDialog);

  // drag & drop на десктопе — удобно для отладки
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  window.addEventListener('online', () => toast('Интернет появился — проверка доступна'));
  window.addEventListener('offline', () => toast('Нет интернета: OCR работает, проверка — нет'));
}

async function restore() {
  const rows = await idbAll();
  if (!rows.length) return;
  rows.sort((a, b) => a.seq - b.seq);
  for (const row of rows) {
    if (!row.blob) continue;
    state.pages.push({
      id: row.id,
      seq: row.seq,
      name: row.name || 'photo.jpg',
      blob: row.blob,
      url: URL.createObjectURL(row.blob),
      text: row.text || '',
      paragraphs: row.paragraphs || [],
      conf: row.conf || 0,
      status: row.status || 'pending',
      error: '',
    });
    state.seq = Math.max(state.seq, (row.seq || 0) + 1);
  }
  renderPages();
  if (state.pages.some((p) => p.status === 'done')) {
    toast('Восстановлены прошлые страницы');
  }
}

async function init() {
  bind();
  renderPages();
  await restore();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('sw', e));
  }
}

// отладочные хуки (используются автотестами)
window.__app = {
  addFiles,
  runOCR,
  buildText,
  rebuildText,
  runSpellcheck,
  pages: () => state.pages,
  text: () => el.result.value,
  setText: (t) => { el.result.value = t; },
  openResult,
  settings,
};

document.addEventListener('DOMContentLoaded', init);
