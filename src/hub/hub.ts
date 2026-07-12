import { WindowRegistry, TodoStore, AcceptanceStore } from "./stores";
import {
  IngestEnvelope,
  WindowState,
  HubSnapshot,
  WindowInfo,
  WindowUsage,
} from "./types";
import { PersonaEngine } from "../persona/types";
import { NotifierBus } from "../notify/factory";
import { ServerMessage } from "../protocol/messages";
import { createLogger } from "../core/logger";
import { readIncremental, ReadIncrementalResult, readLastAssistantText, looksCorruptText } from "./metricsReader";
import { MetricsCursor, SessionMetrics } from "./sessionMetrics";

const log = createLogger("hub");

/**
 * 中枢核心：接 Bifrost 上报 → 更新三张表 → 逐窗口 persona 复命 → 广播 + 推 Bark。
 *
 * 见 docs/design/bifrost-hub-v1.md §3。数据单向：窗口 → 中枢 → 你，中枢不驱动窗口。
 * v1 persona = 逐窗口人设层（把每个窗口本轮输出翻人话），不做跨窗口合成。
 */
export class HubService {
  readonly windows = new WindowRegistry();
  readonly todos = new TodoStore();
  readonly acceptance = new AcceptanceStore();

  /** 每窗口上次 persona 复命时间，用于节流（高频 Stop 不炸手机）。 */
  private lastPersonaAt = new Map<string, number>();

  /** 每窗口在 transcript 文件里的读取位置（增量读用的游标）。 */
  private metricsCursors = new Map<string, MetricsCursor>();

  constructor(
    private persona: PersonaEngine,
    private notifier: NotifierBus,
    private broadcast: (msg: ServerMessage) => void,
    private personaThrottleMs: number,
  ) {}

  snapshot(): HubSnapshot {
    return {
      windows: this.windows.list(),
      todos: this.todos.list(),
      acceptance: this.acceptance.list(),
    };
  }

