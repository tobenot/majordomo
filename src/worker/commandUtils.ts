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
  // ponytail: on Windows, skip extensionless shell wrappers, prefer native exe over cmd wrappers
  if (process.platform === "win32") {
    const exe = lines.find(l => l.toLowerCase().endsWith(".exe"));
    if (exe) return path.normalize(exe);
    // .cmd wrappers may directly invoke an .exe — resolve through them
    for (const l of lines) {
      if (!l.toLowerCase().endsWith(".cmd")) continue;
      const resolved = resolveExeFromCmd(l);
      if (resolved) return path.normalize(resolved);
    }
    // fallback: first .cmd or .bat (for non-SDK use like version check)
    const cmd = lines.find(l => /\.(cmd|bat)$/i.test(l));
    if (cmd) return path.normalize(cmd);
  }
  return lines[0] ? path.normalize(lines[0]) : null;
}

export function getCommandVersion(command: string): string | null {
  const resolved = resolveCommandPath(command);
  if (!resolved) return null;
  const r = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", quoteForCmd([resolved, "--version"])], {
        timeout: 5000,
        stdio: "pipe",
        windowsHide: true,
      })
    : spawnSync(resolved, ["--version"], {
        timeout: 5000,
        stdio: "pipe",
        windowsHide: process.platform === "win32",
      });
  const out = Buffer.concat([
    r.stdout ? Buffer.from(r.stdout as any) : Buffer.alloc(0),
    r.stderr ? Buffer.from(r.stderr as any) : Buffer.alloc(0),
  ])
    .toString("utf8")
    .trim();
  return out.split("\n")[0] || "available";
}

function quoteForCmd(parts: string[]): string {
  return parts.map((s) => `"${s.replace(/%/g, "%%").replace(/([&|<>^])/g, "^$1").replace(/"/g, '\\"')}"`).join(" ");
}

/** 解析 .cmd wrapper，如果它直接调用一个 .exe，返回该 .exe 的完整路径。否则返回 null。 */
function resolveExeFromCmd(cmdPath: string): string | null {
  try {
    const content = fs.readFileSync(cmdPath, "utf8");
    // match: "%dp0%\path\to\foo.exe"  (with optional trailing args like %*)
    const m = content.match(/"%dp0%\\([^"]+\.exe)"/i);
    if (!m) return null;
    const relative = m[1];
    const dir = path.dirname(cmdPath);
    const resolved = path.resolve(dir, relative);
    return fs.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}


