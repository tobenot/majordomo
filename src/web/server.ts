import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { WebSocket } from "ws";
import { createLogger } from "../core/logger";
import { resolvePublicDir, browserWsUrlFor, concreteWsUrlFor, readAsset } from "./staticAssets";

const log = createLogger("web");

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
  const browserWsUrl = browserWsUrlFor(opts.daemonHost, opts.daemonPort);
  const healthWsUrl = concreteWsUrlFor(opts.daemonHost, opts.daemonPort);

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, publicDir, browserWsUrl, healthWsUrl);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.webPort, opts.webHost, () => {
      log.info(`Web 面板 http://${opts.webHost}:${opts.webPort} （连 ${healthWsUrl}）`);
      resolve({ host: opts.webHost, port: opts.webPort });
    });
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  publicDir: string,
  browserWsUrl: string,
  healthWsUrl: string
): Promise<void> {
  let urlPath = (req.url || "/").split("?")[0];
  if (urlPath === "/healthz" || urlPath === "/readyz") {
    const assetsOk = fs.existsSync(path.join(publicDir, "index.html"));
    const daemonWsOk = await canConnectWs(healthWsUrl, 600);
    const ok = assetsOk && daemonWsOk;
    res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok, web: true, assets: assetsOk, daemonWs: daemonWsOk }));
    return;
  }

  if (urlPath === "/") urlPath = "/index.html";
  const asset = readAsset(publicDir, urlPath, browserWsUrl);
  if (!asset) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
    return;
  }
  res.writeHead(200, { "Content-Type": asset.contentType });
  res.end(asset.body);
}

function canConnectWs(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      resolve(false);
    }, timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve(true);
    });
    ws.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}
