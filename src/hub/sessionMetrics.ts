/**
 * 会话度量数据模型与聚合逻辑。
 * 见 docs/design/session-metrics-v1.md §1 / §4。
 *
 * 纯函数，无副作用 — 方便单测。
 */

// ── 从 transcript JSONL 解析出的单条 assistant 记录 ──
export interface AssistantEntry {
  /** 时间戳（ISO 字符串），从 record 顶层或 message 内取 */
  ts: string;
  /** message.usage.input_tokens */
  inputTokens: number;
  /** message.usage.cache_read_input_tokens */
  cacheReadTokens: number;
  /** message.usage.cache_creation_input_tokens（deepseek 恒为 0） */
  cacheCreationTokens: number;
  /** message.usage.output_tokens */
  outputTokens: number;
  /** message.stop_reason: "end_turn" | "tool_use" | ... */
  stopReason: string;
  /** tool_use 名字列表（message.content 里 type=tool_use 的 name） */
  toolNames: string[];
  /** 是否有工具报错（tool_use_result.is_error） */
  hasToolError: boolean;
  /** message.model */
  model: string;
}

// ── 会话度量 ──
export interface SessionMetrics {
  // 缓存健康
  /** 累计加权 miss% = 1 - totalCacheReadTokens/(totalInputTokens+totalCacheReadTokens) */
  missPercent: number;
  /** 最近一段 Stop 的 miss% */
  lastSegmentMissPercent: number;
  /** 本段塌方峰值：段内最大单轮 input_tokens */
  maxSingleRoundInput: number;
  /** 累计产出 token */
  cumulativeOutputTokens: number;

  // 规模
  /** 总 assistant 轮数 */
  totalRounds: number;
  /** 会话时长 ms（首末轮时间戳差） */
  sessionDurationMs: number;

  // 时序
  /** 每轮耗时的中位（ms） */
  latencyMedianMs: number;
  /** 每轮耗时的 p90（ms） */
  latencyP90Ms: number;
  /** 每轮耗时的 max（ms） — 塌方伴随信号 */
  latencyMaxMs: number;

  // 会话画像
  /** 最新 ai-title */
  aiTitle: string;
  /** 工具用量 top-5：[name, count] */
  topTools: [string, number][];
  /** git 分支 */
  gitBranch: string;
  /** 权限模式（如 bypassPermissions） */
  permissionMode: string;

  // 健康
  /** tool_use / 总 stop_reason 比 */
  toolUseRatio: number;
  /** 最长单 turn 耗时 ms */
  maxTurnDurationMs: number;
  /** 工具报错次数 */
  toolErrorCount: number;

  // 内部累计（保证 cumMiss 精确，不用 avgInput 近似）
  /** 累计 input tokens（不含首轮） */
  totalInputTokens: number;
  /** 累计 cache_read tokens（不含首轮） */
  totalCacheReadTokens: number;
}

/** 每个窗口在 transcript 文件里的读取位置 */
export interface MetricsCursor {
  /** 文件字节偏移 */
  lastOffset: number;
  /** 累计已处理的 assistant 条数 */
  accumulatedRounds: number;
  /** 首条 assistant 的时间戳（用于会话时长） */
  firstAssistantTs?: string;
}

export const EMPTY_METRICS: SessionMetrics = {
  missPercent: 0,
  lastSegmentMissPercent: 0,
  maxSingleRoundInput: 0,
  cumulativeOutputTokens: 0,
  totalRounds: 0,
  sessionDurationMs: 0,
  latencyMedianMs: 0,
  latencyP90Ms: 0,
  latencyMaxMs: 0,
  aiTitle: "",
  topTools: [],
  gitBranch: "",
  permissionMode: "",
  toolUseRatio: 0,
  maxTurnDurationMs: 0,
  toolErrorCount: 0,
  totalInputTokens: 0,
  totalCacheReadTokens: 0,
};

// ── 聚合 ────────────────────────────────────────────────────

export interface AggregationInput {
  /** 本段新增的 assistant 条目 */
  entries: AssistantEntry[];
  /** 之前的累计度量（首次为 null） */
  prev?: SessionMetrics | null;
  /** 窗口级辅助信息（从上报拿到） */
  windowMeta?: {
    aiTitle?: string;
    gitBranch?: string;
    permissionMode?: string;
  };
}

/**
 * 把本段新增条目和之前的累计合并成新的 SessionMetrics。
 * 纯函数，不碰文件系统。
 */
