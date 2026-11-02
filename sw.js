// 改了這支 sw.js 以外的檔案時，建議把版本號 +1（例如 qr-scan-v4），讓手機重新下載全部檔案
const VERSION = 'qr-scan-v3';
const CDN = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
const LOCAL_FILES = [
  './',
  './index.html',
  './app.js',
  './otp.js',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './jsQR.js', // 沒放這個檔也沒關係，會改用 CDN 並快取
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // cache: 'reload' 會略過瀏覽器的舊快取，確保拿到剛上傳的新檔案
    await Promise.all(LOCAL_FILES.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await cache.add(new Request(CDN, { mode: 'no-cors' })).catch(() => {});
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// 策略：先用快取（離線也能開），同時在背景抓最新版放進快取，下次開啟就會是新版
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const sameOrigin = new URL(req.url).origin === self.location.origin;

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });

    const refresh = (async () => {
      try {
        const res = sameOrigin ? await fetch(req.url, { cache: 'no-cache' }) : await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) await cache.put(req, res.clone());
        return res;
      } catch (err) {
        return null; // 離線時抓不到，沿用快取
      }
    })();

    if (hit) {
      event.waitUntil(refresh);
      return hit;
    }
    const res = await refresh;
    if (res) return res;
    if (req.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    return Response.error();
  })());
});
