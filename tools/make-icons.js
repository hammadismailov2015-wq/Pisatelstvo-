// Генератор PNG-иконок для установки на телефон: npm run icons
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size * 4 + 1);
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      row.set([r, g, b, a], 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function icon(x, y, size) {
  const u = x / size, v = y / size;             // 0..1
  const bg = mix([124, 92, 255], [255, 92, 138], Math.min(1, (u + v) / 2 + 0.1));
  const white = [255, 255, 255];

  const cx = 0.5, capTop = 0.22, capBottom = 0.55, capR = 0.088;
  // капсула микрофона
  const dx = Math.abs(u - cx);
  const inCap =
    dx <= capR &&
    (v >= capTop + capR && v <= capBottom - capR
      ? true
      : Math.hypot(u - cx, v - Math.min(Math.max(v, capTop + capR), capBottom - capR)) <= capR);
  // дуга-держатель
  const d = Math.hypot(u - cx, v - 0.52);
  const inArc = v >= 0.52 && Math.abs(d - 0.2) <= 0.03;
  // ножка и подставка
  const inStem = dx <= 0.028 && v >= 0.7 && v <= 0.805;
  const inBase = dx <= 0.12 && Math.abs(v - 0.82) <= 0.028;

  return inCap || inArc || inStem || inBase ? [...white, 255] : [...bg, 255];
}

for (const size of [192, 512]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, png(size, icon));
  console.log("создано", file);
}
