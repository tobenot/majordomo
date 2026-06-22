import type {
  CanUseTool,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import * as path from "path";
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

    // 注入项目行为规则（.majordomo/rules.md），走 systemPrompt.append 而非修改 CLAUDE.md
    const rulesPath = path.join(this.opts.cwd, ".majordomo", "rules.md");
    if (fs.existsSync(rulesPath)) {
      const rules = fs.readFileSync(rulesPath, "utf8").trim();
      if (rules) {
        options.systemPrompt = {
          type: "preset",
          preset: "claude_code",
          append: `\n\n---\n## Project Rules (from .majordomo/rules.md)\n${rules}`,
        };
        log.debug(`注入项目行为规则: ${rulesPath} (${rules.length} 字符)`);
      }
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

  // ponytail: handle all SDK message types via any-typed accessor (union is too sprawling)
  private handleSdkMessage(obj: SDKMessage): void {
    if (!obj || typeof obj !== "object") return;
    const o = obj as any;
    const sessionId = o.session_id;
    if (sessionId && sessionId !== this.workerSessionId) {
      this.workerSessionId = sessionId;
      this.emitEvent({ kind: "session_id", id: sessionId });
    }

    switch (o.type) {
      case "system":
        this.handleSystemMessage(o);
        break;
      case "assistant":
        this.emitAssistantContent(o.message?.content ?? []);
        break;
      case "result":
        if (o.subtype !== "success") {
          this.emitEvent({ kind: "error", message: `SDK result ${o.subtype}` });
        } else if (o.result?.trim() && !this.turnHadText) {
          this.emitText(o.result);
        }
        this.finishTurn();
        break;
      case "tool_use_summary":
        this.emitText(`[工具摘要] ${o.summary}`);
        break;
      case "auth_status":
        if (o.output?.length) this.emitText(`[认证] ${o.output.join("\n")}`);
        if (o.error) this.emitEvent({ kind: "error", message: o.error });
        break;
      case "tool_progress":
        this.emitText(`[工具进度] ${o.tool_name} ${o.elapsed_time_seconds?.toFixed(1) ?? "?"}s`);
        break;
      case "rate_limit_event":
        if (o.rate_limit_info?.status) this.emitText(`[速率限制] ${o.rate_limit_info.status}`);
        break;
      case "prompt_suggestion":
        if (o.suggestion) this.emitText(`[建议] ${o.suggestion}`);
        break;
      case "user":
        if (o.message?.content) {
          if (typeof o.message.content === "string") {
            this.emitText(`[已发送] ${o.message.content}`);
          } else if (Array.isArray(o.message.content)) {
            for (const block of o.message.content) {
              if (block.type === "text" && block.text) this.emitText(`[用户] ${block.text}`);
            }
          }
        }
        break;
      default:
        log.debug(`未处理的 SDK 消息类型: ${o.type}`);
        break;
    }
  }

  // ponytail: handle all system subtypes in one switch
  private handleSystemMessage(o: any): void {
    switch (o.subtype) {
      case "init":
        log.debug(`SDK init session=${o.session_id ?? "?"}`);
        break;
      case "compact_boundary":
        this.emitText(
          `[上下文压缩] ${o.compact_metadata.trigger} compact: ${o.compact_metadata.pre_tokens} → ${o.compact_metadata.post_tokens ?? "?"} tokens`
        );
        break;
      case "permission_denied":
        this.emitText(`[权限拒绝] ${o.tool_name}: ${o.message}`);
        break;
      case "notification":
        this.emitText(`[通知] ${o.text}`);
        break;
      case "status":
        if (o.status) this.emitText(`[状态] ${o.status}`);
        break;
      case "informational":
        this.emitText(`[${o.level ?? "info"}] ${o.content}`);
        break;
      case "model_refusal_fallback":
        this.emitText(`[模型回退] ${o.trigger}: ${o.original_model} → ${o.fallback_model}`);
        break;
      case "task_notification": {
        const usage = o.usage
          ? ` (${o.usage.total_tokens}t ${o.usage.tool_uses}工具 ${o.usage.duration_ms}ms)`
          : "";
        const statusLabel =
          o.status === "completed" ? "完成" : o.status === "failed" ? "失败" : "停止";
        this.emitText(`[任务${statusLabel}] ${o.summary}${usage}`);
        break;
      }
      case "task_started":
        this.emitText(`[任务开始] ${o.description}`);
        break;
      case "task_progress": {
        const u = o.usage;
        const usage = u ? ` ${u.total_tokens}t ${u.tool_uses}工具 ${Math.round(u.duration_ms / 1000)}s` : "";
        this.emitText(`[任务进度] ${o.description}${usage}`);
        break;
      }
      case "task_updated":
        this.emitText(`[任务更新] ${o.patch?.status}: ${o.patch?.description ?? ""}`);
        break;
      case "thinking_tokens":
        if (o.estimated_tokens) this.emitText(`[思考] ~${o.estimated_tokens} tokens`);
        break;
      case "worker_shutting_down":
        if (o.reason) this.emitText(`[关闭] ${o.reason}`);
        break;
      case "memory_recall":
        this.emitText(`[记忆] ${o.mode}: ${o.memories?.length ?? 0} 条`);
        break;
      case "files_persisted": {
        const ok = o.files?.length ?? 0;
        const fail = o.failed?.length ?? 0;
        if (ok || fail) this.emitText(`[文件持久化] ${ok} ok${fail ? `, ${fail} 失败` : ""}`);
        break;
      }
      case "hook_started":
        this.emitText(`[钩子] ${o.hook_name} (${o.hook_event}) 开始`);
        break;
      case "hook_progress":
      case "hook_response": {
        const out = typeof o.output === "string" ? `: ${o.output.slice(0, 100)}` : "";
        const label = o.subtype === "hook_response" ? (o.outcome ?? "done") : "...";
        this.emitText(`[钩子] ${o.hook_name} ${label}${out}`);
        break;
      }
      case "plugin_install":
        if (o.status) this.emitText(`[插件] ${o.status}: ${o.name ?? "?"}`);
        break;
      case "api_retry":
        this.emitText(`[API重试] ${o.attempt}/${o.max_retries} (${o.retry_delay_ms ?? "?"}ms)`);
        break;
      case "local_command_output":
        if (o.content) this.emitText(o.content.slice(0, 200));
        break;
      case "mirror_error":
        if (o.error) this.emitText(`[转录错误] ${o.error}`);
        break;
      case "elicitation_complete":
        if (o.mcp_server_name) this.emitText(`[引导完成] ${o.mcp_server_name}`);
        break;
      case "session_state_changed":
        if (o.state) this.emitText(`[会话状态] ${o.state}`);
        break;
      case "commands_changed":
        // silent - internal command registry updates
        break;
      default:
        log.debug(`未处理的 system subtype: ${o.subtype}`);
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
