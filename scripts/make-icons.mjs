// PWA アイコン(PNG)を生成するスクリプト。依存パッケージなし: `node scripts/make-icons.mjs`
// デザイン: 暗い背景に、ハイライトボタンと同じ「白い縁の赤い円 + 白い星」
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [17, 17, 17];
const RED = [229, 72, 77];
const WHITE = [255, 255, 255];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const encodePng = (size, rgb) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8bit
  ihdr[9] = 2; // RGB(透過なし)
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const starPoints = (cx, cy, ro) => {
  const ri = ro * 0.382;
  return Array.from({ length: 10 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? ro : ri;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
};
const inPolygon = (x, y, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

// scale: 円全体(縁を含む)が画像の何割の半径か。maskable は端が切れても欠けないよう小さめにする
const render = (size, scale) => {
  const cx = size / 2;
  const cy = size / 2;
  const outer = size * scale; // 白い縁の外側の半径
  const inner = outer * 0.88; // 赤い円の半径
  const star = starPoints(cx, cy + inner * 0.03, inner * 0.62);
  const rgb = Buffer.alloc(size * size * 3);
  const SS = 4; // 4x4 スーパーサンプリングで縁を滑らかにする
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const d = Math.hypot(px - cx, py - cy);
          let c = BG;
          if (d <= outer) c = WHITE;
          if (d <= inner) c = inPolygon(px, py, star) ? WHITE : RED;
          acc[0] += c[0];
          acc[1] += c[1];
          acc[2] += c[2];
        }
      }
      const o = (y * size + x) * 3;
      rgb[o] = Math.round(acc[0] / (SS * SS));
      rgb[o + 1] = Math.round(acc[1] / (SS * SS));
      rgb[o + 2] = Math.round(acc[2] / (SS * SS));
    }
  }
  return rgb;
};

const targets = [
  ['apple-touch-icon.png', 180, 0.38],
  ['icon-192.png', 192, 0.38],
  ['icon-512.png', 512, 0.38],
  ['icon-maskable-512.png', 512, 0.3],
];
for (const [name, size, scale] of targets) {
  writeFileSync(join(outDir, name), encodePng(size, render(size, scale)));
  console.log(`wrote public/icons/${name} (${size}x${size})`);
}
