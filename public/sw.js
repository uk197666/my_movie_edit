// アプリ本体(HTML/JS/CSS/アイコン)だけをキャッシュする Service Worker。動画やバッファは保存しない。
// ネットワーク優先: オンラインなら常に最新を取得してキャッシュを更新し、オフラインのときだけキャッシュから返す。
const CACHE = 'highlight-rec-v2';

// 初回オンライン時に先読みして、次回以降オフラインでも起動できるようにする(scope からの相対パス)
const PRECACHE = [
  './',
  'manifest.webmanifest',
  'audio-capture-worklet.js',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

const scope = () => self.registration.scope;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const urls = new Set(PRECACHE.map((p) => new URL(p, scope()).href));
      // トップページが参照する、ハッシュ付きの JS/CSS も先読み対象に加える
      try {
        const html = await (await fetch(scope(), { cache: 'reload' })).text();
        for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
          const u = new URL(m[1], scope());
          if (u.origin === self.location.origin && /\.(js|css)$/.test(u.pathname)) urls.add(u.href);
        }
      } catch {
        // オフラインなどで取得できなければ、先読みなしで続行する
      }
      await Promise.all(
        [...urls].map(async (u) => {
          try {
            const res = await fetch(u, { cache: 'reload' });
            if (res.ok) await cache.put(u, res);
          } catch {
            // 個別の失敗は無視する(実際に使われたときにキャッシュされる)
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
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
          const top = await cache.match(new URL('./', scope()).href);
          if (top) return top;
        }
        throw e;
      }
    })(),
  );
});
