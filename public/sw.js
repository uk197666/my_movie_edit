// アプリ本体(HTML/JS/アイコン)だけをキャッシュする Service Worker。動画やバッファは保存しない。
// ネットワーク優先: オンラインなら常に最新を取得してキャッシュを更新し、オフラインのときだけキャッシュから返す。
const CACHE = 'highlight-rec-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        const cached = await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        // ページ遷移(ホーム画面からの起動など)は、キャッシュ済みのトップページで代用する
        if (req.mode === 'navigate') {
          const top = await cache.match(new URL('./', self.registration.scope).href);
          if (top) return top;
        }
        throw e;
      }
    })(),
  );
});