  /** 处理一条上报。同步更新表 + 广播；persona 复命异步进行（不阻塞 /ingest 应答）。 */
  ingest(env: IngestEnvelope): void {
    if (!env || !env.windowId || !env.event) {
      log.warn("忽略无效上报（缺 windowId/event）");
      return;
    }
    const cwd = env.cwd ?? "";
    const p = env.payload ?? {};
    const stale = isStale(env.ts);

    switch (env.event) {
      case "session_start": {
        const w = this.windows.record({
          windowId: env.windowId, cwd, event: env.event,
          state: "idle", summary: `窗口上线 (${p.source ?? "startup"})`,
        });
        this.applyUsage(env.windowId, p.usage);
        this.pushWindow(this.windows.get(env.windowId) ?? w);
        break;
      }

      case "session_end": {
        const w = this.windows.record({
          windowId: env.windowId, cwd, event: env.event,
          state: "offline", summary: `窗口下线 (${p.reason ?? ""})`.trim(),
        });
        this.applyUsage(env.windowId, p.usage);
        this.pushWindow(this.windows.get(env.windowId) ?? w);
        this.broadcast({ type: "window_offline", windowId: env.windowId });
        break;
      }

      case "stop": {
        let text = (p.text ?? "").trim();
        // Cursor Win: stdin 中文常已损坏；transcript 盘上是真 UTF-8。空/乱码则改读文件。
        if (p.transcriptPath && looksCorruptText(text)) {
          const fromFile = readLastAssistantText(p.transcriptPath);
          if (fromFile) text = fromFile.trim();
        }
        const w = this.windows.record({
          windowId: env.windowId, cwd, event: env.event,
          state: "idle", summary: summarize(text) || "完成一个回合", lastText: text,
        });
        this.applyUsage(env.windowId, p.usage);
        this.pushWindow(this.windows.get(env.windowId) ?? w);
        // 增量读 transcript 获取会话度量（v1：只显示数值，不做判定）
        if (p.transcriptPath) {
          void this.updateMetrics(env.windowId, p.transcriptPath);
        }
        // 离线缓存排空的事件只录表、不翻人话（陈腐 > 5min 跳过 persona）
        if (text && !stale) void this.reportPersona(w, text);
        break;
      }

      case "notification": {
        const msg = (p.text ?? "").trim();
        const nType = p.notificationType ?? "";
        // idle_prompt = 窗口只是闲着等你输入，不是「待验收事项」，更不该炸手机。
        // 只有真正需你介入的（permission / 其它非 idle 通知）才进待验收 + 推 Bark。
        const isIdle = nType.includes("idle");
        const w = this.windows.record({
          windowId: env.windowId, cwd, event: env.event,
          state: "waiting", summary: msg || (isIdle ? "空闲等待输入" : "等待你介入"),
        });
        this.applyUsage(env.windowId, p.usage);
        this.pushWindow(this.windows.get(env.windowId) ?? w);
        if (isIdle) break;
        // 窗口等你 = 需你介入 → 记一条待验收（按窗口去重，反复通知不堆叠）。
        const isPermission = nType.includes("permission");
        const acc = this.acceptance.addUnique({
          windowId: env.windowId,
          what: `${w.title}: ${msg || "窗口等待你"}`,
          kind: isPermission ? "permission" : "review",
        });
        this.broadcast({ type: "acceptance", items: this.acceptance.list() });
        // 离线缓存排空的 notification 不推 Bark（陈腐 > 5min 跳过）
        if (!stale) {
          void this.notifier.notify(`${w.title} 需要你：${msg || "等待介入"}`);
        }
        log.debug(`待验收 +1: ${acc.what}`);
        break;
      }

      case "task_created": {
        const w = this.windows.record({
          windowId: env.windowId, cwd, event: env.event,
          state: "working", summary: `新任务：${p.taskSubject ?? p.taskDesc ?? p.taskId ?? "?"}`,
        });
        this.applyUsage(env.windowId, p.usage);
        this.pushWindow(this.windows.get(env.windowId) ?? w);
        // 确定性喂养 todolist，不烧 LLM。
        this.todos.add({
          text: p.taskSubject || p.taskDesc || `任务 ${p.taskId ?? ""}`.trim(),
          windowId: env.windowId,
          source: "task_hook",
          taskId: p.taskId,
        });
        this.broadcast({ type: "todos", todos: this.todos.list() });
        break;
      }

      case "task_completed": {
        const w = this.windows.record({
          windowId: env.windowId, cwd, event: env.event,
          state: "working", summary: `完成任务：${p.taskSubject ?? p.taskDesc ?? p.taskId ?? "?"}`,
        });
        this.applyUsage(env.windowId, p.usage);
        this.pushWindow(this.windows.get(env.windowId) ?? w);
        if (p.taskId) this.todos.completeByTaskId(p.taskId);
        this.broadcast({ type: "todos", todos: this.todos.list() });
        break;
      }

      case "user_prompt": {
        const userText = (p.text ?? "").trim();
        const w = this.windows.record({
          windowId: env.windowId, cwd, event: env.event,
          state: "working", summary: userText || "用户输入", lastUserText: userText,
        });
        this.applyUsage(env.windowId, p.usage);
        this.pushWindow(this.windows.get(env.windowId) ?? w);
        break;
      }

      default: {
        // 未知事件：仍登记，方便回归采样看新事件形状。
        const w = this.windows.record({
          windowId: env.windowId, cwd, event: env.event,
          state: this.windows.get(env.windowId)?.state ?? "idle",
          summary: `未知事件 ${env.event}`,
        });
        this.applyUsage(env.windowId, p.usage);
        this.pushWindow(this.windows.get(env.windowId) ?? w);
        log.debug(`收到未知事件 ${env.event}`);
      }
    }
  }

  /** payload.usage 有则覆盖挂到窗口（statusline 落盘 → report 透传）。 */
  private applyUsage(windowId: string, usage?: WindowUsage): void {
    if (!usage || typeof usage !== "object") return;
    this.windows.updateUsage(windowId, usage);
  }

  private pushWindow(w: WindowInfo): void {
    this.broadcast({ type: "window_update", window: w });
  }

  private async updateMetrics(windowId: string, transcriptPath: string): Promise<void> {
    const cursor = this.metricsCursors.get(windowId) ?? null;
    // ponytail: cursor=null 意味着 daemon 重启或首次读——从头扫整个 transcript。
    // 此时必须清 prev，否则 skipFirst 失效（prev truthy → 第一轮 100% miss 被计入），
    // 且旧轮次会被重复累加到累计值。游标和 prev 同生同灭。
    const prev = cursor ? (this.windows.get(windowId)?.metrics ?? null) : null;
    try {
      const result = readIncremental(transcriptPath, cursor, prev);
      this.metricsCursors.set(windowId, result.cursor);
      if (result.metrics) {
        const updated = this.windows.updateMetrics(windowId, result.metrics);
        if (updated) {
          this.pushWindow(updated);
          this.checkMetricsAlert(updated);
        }
      }
    } catch (e) {
      log.debug(`会话度量读取失败（窗口 ${windowId}）: ${(e as Error).message}`);
    }
  }

