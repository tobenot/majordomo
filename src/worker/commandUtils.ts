import { spawn, spawnSync, ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";

export function spawnCommand(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {}
): ChildProcessWithoutNullStreams {
  const resolved = resolveCommandPath(command);

  if (process.platform === "win32" && resolved && /\.(cmd|bat)$/i.test(resolved)) {
    const cmdLine = quoteForCmd([resolved, ...args]);
    return spawn("cmd.exe", ["/d", "/s", "/c", cmdLine], {
      cwd: opts.cwd,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
  }

  return spawn(resolved ?? command, args, {
    cwd: opts.cwd,
    windowsHide: process.platform === "win32",
  }) as ChildProcessWithoutNullStreams;
}

export function spawnCommandSync(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; stdio?: "ignore" | "pipe" } = {}
) {
  const resolved = resolveCommandPath(command);

  if (process.platform === "win32" && resolved && /\.(cmd|bat)$/i.test(resolved)) {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", quoteForCmd([resolved, ...args])], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      stdio: opts.stdio ?? "ignore",
      windowsHide: true,
    });
  }

  return spawnSync(resolved ?? command, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    stdio: opts.stdio ?? "ignore",
    windowsHide: process.platform === "win32",
  });
}

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
  const first = r.stdout.toString("utf8").split(/\r?\n/).find(Boolean);
  return first ? path.normalize(first.trim()) : null;
}

function quoteForCmd(parts: string[]): string {
  return parts.map(quoteCmdArg).join(" ");
}

function quoteCmdArg(s: string): string {
  // 只用于 .cmd/.bat shim fallback；用户 prompt 不会进入这里。
  return `"${s
    .replace(/%/g, "%%")
    .replace(/([&|<>^])/g, "^$1")
    .replace(/"/g, '\\"')}"`;
}
