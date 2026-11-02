// 改了任何檔案後，請把版本號 +1（例如 qr-scan-v2），手機才會更新快取
const VERSION = 'qr-scan-v2';
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

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    const hit = await caches.match(event.request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(event.request);
      if (res && (res.ok || res.type === 'opaque')) {
        const cache = await caches.open(VERSION);
        cache.put(event.request, res.clone());
      }
      return res;
    } catch (err) {
      if (event.request.mode === 'navigate') {
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});
