// 解析 TTF 字体的 cmap 表，输出 码点 -> 字形ID 映射
import { readFileSync } from "node:fs";

const buf = readFileSync(process.argv[2] || "cxsecret.ttf");

const numTables = buf.readUInt16BE(4);
const tables = {};
for (let i = 0; i < numTables; i++) {
  const off = 12 + i * 16;
  const tag = buf.toString("ascii", off, off + 4);
  tables[tag] = {
    checksum: buf.readUInt32BE(off + 4),
    offset: buf.readUInt32BE(off + 8),
    length: buf.readUInt32BE(off + 12),
  };
}

const cmap = tables["cmap"];
if (!cmap) {
  console.error("no cmap table, tables:", Object.keys(tables));
  process.exit(1);
}

const numSubtables = buf.readUInt16BE(cmap.offset + 2);
const subtables = [];
for (let i = 0; i < numSubtables; i++) {
  const off = cmap.offset + 4 + i * 8;
  subtables.push({
    platformID: buf.readUInt16BE(off),
    encodingID: buf.readUInt16BE(off + 2),
    offset: cmap.offset + buf.readUInt32BE(off + 4),
  });
}

// 解析 format 4 / format 12 子表
const map = new Map(); // codepoint -> glyphId
for (const st of subtables) {
  const format = buf.readUInt16BE(st.offset);
  if (format === 4) {
    const segCountX2 = buf.readUInt16BE(st.offset + 6);
    const segCount = segCountX2 / 2;
    const endCodesBase = st.offset + 14;
    const startCodesBase = endCodesBase + segCountX2 + 2;
    const idDeltasBase = startCodesBase + segCountX2;
    const idRangeOffsetsBase = idDeltasBase + segCountX2;
    for (let i = 0; i < segCount; i++) {
      const endCode = buf.readUInt16BE(endCodesBase + i * 2);
      const startCode = buf.readUInt16BE(startCodesBase + i * 2);
      const idDelta = buf.readInt16BE(idDeltasBase + i * 2);
      const idRangeOffset = buf.readUInt16BE(idRangeOffsetsBase + i * 2);
      for (let cp = startCode; cp <= endCode && cp !== 0xffff; cp++) {
        let glyphId;
        if (idRangeOffset === 0) {
          glyphId = (cp + idDelta) & 0xffff;
        } else {
          const addr = idRangeOffsetsBase + i * 2 + idRangeOffset + (cp - startCode) * 2;
          glyphId = buf.readUInt16BE(addr);
          if (glyphId !== 0) glyphId = (glyphId + idDelta) & 0xffff;
        }
        if (glyphId !== 0) map.set(cp, glyphId);
      }
    }
  } else if (format === 12) {
    const nGroups = buf.readUInt32BE(st.offset + 12);
    for (let i = 0; i < nGroups; i++) {
      const off = st.offset + 16 + i * 12;
      const start = buf.readUInt32BE(off);
      const end = buf.readUInt32BE(off + 4);
      const startGID = buf.readUInt32BE(off + 8);
      for (let cp = start; cp <= end; cp++) map.set(cp, startGID + (cp - start));
    }
  } else {
    console.error("skip subtable format", format);
  }
}

// 输出: 按字形ID分组,看哪些码点共享同一字形
const byGlyph = new Map();
for (const [cp, gid] of map) {
  if (!byGlyph.has(gid)) byGlyph.set(gid, []);
  byGlyph.get(gid).push(cp);
}

const out = [];
for (const [gid, cps] of byGlyph) {
  const chars = cps.map((c) => "U+" + c.toString(16).toUpperCase().padStart(4, "0") + "(" + String.fromCodePoint(c) + ")");
  out.push({ gid, chars });
}
console.log("total mapped codepoints:", map.size);
console.log("total glyphs with mappings:", byGlyph.size);
console.log(JSON.stringify(out, null, 1));
