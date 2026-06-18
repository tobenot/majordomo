import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { Notifier } from "./types";
import { createLogger } from "../core/logger";

const log = createLogger("notify:ps");

/**
 * 包装第二代 tools/notify-done/notify-done.ps1（提示音 + 任务栏闪烁 + TTS + 持久浮窗）。
 * 仅 Windows 可用，非阻塞（脚本自身会拉后台 worker 立即返回）。
 */
export class PowershellNotifier implements Notifier {
  readonly name = "powershell";
  private scriptPath?: string;

  constructor() {
    this.scriptPath = locateScript();
    if (!this.scriptPath) {
      log.warn("未找到 notify-done.ps1，PowerShell 通知器将不可用（可设 MAJORDOMO_NOTIFY_DIR）");
    }
  }

  notify(message: string): void {
    if (process.platform !== "win32") return;
    if (!this.scriptPath) return;
    try {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          this.scriptPath,
          message,
        ],
        { detached: true, stdio: "ignore", windowsHide: true }
      );
      child.unref();
    } catch (e) {
      log.warn(`PowerShell 通知失败: ${(e as Error).message}`);
    }
  }
}

function locateScript(): string | undefined {
  const candidates = [
    process.env.MAJORDOMO_NOTIFY_DIR
      ? path.join(process.env.MAJORDOMO_NOTIFY_DIR, "notify-done.ps1")
      : "",
    path.resolve(__dirname, "../../tools/notify-done/notify-done.ps1"),
    path.resolve(__dirname, "../../../tools/notify-done/notify-done.ps1"),
    path.join(process.cwd(), "tools/notify-done/notify-done.ps1"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return undefined;
}
