import type {
  CanUseTool,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "crypto";
import { WorkerEngine } from "./types";
import { createLogger } from "../core/logger";
import { resolveCommandPath } from "./commandUtils";

const log = createLogger("worker:sdk");

type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query;

/**
 * Claude Agent SDK 工作层。
 *
 * 正式路径使用 streaming input：每个 SdkWorker 持有一个活着的 query()，
 * 多轮输入通过 AsyncIterable 队列送入同一底层 session。`--resume` 只作为崩溃恢复兜底。
 */
export class SdkWorker extends WorkerEngine {
  readonly engineName = "sdk";
  private input?: SdkInputQueue;
  private query?: Query;
  private abort?: AbortController;
  private closed = false;
  private currentTurn?: PendingTurn;
  private pendingPermissions = new Map<string, (result: PermissionReply) => void>();
  private turnHadText = false;

  async send(text: string): Promise<void> {
    if (this.currentTurn) {
      this.emitEvent({ kind: "error", message: "上一个 SDK 回合尚未结束" });
      return;
    }

    await this.startIfNeeded();

    return new Promise<void>((resolve) => {
      const turn: PendingTurn = { resolve };
      if (this.opts.timeoutMs && this.opts.timeoutMs > 0) {
        turn.timer = setTimeout(() => {
          this.emitEvent({ kind: "error", message: `SDK 工作层超时（${this.opts.timeoutMs}ms），已中断本轮` });
          void this.query?.interrupt().catch((e) => log.warn(`SDK interrupt 失败: ${(e as Error).message}`));
          this.finishTurn();
        }, this.opts.timeoutMs);
      }
      this.currentTurn = turn;
      this.turnHadText = false;
      this.input!.push(toUserMessage(text));
    });
  }

  resolvePermission(requestId: string, approve: boolean, updatedInput?: Record<string, unknown>): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) return;
    this.pendingPermissions.delete(requestId);
    resolve({ approve, updatedInput });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.input?.close();
    this.query?.close();
    this.abort?.abort();
    for (const [id, resolve] of this.pendingPermissions) {
      this.pendingPermissions.delete(id);
      resolve({ approve: false });
    }
    this.finishTurn(false);
  }

  private async startIfNeeded(): Promise<void> {
    if (this.query) return;

    const query = await loadQuery();
    this.input = new SdkInputQueue();
    this.abort = new AbortController();
    this.query = query({ prompt: this.input, options: this.buildOptions() });
    void this.pump(this.query);
  }

  private buildOptions(): Options {
    const options: Options = {
      cwd: this.opts.cwd,
      permissionMode: mapPermissionMode(this.opts.permissionMode),
      canUseTool: this.canUseTool,
      abortController: this.abort,
      settingSources: ["user", "project", "local"],
    };
    if (this.opts.maxTurns) options.maxTurns = this.opts.maxTurns;
    if (this.opts.allowedTools?.length) options.allowedTools = this.opts.allowedTools;
    if (this.opts.disallowedTools?.length) options.disallowedTools = this.opts.disallowedTools;
    if (this.workerSessionId) options.resume = this.workerSessionId;

    const executable = resolveCommandPath(this.opts.command);
    // ponytail: only pass native binaries to SDK (.cmd/.bat are wrappers)
    if (executable && !/\.(cmd|bat)$/i.test(executable)) {
      options.pathToClaudeCodeExecutable = executable;
    }

    return options;
  }

  private readonly canUseTool: CanUseTool = async (toolName, input, options): Promise<PermissionResult> => {
    const requestId = options.toolUseID || randomUUID();
    const detail = formatPermissionDetail(toolName, input, options);
    const rawInput = toolName === "AskUserQuestion" ? safeJson(input) : undefined;
    this.emitEvent({ kind: "permission", requestId, tool: toolName, detail, rawInput });

    const result = await waitForPermission(this.pendingPermissions, requestId, options.signal);
    if (result.approve) {
      return { behavior: "allow", updatedInput: result.updatedInput ?? input };
    }
    return {
      behavior: "deny",
      message: `User denied permission to use ${toolName}.`,
      toolUseID: options.toolUseID,
    };
  };

  private async pump(query: Query): Promise<void> {
    try {
      for await (const msg of query) {
        this.handleSdkMessage(msg);
      }
      if (!this.closed) {
        this.emitEvent({ kind: "error", message: "SDK 工作层会话已结束" });
      }
    } catch (e) {
      if (!this.closed) {
        this.emitEvent({ kind: "error", message: `SDK 工作层失败: ${(e as Error).message}` });
      }
    } finally {
      this.query = undefined;
      this.input?.close();
      this.input = undefined;
      this.abort = undefined;
      this.finishTurn();
    }
  }

  private handleSdkMessage(obj: SDKMessage): void {
    if (!obj || typeof obj !== "object") return;
    const sessionId = (obj as { session_id?: string }).session_id;
    if (sessionId && sessionId !== this.workerSessionId) {
      this.workerSessionId = sessionId;
      this.emitEvent({ kind: "session_id", id: sessionId });
    }

    switch (obj.type) {
      case "system":
        this.handleSystemMessage(obj);
        break;
      case "assistant":
        this.emitAssistantContent(obj.message?.content ?? []);
        break;
      case "result":
        if (obj.subtype !== "success") {
          this.emitEvent({ kind: "error", message: `SDK result ${obj.subtype}` });
        } else if (obj.result?.trim() && !this.turnHadText) {
          this.emitText(obj.result);
        }
        this.finishTurn();
        break;
      case "tool_use_summary":
        this.emitText(`[工具摘要] ${obj.summary}`);
        break;
      case "auth_status":
        if (obj.output.length) this.emitText(`[认证] ${obj.output.join("\n")}`);
        if (obj.error) this.emitEvent({ kind: "error", message: obj.error });
        break;
      default:
        break;
    }
  }

  private handleSystemMessage(obj: Extract<SDKMessage, { type: "system" }>): void {
    switch (obj.subtype) {
      case "init":
        log.debug(`SDK init session=${obj.session_id ?? "?"}`);
        break;
      case "compact_boundary":
        this.emitText(
          `[上下文压缩] ${obj.compact_metadata.trigger} compact: ${obj.compact_metadata.pre_tokens} → ${obj.compact_metadata.post_tokens ?? "?"} tokens`
        );
        break;
      case "permission_denied":
        this.emitText(`[权限拒绝] ${obj.tool_name}: ${obj.message}`);
        break;
      case "notification":
        this.emitText(`[通知] ${obj.text}`);
        break;
      default:
        break;
    }
  }

  private emitAssistantContent(content: any[]): void {
    for (const block of content) {
      if (block?.type === "text" && block.text) {
        this.emitText(block.text);
      } else if (block?.type === "tool_use") {
        const name = block.name ?? "?";
        const summary = toolSummary(name, block.input);
        this.emitText(`[${name}] ${summary}`);
      }
    }
  }

  private emitText(text: string): void {
    this.turnHadText = true;
    this.emitEvent({ kind: "text", text });
  }

  private finishTurn(emitDone = true): void {
    const turn = this.currentTurn;
    if (!turn) return;
    if (turn.timer) clearTimeout(turn.timer);
    this.currentTurn = undefined;
    if (emitDone) this.emitEvent({ kind: "done" });
    turn.resolve();
  }
}

