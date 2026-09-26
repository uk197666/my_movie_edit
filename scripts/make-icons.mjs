// PWA アイコン(PNG)を生成するスクリプト。依存パッケージなし: `node scripts/make-icons.mjs`
// デザイン: 暗い背景に、バスケットボール(オレンジの球 + 黒い縫い目)
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [17, 17, 17];
const ORANGE = [240, 128, 40];
const SEAM = [30, 20, 15];

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

// scale: ボールの半径が画像サイズの何割か。maskable は端が切れても欠けないよう小さめにする
const render = (size, scale) => {
  const cx = size / 2;
  const cy = size / 2;
  const R = size * scale; // ボールの半径
  const hw = R * 0.05; // 縫い目の太さ(半分)
  // 縫い目: 縦線・横線、左右に膨らむ2本の弧(中心が ±1.3R、半径 0.9R の円の一部)
  const isSeam = (px, py) =>
    Math.abs(px - cx) <= hw ||
    Math.abs(py - cy) <= hw ||
    Math.abs(Math.hypot(px - (cx - 1.3 * R), py - cy) - 0.9 * R) <= hw ||
    Math.abs(Math.hypot(px - (cx + 1.3 * R), py - cy) - 0.9 * R) <= hw;
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
          if (d <= R) {
            if (d >= R - hw || isSeam(px, py)) {
              c = SEAM;
            } else {
              // 左上を少し明るくして立体感を出す
              const light = 1 + (0.14 * ((cx - px) + (cy - py))) / (2 * R);
              c = ORANGE.map((v) => Math.min(255, v * light));
            }
          }
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
  ['apple-touch-icon.png', 180, 0.4],
  ['icon-192.png', 192, 0.4],
  ['icon-512.png', 512, 0.4],
  ['icon-maskable-512.png', 512, 0.3],
];
for (const [name, size, scale] of targets) {
  writeFileSync(join(outDir, name), encodePng(size, render(size, scale)));
  console.log(`wrote public/icons/${name} (${size}x${size})`);
}
