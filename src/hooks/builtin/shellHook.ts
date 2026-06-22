import { execFile } from "child_process";
import { Hook, HookContext } from "../types";
import { createLogger } from "../../core/logger";

const log = createLogger("hook:shell");

/**
 * Runs an arbitrary shell command on hook events.
 * Injects MJ_* env vars so scripts can access session context.
 * Timeout default 30s; failures logged, never propagated.
 */
export class ShellHook implements Hook {
  readonly name: string;

  constructor(private config: {
    command: string;
    cwd: string;
    shell?: string;
    timeoutMs?: number;
  }) {
    this.name = `shell:${config.command.slice(0, 40)}`;
  }

  async run(context: HookContext): Promise<void> {
    const shell = this.config.shell ?? (process.platform === "win32" ? "cmd" : "sh");
    const shellArgs = process.platform === "win32"
      ? ["/c", this.config.command]
      : ["-c", this.config.command];

    const env = {
      ...process.env,
      MJ_SESSION_ID: context.sessionId,
      MJ_SESSION_NAME: context.sessionName,
      MJ_CWD: context.cwd,
      MJ_PROFILE: context.profile,
      MJ_TEXT: context.text,
      MJ_EVENT_TYPE: context.eventType,
    };

    await new Promise<void>((resolve) => {
      const timeout = this.config.timeoutMs ?? 30000;
      const timer = setTimeout(() => {
        child.kill();
        log.warn(`Shell hook "${this.name}" 超时 (${timeout}ms)`);
        resolve();
      }, timeout);

      const child = execFile(shell, shellArgs, {
        cwd: this.config.cwd,
        env,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        clearTimeout(timer);
        if (err) {
          log.warn(`Shell hook "${this.name}" 退出码 ${err.code}: ${(stderr ?? err.message).slice(0, 200)}`);
        } else if (stdout?.trim()) {
          log.debug(`Shell hook stdout: ${stdout.trim().slice(0, 200)}`);
        }
        resolve();
      });
    });
  }
}
