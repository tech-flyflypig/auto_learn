// 下载考试图片并与华图图片做像素比对
import { writeFileSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

async function dl(url, file) {
  const res = await fetch(url, { headers: { "Referer": "https://mooc1.chaoxing.com/" } });
  if (!res.ok) throw new Error(url + " -> HTTP " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  console.log("downloaded", file, buf.length, "bytes");
  return buf;
}

// ---------- 最小PNG解码器 ----------
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not PNG");
  let off = 8;
  let width = 0, height = 0, bitDepth = 8, colorType = 6;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error("unsupported bitDepth " + bitDepth);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * channels);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = Buffer.from(line);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = cur[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      cur[x] = v;
    }
    cur.copy(pixels, y * stride);
    prev = cur;
  }
  return { width, height, channels, pixels };
}

function toGray(img, S = 64) {
  const g = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const sx = Math.floor((x * img.width) / S);
      const sy = Math.floor((y * img.height) / S);
      const i = (sy * img.width + sx) * img.channels;
      let v;
      if (img.channels === 1) v = img.pixels[i];
      else v = (img.pixels[i] + img.pixels[i + 1] + img.pixels[i + 2]) / 3;
      // 透明背景按白处理
      const alpha = img.channels === 4 ? img.pixels[i + 3] / 255 : 1;
      g[y * S + x] = v * alpha + 255 * (1 - alpha);
    }
  }
  return g;
}

function corr(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

const huatu = decodePNG(readFileSync("huatu_prune.png"));
console.log("huatu:", huatu.width + "x" + huatu.height, "channels:", huatu.channels);

const q17 = decodePNG(readFileSync("q17_33.png"));
const q28 = decodePNG(readFileSync("q28_34.png"));
console.log("q17(33.png):", q17.width + "x" + q17.height);
console.log("q28(34.png):", q28.width + "x" + q28.height);

const h = toGray(huatu);
console.log("corr(huatu, q17_33.png) =", corr(h, toGray(q17)).toFixed(4));
console.log("corr(huatu, q28_34.png) =", corr(h, toGray(q28)).toFixed(4));
console.log("corr(q17, q28) =", corr(toGray(q17), toGray(q28)).toFixed(4));
