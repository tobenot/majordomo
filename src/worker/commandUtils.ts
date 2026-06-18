import { spawn, spawnSync, ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";

/**
 * Windows 下避免 child_process 的 shell+args DEP0190 警告：
 * 不用 shell:true，而是显式走 cmd.exe /d /s /c "..."。
 */
export function spawnCommand(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {}
): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") {
    const cmdLine = quoteForCmd([command, ...args]);
    return spawn("cmd.exe", ["/d", "/s", "/c", cmdLine], {
      cwd: opts.cwd,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
  }
  return spawn(command, args, { cwd: opts.cwd }) as ChildProcessWithoutNullStreams;
}

export function spawnCommandSync(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; stdio?: "ignore" | "pipe" } = {}
) {
  if (process.platform === "win32") {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", quoteForCmd([command, ...args])], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      stdio: opts.stdio ?? "ignore",
      windowsHide: true,
    });
  }
  return spawnSync(command, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    stdio: opts.stdio ?? "ignore",
  });
}

/** PATH 上是否能找到某个命令。 */
export function isCommandAvailable(command: string): boolean {
  if (fs.existsSync(command)) return true;
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnCommandSync(probe, [command], { timeoutMs: 5000, stdio: "ignore" });
  return r.status === 0;
}

function quoteForCmd(parts: string[]): string {
  return parts.map(quoteOne).join(" ");
}

function quoteOne(s: string): string {
  // cmd.exe 的安全最小引用：双引号包裹，内部双引号转义。
  return `"${s.replace(/"/g, '\\"')}"`;
}
