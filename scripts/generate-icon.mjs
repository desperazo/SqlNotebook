import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync } from "node:fs";

const S = 1024;
const buf = Buffer.alloc(S * S * 4);

function over(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const t = a / 255;
  const inv = 1 - t;
  buf[i] = r * t + buf[i] * inv;
  buf[i + 1] = g * t + buf[i + 1] * inv;
  buf[i + 2] = b * t + buf[i + 2] * inv;
  buf[i + 3] = Math.min(255, a + buf[i + 3] * inv);
}

const cov = (sd) => Math.max(0, Math.min(1, 0.5 - sd));

function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - hw + r;
  const dy = Math.abs(y - cy) - hh + r;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - r;
}

function sdRect(x, y, x0, y0, x1, y1) {
  return Math.max(x0 - x, x - x1, y0 - y, y - y1);
}

const foldSize = 132;
const pageRight = 700;
const pageTop = 236;
const inFold = (x, y) => x - pageRight + (y - pageTop) > 0 && x > pageRight - foldSize && y < pageTop + foldSize;

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const px = x + 0.5;
    const py = y + 0.5;

    const bg = cov(sdRoundRect(px, py, 512, 512, 472, 472, 216));
    if (bg > 0) {
      const t = y / S;
      over(x, y, Math.round(46 + (23 - 46) * t), Math.round(109 + (58 - 109) * t), Math.round(236 + (138 - 236) * t), Math.round(bg * 255));
    }

    const pageSd = sdRoundRect(px, py, 512, 512, 196, 282, 26);
    const isPage = cov(pageSd) * (inFold(px, py) ? 0 : 1);
    if (isPage > 0) over(x, y, 245, 246, 248, Math.round(isPage * 255));

    if (inFold(px, py)) {
      const c = cov(Math.max(sdRect(px, py, pageRight - foldSize, pageTop, pageRight, pageTop + foldSize), pageSd));
      if (c > 0) over(x, y, 205, 211, 222, Math.round(c * 255));
    }

    for (const [ly, lw, h] of [[430, 300, 26], [512, 300, 26], [594, 210, 26]]) {
      const c = cov(sdRoundRect(px, py, 512 - (300 - lw) / 2, ly, lw / 2, h / 2, h / 2));
      if (c > 0) over(x, y, 76, 104, 168, Math.round(c * 235));
    }
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;
ihdr[9] = 6;

const stride = S * 4 + 1;
const raw = Buffer.alloc(S * stride);
for (let y = 0; y < S; y++) {
  raw[y * stride] = 0;
  buf.copy(raw, y * stride + 1, y * S * 4, (y + 1) * S * 4);
}

const out = process.argv[2] ?? "app-icon.png";
writeFileSync(
  out,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
);
console.log(`wrote ${out}`);
