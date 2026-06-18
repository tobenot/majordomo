import { spawn, spawnSync, ChildProcessWithoutNullStreams } from "child_process";
import { WorkerEngine, WorkerStartOptions } from "./types";
import { createLogger } from "../core/logger";

const log = createLogger("worker:claude");

/**
 * 真实 Claude Code 工作层。
 *
 * 实现取舍（见 docs/design/main-mind.md 的"连续 session"讨论）：
 * - 用 `--resume <session_id>` 保持连续性，而不是依赖不可靠的 `--continue`。
 *   每个回合 spawn 一个新进程，带上次捕获的 session_id 续接。
 * - prompt 走 stdin（`-p` 不带参数时从 stdin 读），彻底避免把用户文本拼进命令行
 *   带来的注入/转义问题（Windows 上尤其重要）。
 * - 输出用 `--output-format stream-json --verbose`，逐行解析结构化事件。
 *
 * 已知限制：headless 一次性回合 + acceptEdits 下不会产生交互式权限请求；
 * 真正的 canUseTool 双向确认需要 SDK 的 stream-json 输入通道，留待后续接入。
 * 这是当前唯一未做的能力，已在验收文档标注。
 */
export class ClaudeCodeWorker extends WorkerEngine {
  readonly engineName = "claude";
  private child?: ChildProcessWithoutNullStreams;

  async send(text: string): Promise<void> {
    if (this.child) {
      this.emitEvent({ kind: "error", message: "上一个回合尚未结束" });
      return;
    }

    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    const mode = mapPermissionMode(this.opts.permissionMode);
    if (mode) args.push("--permission-mode", mode);
    if (this.workerSessionId) args.push("--resume", this.workerSessionId);

    log.debug(`spawn ${this.opts.command} ${args.join(" ")} (cwd=${this.opts.cwd})`);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.opts.command, args, {
        cwd: this.opts.cwd,
        shell: process.platform === "win32",
      });
    } catch (e) {
      this.emitEvent({ kind: "error", message: `无法启动工作层: ${(e as Error).message}` });
      return;
    }
    this.child = child;

    // prompt 走 stdin，避免命令行注入
    child.stdin.write(text);
    child.stdin.end();

    let buf = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      buf += d;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) this.handleLine(line);
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
      if (buf.trim()) this.handleLine(buf.trim());
      if (code !== 0 && code !== null) {
        const msg = stderr.trim() || `工作层退出码 ${code}`;
        this.emitEvent({ kind: "error", message: msg });
      }
      this.emitEvent({ kind: "done" });
    });
  }

  private handleLine(line: string): void {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      // 非 JSON 行（可能是普通日志），当作文本透出
      this.emitEvent({ kind: "text", text: line });
      return;
    }

    switch (obj.type) {
      case "system":
        if (obj.session_id && obj.session_id !== this.workerSessionId) {
          this.workerSessionId = obj.session_id;
          this.emitEvent({ kind: "session_id", id: obj.session_id });
        }
        break;
      case "assistant": {
        const content = obj.message?.content ?? [];
        for (const block of content) {
          if (block.type === "text" && block.text) {
            this.emitEvent({ kind: "text", text: block.text });
          } else if (block.type === "tool_use") {
            this.emitEvent({ kind: "text", text: `[工具调用] ${block.name ?? "?"}` });
          }
        }
        break;
      }
      case "result":
        if (obj.session_id) this.workerSessionId = obj.session_id;
        // done 在 close 时统一发，这里仅记录 summary 由后续封装；避免重复
        if (typeof obj.result === "string" && obj.result.trim()) {
          this.emitEvent({ kind: "text", text: obj.result });
        }
        break;
      default:
        break;
    }
  }

  resolvePermission(_requestId: string, _approve: boolean): void {
    // headless 一次性回合下不产生交互式权限请求，见类注释。
  }

  async close(): Promise<void> {
    if (this.child) {
      this.child.kill();
      this.child = undefined;
    }
  }
}

function mapPermissionMode(mode: string): string | null {
  switch (mode) {
    case "auto":
      return "acceptEdits";
    case "default":
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
      return mode;
    default:
      return "acceptEdits";
  }
}

/** 探测某个命令是否可用（PATH 上能跑 --version）。 */
export function isCommandAvailable(command: string): boolean {
  try {
    const r = spawnSync(command, ["--version"], {
      shell: process.platform === "win32",
      timeout: 5000,
      stdio: "ignore",
    });
    return r.status === 0 || r.status === null ? r.error === undefined : false;
  } catch {
    return false;
  }
}
