import * as fs from "fs";
import { hubStorePath, ensureDir, globalDir } from "../core/paths";
import { createLogger } from "../core/logger";
import { WindowInfo, WindowState, WindowActivity, TodoItem, AcceptanceItem, IngestEvent } from "./types";
import { SessionMetrics } from "./sessionMetrics";

const log = createLogger("hub:store");

/** 单调递增的 id 后缀，进程内保证同一毫秒不撞。 */
let idSeq = 0;
function newId(prefix: string): string {
  idSeq = (idSeq + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${idSeq.toString(36)}`;
}

/** 极简 JSON 文件持久化基类：加载数组 → Map，写回整份。与 core/store.ts 同套路。 */
class JsonArrayStore<T> {
  protected map = new Map<string, T>();
  private file: string;

  constructor(name: "windows" | "todos" | "acceptance", private keyOf: (v: T) => string) {
    ensureDir(globalDir());
    this.file = hubStorePath(name);
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    try {
      const arr = JSON.parse(fs.readFileSync(this.file, "utf8")) as T[];
      for (const v of arr) this.map.set(this.keyOf(v), v);
    } catch (e) {
      log.warn(`${this.file} 读取失败: ${(e as Error).message}`);
    }
  }

  protected persist(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify([...this.map.values()], null, 2), "utf8");
    } catch (e) {
      log.warn(`${this.file} 写入失败: ${(e as Error).message}`);
    }
  }

  /** 加载后淘汰陈旧死数据（自愈：系统自己收敛状态，不无限增长）。删了才落库。 */
  protected prune(shouldRemove: (v: T) => boolean): void {
    let removed = 0;
    for (const [k, v] of this.map) {
      if (shouldRemove(v)) {
        this.map.delete(k);
        removed++;
      }
    }
    if (removed) {
      log.debug(`${this.file} 淘汰 ${removed} 条陈旧记录`);
      this.persist();
    }
  }

  all(): T[] {
    return [...this.map.values()];
  }
}

/** 陈旧记录淘汰阈值：死数据（offline 窗口 / done 待办 / resolved 验收）超此时长在加载时清理。 */
const PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

const ACTIVITY_KEEP = 30;
const PERSONA_KEEP = 50;

/** ① 每个窗口做了什么。state 由事件推导。 */
export class WindowRegistry extends JsonArrayStore<WindowInfo> {
  constructor() {
    super("windows", (w) => w.windowId);
    // offline 且超过阈值未更新的死窗口清掉。
    this.prune((w) => w.state === "offline" && Date.now() - w.updatedAt > PRUNE_MS);
  }

  get(windowId: string): WindowInfo | undefined {
    return this.map.get(windowId);
  }

  list(): WindowInfo[] {
    return this.all().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 记一条事件：确保窗口存在、推导状态、追加活动流、落库。返回更新后的窗口。 */
  record(opts: {
    windowId: string;
    cwd: string;
    event: IngestEvent;
    state: WindowState;
    summary: string;
    lastText?: string;
    lastUserText?: string;
  }): WindowInfo {
    const now = Date.now();
    let w = this.map.get(opts.windowId);
    if (!w) {
      w = {
        windowId: opts.windowId,
        cwd: opts.cwd,
        title: titleOf(opts.cwd, opts.windowId),
        state: opts.state,
        lastEvent: opts.event,
        lastText: opts.lastText ?? "",
        lastSummary: "",
        lastUserText: "",
        personaMessages: [],
        activity: [],
        onlineSince: now,
        updatedAt: now,
      };
      this.map.set(opts.windowId, w);
    }
    // 旧数据兼容：无 personaMessages / lastSummary / lastUserText 的窗口补齐
    if (!w.personaMessages) w.personaMessages = [];
    if (w.lastSummary === undefined) w.lastSummary = "";
    if (w.lastUserText === undefined) w.lastUserText = "";
    if (opts.cwd) {
      w.cwd = opts.cwd;
      w.title = titleOf(opts.cwd, opts.windowId);
    }
    w.state = opts.state;
    w.lastEvent = opts.event;
    if (opts.lastText !== undefined && opts.lastText !== "") w.lastText = opts.lastText;
    if (opts.lastUserText !== undefined && opts.lastUserText !== "") w.lastUserText = opts.lastUserText;
    // stop 事件的 summary 就是 worker 原文首句 → 列表预览用
    if (opts.summary) w.lastSummary = opts.summary;
    w.updatedAt = now;
    const act: WindowActivity = { ts: now, event: opts.event, summary: opts.summary };
    w.activity.push(act);
    if (w.activity.length > ACTIVITY_KEEP) w.activity.splice(0, w.activity.length - ACTIVITY_KEEP);
    this.persist();
    return w;
  }

  /** 更新窗口的会话度量（缓存率 + 画像）。v1 只覆盖，不累积——metricsReader 已在外部做好聚合。 */
  updateMetrics(windowId: string, metrics: SessionMetrics): WindowInfo | undefined {
    const w = this.map.get(windowId);
    if (!w) return undefined;
    w.metrics = metrics;
    w.updatedAt = Date.now();
    this.persist();
    return w;
  }

  addPersona(windowId: string, text: string): WindowInfo | undefined {
    const w = this.map.get(windowId);
    if (!w) return undefined;
    w.lastPersona = text;
    w.personaMessages.push({ ts: Date.now(), text });
    if (w.personaMessages.length > PERSONA_KEEP) w.personaMessages.splice(0, w.personaMessages.length - PERSONA_KEEP);
    w.updatedAt = Date.now();
    this.persist();
    return w;
  }
}

/** ② 全局待办。确定性路（task hook）为主，人话/手动为辅。 */
export class TodoStore extends JsonArrayStore<TodoItem> {
  constructor() {
    super("todos", (t) => t.id);
    // done 且勾销超过阈值的待办清掉；open 的永远留着。
    this.prune((t) => t.status === "done" && !!t.doneAt && Date.now() - t.doneAt > PRUNE_MS);
  }

  list(): TodoItem[] {
    return this.all().sort((a, b) => a.createdAt - b.createdAt);
  }

  add(opts: { text: string; windowId?: string; source: TodoItem["source"]; taskId?: string }): TodoItem {
    const item: TodoItem = {
      id: newId("todo"),
      text: opts.text,
      windowId: opts.windowId,
      status: "open",
      source: opts.source,
      taskId: opts.taskId,
      createdAt: Date.now(),
    };
    this.map.set(item.id, item);
    this.persist();
    return item;
  }

  /** 确定性勾销：按 CC task_id 找到对应 open 项，标记 done。 */
  completeByTaskId(taskId: string): TodoItem | undefined {
    for (const t of this.map.values()) {
      if (t.taskId === taskId && t.status === "open") {
        t.status = "done";
        t.doneAt = Date.now();
        this.persist();
        return t;
      }
    }
    return undefined;
  }

  setStatus(id: string, status: TodoItem["status"]): TodoItem | undefined {
    const t = this.map.get(id);
    if (!t) return undefined;
    t.status = status;
    t.doneAt = status === "done" ? Date.now() : undefined;
    this.persist();
    return t;
  }

  remove(id: string): boolean {
    const ok = this.map.delete(id);
    if (ok) this.persist();
    return ok;
  }

  clearAll(): void {
    this.map.clear();
    this.persist();
  }
}

/** ③ 待验收事项：要你 review / 拍板 / 处理权限的事。 */
export class AcceptanceStore extends JsonArrayStore<AcceptanceItem> {
  constructor() {
    super("acceptance", (a) => a.id);
    // resolved 且超过阈值的验收项清掉；pending 的永远留着。
    this.prune((a) => a.status === "resolved" && !!a.resolvedAt && Date.now() - a.resolvedAt > PRUNE_MS);
  }

  list(): AcceptanceItem[] {
    return this.all().sort((a, b) => b.createdAt - a.createdAt);
  }

  add(opts: { windowId?: string; what: string; kind: AcceptanceItem["kind"] }): AcceptanceItem {
    const item: AcceptanceItem = {
      id: newId("acc"),
      windowId: opts.windowId,
      what: opts.what,
      kind: opts.kind,
      status: "pending",
      createdAt: Date.now(),
    };
    this.map.set(item.id, item);
    this.persist();
    return item;
  }

  /**
   * 去重新增：同一窗口若已有 pending 项，就刷新它（what/kind/时间），不再堆一条。
   * 否则新增。防止一个窗口反复 notification 把待验收表刷屏。有 windowId 才去重。
   */
  addUnique(opts: { windowId?: string; what: string; kind: AcceptanceItem["kind"] }): AcceptanceItem {
    if (opts.windowId) {
      for (const a of this.map.values()) {
        if (a.windowId === opts.windowId && a.status === "pending") {
          a.what = opts.what;
          a.kind = opts.kind;
          a.createdAt = Date.now();
          this.persist();
          return a;
        }
      }
    }
    return this.add(opts);
  }

  /** 检查窗口+品类是否已有任何项（不论状态）。用户手动消除后不再重复告警。 */
  hasByWindowAndKind(windowId: string, kind: AcceptanceItem["kind"]): boolean {
    for (const a of this.map.values()) {
      if (a.windowId === windowId && a.kind === kind) return true;
    }
    return false;
  }

  /** 按窗口 + kind 找到 pending 项并标记 resolved。用于告警自愈：miss% 回落自动消警。 */
  resolveByWindowAndKind(windowId: string, kind: AcceptanceItem["kind"]): AcceptanceItem | undefined {
    for (const a of this.map.values()) {
      if (a.windowId === windowId && a.kind === kind && a.status === "pending") {
        a.status = "resolved";
        a.resolvedAt = Date.now();
        this.persist();
        return a;
      }
    }
    return undefined;
  }

  resolve(id: string): AcceptanceItem | undefined {
    const a = this.map.get(id);
    if (!a) return undefined;
    a.status = "resolved";
    a.resolvedAt = Date.now();
    this.persist();
    return a;
  }

  clearAll(): void {
    this.map.clear();
    this.persist();
  }
}

/** cwd 尾段 + windowId 短码作为窗口标题。同仓库多窗口靠后缀区分。 */
function titleOf(cwd: string, windowId: string): string {
  const base = (() => {
    if (!cwd) return "window";
    const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
    return parts[parts.length - 1] || cwd;
  })();
  const short = windowId.slice(0, 4);
  return `${base} (${short})`;
}
