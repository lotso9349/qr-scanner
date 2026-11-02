(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const video = $('#video');
  const statusEl = $('#status');
  const resultBox = $('#result');
  const textEl = $('#text');
  const metaEl = $('#meta');
  const copyBtn = $('#copy');
  const openLink = $('#open');
  const againBtn = $('#again');
  const fileInput = $('#file');
  const restartBtn = $('#restart');
  const histBox = $('#historyBox');
  const histList = $('#history');
  const clearBtn = $('#clear');
  const toastEl = $('#toast');
  const netEl = $('#net');
  const otpBox = $('#otpBox');
  const otpList = $('#otpList');
  const otpMeta = $('#otpMeta');
  const otpCopyAll = $('#otpCopyAll');
  const otpShare = $('#otpShare');
  const otpNext = $('#otpNext');
  const otpClear = $('#otpClear');

  // 解碼器：優先用同資料夾的 jsQR.js，找不到才用 CDN（sw.js 會幫你快取起來）
  const CDN = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
  const HKEY = 'qr_history_v1';

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let stream = null;
  let scanning = false;
  let rafId = 0;
  let lastTs = 0;
  let holding = false;   // 正在顯示結果（暫停掃描）
  let otpAccounts = [];  // OTP 帳號只放在記憶體，不寫入歷史紀錄或任何儲存空間
  let otpBatch = null;   // 追蹤 Google 匯出碼分成幾張、掃了幾張

  // ---------- 小工具 ----------
  function setStatus(msg, isErr) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('err', !!isErr);
  }

  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
  }

  function fmt(ts) {
    try {
      return new Date(ts).toLocaleString('zh-TW', { hour12: false });
    } catch (e) {
      return '';
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('load failed: ' + src));
      document.head.appendChild(s);
    });
  }

  async function ensureDecoder() {
    if (typeof jsQR === 'function') return true;
    try { await loadScript('jsQR.js'); } catch (e) { /* 沒有本機檔，改用 CDN */ }
    if (typeof jsQR === 'function') return true;
    try { await loadScript(CDN); } catch (e) { /* 離線且尚未快取 */ }
    return typeof jsQR === 'function';
  }

  // ---------- 歷史紀錄 ----------
  function loadHist() {
    try { return JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch (e) { return []; }
  }
  function saveHist(list) {
    try { localStorage.setItem(HKEY, JSON.stringify(list.slice(0, 30))); } catch (e) { /* 忽略 */ }
  }
  function addHist(text) {
    const list = loadHist().filter((x) => x.t !== text);
    list.unshift({ t: text, ts: Date.now() });
    saveHist(list);
    renderHist();
  }
  function renderHist() {
    const list = loadHist();
    histBox.classList.toggle('hidden', list.length === 0);
    histList.textContent = '';
    list.forEach((item) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'hist';
      const t = document.createElement('span');
      t.className = 'ht';
      t.textContent = item.t;
      const d = document.createElement('span');
      d.className = 'hd';
      d.textContent = fmt(item.ts);
      b.append(t, d);
      b.addEventListener('click', () => showResult(item.t, false, item.ts));
      li.append(b);
      histList.append(li);
    });
  }

  // ---------- 相機 ----------
  async function startCamera() {
    stopCamera();
    holding = false;
    resultBox.classList.add('hidden');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('此瀏覽器不支援相機，請用「從相簿選圖」', true);
      return;
    }
    if (typeof jsQR !== 'function') {
      setStatus('解碼程式載入中…');
      if (!(await ensureDecoder())) {
        setStatus('找不到解碼程式，請先連網開啟一次', true);
        return;
      }
    }
    setStatus('啟動相機中…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      scanning = true;
      setStatus('將 QR code 對準框內');
      rafId = requestAnimationFrame(tick);
    } catch (err) {
      stopCamera();
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setStatus('相機權限被拒絕：請到 設定 > Safari > 相機 允許，或刪除後重新加入主畫面', true);
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setStatus('找不到可用的相機', true);
      } else {
        setStatus('無法啟動相機：' + (name || '未知錯誤'), true);
      }
    }
  }

  function stopCamera() {
    scanning = false;
    cancelAnimationFrame(rafId);
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.srcObject = null;
  }

  function resumeScan() {
    holding = false;
    resultBox.classList.add('hidden');
    if (stream && stream.active) {
      video.play().catch(() => {});
      scanning = true;
      setStatus('將 QR code 對準框內');
      rafId = requestAnimationFrame(tick);
    } else {
      startCamera();
    }
  }

  function pauseScan() {
    scanning = false;
    cancelAnimationFrame(rafId);
    try { video.pause(); } catch (e) { /* 忽略 */ }
  }

  function tick(ts) {
    if (!scanning) return;
    rafId = requestAnimationFrame(tick);
    if (ts - lastTs < 100) return; // 約每秒 10 次，省電
    lastTs = ts;
    if (video.readyState !== video.HAVE_ENOUGH_DATA) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(1, 800 / Math.max(vw, vh));
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
    if (code) {
      const text = extractText(code);
      if (text) onScanned(text);
    }
  }

  // ---------- 解碼結果 ----------
  function extractText(code) {
    let text = code.data || '';
    // jsQR 遇到非 UTF-8 的內容時 data 可能是空的，改用原始位元組嘗試其他編碼
    if ((!text || text.indexOf('�') !== -1) && code.binaryData && code.binaryData.length && window.TextDecoder) {
      const bytes = new Uint8Array(code.binaryData);
      const encodings = ['utf-8', 'big5', 'gbk', 'shift_jis'];
      for (const enc of encodings) {
        try {
          const t = new TextDecoder(enc, { fatal: true }).decode(bytes);
          if (t) { text = t; break; }
        } catch (e) { /* 換下一種編碼 */ }
      }
    }
    return text;
  }

  function onScanned(text) {
    if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) { /* 忽略 */ } }
    if (/^otpauth(-migration)?:\/\//i.test(text.trim())) {
      handleOtp(text.trim()); // OTP 內容含金鑰，不寫入歷史紀錄
      return;
    }
    showResult(text, true, Date.now());
  }

  function showResult(text, save, ts) {
    pauseScan();
    holding = true;
    textEl.value = text;
    metaEl.textContent = fmt(ts || Date.now()) + '・' + text.length + ' 字';
    if (/^https?:\/\/\S+$/i.test(text.trim())) {
      openLink.href = text.trim();
      openLink.classList.remove('hidden');
    } else {
      openLink.classList.add('hidden');
      openLink.removeAttribute('href');
    }
    resultBox.classList.remove('hidden');
    setStatus('掃描成功');
    if (save) addHist(text);
    resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) { /* 改用舊方法 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  // ---------- 從相簿選圖 ----------
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
      img.src = url;
    });
  }

  function decodeImage(img, maxSide) {
    const c = document.createElement('canvas');
    const cx = c.getContext('2d', { willReadFrequently: true });
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const scale = Math.min(1, maxSide / Math.max(iw, ih));
    c.width = Math.round(iw * scale);
    c.height = Math.round(ih * scale);
    cx.drawImage(img, 0, 0, c.width, c.height);
    const data = cx.getImageData(0, 0, c.width, c.height);
    return jsQR(data.data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
  }

  async function onFile() {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    if (!(await ensureDecoder())) {
      setStatus('找不到解碼程式，請先連網開啟一次', true);
      return;
    }
    setStatus('解析圖片中…');
    try {
      const img = await loadImage(f);
      let code = null;
      for (const side of [1600, 900, 500]) {
        code = decodeImage(img, side);
        if (code) break;
      }
      const text = code && extractText(code);
      if (text) {
        onScanned(text);
      } else {
        setStatus('這張圖片裡找不到 QR code', true);
      }
    } catch (e) {
      setStatus('無法讀取這張圖片', true);
    }
  }

  // ---------- 離線狀態 ----------
  function setBadge(text, cls) {
    netEl.textContent = text;
    netEl.className = 'pill' + (cls ? ' ' + cls : '');
  }

  async function isCached() {
    if (!('caches' in window)) return false;
    const app = await caches.match('app.js');
    const dec = (await caches.match('jsQR.js')) || (await caches.match(CDN));
    return !!(app && dec);
  }

  async function watchOfflineReady() {
    if (!('serviceWorker' in navigator)) {
      setBadge('無法離線（需 HTTPS）', 'warn');
      return;
    }
    for (let i = 0; i < 15; i++) {
      try {
        if (await isCached()) {
          setBadge('✓ 已可離線使用', 'ok');
          return;
        }
      } catch (e) { /* 重試 */ }
      setBadge(navigator.onLine ? '正在準備離線…' : '尚未完成離線快取', 'warn');
      await new Promise((r) => setTimeout(r, 1000));
    }
    setBadge('尚未完成離線快取', 'warn');
  }

  // ---------- 事件 ----------
  copyBtn.addEventListener('click', async () => {
    toast((await copyText(textEl.value)) ? '已複製' : '複製失敗，請長按文字手動複製');
  });
  againBtn.addEventListener('click', resumeScan);
  restartBtn.addEventListener('click', startCamera);
  fileInput.addEventListener('change', onFile);
  clearBtn.addEventListener('click', () => {
    saveHist([]);
    renderHist();
    toast('已清除');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopCamera();
      renderOtp(); // 離開畫面時，把已顯示的金鑰重新遮蔽
    } else if (!holding) {
      startCamera();
    }
  });

  // ---------- OTP ----------
  const MASK = '•••• •••• •••• ••••';

  function groupSecret(s) {
    return s.replace(/(.{4})/g, '$1 ').trim();
  }

  function renderOtp() {
    otpBox.classList.toggle('hidden', otpAccounts.length === 0);
    otpList.textContent = '';
    otpAccounts.forEach((a) => {
      const item = document.createElement('div');
      item.className = 'otp-item';

      const title = document.createElement('div');
      title.className = 'otp-title';
      title.textContent = a.issuer || a.account || '(未命名)';

      const sub = document.createElement('div');
      sub.className = 'otp-sub';
      const spec = a.type.toUpperCase() + '・' + a.algorithm + '・' + a.digits + ' 位' +
        (a.type === 'totp' ? '・' + a.period + ' 秒' : '・計數 ' + a.counter);
      sub.textContent = (a.issuer && a.account ? '帳號：' + a.account + '　' : '') + spec;

      const secret = document.createElement('div');
      secret.className = 'otp-secret';
      secret.textContent = MASK;

      const row = document.createElement('div');
      row.className = 'row';

      let shown = false;
      const showBtn = document.createElement('button');
      showBtn.textContent = '顯示金鑰';
      showBtn.addEventListener('click', () => {
        shown = !shown;
        secret.textContent = shown ? groupSecret(a.secret) : MASK;
        showBtn.textContent = shown ? '隱藏金鑰' : '顯示金鑰';
      });

      const cpSecret = document.createElement('button');
      cpSecret.textContent = '複製金鑰';
      cpSecret.addEventListener('click', async () => {
        toast((await copyText(a.secret)) ? '已複製金鑰' : '複製失敗');
      });

      const cpUri = document.createElement('button');
      cpUri.textContent = '複製 URI';
      cpUri.addEventListener('click', async () => {
        toast((await copyText(a.uri)) ? '已複製 URI' : '複製失敗');
      });

      row.append(showBtn, cpSecret, cpUri);
      item.append(title, sub, secret, row);
      otpList.append(item);
    });
  }

  function updateOtpMeta(added) {
    let t = '共 ' + otpAccounts.length + ' 個帳號';
    if (otpBatch) {
      const n = Object.keys(otpBatch.seen).length;
      t += '・匯出碼已掃 ' + n + '/' + otpBatch.size + ' 張';
      if (n < otpBatch.size) t += '，請繼續掃描其餘的';
    }
    otpMeta.textContent = t;
    if (added === 0) toast('這個帳號已經讀取過了');
  }

  function handleOtp(text) {
    let parsed = null;
    try {
      parsed = window.OtpParse && window.OtpParse.parseOtp(text);
    } catch (e) {
      parsed = null;
    }
    if (!parsed || !parsed.accounts.length) {
      toast('無法解析這個 OTP 碼，改顯示原始文字');
      showResult(text, false, Date.now());
      return;
    }
    pauseScan();
    holding = true;
    resultBox.classList.add('hidden');
    let added = 0;
    parsed.accounts.forEach((a) => {
      a.key = a.secret + '|' + a.issuer + '|' + a.account;
      if (!otpAccounts.some((x) => x.key === a.key)) {
        otpAccounts.push(a);
        added++;
      }
    });
    if (parsed.batchSize > 1) {
      if (!otpBatch || otpBatch.id !== parsed.batchId) {
        otpBatch = { id: parsed.batchId, size: parsed.batchSize, seen: {} };
      }
      otpBatch.seen[parsed.batchIndex] = true;
    }
    updateOtpMeta(added);
    renderOtp();
    setStatus('已讀取 OTP');
    otpBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function shareBackup() {
    const text = window.OtpParse.formatBackup(otpAccounts, fmt(Date.now()));
    if (navigator.share) {
      try {
        await navigator.share({ title: 'OTP 備份', text: text });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'otp-backup.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      toast('無法分享，請改用「複製全部」');
    }
  }

  otpNext.addEventListener('click', resumeScan);
  otpCopyAll.addEventListener('click', async () => {
    const text = window.OtpParse.formatBackup(otpAccounts, fmt(Date.now()));
    toast((await copyText(text)) ? '已複製全部' : '複製失敗');
  });
  otpShare.addEventListener('click', shareBackup);
  otpClear.addEventListener('click', () => {
    if (!window.confirm('確定要清除畫面上的 OTP 資料嗎？清除後需要重新掃描。')) return;
    otpAccounts = [];
    otpBatch = null;
    otpMeta.textContent = '';
    renderOtp();
  });

  // ---------- 啟動 ----------
  async function init() {
    renderHist();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    watchOfflineReady();
    if (!(await ensureDecoder())) {
      setStatus('找不到解碼程式：請先連網開啟一次（或把 jsQR.js 放進同一個資料夾）', true);
      return;
    }
    startCamera();
  }

  init();
})();