class SdkInputQueue implements AsyncIterable<SDKUserMessage>, AsyncIterator<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private isClosed = false;

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return this;
  }

  next(): Promise<IteratorResult<SDKUserMessage>> {
    const item = this.items.shift();
    if (item) return Promise.resolve({ value: item, done: false });
    if (this.isClosed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  push(item: SDKUserMessage): void {
    if (this.isClosed) throw new Error("SDK input queue is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }
}

interface PendingTurn {
  resolve: () => void;
  timer?: NodeJS.Timeout;
}

function toUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    origin: { kind: "human" },
    shouldQuery: true,
  };
}

interface PermissionReply {
  approve: boolean;
  updatedInput?: Record<string, unknown>;
}

async function waitForPermission(
  pending: Map<string, (result: PermissionReply) => void>,
  requestId: string,
  signal: AbortSignal
): Promise<PermissionReply> {
  const denied: PermissionReply = { approve: false };
  if (signal.aborted) return denied;
  return new Promise<PermissionReply>((resolve) => {
    const done = (result: PermissionReply) => {
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => {
      pending.delete(requestId);
      done(denied);
    };
    pending.set(requestId, done);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function formatPermissionDetail(toolName: string, input: Record<string, unknown>, options: Parameters<CanUseTool>[2]): string {
  const lines = [options.title, options.description, options.decisionReason]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (lines.length) return lines.join("\n");
  return `${toolName}: ${safeJson(input)}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 800);
  } catch {
    return String(value).slice(0, 800);
  }
}

/** ponytail: extract the most useful field from a tool_use input for display. */
function toolSummary(name: string, input: Record<string, unknown>): string {
  const FIELDS: Record<string, string> = {
    Bash: "command", Read: "file_path", Write: "file_path", Edit: "file_path",
    Grep: "pattern", Glob: "pattern", WebFetch: "url", WebSearch: "query",
  };
  const key = FIELDS[name];
  if (key && typeof input[key] === "string") {
    // ponytail: trim long commands/paths to ~100 chars
    const v = input[key] as string;
    return v.length > 100 ? v.slice(0, 97) + "..." : v;
  }
  if (name === "AskUserQuestion" && Array.isArray(input.questions) && input.questions.length > 0) {
    const q = input.questions[0] as Record<string, unknown>;
    return `Q: ${typeof q.question === "string" ? (q.question as string).slice(0, 80) : "?"}`;
  }
  return safeJson(input);
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
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string
  ) => Promise<typeof import("@anthropic-ai/claude-agent-sdk")>;
  const mod = await dynamicImport("@anthropic-ai/claude-agent-sdk");
  if (typeof mod.query !== "function") {
    throw new Error("@anthropic-ai/claude-agent-sdk 未导出 query()；请检查版本");
  }
  return mod.query as QueryFn;
}

function mapPermissionMode(mode: string): PermissionMode {
  switch (mode) {
    case "default":
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
    case "dontAsk":
    case "auto":
      return mode;
    default:
      return "auto";
  }
}