export function aggregateMetrics(input: AggregationInput): SessionMetrics {
  const { entries, prev, windowMeta } = input;
  if (!entries.length) {
    if (prev) return { ...prev };
    return { ...EMPTY_METRICS };
  }

  // 本段统计
  let segInput = 0;
  let segCacheRead = 0;
  let segOutput = 0;
  let segToolUse = 0;
  let segEndTurn = 0;
  let segMaxInput = 0;
  let segErrors = 0;
  const toolHisto = new Map<string, number>();
  const latencies: number[] = [];
  let prevTs: number | null = null;
  let segFirstTs: number | null = null;
  let segLastTs: number | null = null;
  let maxTurnMs = 0;

  for (const e of entries) {
    const ts = Date.parse(e.ts);
    if (!isNaN(ts)) {
      if (segFirstTs === null) segFirstTs = ts;
      segLastTs = ts;
      if (prevTs !== null) {
        const lat = ts - prevTs;
        if (lat > 0) latencies.push(lat);
        if (lat > maxTurnMs) maxTurnMs = lat;
      }
      prevTs = ts;
    }

    segInput += e.inputTokens;
    segCacheRead += e.cacheReadTokens;
    segOutput += e.outputTokens;
    if (e.inputTokens > segMaxInput) segMaxInput = e.inputTokens;

    if (e.stopReason === "tool_use") segToolUse++;
    else if (e.stopReason === "end_turn") segEndTurn++;

    for (const name of e.toolNames) {
      toolHisto.set(name, (toolHisto.get(name) ?? 0) + 1);
    }
    if (e.hasToolError) segErrors++;
  }

  // 本段 miss%（首轮必 miss，不计入——不然每个会话开头都拉高误报）
  // ponytail: transcript 里 input_tokens 不含 cache_read，总 token = input + cache_read
  const skipFirst = !prev && entries.length > 0;
  const firstRound = skipFirst ? entries[0] : null;
  const missInput = segInput - (firstRound ? firstRound.inputTokens : 0);
  const missCache = segCacheRead - (firstRound ? firstRound.cacheReadTokens : 0);
  const segTotal = missInput + missCache;
  const segMiss = segTotal > 0 ? 1 - missCache / segTotal : 0;

  // 累计 miss%（精确：直接用存储的累计值，不再用 maxSingleRoundInput 近似）
  const prevRounds = prev?.totalRounds ?? 0;
  const newRounds = prevRounds + entries.length;
  const cumInput = (prev?.totalInputTokens ?? 0) + missInput;
  const cumCache = (prev?.totalCacheReadTokens ?? 0) + missCache;
  const cumAllTokens = cumInput + cumCache;
  const cumMiss = cumAllTokens > 0 ? 1 - cumCache / cumAllTokens : 0;

  // 累计 output
  const cumOutput = (prev?.cumulativeOutputTokens ?? 0) + segOutput;

  // 工具直方图合并
  if (prev?.topTools) {
    for (const [name, count] of prev.topTools) {
      toolHisto.set(name, (toolHisto.get(name) ?? 0) + count);
    }
  }
  const topTools: [string, number][] = [...toolHisto.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // 每轮耗时：把旧的也合进来算。ponytail: 只保留旧的中位/p90/max + 本轮 new latencies，近似合并不精确但不影响观感。
  const allLatencies = [...latencies];
  if (prev && prev.latencyMaxMs > 0) {
    // 无法精确还原旧序列，用旧值加权近似。足够展示趋势。
  }
  const { med, p90, max } = latStats(latencies, prev);

  // 会话时长
  const durationMs = segFirstTs && segLastTs
    ? segLastTs - segFirstTs + (prev?.sessionDurationMs ?? 0)
    : (prev?.sessionDurationMs ?? 0);

  // tool_use ratio
  const totalReasons = segToolUse + segEndTurn;
  const cumToolUse = (prev?.toolUseRatio ?? 0) * (prev?.totalRounds ?? 0) + segToolUse;
  const cumTotal = (prev?.totalRounds ?? 0) + Math.max(totalReasons, 1);
  const toolRatio = cumTotal > 0 ? cumToolUse / cumTotal : 0;

  return {
    missPercent: round4(cumMiss),
    lastSegmentMissPercent: round4(segMiss),
    maxSingleRoundInput: Math.max(prev?.maxSingleRoundInput ?? 0, segMaxInput),
    cumulativeOutputTokens: cumOutput,
    totalRounds: newRounds,
    sessionDurationMs: durationMs,
    latencyMedianMs: med,
    latencyP90Ms: p90,
    latencyMaxMs: Math.max(prev?.latencyMaxMs ?? 0, max),
    aiTitle: windowMeta?.aiTitle ?? prev?.aiTitle ?? "",
    topTools,
    gitBranch: windowMeta?.gitBranch ?? prev?.gitBranch ?? "",
    permissionMode: windowMeta?.permissionMode ?? prev?.permissionMode ?? "",
    toolUseRatio: round4(toolRatio),
    maxTurnDurationMs: Math.max(prev?.maxTurnDurationMs ?? 0, maxTurnMs),
    toolErrorCount: (prev?.toolErrorCount ?? 0) + segErrors,
    totalInputTokens: cumInput,
    totalCacheReadTokens: cumCache,
  };
}

// ── helpers ──────────────────────────────────────────────────

function latStats(latencies: number[], prev?: SessionMetrics | null) {
  // ponytail: 从旧值无法还原完整序列，把旧的中位/p90/max 当作单点并入排序。足够。
  const all = [...latencies];
  if (prev && prev.latencyMaxMs > 0) {
    all.push(prev.latencyMedianMs);
    all.push(prev.latencyP90Ms);
    all.push(prev.latencyMaxMs);
  }
  if (!all.length) return { med: 0, p90: 0, max: 0 };
  all.sort((a, b) => a - b);
  return {
    med: all[Math.floor(all.length / 2)],
    p90: all[Math.floor(all.length * 0.9)],
    max: all[all.length - 1],
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
