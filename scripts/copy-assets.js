// 把 Web 静态资源从 src/web/public 拷到 dist/web/public（tsc 不处理非 ts 文件）。
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "src", "web", "public");
const dest = path.join(__dirname, "..", "dist", "web", "public");

function copyDir(s, d) {
  fs.mkdirSync(d, { recursive: true });
  for (const entry of fs.readdirSync(s, { withFileTypes: true })) {
    const sp = path.join(s, entry.name);
    const dp = path.join(d, entry.name);
    if (entry.isDirectory()) copyDir(sp, dp);
    else fs.copyFileSync(sp, dp);
  }
}

if (fs.existsSync(src)) {
  copyDir(src, dest);
  console.log("[copy-assets] web public -> dist/web/public");
} else {
  console.warn("[copy-assets] 未找到 src/web/public，跳过");
}
