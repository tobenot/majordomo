import * as fs from "fs";
import { hubStorePath, ensureDir, globalDir } from "../core/paths";
import { createLogger } from "../core/logger";
import { WindowInfo, WindowState, WindowActivity, TodoItem, AcceptanceItem, IngestEvent } from "./types";

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

  all(): T[] {
    return [...this.map.values()];
  }
}

const ACTIVITY_KEEP = 30;

/** ① 每个窗口做了什么。state 由事件推导。 */
export class WindowRegistry extends JsonArrayStore<WindowInfo> {
  constructor() {
    super("windows", (w) => w.windowId);
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
  }): WindowInfo {
    const now = Date.now();
    let w = this.map.get(opts.windowId);
    if (!w) {
      w = {
        windowId: opts.windowId,
        cwd: opts.cwd,
        title: titleOf(opts.cwd),
        state: opts.state,
        lastEvent: opts.event,
        lastText: opts.lastText ?? "",
        activity: [],
        onlineSince: now,
        updatedAt: now,
      };
      this.map.set(opts.windowId, w);
    }
    if (opts.cwd) {
      w.cwd = opts.cwd;
      w.title = titleOf(opts.cwd);
    }
    w.state = opts.state;
    w.lastEvent = opts.event;
    if (opts.lastText !== undefined && opts.lastText !== "") w.lastText = opts.lastText;
    w.updatedAt = now;
    const act: WindowActivity = { ts: now, event: opts.event, summary: opts.summary };
    w.activity.push(act);
    if (w.activity.length > ACTIVITY_KEEP) w.activity.splice(0, w.activity.length - ACTIVITY_KEEP);
    this.persist();
    return w;
  }

  setPersona(windowId: string, text: string): WindowInfo | undefined {
    const w = this.map.get(windowId);
    if (!w) return undefined;
    w.lastPersona = text;
    w.updatedAt = Date.now();
    this.persist();
    return w;
  }
}

/** ② 全局待办。确定性路（task hook）为主，人话/手动为辅。 */
export class TodoStore extends JsonArrayStore<TodoItem> {
  constructor() {
    super("todos", (t) => t.id);
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
}

/** ③ 待验收事项：要你 review / 拍板 / 处理权限的事。 */
export class AcceptanceStore extends JsonArrayStore<AcceptanceItem> {
  constructor() {
    super("acceptance", (a) => a.id);
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

  resolve(id: string): AcceptanceItem | undefined {
    const a = this.map.get(id);
    if (!a) return undefined;
    a.status = "resolved";
    a.resolvedAt = Date.now();
    this.persist();
    return a;
  }
}

/** cwd 尾段作为窗口标题。见设计稿 §8 拍板 2。 */
function titleOf(cwd: string): string {
  if (!cwd) return "window";
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}
