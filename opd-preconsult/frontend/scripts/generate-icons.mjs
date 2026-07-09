#!/usr/bin/env node
/**
 * Generates the PWA icon set into public/icons/.
 *
 * Run: npm run gen:icons   (only needed when the mark or brand colour changes;
 *                           the PNGs are committed, so a normal build never runs this)
 *
 * Dependency-free on purpose: `sharp` / `canvas` are native modules that would
 * have to compile inside the Alpine build image, and this repo already had one
 * platform-native-binary incident (@next/swc). A PNG is a zlib stream plus four
 * CRC'd chunks, so we just write it.
 *
 * The mark is a white medical cross on --primary (#1B4F72), drawn with 4x4
 * supersampling so the rounded corners and cross edges are not jagged.
 *
 * Two shapes, because Android will crop what you give it:
 *   "any"      rounded square, transparent outside the radius. Used as-is.
 *   "maskable" full-bleed, cross kept inside the central 80% safe circle that
 *              the spec guarantees survives any mask (circle, squircle, teardrop).
 *              A maskable icon that reuses the rounded-square art gets its
 *              corners shaved and looks like a mistake.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const NAVY = [0x1b, 0x4f, 0x72];
const WHITE = [0xff, 0xff, 0xff];

// ── PNG encoding ──────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  // 10,11,12 = deflate / adaptive filter / no interlace, all zero
  // Each scanline is prefixed with filter type 0 (None).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── the mark ──────────────────────────────────────────────────────────────────
// `arm` is the half-thickness of the cross, `reach` its half-length, both as a
// fraction of the icon size. Coverage is sampled 4x4 per pixel and averaged.
function render(size, { maskable }) {
  const SS = 4;
  const rgba = Buffer.alloc(size * size * 4);
  const r = maskable ? 0 : size * 0.2237;      // corner radius (0 = full bleed)
  const reach = (maskable ? 0.30 : 0.34) * size;
  const arm = (maskable ? 0.095 : 0.105) * size;
  const cx = size / 2, cy = size / 2;

  const insideRounded = (x, y) => {
    if (r === 0) return true;
    const dx = Math.max(r - x, 0, x - (size - r));
    const dy = Math.max(r - y, 0, y - (size - r));
    return dx * dx + dy * dy <= r * r;
  };
  const insideCross = (x, y) => {
    const ax = Math.abs(x - cx), ay = Math.abs(y - cy);
    return (ax <= arm && ay <= reach) || (ay <= arm && ax <= reach);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (!insideRounded(px, py)) continue;
          bg++;
          if (insideCross(px, py)) fg++;
        }
      }
      const n = SS * SS;
      const alpha = bg / n;                       // shape coverage
      const cross = bg ? fg / bg : 0;             // cross coverage within the shape
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[i + c] = Math.round(NAVY[c] * (1 - cross) + WHITE[c] * cross);
      }
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT, { recursive: true });
const files = [
  ['icon-192.png', 192, { maskable: false }],
  ['icon-512.png', 512, { maskable: false }],
  ['icon-maskable-192.png', 192, { maskable: true }],
  ['icon-maskable-512.png', 512, { maskable: true }],
  // iOS ignores the manifest's icons and masks this one itself, so it is
  // full-bleed with no transparency of its own.
  ['apple-touch-icon.png', 180, { maskable: true }],
];
for (const [name, size, opts] of files) {
  const png = render(size, opts);
  writeFileSync(join(OUT, name), png);
  console.log(`${name.padEnd(26)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
console.log(`\nWrote ${files.length} icons to public/icons/`);
