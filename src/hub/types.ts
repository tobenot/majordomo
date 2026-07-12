/**
 * 中枢（Hub）数据模型。见 docs/design/bifrost-hub-v1.md §2.5 / §3.2。
 *
 * 数据单向：窗口 → Bifrost → 中枢 → 你。中枢只旁观，不驱动窗口。
 * 三张表（WindowRegistry / TodoStore / AcceptanceStore）是 v1 的核心状态。
 */

import type { SessionMetrics } from "./sessionMetrics";
export type { SessionMetrics } from "./sessionMetrics";

/** Bifrost 上报事件的归一形状（report.ps1 POST 的 body，见设计稿 §2.5）。 */
export interface IngestEnvelope {
  /** 窗口主键 = CC 的 session_id */
  windowId: string;
  event: IngestEvent;
  /** 项目路径，报菜名用 */
  cwd?: string;
  ts?: number;
  payload?: IngestPayload;
}

export type IngestEvent =
  | "session_start"
  | "session_end"
  | "stop"
  | "notification"
  | "task_created"
  | "task_completed"
  | "user_prompt"
  | string; // 未知事件容错前向

export interface IngestPayload {
  /** Stop 直取 last_assistant_message / Notification 的 message */
  text?: string;
  taskId?: string;
  taskSubject?: string;
  taskDesc?: string;
  taskStatus?: string;
  source?: string; // startup | resume | clear
  reason?: string; // prompt_input_exit | clear | ...
  notificationType?: string; // permission_prompt | idle_prompt | ...
  /** transcript 文件路径（CC hook 的 transcript_path，透传），供中枢增量读 usage。 */
  transcriptPath?: string;
  /** statusline 落盘的上下文/token 快照（见 bifrost-usage-v1.md）。 */
  usage?: WindowUsage;
}

/** 上下文占用 + token 用量（statusline → report → 中枢）。与 SessionMetrics（miss%）分立。 */
export interface WindowUsage {
  usedPercent?: number;
  windowSize?: number;
  lastInputTokens?: number;
  lastOutputTokens?: number;
  lastCacheReadTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  updatedAt: number;
}

// ── ① WindowRegistry ────────────────────────────────────────
export type WindowState = "working" | "waiting" | "idle" | "offline";

export interface WindowActivity {
  ts: number;
  event: IngestEvent;
  summary: string;
}

/** 一条人设复命。 */
export interface PersonaMessage {
  ts: number;
  text: string;
}

export interface WindowInfo {
  windowId: string;
  cwd: string;
  /** cwd 尾段自动命名（v1 不手动起名，重名只影响显示） */
  title: string;
  state: WindowState;
  lastEvent: IngestEvent;
  /** 最近一次 assistant 文本摘要 */
  lastText: string;
  /** 最近一次人设复命（人话）——便利字段，取 personaMessages 最后一条 */
  lastPersona?: string;
  /** 人设复命历史，环形缓冲。列表预览用 lastSummary，详情面板渲染这个数组。 */
  personaMessages: PersonaMessage[];
  /** worker stop 事件的原文摘要（summarize 首句），列表预览用。 */
  lastSummary: string;
  /** 用户最近一次发送的消息（截断），列表预览优先显示。 */
  lastUserText: string;
  /** 事件流环形缓冲，保留最近 N 条 */
  activity: WindowActivity[];
  onlineSince: number;
  updatedAt: number;
  /** 会话度量（缓存率 + 画像），v1 只显示原始数值，不做判定。 */
  metrics?: SessionMetrics;
  /** 上下文 / token（statusline 上报；Cursor 主看这个，CC 与 miss% 并存）。 */
  usage?: WindowUsage;
}

// ── ② TodoStore ─────────────────────────────────────────────
export type TodoStatus = "open" | "done";
export type TodoSource = "task_hook" | "persona" | "manual";

export interface TodoItem {
  id: string;
  text: string;
  /** 来自哪个窗口，可空（手动 / 跨窗口） */
  windowId?: string;
  status: TodoStatus;
  source: TodoSource;
  /** task_hook 来源时记住 CC 的 task_id，用于确定性勾销 */
  taskId?: string;
  createdAt: number;
  doneAt?: number;
}

// ── ③ AcceptanceStore ───────────────────────────────────────
export type AcceptanceKind = "permission" | "review" | "decision" | "alert";
export type AcceptanceStatus = "pending" | "resolved";

export interface AcceptanceItem {
  id: string;
  windowId?: string;
  what: string;
  kind: AcceptanceKind;
  status: AcceptanceStatus;
  createdAt: number;
  resolvedAt?: number;
}

/** 中枢整体状态快照，一次性推给新接入的前端。 */
export interface HubSnapshot {
  windows: WindowInfo[];
  todos: TodoItem[];
  acceptance: AcceptanceItem[];
}
