import { WorkerEngine } from "./types";
import { createLogger } from "../core/logger";

const log = createLogger("worker:sdk");

type QueryFn = (args: any) => AsyncIterable<any>;

/**
 * Claude Code TypeScript SDK 工作层（可选）。
 *
 * 网络调研结论：当前公开文档的 TypeScript SDK 包是 `@anthropic-ai/claude-code`，
 * 主 API 是 `query()` async iterator；没有稳定公开的 `ClaudeSDKClient/canUseTool`。
 * 因此这里做"可用则用"的防御式接入，不把该包作为硬依赖。
 */
export class SdkWorker extends WorkerEngine {
  readonly engineName = "sdk";
  private abort?: AbortController;
  private running = false;

  async send(text: string): Promise<void> {
    if (this.running) {
      this.emitEvent({ kind: "error", message: "上一个 SDK 回合尚未结束" });
      return;
    }
    this.running = true;
    this.abort = new AbortController();

    try {
      const query = await loadQuery();
      const options: any = {
        permissionMode: mapPermissionMode(this.opts.permissionMode),
      };
      if (this.opts.maxTurns) options.maxTurns = this.opts.maxTurns;
      if (this.opts.allowedTools?.length) options.allowedTools = this.opts.allowedTools;
      if (this.opts.disallowedTools?.length) options.disallowedTools = this.opts.disallowedTools;
      if (this.workerSessionId) options.resume = this.workerSessionId;

      const timer = this.opts.timeoutMs
        ? setTimeout(() => this.abort?.abort(), this.opts.timeoutMs)
        : undefined;

      for await (const msg of query({
        prompt: text,
        cwd: this.opts.cwd,
        abortController: this.abort,
        options,
      })) {
        this.handleSdkMessage(msg);
      }

      if (timer) clearTimeout(timer);
    } catch (e) {
      this.emitEvent({ kind: "error", message: `SDK 工作层失败: ${(e as Error).message}` });
    } finally {
      this.running = false;
      this.abort = undefined;
      this.emitEvent({ kind: "done" });
    }
  }

  resolvePermission(_requestId: string, _approve: boolean): void {
    // 公开 TS SDK 文档没有 canUseTool；真实交互权限后续走 MCP permission-prompt-tool。
  }

  async close(): Promise<void> {
    this.abort?.abort();
  }

  private handleSdkMessage(obj: any): void {
    if (!obj || typeof obj !== "object") return;
    if (obj.session_id && obj.session_id !== this.workerSessionId) {
      this.workerSessionId = obj.session_id;
      this.emitEvent({ kind: "session_id", id: obj.session_id });
    }
    switch (obj.type) {
      case "system":
        if (obj.subtype === "init") {
          log.debug(`SDK init model=${obj.model ?? "?"} permission=${obj.permissionMode ?? "?"}`);
        }
        break;
      case "assistant":
        emitAssistantContent(this, obj.message?.content ?? []);
        break;
      case "result":
        if (obj.subtype && obj.subtype !== "success") {
          this.emitEvent({ kind: "error", message: `SDK result ${obj.subtype}` });
        }
        if (typeof obj.result === "string" && obj.result.trim()) {
          this.emitEvent({ kind: "text", text: obj.result });
        }
        break;
      default:
        break;
    }
  }
}

export async function isSdkAvailable(): Promise<boolean> {
  try {
    await loadQuery();
    return true;
  } catch {
    return false;
  }
}

async function loadQuery(): Promise<QueryFn> {
  const mod = await import("@anthropic-ai/claude-code");
  if (typeof (mod as any).query !== "function") {
    throw new Error("@anthropic-ai/claude-code 未导出 query()；请检查版本");
  }
  return (mod as any).query as QueryFn;
}

function emitAssistantContent(worker: WorkerEngine, content: any[]): void {
  for (const block of content) {
    if (block?.type === "text" && block.text) {
      (worker as any).emitEvent({ kind: "text", text: block.text });
    } else if (block?.type === "tool_use") {
      (worker as any).emitEvent({ kind: "text", text: `[工具调用] ${block.name ?? "?"}` });
    }
  }
}

function mapPermissionMode(mode: string): string {
  return mode === "auto" ? "acceptEdits" : mode;
}
