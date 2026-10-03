// 用 Node fetch 下载 MinGit (curl TLS 失败时的备选通道)
import { writeFileSync, statSync } from "node:fs";

const urls = [
  "https://registry.npmmirror.com/-/binary/git-for-windows/v2.56.0.windows.1/MinGit-2.56.0-64-bit.zip",
  "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.1/MinGit-2.56.0-64-bit.zip"
];

for (const url of urls) {
  try {
    console.log("尝试:", url);
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(120000)
    });
    if (!res.ok) { console.log("  HTTP", res.status); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync("tools/mingit.zip", buf);
    console.log("  成功:", buf.length, "bytes");
    process.exit(0);
  } catch (e) {
    console.log("  失败:", e.message);
  }
}
console.log("全部失败");
process.exit(1);
