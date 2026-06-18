import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { createLogger } from "../core/logger";

const log = createLogger("web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** 解析静态资源目录：优先 dist/web/public（构建产物），回退 src/web/public（开发期）。 */
function resolvePublicDir(): string {
  const candidates = [
    path.resolve(__dirname, "public"),
    path.resolve(__dirname, "../../src/web/public"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "index.html"))) return c;
  }
  return candidates[0];
}

/**
 * Web 面板静态服务。页面本身直接连 core daemon 的 WebSocket（看同一份状态）。
 * 通过把 daemon 的 ws 地址注入 index.html 的占位符传给前端。
 */
export function startWebServer(opts: {
  webHost: string;
  webPort: number;
  daemonHost: string;
  daemonPort: number;
}): Promise<{ host: string; port: number }> {
  const publicDir = resolvePublicDir();
  const wsUrl = `ws://${opts.daemonHost}:${opts.daemonPort}`;

  const server = http.createServer((req, res) => {
    let urlPath = (req.url || "/").split("?")[0];
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.join(publicDir, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 Not Found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      let body: Buffer | string = data;
      if (ext === ".html") {
        body = data.toString("utf8").replace(/__WS_URL__/g, wsUrl);
      }
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(body);
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.webPort, opts.webHost, () => {
      log.info(`Web 面板 http://${opts.webHost}:${opts.webPort} （连 ${wsUrl}）`);
      resolve({ host: opts.webHost, port: opts.webPort });
    });
  });
}
