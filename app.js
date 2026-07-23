// DM Restore — восстановление DataMatrix «Честного знака»
// Локальный препроцессинг + декодирование через @zxing/library.

(() => {
  const $ = (id) => document.getElementById(id);

  const drop = $('drop');
  const file = $('file');
  const pickBtn = $('pickBtn');
  const workspace = $('workspace');
  const srcCanvas = $('src');
  const dstCanvas = $('dst');
  const statusEl = $('status');
  const resultEl = $('result');
  const rawEl = $('raw');
  const parsedTbody = $('parsed').querySelector('tbody');

  const ctlBrightness = $('brightness');
  const ctlContrast   = $('contrast');
  const ctlSharpen    = $('sharpen');
  const ctlBlur       = $('blur');
  const ctlThreshold  = $('threshold');
  const ctlBinarize   = $('binarize');
  const ctlAdaptive   = $('adaptive');
  const ctlInvert     = $('invert');
  const ctlRotate     = $('rotate');
  const ctlScale      = $('scale');

  const decodeBtn  = $('decode');
  const autoBtn    = $('autoTry');
  const resetBtn   = $('reset');
  const newFileBtn = $('newFile');
  const clearSelBtn = $('clearSel');

  const cameraBtn   = $('cameraBtn');
  const cameraInput = $('camera');
  const liveScanBtn = $('liveScanBtn');
  const camOverlay  = $('camOverlay');
  const camVideo    = $('camVideo');
  const camStopBtn  = $('camStop');
  const scanViewBtn = $('scanView');
  const scanOverlay = $('scanOverlay');
  const scanCanvas  = $('scanCanvas');
  const scanCloseBtn = $('scanClose');
  const scanModeLabel = $('scanMode');
  const scanToggleBtn = $('scanToggle');
  const scanWarn = $('scanWarn');
  const cropWrap = $('cropWrap');
  const cropFrame = $('cropFrame');
  const manualData = $('manualData');
  const manualGenBtn = $('manualGen');
  const statNow = $('statNow');
  const statFrom = $('statFrom');
  const statTo = $('statTo');
  const statPeriod = $('statPeriod');
  const statTable = $('statTable');
  const statCsvBtn = $('statCsv');

  let originalImage = null;     // ImageData
  let originalBitmap = null;    // ImageBitmap (для поворота/масштаба)
  let lastDecode = null;        // { text, format, points:[{x,y}] } — данные последнего успешного распознавания
  let scanImages = { regen: null, photo: null, best: null }; // варианты для показа
  let scanMode = 'regen';       // какой вариант сейчас на экране
  let scanVerified = true;      // подтвердила ли программа читаемость (декодировала код)
  let selection = null;         // область кода в пикселях оригинала {x,y,w,h} или null (весь кадр)
  let cropDrag = null;          // состояние во время перетаскивания рамки/угла
  let workingCache = null;      // кэш обрезанного по выделению изображения
  let liveReader = null;        // ZXing-ридер живого сканирования
  let liveActive = false;       // идёт ли сейчас живое сканирование
  let lastCountedText = null;   // текст последнего засчитанного кода (защита от двойного счёта)

  // ---------- UI: дроп-зона ----------
  function bindDrop() {
    drop.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') file.click();
    });
    pickBtn.addEventListener('click', () => file.click());
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });
    file.addEventListener('change', () => {
      if (file.files && file.files[0]) loadFile(file.files[0]);
    });

    // Кнопка «Сфотографировать» открывает камеру телефона (capture="environment").
    cameraBtn.addEventListener('click', () => cameraInput.click());
    cameraInput.addEventListener('change', () => {
      if (cameraInput.files && cameraInput.files[0]) loadFile(cameraInput.files[0]);
    });
  }

  async function loadFile(f) {
    setStatus('Загружаю изображение…');
    const bmp = await createImageBitmap(f);
    // Ограничим максимальную сторону для производительности
    const maxSide = 1600;
    let { width: w, height: h } = bmp;
    if (Math.max(w, h) > maxSide) {
      const k = maxSide / Math.max(w, h);
      w = Math.round(w * k);
      h = Math.round(h * k);
    }
    const off = new OffscreenCanvas(w, h);
    const oc = off.getContext('2d');
    oc.drawImage(bmp, 0, 0, w, h);
    originalImage = oc.getImageData(0, 0, w, h);
    originalBitmap = bmp;

    selection = null;
    cropDrag = null;
    workingCache = null;
    srcCanvas.width = w; srcCanvas.height = h;
    drawSrc();

    workspace.hidden = false;
    resultEl.hidden = true;
    lastDecode = null;
    scanViewBtn.hidden = true;

    setDefaultFrame();                 // рамка по центру — сразу как область обработки
    clearSelBtn.hidden = !selection;
    applyPreprocess();

    // Пробуем распознать сразу по области рамки.
    if (tryDecode()) {
      setStatus('Код распознан. Нажмите «Показать код для сканирования».', 'ok');
    } else {
      setStatus('Готово. Наведите рамку точно на код и/или нажмите «Авто-перебор». Можно сразу показать лучший вариант (без гарантии).');
    }
    refreshScanBtn();
  }

  // ---------- Рамка обреза области кода ----------
  function drawSrc() {
    if (!originalImage) return;
    srcCanvas.getContext('2d').putImageData(originalImage, 0, 0);
  }

  // Рамка по умолчанию: центральный квадрат ~70% меньшей стороны.
  function setDefaultFrame() {
    const dispW = cropWrap.clientWidth, dispH = cropWrap.clientHeight;
    const side = Math.round(Math.min(dispW, dispH) * 0.7);
    cropFrame.hidden = false;
    applyFrameRect({ left: (dispW - side) / 2, top: (dispH - side) / 2, width: side, height: side });
    updateSelectionFromFrame();
  }

  // Рамка на весь кадр (= обработка всего изображения).
  function frameToFull() {
    cropFrame.hidden = false;
    applyFrameRect({ left: 0, top: 0, width: cropWrap.clientWidth, height: cropWrap.clientHeight });
    selection = null;
    workingCache = null;
  }

  function currentFrameRect() {
    return { left: cropFrame.offsetLeft, top: cropFrame.offsetTop, width: cropFrame.offsetWidth, height: cropFrame.offsetHeight };
  }

  // Ставит рамку по прямоугольнику (дисплейные px), удерживая её в пределах кадра.
  function applyFrameRect(r) {
    const dispW = cropWrap.clientWidth, dispH = cropWrap.clientHeight;
    const min = 30;
    let width = Math.max(min, Math.min(r.width, dispW));
    let height = Math.max(min, Math.min(r.height, dispH));
    let left = Math.max(0, Math.min(r.left, dispW - width));
    let top = Math.max(0, Math.min(r.top, dispH - height));
    cropFrame.style.left = left + 'px';
    cropFrame.style.top = top + 'px';
    cropFrame.style.width = width + 'px';
    cropFrame.style.height = height + 'px';
  }

  // Считываем положение рамки в selection (пиксели оригинала).
  function updateSelectionFromFrame() {
    const r = currentFrameRect();
    const kx = srcCanvas.width / cropWrap.clientWidth;
    const ky = srcCanvas.height / cropWrap.clientHeight;
    const full = r.left <= 0 && r.top <= 0 &&
      r.width >= cropWrap.clientWidth - 1 && r.height >= cropWrap.clientHeight - 1;
    selection = full ? null : { x: r.left * kx, y: r.top * ky, w: r.width * kx, h: r.height * ky };
    workingCache = null;
  }

  // Возвращает рамку на место после изменения размеров окна.
  function layoutFrameFromSelection() {
    if (cropFrame.hidden) return;
    if (!selection) {
      applyFrameRect({ left: 0, top: 0, width: cropWrap.clientWidth, height: cropWrap.clientHeight });
      return;
    }
    const kx = srcCanvas.width / cropWrap.clientWidth;
    const ky = srcCanvas.height / cropWrap.clientHeight;
    applyFrameRect({ left: selection.x / kx, top: selection.y / ky, width: selection.w / kx, height: selection.h / ky });
  }

  function bindCrop() {
    let cropRAF = 0;

    const start = (e, mode) => {
      if (!originalImage) return;
      e.preventDefault();
      cropDrag = { mode, px: e.clientX, py: e.clientY, rect: currentFrameRect() };
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    };

    // Углы — ресайз, тело рамки — перемещение.
    cropFrame.querySelectorAll('.crop-handle').forEach((h) => {
      h.addEventListener('pointerdown', (e) => { e.stopPropagation(); start(e, h.dataset.h); });
    });
    cropFrame.addEventListener('pointerdown', (e) => start(e, 'move'));

    window.addEventListener('pointermove', (e) => {
      if (!cropDrag) return;
      e.preventDefault();
      const dx = e.clientX - cropDrag.px, dy = e.clientY - cropDrag.py;
      const o = cropDrag.rect;
      let r;
      if (cropDrag.mode === 'move') {
        r = { left: o.left + dx, top: o.top + dy, width: o.width, height: o.height };
      } else {
        r = { left: o.left, top: o.top, width: o.width, height: o.height };
        if (cropDrag.mode.includes('w')) { r.left = o.left + dx; r.width = o.width - dx; }
        if (cropDrag.mode.includes('e')) { r.width = o.width + dx; }
        if (cropDrag.mode.includes('n')) { r.top = o.top + dy; r.height = o.height - dy; }
        if (cropDrag.mode.includes('s')) { r.height = o.height + dy; }
        if (r.width < 30 && cropDrag.mode.includes('w')) r.left = o.left + o.width - 30;
        if (r.height < 30 && cropDrag.mode.includes('n')) r.top = o.top + o.height - 30;
      }
      applyFrameRect(r);
      updateSelectionFromFrame();
      if (!cropRAF) cropRAF = requestAnimationFrame(() => { cropRAF = 0; applyPreprocess(); });
    });

    window.addEventListener('pointerup', () => {
      if (!cropDrag) return;
      cropDrag = null;
      clearSelBtn.hidden = !selection;
      applyAfterSelectionChange();
    });

    window.addEventListener('resize', layoutFrameFromSelection);
  }

  // Область для обработки: выделение (обрезанное из оригинала) или весь оригинал.
  function getWorkingImage() {
    if (!selection) return originalImage;
    if (workingCache) return workingCache;
    const s = selection;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(s.w));
    c.height = Math.max(1, Math.round(s.h));
    const cx = c.getContext('2d');
    const tmp = document.createElement('canvas');
    tmp.width = originalImage.width; tmp.height = originalImage.height;
    tmp.getContext('2d').putImageData(originalImage, 0, 0);
    cx.drawImage(tmp, s.x, s.y, s.w, s.h, 0, 0, c.width, c.height);
    workingCache = cx.getImageData(0, 0, c.width, c.height);
    return workingCache;
  }

  // После изменения выделения: пересчитываем препроцесс и пробуем распознать.
  function applyAfterSelectionChange() {
    lastDecode = null;
    resultEl.hidden = true;
    applyPreprocess();
    if (tryDecode()) {
      setStatus(selection ? 'Код распознан по выделенной области.' : 'Код распознан.', 'ok');
    } else {
      setStatus(selection
        ? 'По выделению распознать не удалось. Попробуйте «Авто-перебор» или покажите лучший вариант (без гарантии).'
        : 'Выделение снято. По полному кадру распознать не удалось — попробуйте «Авто-перебор» или обведите код заново.', 'warn');
    }
    refreshScanBtn();
  }

  // ---------- Препроцессинг ----------
  function readParams() {
    return {
      brightness: +ctlBrightness.value,
      contrast:   +ctlContrast.value,
      sharpen:    +ctlSharpen.value,
      blur:       +ctlBlur.value,
      threshold:  +ctlThreshold.value,
      binarize:   ctlBinarize.checked,
      adaptive:   ctlAdaptive.checked,
      invert:     ctlInvert.checked,
      rotate:     +ctlRotate.value,
      scale:      +ctlScale.value,
    };
  }

  function refreshLabels() {
    $('brightnessV').textContent = ctlBrightness.value;
    $('contrastV').textContent   = ctlContrast.value;
    $('sharpenV').textContent    = ctlSharpen.value;
    $('blurV').textContent       = ctlBlur.value;
    $('thresholdV').textContent  = ctlAdaptive.checked ? 'авто' : ctlThreshold.value;
    $('rotateV').textContent     = ctlRotate.value;
    $('scaleV').textContent      = (+ctlScale.value).toFixed(1) + '×';
    ctlThreshold.disabled = ctlAdaptive.checked || !ctlBinarize.checked;
  }

  function applyPreprocess() {
    if (!originalImage) return;
    const p = readParams();
    refreshLabels();
    const out = preprocess(getWorkingImage(), p);
    dstCanvas.width = out.width;
    dstCanvas.height = out.height;
    dstCanvas.getContext('2d').putImageData(out, 0, 0);
  }

  // Главный пайплайн препроцессинга
  function preprocess(src, p) {
    // 1. Поворот + масштаб через offscreen canvas (CSS-фильтры для blur/контраста дают быстрее)
    const w0 = src.width, h0 = src.height;
    const rad = (p.rotate * Math.PI) / 180;
    const sin = Math.abs(Math.sin(rad)), cos = Math.abs(Math.cos(rad));
    const rw = Math.round((w0 * cos + h0 * sin) * p.scale);
    const rh = Math.round((w0 * sin + h0 * cos) * p.scale);

    const cnv = new OffscreenCanvas(rw, rh);
    const cx = cnv.getContext('2d');
    cx.fillStyle = '#000';
    cx.fillRect(0, 0, rw, rh);
    cx.save();
    cx.translate(rw / 2, rh / 2);
    cx.rotate(rad);
    cx.scale(p.scale, p.scale);

    // Перенесём исходные пиксели на временный canvas, чтобы применить filter
    const tmp = new OffscreenCanvas(w0, h0);
    tmp.getContext('2d').putImageData(src, 0, 0);

    const filters = [];
    if (p.brightness) filters.push(`brightness(${1 + p.brightness / 100})`);
    if (p.contrast)   filters.push(`contrast(${1 + p.contrast / 100})`);
    if (p.blur > 0)   filters.push(`blur(${p.blur}px)`);
    cx.filter = filters.join(' ') || 'none';
    cx.drawImage(tmp, -w0 / 2, -h0 / 2);
    cx.restore();
    cx.filter = 'none';

    let img = cx.getImageData(0, 0, rw, rh);

    // 2. Резкость (unsharp mask упрощённый: свёртка ядром)
    if (p.sharpen > 0) img = sharpen(img, p.sharpen);

    // 3. Бинаризация
    if (p.binarize) {
      img = p.adaptive ? adaptiveThreshold(img, 25, 10) : globalThreshold(img, p.threshold);
    } else {
      img = grayscale(img);
    }

    // 4. Инверсия
    if (p.invert) img = invert(img);

    return img;
  }

  function grayscale(img) {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const y = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      d[i] = d[i + 1] = d[i + 2] = y;
    }
    return img;
  }

  function invert(img) {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 255 - d[i];
      d[i + 1] = 255 - d[i + 1];
      d[i + 2] = 255 - d[i + 2];
    }
    return img;
  }

  function globalThreshold(img, t) {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const y = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
      const v = y >= t ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    return img;
  }

  // Адаптивный порог через локальное среднее (быстрый бокс-фильтр через integral image)
  function adaptiveThreshold(img, window, C) {
    const w = img.width, h = img.height, d = img.data;
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      gray[j] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
    }
    // Integral image
    const integ = new Float64Array((w + 1) * (h + 1));
    for (let y = 1; y <= h; y++) {
      let rowSum = 0;
      for (let x = 1; x <= w; x++) {
        rowSum += gray[(y - 1) * w + (x - 1)];
        integ[y * (w + 1) + x] = integ[(y - 1) * (w + 1) + x] + rowSum;
      }
    }
    const r = Math.max(1, window | 0);
    for (let y = 0; y < h; y++) {
      const y1 = Math.max(0, y - r), y2 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x1 = Math.max(0, x - r), x2 = Math.min(w - 1, x + r);
        const area = (x2 - x1 + 1) * (y2 - y1 + 1);
        const sum =
          integ[(y2 + 1) * (w + 1) + (x2 + 1)] -
          integ[(y1) * (w + 1) + (x2 + 1)] -
          integ[(y2 + 1) * (w + 1) + (x1)] +
          integ[(y1) * (w + 1) + (x1)];
        const mean = sum / area;
        const idx = (y * w + x) * 4;
        const v = gray[y * w + x] < (mean - C) ? 0 : 255;
        d[idx] = d[idx + 1] = d[idx + 2] = v;
      }
    }
    return img;
  }

  function sharpen(img, amount) {
    const w = img.width, h = img.height, src = img.data;
    const out = new Uint8ClampedArray(src.length);
    const k = amount;
    // 3x3 unsharp-mask-like: центр (1 + 4k), соседи -k
    const cw = 1 + 4 * k;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const v =
            src[idx + c] * cw
            - src[idx - 4 + c] * k
            - src[idx + 4 + c] * k
            - src[idx - w * 4 + c] * k
            - src[idx + w * 4 + c] * k;
          out[idx + c] = Math.max(0, Math.min(255, v));
        }
        out[idx + 3] = src[idx + 3];
      }
    }
    return new ImageData(out, w, h);
  }

  // ---------- Декодирование ----------
  let reader = null;
  function getReader() {
    if (reader) return reader;
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      ZXing.BarcodeFormat.DATA_MATRIX,
      ZXing.BarcodeFormat.QR_CODE,
    ]);
    reader = new ZXing.MultiFormatReader();
    reader.setHints(hints);
    return reader;
  }

  function decodeCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const luminance = new ZXing.RGBLuminanceSource(
      toLuminance(img.data),
      img.width,
      img.height
    );
    const bin = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance));
    return getReader().decode(bin);
  }

  function toLuminance(rgba) {
    // ZXing ожидает массив 32-битных значений (luminance в нижнем байте) для RGBLuminanceSource.
    const out = new Int32Array(rgba.length / 4);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
      const y = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) | 0;
      out[j] = (0xff << 24) | (y << 16) | (y << 8) | y;
    }
    return out;
  }

  function tryDecode() {
    try {
      const r = decodeCanvas(dstCanvas);
      // Запоминаем углы кода — по ним потом вырежем символ для показа на экране.
      let points = [];
      try {
        const rp = r.getResultPoints() || [];
        points = rp
          .filter(p => p)
          .map(p => ({ x: p.getX(), y: p.getY() }));
      } catch (_) { points = []; }
      lastDecode = { text: r.getText(), format: r.getBarcodeFormat(), points };
      onDecoded(r.getText(), r.getBarcodeFormat());
      return true;
    } catch (e) {
      return false;
    }
  }

  // Применяем комбинацию фильтров к контролам и пересчитываем препроцесс.
  function applyCombo(c) {
    ctlBinarize.checked = !!c.binarize;
    ctlAdaptive.checked = !!c.adaptive;
    ctlInvert.checked   = !!c.invert;
    ctlContrast.value = c.contrast ?? 0;
    ctlSharpen.value  = c.sharpen ?? 0;
    ctlScale.value    = c.scale ?? 1.5;
    applyPreprocess();
  }

  // Грубая оценка «похоже на чистый код»: доля чёрного близка к 50% и много переходов.
  // Нужна, чтобы после неудачного перебора выбрать самый подходящий вариант.
  function scoreCandidate() {
    const w = dstCanvas.width, h = dstCanvas.height;
    if (!w || !h) return -1;
    const d = dstCanvas.getContext('2d').getImageData(0, 0, w, h).data;
    const step = 2;
    let black = 0, transitions = 0, count = 0;
    for (let y = 0; y < h; y += step) {
      let prev = -1;
      const row = y * w;
      for (let x = 0; x < w; x += step) {
        const v = d[(row + x) * 4] < 128 ? 0 : 1;
        if (v === 0) black++;
        if (prev !== -1 && v !== prev) transitions++;
        prev = v;
        count++;
      }
    }
    if (!count) return -1;
    const balance = 1 - Math.abs(black / count - 0.5) * 2; // 1 при 50% чёрного
    const density = transitions / count;                    // высокая у кодов
    return balance * density;
  }

  // Перебор сочетаний препроцессов
  async function autoTry() {
    setStatus('Перебираю комбинации фильтров…');
    autoBtn.disabled = true; decodeBtn.disabled = true;

    const combos = [];
    // Базовые варианты
    for (const adaptive of [true, false]) {
      for (const invert of [false, true]) {
        for (const contrast of [0, 40, 80, 120]) {
          for (const sharpen of [0, 1, 2]) {
            for (const scale of [1.0, 1.5, 2.0]) {
              combos.push({ adaptive, invert, contrast, sharpen, scale, binarize: true });
            }
          }
        }
      }
    }
    // Несколько без бинаризации (ZXing иногда лучше работает по серому)
    for (const contrast of [0, 60, 120]) {
      for (const sharpen of [0, 1.5]) {
        combos.push({ binarize: false, adaptive: false, invert: false, contrast, sharpen, scale: 1.5 });
      }
    }

    let best = { score: -1, apply: null };

    for (let i = 0; i < combos.length; i++) {
      const c = combos[i];
      applyCombo(c);
      // Пара поворотов на каждый набор
      for (const rot of [0, 90, 180, 270]) {
        ctlRotate.value = rot;
        applyPreprocess();
        if (tryDecode()) {
          autoBtn.disabled = false; decodeBtn.disabled = false;
          return;
        }
        // Не декодировалось — запоминаем самый «код-подобный» вариант.
        const sc = scoreCandidate();
        if (sc > best.score) {
          best = { score: sc, apply: () => { applyCombo(c); ctlRotate.value = rot; applyPreprocess(); } };
        }
        await new Promise(r => setTimeout(r, 0)); // не блокируем UI
      }
      if (i % 5 === 0) setStatus(`Перебираю комбинации фильтров… ${i + 1}/${combos.length}`);
    }

    // Ничего не декодировалось — восстанавливаем самый подходящий вариант,
    // чтобы «Показать лучший вариант» вывел именно его, а не последнюю случайную комбинацию.
    if (best.apply) best.apply();

    autoBtn.disabled = false; decodeBtn.disabled = false;
    setStatus('Декодировать не удалось. Выбран самый подходящий вариант — нажмите «📱 Показать лучший вариант (без гарантии)», чтобы вывести его на экран. Либо переснимите фото крупнее и без бликов.', 'warn');
    refreshScanBtn();
  }

  function onDecoded(text, format) {
    resultEl.hidden = false;
    refreshScanBtn();
    rawEl.textContent = text;
    parsedTbody.innerHTML = '';
    setStatus(`Распознано (${format}).`, 'ok');
    const parsed = parseGS1(text);
    for (const row of parsed) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      const td2 = document.createElement('td');
      td1.textContent = row.label;
      td2.textContent = row.value;
      tr.appendChild(td1); tr.appendChild(td2);
      parsedTbody.appendChild(tr);
    }
  }

  // ---------- GS1 / «Честный знак» парсер ----------
  // Формат на пиве (тип «Альбатрос», КИЗ ЦРПТ):
  //   01<GTIN:14>21<серийный>[GS]93<crypto:4>
  // или с расширенным крипто-кодом:
  //   01<GTIN:14>21<серийный>[GS]91<4>[GS]92<44>
  function parseGS1(text) {
    const rows = [];
    const GS = String.fromCharCode(29); // FNC1 separator
    // Уберём ведущий FNC1 если есть
    let s = text.replace(/^?/, '');

    const fields = {
      '01': { name: 'GTIN', len: 14, fixed: true },
      '21': { name: 'Серийный номер', len: 20, fixed: false }, // переменная, до GS
      '91': { name: 'Крипто-ключ (91)', len: 4, fixed: true },
      '92': { name: 'Крипто-код (92)', len: 44, fixed: true },
      '93': { name: 'Крипто-хвост (93)', len: 4, fixed: true },
      '8005': { name: 'Цена', len: 6, fixed: true },
      '17': { name: 'Срок годности', len: 6, fixed: true },
      '10': { name: 'Партия', len: 20, fixed: false },
    };

    let i = 0;
    while (i < s.length) {
      // AI может быть 2 или 4 знаков
      let ai = s.substr(i, 2);
      let f = fields[ai];
      if (!f) {
        ai = s.substr(i, 4);
        f = fields[ai];
      }
      if (!f) {
        rows.push({ label: 'Хвост (не распознан)', value: s.substr(i) });
        break;
      }
      i += ai.length;
      let value;
      if (f.fixed) {
        value = s.substr(i, f.len);
        i += f.len;
      } else {
        const gsIdx = s.indexOf(GS, i);
        if (gsIdx === -1) { value = s.substr(i); i = s.length; }
        else { value = s.substring(i, gsIdx); i = gsIdx + 1; }
      }
      rows.push({ label: `${f.name} (AI ${ai})`, value });
    }

    return rows;
  }

  // ---------- Живое сканирование камерой ----------
  // Непрерывно читаем кадры с камеры: много попыток под разными углами/светом
  // повышают шанс поймать плохо читаемый код (аналог многокадрового ТСД).
  async function startLiveScan() {
    if (typeof ZXing === 'undefined') { setStatus('ZXing не загрузился — живое сканирование недоступно.', 'err'); return; }
    if (liveActive) return;
    liveActive = true;
    camOverlay.hidden = false;

    const hints = new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      ZXing.BarcodeFormat.DATA_MATRIX,
      ZXing.BarcodeFormat.QR_CODE,
    ]);
    liveReader = new ZXing.BrowserMultiFormatReader(hints);
    try {
      await liveReader.decodeFromConstraints(
        { video: { facingMode: { ideal: 'environment' } } },
        camVideo,
        (result) => { if (result && liveActive) onLiveDecode(result); }
      );
    } catch (e) {
      setStatus('Не удалось открыть камеру: ' + (e && e.message ? e.message : e), 'err');
      stopLiveScan();
    }
  }

  function stopLiveScan() {
    liveActive = false;
    try { if (liveReader) liveReader.reset(); } catch (_) {}
    liveReader = null;
    camOverlay.hidden = true;
  }

  function onLiveDecode(r) {
    liveActive = false;                 // ловим только первый успешный кадр
    lastDecode = { text: r.getText(), format: r.getBarcodeFormat(), points: [] };
    stopLiveScan();
    setStatus('Код распознан камерой.', 'ok');
    showScanView();                     // сразу показываем чистый восстановленный код
  }

  // ---------- Показ кода для сканирования с экрана ----------
  // Кнопка показа видна всегда после загрузки фото; подпись зависит от того,
  // распознан код (подтверждённый вариант) или нет (лучший вариант без гарантии).
  function refreshScanBtn() {
    scanViewBtn.hidden = !originalImage;
    scanViewBtn.textContent = lastDecode
      ? '📱 Показать код для сканирования'
      : '📱 Показать лучший вариант (без гарантии)';
  }

  function showScanView() {
    if (!originalImage && !lastDecode) {
      setStatus('Сначала загрузите фото или введите данные кода.', 'warn');
      return;
    }
    // Подтверждённые варианты — только если код реально декодирован.
    scanImages.regen = regenerateFromData();
    scanImages.photo = buildScanImage();
    scanImages.best = null;
    scanVerified = !!(scanImages.regen || scanImages.photo);

    if (scanVerified) {
      // По умолчанию показываем восстановленный код — он всегда чёткий и читается надёжнее.
      scanMode = scanImages.regen ? 'regen' : 'photo';
      countScan(); // засчитываем успешно восстановленный код в статистику
    } else {
      // Код не распознан: готовим максимально очищенный вариант и предупредим.
      scanImages.best = buildBestEffortImage();
      if (!scanImages.best) {
        setStatus('Не удалось подготовить изображение для показа.', 'err');
        return;
      }
      scanMode = 'best';
    }
    renderScan();
    scanOverlay.hidden = false;
  }

  // Рисуем выбранный вариант на экране и обновляем подпись/предупреждение/переключатель.
  function renderScan() {
    const img = scanImages[scanMode];
    scanCanvas.width = img.width;
    scanCanvas.height = img.height;
    scanCanvas.getContext('2d').putImageData(img, 0, 0);

    scanWarn.hidden = scanVerified;

    if (!scanVerified) {
      scanModeLabel.textContent = 'Лучший из возможных вариантов (программой не распознан)';
      scanToggleBtn.hidden = true;
      return;
    }

    const bothAvailable = scanImages.regen && scanImages.photo;
    scanModeLabel.textContent = scanMode === 'regen'
      ? 'Восстановленный код (перекодирован из считанных данных)'
      : 'Очищенное фото исходного кода';
    scanToggleBtn.hidden = !bothAvailable;
    scanToggleBtn.textContent = scanMode === 'regen'
      ? 'Показать очищенное фото'
      : 'Показать восстановленный';
  }

  // Лучший вариант без распознавания: код не найден по координатам, поэтому
  // берём весь очищенный кадр, приводим к чистому ч/б и добавляем белое поле.
  function buildBestEffortImage() {
    if (!originalImage || !dstCanvas.width) return null;
    const whole = { x: 0, y: 0, w: dstCanvas.width, h: dstCanvas.height };
    const crop = cropCanvas(dstCanvas, whole);
    const bw = otsuBinary(crop);
    const pad = Math.max(16, Math.round(Math.max(bw.width, bw.height) * 0.08));
    return addQuietZone(bw, pad);
  }

  function toggleScanMode() {
    scanMode = scanMode === 'regen' ? 'photo' : 'regen';
    renderScan();
  }

  function hideScanView() {
    scanOverlay.hidden = true;
  }

  // Восстановление: перекодируем ПРОЧИТАННЫЕ данные обратно в тот же формат кода.
  // Это не новый код — это идеально чистая копия того, что реально считано с упаковки.
  function regenerateFromData() {
    if (!lastDecode || !lastDecode.text) return null;
    // 1) Правильный GS1 DataMatrix через bwip-js (как tec-it) — предпочтительно.
    const gs1 = bwipGS1DataMatrix(lastDecode.text, lastDecode.format);
    if (gs1) return gs1;
    // 2) Запасной путь: ZXing (кодирует FNC1 обычным байтом, без GS1-флага).
    try {
      let matrix;
      if (lastDecode.format === ZXing.BarcodeFormat.QR_CODE) {
        matrix = new ZXing.QRCodeWriter().encode(lastDecode.text, ZXing.BarcodeFormat.QR_CODE, 0, 0);
      } else {
        matrix = new ZXing.DataMatrixWriter().encode(lastDecode.text, ZXing.BarcodeFormat.DATA_MATRIX, 0, 0);
      }
      return bitMatrixToImageData(matrix, 8, 4); // модуль 8px, поле 4 модуля
    } catch (e) {
      return null; // если формат не кодируется — молча остаёмся на очищенном фото
    }
  }

  // Правильный GS1 DataMatrix через bwip-js: ведущий FNC1 (GS1-режим) и каждый
  // разделитель GS (\x1d) кодируется как FNC1 — так же, как это делает tec-it.
  function bwipGS1DataMatrix(text, format) {
    if (typeof bwipjs === 'undefined') return null;              // библиотека не загрузилась (нет интернета)
    if (format === ZXing.BarcodeFormat.QR_CODE) return null;     // QR оставляем ZXing-пути
    try {
      const GS = String.fromCharCode(29);
      const body = text.replace(new RegExp('^' + GS), '');       // убрать ведущий GS, если есть
      // GS1-режим только для маркировки (начинается с AI «01» — GTIN). Иначе — откат на ZXing.
      if (!/^01\d/.test(body)) return null;
      const parsed = '^FNC1' + body.split(GS).join('^FNC1');     // ведущий + внутренние FNC1
      const canvas = document.createElement('canvas');
      bwipjs.toCanvas(canvas, {
        bcid: 'datamatrix',
        text: parsed,
        parsefnc: true,
        scale: 6,
        padding: 10,               // тихая зона вокруг
        backgroundcolor: 'FFFFFF',
      });
      return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    } catch (e) {
      return null;                 // при любой ошибке — откат на ZXing
    }
  }

  // Ручной ввод: чистый код прямо из введённых/отсканированных данных (сценарий с видео).
  function generateFromManualData() {
    let text = (manualData.value || '').trim();
    if (!text) { setStatus('Введите или отсканируйте данные кода.', 'warn'); return; }
    // Разделитель можно писать как (GS) — заменим на настоящий символ FNC1/GS.
    text = text.replace(/\(GS\)/gi, String.fromCharCode(29));
    lastDecode = { text, format: ZXing.BarcodeFormat.DATA_MATRIX, points: [] };
    setStatus('Код сгенерирован из введённых данных.', 'ok');
    showScanView();
  }


  // Рисуем BitMatrix (сетку модулей) в чёткое чёрно-белое изображение с белым полем.
  function bitMatrixToImageData(matrix, mod, quietModules) {
    const mw = matrix.getWidth(), mh = matrix.getHeight();
    const pad = quietModules * mod;
    const w = mw * mod + pad * 2, h = mh * mod + pad * 2;
    const cnv = document.createElement('canvas');
    cnv.width = w; cnv.height = h;
    const cx = cnv.getContext('2d');
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
    cx.fillStyle = '#000';
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        if (matrix.get(x, y)) cx.fillRect(pad + x * mod, pad + y * mod, mod, mod);
      }
    }
    return cx.getImageData(0, 0, w, h);
  }

  // Готовим чистое изображение кода: вырезаем символ по углам, бинаризуем, добавляем белое поле.
  function buildScanImage() {
    if (!lastDecode || !originalImage || !dstCanvas.width) return null; // нет фото — нет фото-варианта
    const box = pointsToBox(lastDecode.points, dstCanvas.width, dstCanvas.height);
    const crop = cropCanvas(dstCanvas, box);
    const bw = otsuBinary(crop);
    const pad = Math.max(16, Math.round(Math.max(bw.width, bw.height) * 0.18));
    return addQuietZone(bw, pad);
  }

  // Прямоугольник вокруг кода по его углам (+ запас). Если углов нет — берём весь холст.
  function pointsToBox(points, w, h) {
    if (!points || points.length < 2) return { x: 0, y: 0, w, h };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (!isFinite(p.x) || !isFinite(p.y)) continue;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    if (!isFinite(minX)) return { x: 0, y: 0, w, h };
    const m = Math.max(maxX - minX, maxY - minY) * 0.15; // запас, чтобы не срезать край символа
    const x = Math.max(0, Math.floor(minX - m));
    const y = Math.max(0, Math.floor(minY - m));
    const x2 = Math.min(w, Math.ceil(maxX + m));
    const y2 = Math.min(h, Math.ceil(maxY + m));
    return { x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
  }

  function cropCanvas(canvas, box) {
    const c = document.createElement('canvas');
    c.width = box.w; c.height = box.h;
    const cx = c.getContext('2d');
    cx.drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    return cx.getImageData(0, 0, box.w, box.h);
  }

  // Порог Оцу: сам находит границу тёмное/светлое и даёт чистый чёрно-белый.
  function otsuBinary(img) {
    const w = img.width, h = img.height, d = img.data;
    const hist = new Array(256).fill(0);
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const y = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      gray[j] = y; hist[y]++;
    }
    const total = w * h;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, maxVar = -1, thr = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVar) { maxVar = between; thr = t; }
    }
    const out = new Uint8ClampedArray(d.length);
    for (let j = 0, i = 0; j < gray.length; j++, i += 4) {
      // Строго «>»: для уже бинарного входа порог Оцу вырождается в 0, и «>=»
      // покрасил бы всё в белое. «>» корректно делит и бинарный, и серый вход.
      const v = gray[j] > thr ? 255 : 0;
      out[i] = out[i + 1] = out[i + 2] = v; out[i + 3] = 255;
    }
    return new ImageData(out, w, h);
  }

  // Белая рамка (quiet zone) вокруг кода — без неё сканеры код не берут.
  function addQuietZone(img, pad) {
    const w = img.width + pad * 2, h = img.height + pad * 2;
    const out = new Uint8ClampedArray(w * h * 4).fill(255); // заливаем белым
    const src = img.data;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const si = (y * img.width + x) * 4;
        const di = ((y + pad) * w + (x + pad)) * 4;
        out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2];
      }
    }
    return new ImageData(out, w, h);
  }

  // ---------- Утилиты ----------
  function setStatus(msg, kind) {
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
    statusEl.textContent = msg;
  }

  function bindControls() {
    [ctlBrightness, ctlContrast, ctlSharpen, ctlBlur, ctlThreshold,
     ctlBinarize, ctlAdaptive, ctlInvert, ctlRotate, ctlScale]
      .forEach(el => el.addEventListener('input', applyPreprocess));

    decodeBtn.addEventListener('click', () => {
      setStatus('Декодирую…');
      if (!tryDecode()) {
        setStatus('С текущими настройками не получилось. Попробуйте «Авто-перебор» или подправьте фильтры.', 'warn');
      }
    });
    autoBtn.addEventListener('click', autoTry);
    scanViewBtn.addEventListener('click', showScanView);
    scanCloseBtn.addEventListener('click', hideScanView);
    scanToggleBtn.addEventListener('click', toggleScanMode);
    manualGenBtn.addEventListener('click', generateFromManualData);
    liveScanBtn.addEventListener('click', startLiveScan);
    camStopBtn.addEventListener('click', stopLiveScan);
    clearSelBtn.addEventListener('click', () => {
      frameToFull();
      clearSelBtn.hidden = true;
      applyAfterSelectionChange();
    });
    resetBtn.addEventListener('click', () => {
      ctlBrightness.value = 0;
      ctlContrast.value = 0;
      ctlSharpen.value = 0;
      ctlBlur.value = 0;
      ctlThreshold.value = 128;
      ctlBinarize.checked = false;
      ctlAdaptive.checked = true;
      ctlInvert.checked = false;
      ctlRotate.value = 0;
      ctlScale.value = 1.5;
      applyPreprocess();
      setStatus('Настройки сброшены.');
    });
    newFileBtn.addEventListener('click', () => {
      workspace.hidden = true;
      resultEl.hidden = true;
      scanViewBtn.hidden = true;
      scanOverlay.hidden = true;
      clearSelBtn.hidden = true;
      cropFrame.hidden = true;
      lastDecode = null;
      originalImage = null;
      selection = null;
      cropDrag = null;
      workingCache = null;
      file.value = '';
      cameraInput.value = '';
      setStatus('');
    });
  }

  // ---------- Статистика сканирований (для коммерческого учёта) ----------
  const SCAN_STORE_KEY = 'dmRestoreScanCounts';
  const MONTH_NAMES = ['Январь','Февраль','Март','Апрель','Май','Июнь',
    'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

  function loadScanCounts() {
    try { return JSON.parse(localStorage.getItem(SCAN_STORE_KEY)) || {}; }
    catch (_) { return {}; }
  }
  function saveScanCounts(obj) {
    try { localStorage.setItem(SCAN_STORE_KEY, JSON.stringify(obj)); } catch (_) {}
  }
  function currentMonthKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function formatMonth(key) {
    const [y, m] = key.split('-');
    return (MONTH_NAMES[+m - 1] || m) + ' ' + y;
  }

  // Каждый акт восстановления = 1 скан. Дедуп по последнему коду защищает от
  // задвоения при повторном показе/переключениях того же кода подряд.
  function countScan() {
    if (!lastDecode || !lastDecode.text || lastDecode.text === lastCountedText) return;
    lastCountedText = lastDecode.text;
    const counts = loadScanCounts();
    const k = currentMonthKey();
    counts[k] = (counts[k] || 0) + 1;
    saveScanCounts(counts);
    renderStats();
  }

  function renderStats() {
    const counts = loadScanCounts();
    const nowKey = currentMonthKey();
    statNow.textContent = counts[nowKey] || 0;

    const keys = Object.keys(counts).sort();          // по возрастанию для дефолтов периода
    // Дефолтные границы периода: от самого раннего месяца до текущего.
    if (!statFrom.value) statFrom.value = keys.length ? keys[0] : nowKey;
    if (!statTo.value) statTo.value = nowKey;

    // Таблица по убыванию (свежие сверху)
    statTable.innerHTML = '';
    for (const k of keys.slice().reverse()) {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      const td2 = document.createElement('td');
      td1.textContent = formatMonth(k);
      td2.textContent = counts[k];
      tr.appendChild(td1); tr.appendChild(td2);
      statTable.appendChild(tr);
    }
    if (!keys.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 2; td.textContent = 'Пока нет данных';
      td.style.color = 'var(--muted)';
      tr.appendChild(td); statTable.appendChild(tr);
    }
    renderPeriodTotal();
  }

  function renderPeriodTotal() {
    const counts = loadScanCounts();
    const from = statFrom.value, to = statTo.value;   // строки 'YYYY-MM' сравниваются лексикографически
    let total = 0;
    for (const k of Object.keys(counts)) {
      if ((!from || k >= from) && (!to || k <= to)) total += counts[k];
    }
    statPeriod.textContent = total;
  }

  function exportStatsCsv() {
    const counts = loadScanCounts();
    const from = statFrom.value, to = statTo.value;
    const rows = [['Месяц', 'Сканирований']];
    Object.keys(counts).sort().forEach(k => {
      if ((!from || k >= from) && (!to || k <= to)) rows.push([k, counts[k]]);
    });
    const csv = rows.map(r => r.join(';')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `сканирования_${from || 'все'}_${to || 'все'}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Инициализация
  function init() {
    if (typeof ZXing === 'undefined') {
      setStatus('Не удалось загрузить @zxing/library (нет интернета?). Декодирование недоступно.', 'err');
    }
    bindDrop();
    bindControls();
    bindCrop();
    statFrom.addEventListener('change', renderPeriodTotal);
    statTo.addEventListener('change', renderPeriodTotal);
    statCsvBtn.addEventListener('click', exportStatsCsv);
    renderStats();
    refreshLabels();
  }

  init();
})();
