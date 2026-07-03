import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/** PATH 上是否能找到某个命令。 */
export function isCommandAvailable(command: string): boolean {
  return !!resolveCommandPath(command);
}

export function resolveCommandPath(command: string): string | null {
  if (fs.existsSync(command)) return command;
  const probe = process.platform === "win32" ? "where.exe" : "which";
  const r = spawnSync(probe, [command], {
    timeout: 5000,
    stdio: "pipe",
    windowsHide: process.platform === "win32",
  });
  if (r.status !== 0 || !r.stdout) return null;
  const lines = r.stdout.toString("utf8").split(/\r?\n/).filter(Boolean).map(s => s.trim());
  // ponytail: on Windows, skip extensionless shell wrappers, prefer .exe > .cmd > .bat
  if (process.platform === "win32") {
    for (const ext of [".exe", ".cmd", ".bat"]) {
      const match = lines.find(l => l.toLowerCase().endsWith(ext));
      if (match) return path.normalize(match);
    }
  }
  return lines[0] ? path.normalize(lines[0]) : null;
}

export function getCommandVersion(command: string): string | null {
  const resolved = resolveCommandPath(command);
  if (!resolved) return null;
  // win32 上 .cmd/.bat 是 shell 脚本，必须经 cmd.exe。用 shell:true + 自带引号的
  // 整行命令（避免手工拼 cmd 串导致的二次转义 → “不是内部或外部命令”，也兼容含空格路径）。
  const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved);
  const r = needsShell
    ? spawnSync(`"${resolved}" --version`, [], {
        timeout: 5000,
        stdio: "pipe",
        windowsHide: true,
        shell: true,
      })
    : spawnSync(resolved, ["--version"], {
        timeout: 5000,
        stdio: "pipe",
        windowsHide: process.platform === "win32",
      });
  const out = decodeConsole(Buffer.concat([
    r.stdout ? Buffer.from(r.stdout as any) : Buffer.alloc(0),
    r.stderr ? Buffer.from(r.stderr as any) : Buffer.alloc(0),
  ])).trim();
  return out.split("\n")[0] || "available";
}

/** Windows 中文控制台默认 cp936(GBK)，用 utf8 解会乱码；其他平台按 utf8。 */
function decodeConsole(buf: Buffer): string {
  if (process.platform === "win32") {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      /* 无 ICU 时回退 utf8 */
    }
  }
  return buf.toString("utf8");
}




