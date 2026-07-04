/**
 * 增量 transcript JSONL 读取器。
 * 见 docs/design/session-metrics-v1.md §4。
 *
 * 职责：给定 transcriptPath + 上次读到的位置 → 读新增行 → 解析 assistant 消息 → 返回度量增量。
 * 纯 Node 实现，不引入新依赖。
 */

import * as fs from "fs";
import { AssistantEntry, aggregateMetrics, AggregationInput, SessionMetrics, MetricsCursor } from "./sessionMetrics";
import { createLogger } from "../core/logger";

const log = createLogger("hub:metrics");

// ── transcript 单行原始结构（CC transcript JSONL） ──
interface TranscriptRecord {
  type?: string;
  message?: {
    model?: string;
    stop_reason?: string | null;
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      output_tokens?: number;
    };
    content?: Array<{
      type?: string;
      name?: string;
      input?: Record<string, unknown>;
      tool_use_result?: unknown;
    }>;
  };
  tool_use_result?: {
    is_error?: boolean;
    stderr?: string;
  };
  system?: {
    turn_duration?: { durationMs?: number };
  };
  /** "ai-title" 类型的记录 */
  title?: string;
  /** 权限模式 */
  permission_mode?: string;
}

// ── 公开 API ─────────────────────────────────────────────────

export interface ReadIncrementalResult {
  /** 本次聚合出的度量（null = 无新数据） */
  metrics: SessionMetrics | null;
  /** 更新后的读取位置 */
  cursor: MetricsCursor;
}

/**
 * 从 transcript JSONL 增量读取新 assistant 消息，聚合成 SessionMetrics。
 *
 * @param path transcript JSONL 文件路径
 * @param cursor 上次读取位置（首次传 null）
 * @param prevMetrics 之前的累计度量（首次传 null）
 * @param windowMeta 窗口级辅助信息（ai-title / gitBranch / permissionMode）
 */
export function readIncremental(
  path: string,
  cursor: MetricsCursor | null,
  prevMetrics: SessionMetrics | null,
  windowMeta?: { aiTitle?: string; gitBranch?: string; permissionMode?: string },
): ReadIncrementalResult {
  const cur: MetricsCursor = cursor ?? { lastOffset: 0, accumulatedRounds: 0 };
  let fd: number | undefined;

  try {
    if (!fs.existsSync(path)) {
      log.debug(`transcript 不存在: ${path}`);
      return { metrics: null, cursor: cur };
    }

    const stat = fs.statSync(path);
    if (stat.size <= cur.lastOffset) {
      // 文件没变大（或者被 /clear 缩小了——新 session 已经换 windowId，不会走到这）
      return { metrics: null, cursor: cur };
    }

    // 从上次偏移读到文件尾
    fd = fs.openSync(path, "r");
    const buf = Buffer.alloc(stat.size - cur.lastOffset);
    fs.readSync(fd, buf, 0, buf.length, cur.lastOffset);

    const text = buf.toString("utf8");
    const lines = text.split("\n");

    const entries: AssistantEntry[] = [];
    let title = windowMeta?.aiTitle ?? "";
    let permMode = windowMeta?.permissionMode ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as TranscriptRecord;

        // 采集 ai-title（用户级元记录，不是 assistant 消息）
        if (rec.type === "ai-title" && rec.title) {
          title = rec.title;
        }

        // 只处理 assistant 类型的消息
        if (rec.type !== "assistant") continue;
        if (!rec.message?.usage) continue; // 没有 usage 的跳过（极少见，可能是思考中间态）

        const usage = rec.message.usage;
        const tools = extractToolNames(rec.message.content);
        const hasError = rec.message.content?.some(
          (c) => c.type === "tool_use_result" || !!(c.tool_use_result as { is_error?: boolean })?.is_error,
        ) ?? false;

        // 时间戳：优先 message 级别
        const ts = (rec as Record<string, unknown>).timestamp as string
          ?? (rec as Record<string, unknown>).ts as string
          ?? "";

        entries.push({
          ts,
          inputTokens: usage.input_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          stopReason: rec.message.stop_reason ?? "",
          toolNames: tools,
          hasToolError: hasError,
          model: rec.message.model ?? "",
        });

        if (rec.permission_mode && !permMode) permMode = rec.permission_mode;
      } catch {
        // 行解析失败：跳过（非 JSON 行、空行等）
      }
    }

    if (!entries.length) {
      // 文件变大了但没有新 assistant —— 更新偏移但不算度量
      return { metrics: null, cursor: { ...cur, lastOffset: stat.size } };
    }

    // 首条 assistant 的时间戳
    if (!cur.firstAssistantTs && entries.length > 0) {
      cur.firstAssistantTs = entries[0].ts;
    }

    const input: AggregationInput = {
      entries,
      prev: prevMetrics,
      windowMeta: {
        aiTitle: title || windowMeta?.aiTitle,
        gitBranch: windowMeta?.gitBranch,
        permissionMode: permMode || windowMeta?.permissionMode,
      },
    };

    const metrics = aggregateMetrics(input);

    return {
      metrics,
      cursor: {
        lastOffset: stat.size,
        accumulatedRounds: metrics.totalRounds,
        firstAssistantTs: cur.firstAssistantTs,
      },
    };
  } catch (e) {
    log.debug(`增量读 transcript 失败: ${(e as Error).message}`);
    return { metrics: null, cursor: cur };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

// ── helpers ──────────────────────────────────────────────────

function extractToolNames(content?: Array<{ type?: string; name?: string }>): string[] {
  if (!content) return [];
  return content
    .filter((c): c is { type: string; name: string } => c.type === "tool_use" && typeof c.name === "string")
    .map((c) => c.name);
}
