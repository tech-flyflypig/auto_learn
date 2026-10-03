import { writeFileSync } from "node:fs";

const targets = [
  ["http://p.ananas.chaoxing.com/star3/origin/4f4d6a7ececc918555e27b549e051088.png", "q17_33.png"],
  ["http://p.ananas.chaoxing.com/star3/origin/19c196e0f5f4e0fef5dc2243de2d71ba.png", "q28_34.png"],
  ["http://p.ananas.chaoxing.com/star3/origin/53bf4cc7fb17cca383d6fd08abc2d8a9.png", "q8_41.png"],
  ["http://p.ananas.chaoxing.com/star3/origin/11c15750d4c49c4d6554f403c87234a4.png", "q22_32.png"],
  ["http://p.ananas.chaoxing.com/star3/origin/968e1a7328f78ba8cdbb5c3e1588b540.png", "q24_31.png"]
];

for (const [url, file] of targets) {
  try {
    const res = await fetch(url, { headers: { "Referer": "https://mooc1.chaoxing.com/" } });
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(file, buf);
    console.log("saved", file, buf.length, "bytes");
  } catch (e) {
    console.log("FAIL", file, e.message);
  }
}
