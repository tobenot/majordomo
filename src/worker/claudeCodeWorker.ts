import { ChildProcessWithoutNullStreams } from "child_process";
import { WorkerEngine, WorkerStartOptions } from "./types";
import { createLogger } from "../core/logger";
import { isCommandAvailable, spawnCommand, spawnCommandSync } from "./commandUtils";

const log = createLogger("worker:cli");

/**
 * 真实 Claude Code CLI 工作层。
 *
 * 网络调研后校正：公开资料确认 CLI 支持 `--output-format stream-json`、
 * `--input-format stream-json`、`--permission-mode`、`--resume <session_id>`，
 * 且 TypeScript SDK 的公开主 API 是 query()，并没有稳定公开的 ClaudeSDKClient/canUseTool。
 * 因此本 CLI Worker 作为稳定 fallback：prompt 走 stdin，输出逐行解析 stream-json。
 */
export class ClaudeCodeWorker extends WorkerEngine {
  readonly engineName = "cli";
  private child?: ChildProcessWithoutNullStreams;
  private timer?: NodeJS.Timeout;

  async send(text: string): Promise<void> {
    if (this.child) {
      this.emitEvent({ kind: "error", message: "上一个回合尚未结束" });
      return;
    }

    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    const mode = mapPermissionMode(this.opts.permissionMode);
    if (mode) args.push("--permission-mode", mode);
    if (this.opts.maxTurns) args.push("--max-turns", String(this.opts.maxTurns));
    if (this.opts.allowedTools?.length) args.push("--allowedTools", this.opts.allowedTools.join(","));
    if (this.opts.disallowedTools?.length)
      args.push("--disallowedTools", this.opts.disallowedTools.join(","));
    if (this.workerSessionId) args.push("--resume", this.workerSessionId);

    log.debug(`spawn ${this.opts.command} ${args.join(" ")} (cwd=${this.opts.cwd})`);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnCommand(this.opts.command, args, { cwd: this.opts.cwd });
    } catch (e) {
      this.emitEvent({ kind: "error", message: `无法启动工作层: ${(e as Error).message}` });
      return;
    }
    this.child = child;

    if (this.opts.timeoutMs && this.opts.timeoutMs > 0) {
      this.timer = setTimeout(() => {
        this.emitEvent({ kind: "error", message: `工作层超时（${this.opts.timeoutMs}ms），已终止` });
        this.child?.kill();
      }, this.opts.timeoutMs);
    }

    child.stdin.write(text);
    child.stdin.end();

    let buf = "";
    let stderr = "";
    let sawResult = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      buf += d;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) {
          const r = this.handleLine(line);
          if (r === "result") sawResult = true;
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });

    child.on("error", (e) => {
      this.emitEvent({ kind: "error", message: `工作层进程错误: ${e.message}` });
    });

    child.on("close", (code) => {
      this.child = undefined;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      if (buf.trim()) {
        const r = this.handleLine(buf.trim());
        if (r === "result") sawResult = true;
      }
      if (code !== 0 && code !== null) {
        const msg = compactStderr(stderr) || `工作层退出码 ${code}`;
        this.emitEvent({ kind: "error", message: msg });
      } else if (!sawResult && stderr.trim()) {
        log.debug(`工作层 stderr: ${compactStderr(stderr)}`);
      }
      this.emitEvent({ kind: "done" });
    });
  }

  private handleLine(line: string): "result" | "other" {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      this.emitEvent({ kind: "text", text: line });
      return "other";
    }

    if (obj.session_id && obj.session_id !== this.workerSessionId) {
      this.workerSessionId = obj.session_id;
      this.emitEvent({ kind: "session_id", id: obj.session_id });
    }

    switch (obj.type) {
      case "system":
        if (obj.subtype === "init") {
          log.debug(`CLI init model=${obj.model ?? "?"} permission=${obj.permissionMode ?? "?"}`);
        }
        return "other";

      case "assistant":
        this.emitAssistantContent(obj.message?.content ?? []);
        return "other";

      case "result":
        if (obj.subtype && obj.subtype !== "success") {
          this.emitEvent({ kind: "error", message: `CLI result ${obj.subtype}` });
        }
        if (typeof obj.result === "string" && obj.result.trim()) {
          this.emitEvent({ kind: "text", text: obj.result });
        }
        return "result";

      default:
        return "other";
    }
  }

  private emitAssistantContent(content: any[]): void {
    for (const block of content) {
      if (block?.type === "text" && block.text) {
        this.emitEvent({ kind: "text", text: block.text });
      } else if (block?.type === "tool_use") {
        this.emitEvent({ kind: "text", text: `[工具调用] ${block.name ?? "?"}` });
      }
    }
  }

  resolvePermission(_requestId: string, _approve: boolean): void {
    // CLI 一次性回合下不产生 UI 交互式权限；后续通过 MCP permission-prompt-tool 桥接。
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.child) {
      this.child.kill();
      this.child = undefined;
    }
  }
}

function mapPermissionMode(mode: string): string | null {
  switch (mode) {
    case "auto":
      // MCP permission bridge 尚未接入前，auto 采用更保守的 default，而不是 acceptEdits。
      return "default";
    case "default":
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
      return mode;
    default:
      return "acceptEdits";
  }
}

function compactStderr(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 600);
}

/** 探测某个命令是否可用（PATH 上能找到，且 --version 不崩）。 */
export { isCommandAvailable };

export function getCommandVersion(command: string): string | null {
  if (!isCommandAvailable(command)) return null;
  const r = spawnCommandSync(command, ["--version"], { timeoutMs: 5000, stdio: "pipe" });
  const out = Buffer.concat([
    r.stdout ? Buffer.from(r.stdout as any) : Buffer.alloc(0),
    r.stderr ? Buffer.from(r.stderr as any) : Buffer.alloc(0),
  ])
    .toString("utf8")
    .trim();
  return out.split("\n")[0] || "available";
}