  /** 缓存 miss% 超过阈值时告警，回落时自动消警。用户手动消除后不再重复。 */
  private checkMetricsAlert(w: WindowInfo): void {
    const m = w.metrics;
    if (!m || m.totalRounds === 0) return;
    const pct = Math.round(m.missPercent * 100);
    if (m.missPercent > 0.5) {
      // 用户已手动消除过 → 不再重复告警
      if (this.acceptance.hasByWindowAndKind(w.windowId, "alert")) return;
      const acc = this.acceptance.addUnique({
        windowId: w.windowId,
        what: `${w.title} 缓存miss率 ${pct}% 超阈值50%（${m.totalRounds}轮）`,
        kind: "alert",
      });
      this.broadcast({ type: "acceptance", items: this.acceptance.list() });
      void this.notifier.notify(`⚠️ ${w.title} miss ${pct}%`);
      log.info(`告警: ${w.title} miss ${pct}% → acceptance ${acc.id}`);
    } else {
      const resolved = this.acceptance.resolveByWindowAndKind(w.windowId, "alert");
      if (resolved) {
        this.broadcast({ type: "acceptance", items: this.acceptance.list() });
        log.debug(`消警: ${w.title} miss ${pct}% ≤ 50%，自动解除`);
      }
    }
  }

  private async reportPersona(w: WindowInfo, workerText: string): Promise<void> {
    const now = Date.now();
    const last = this.lastPersonaAt.get(w.windowId) ?? 0;
    if (now - last < this.personaThrottleMs) {
      log.debug(`persona 节流跳过窗口 ${w.title}（距上次 ${now - last}ms）`);
      return;
    }
    this.lastPersonaAt.set(w.windowId, now);
    this.broadcast({ type: "window_persona_status", windowId: w.windowId, phase: "start" });
    log.info(`persona 调用中 [${w.title}]…`);
    try {
      const text = await this.persona.report({
        userText: "",
        workerText,
        sessionName: w.title,
      });
      this.windows.addPersona(w.windowId, text);
      this.broadcast({ type: "window_persona", windowId: w.windowId, text, personaMessages: w.personaMessages });
      void this.notifier.notify(`[${w.title}] ${text}`);
      // 链路诊断：确认 persona→notifier 真的走通（跑真窗口时看这行判断弹窗是否该弹）
      log.info(`persona 复命 → notifier [${w.title}]: ${summarize(text)}`);
    } catch (e) {
      log.warn(`persona 复命失败（窗口 ${w.title}）: ${(e as Error).message}`);
    } finally {
      this.broadcast({ type: "window_persona_status", windowId: w.windowId, phase: "done" });
    }
  }

  // ── 面板对三张表的操作 ──────────────────────────────────
  addTodo(text: string, windowId?: string): void {
    this.todos.add({ text, windowId, source: "manual" });
    this.broadcast({ type: "todos", todos: this.todos.list() });
  }

  setTodoStatus(id: string, status: "open" | "done"): void {
    this.todos.setStatus(id, status);
    this.broadcast({ type: "todos", todos: this.todos.list() });
  }

  removeTodo(id: string): void {
    this.todos.remove(id);
    this.broadcast({ type: "todos", todos: this.todos.list() });
  }

  resolveAcceptance(id: string): void {
    this.acceptance.resolve(id);
    this.broadcast({ type: "acceptance", items: this.acceptance.list() });
  }

  clearAllTodos(): void {
    this.todos.clearAll();
    this.broadcast({ type: "todos", todos: this.todos.list() });
  }

  clearAllAcceptance(): void {
    this.acceptance.clearAll();
    this.broadcast({ type: "acceptance", items: this.acceptance.list() });
  }
}

/** 摘一句话作活动流 summary。取首句 / 首行，截断。 */
function summarize(text: string): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.split(/[。.!?！？\n]/)[0] || flat;
  return cut.length > 80 ? cut.slice(0, 80) + "…" : cut;
}

/** 事件是否陈腐（离线缓存排空）。阈值 5 分钟——超过说明是积压回放，只录表不扰人。 */
const STALE_MS = 5 * 60 * 1000;
function isStale(ts?: number): boolean {
  if (!ts) return false;
  return Date.now() - ts > STALE_MS;
}
