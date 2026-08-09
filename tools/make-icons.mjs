/**
 * Generate every app icon: gamevault.ico for the Windows shortcut, and PNGs
 * for the PWA manifest / iOS home screen.
 *
 * Written as code rather than shipped as binaries so the repo stays
 * text-only (reviewable, diffable, no opaque blobs) and the portable zip
 * stays small. Run with: npm run icons
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { PATHS } from '../lib/paths.mjs';

const BG = [0x10, 0x13, 0x1a];      // #10131a
const ACCENT = [0x6e, 0xa8, 0xff];  // #6ea8ff
const HUB = [0x38, 0x55, 0x80];

/**
 * Draw the mark at any size, as RGBA.
 * A vault dial: it has to stay legible at 16px in a taskbar, so it is built
 * from a thick ring plus four diagonal spokes rather than fine detail.
 */
function render(size, { rounded = true } = {}) {
  const px = Buffer.alloc(size * size * 4); // RGBA, starts transparent
  const put = (x, y, [r, g, b]) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  };

  const s = size;
  const r = rounded ? s * 0.18 : 0;
  const cx = s / 2, cy = s / 2;

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = Math.max(r - x, 0, x - (s - 1 - r));
      const dy = Math.max(r - y, 0, y - (s - 1 - r));
      if (dx * dx + dy * dy <= r * r) put(x, y, BG);
    }
  }

  const ringOuter = s * 0.34;
  const ringInner = s * 0.25;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const d = Math.hypot(x - cx + 0.5, y - cy + 0.5);
      if (d <= ringOuter && d >= ringInner) put(x, y, ACCENT);
    }
  }

  // Four spokes on the diagonals.
  const half = Math.max(1, s * 0.045);
  for (let t = 0; t < s * 0.46; t += 0.5) {
    for (let w = -half; w <= half; w += 0.5) {
      const a = t * 0.7071, b = w * 0.7071;
      const c = t < ringInner ? BG : ACCENT;
      put(cx + a + b, cy + a - b, c);
      put(cx - a + b, cy - a - b, c);
      put(cx + a + b, cy - a + b, c);
      put(cx - a + b, cy + a + b, c);
    }
  }

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      if (Math.hypot(x - cx + 0.5, y - cy + 0.5) <= s * 0.12) put(x, y, HUB);
    }
  }
  return px;
}

// ---------- PNG ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(6, 9);   // colour type: RGBA

  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- ICO ----------
function bmpFor(size) {
  const px = render(size);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);   // height counts image + AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4, 20);

  // ICO stores BGRA, bottom-up.
  const body = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = ((size - 1 - y) * size + x) * 4;
      body[dst] = px[src + 2];
      body[dst + 1] = px[src + 1];
      body[dst + 2] = px[src];
      body[dst + 3] = px[src + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, body, Buffer.alloc(maskRow * size)]);
}

function ico(sizes) {
  // Sizes >= 256 are embedded as PNG rather than raw BMP. A 256x256 32bpp
  // bitmap is 256 KB on its own; PNG-in-ICO (Vista+) drops the whole file
  // from ~285 KB to ~15 KB with no visual difference.
  const images = sizes.map((s) => (s >= 256 ? encodePng(render(s), s) : bmpFor(s)));
  const dir = Buffer.alloc(6 + 16 * sizes.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(sizes.length, 4);
  let offset = dir.length;
  sizes.forEach((size, i) => {
    const e = 6 + i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e);   // 0 encodes 256
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(images[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([dir, ...images]);
}

await mkdir(PATHS.public, { recursive: true });

const icoBuf = ico([16, 32, 48, 256]);
await writeFile(path.join(PATHS.public, 'gamevault.ico'), icoBuf);
console.log(`gamevault.ico         ${icoBuf.length} bytes (16/32/48/256)`);

// 192 + 512 for the PWA manifest; 180 is what iOS uses for the home screen.
for (const size of [180, 192, 512]) {
  const buf = encodePng(render(size), size);
  await writeFile(path.join(PATHS.public, `icon-${size}.png`), buf);
  console.log(`icon-${size}.png       ${buf.length} bytes`);
}

// Maskable: Android/iOS crop to a circle, so this one is full-bleed.
const maskable = encodePng(render(512, { rounded: false }), 512);
await writeFile(path.join(PATHS.public, 'icon-maskable.png'), maskable);
console.log(`icon-maskable.png     ${maskable.length} bytes (full-bleed)`);
