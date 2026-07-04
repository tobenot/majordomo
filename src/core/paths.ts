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

/** 指挥官全局数据目录：~/.majordomo（配置、会话库、历史）。可用 MAJORDOMO_HOME 覆盖，方便测试/便携模式。 */
export function globalDir(): string {
  return process.env.MAJORDOMO_HOME
    ? path.resolve(expandHome(process.env.MAJORDOMO_HOME))
    : path.join(os.homedir(), ".majordomo");
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

/** 中枢三张表的持久化文件（windows / todos / acceptance）。 */
export function hubStorePath(name: "windows" | "todos" | "acceptance"): string {
  return path.join(globalDir(), `hub-${name}.json`);
}

/** 弹窗抑制标记：存在则 popup-web.ps1 不自动拉起。 */
export function popupSuppressPath(): string {
  return path.join(globalDir(), "popup.suppress");
}

/** 项目级 .majordomo/ 数据目录。可用 MAJORDOMO_PROJECT_DIR 覆盖。 */
export function projectDir(root: string = process.cwd()): string {
  return process.env.MAJORDOMO_PROJECT_DIR
    ? path.resolve(expandHome(process.env.MAJORDOMO_PROJECT_DIR))
    : path.join(root, ".majordomo");
}
