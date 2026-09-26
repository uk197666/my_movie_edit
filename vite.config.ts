import { defineConfig, type Plugin } from 'vite';

// GitHub Pages では HTTP ヘッダーを設定できないため、CSP は meta タグで入れる。
// 外部への通信は一切なく、スクリプト・スタイルはすべて同一オリジンのファイルから読み込む。
// 開発サーバー(HMR がインラインスクリプトと WebSocket を使う)では CSP を付けず、ビルド時だけ挿入する。
const CSP = [
  "default-src 'none'",
  "script-src 'self'", // アプリ本体と AudioWorklet(public/audio-capture-worklet.js)
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' blob:", // 完成したクリップのプレビュー(blob: URL)
  "connect-src 'self' blob:", // Service Worker による同一オリジンの取得
  "worker-src 'self'", // Service Worker
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

const injectCsp = (): Plugin => ({
  name: 'inject-csp',
  apply: 'build',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
  ],
});

// GitHub Pages のプロジェクトサイトは /<リポジトリ名>/ 配下で公開される
export default defineConfig({
  base: '/my_movie_edit/',
  plugins: [injectCsp()],
});
