import * as os from "os";
import * as path from "path";
import * as fs from "fs";

/** 把 ~ 展开成用户主目录。 */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** 指挥官全局数据目录：~/.majordomo（配置、会话库、历史）。 */
export function globalDir(): string {
  return path.join(os.homedir(), ".majordomo");
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 全局会话库文件。 */
export function sessionsDbPath(): string {
  return path.join(globalDir(), "sessions.json");
}

/** 全局历史目录（每会话一个 jsonl）。 */
export function historyDir(): string {
  return path.join(globalDir(), "history");
}
