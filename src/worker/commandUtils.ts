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
  // ponytail: on Windows, skip extensionless shell wrappers, prefer .exe/.cmd/.bat
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


