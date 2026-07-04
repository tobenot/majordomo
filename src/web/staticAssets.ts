import * as fs from "fs";
import * as path from "path";

/**
 * Web 静态资产的公共逻辑：目录解析 + 文件读取 + WS 地址注入。
 * daemon（直供 /popup 浮窗页）与独立 web server 共用同一份，避免两处各写一遍目录解析。
 */

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** 静态资源目录：优先 dist/web/public（构建产物），回退 src/web/public（开发期）。 */
export function resolvePublicDir(): string {
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
 * 浏览器要连的 WS 地址：localhost 系一律给占位符，让页面从 location 自解析同源，
 * 这样 0.0.0.0 / 远程访问都不会连到错的 host。非本机 host 直给具体地址。
 */
export function browserWsUrlFor(host: string, port: number): string {
  const normalized = host.toLowerCase().trim();
  if (
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1"
  ) {
    return `__AUTO_WS__:${port}`;
  }
  return `ws://${host}:${port}`;
}

/** 健康检查用的具体 WS 地址（不能是占位符）。 */
export function concreteWsUrlFor(host: string, port: number): string {
  const connectHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `ws://${connectHost}:${port}`;
}

/**
 * 读一个静态文件并按扩展名定 MIME。.html 里的 {{WS_URL}} 占位符替换成 wsUrl。
 * 命中返回 {body, contentType}；文件不存在返回 null（调用方给 404）。
 * urlPath 已归一防目录穿越（去掉前导 ../）。
 */
export function readAsset(
  publicDir: string,
  urlPath: string,
  wsUrl: string,
): { body: Buffer | string; contentType: string } | null {
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safe);
  let data: Buffer;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  const ext = path.extname(filePath).toLowerCase();
  let body: Buffer | string = data;
  if (ext === ".html") {
    body = data.toString("utf8").replace(/\{\{WS_URL\}\}/g, wsUrl);
  }
  return { body, contentType: MIME[ext] || "application/octet-stream" };
}
