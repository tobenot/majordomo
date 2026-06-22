import { EventEmitter } from "events";

/** 工作层向上抛出的结构化事件。 */
export type WorkerEvent =
  | { kind: "session_id"; id: string }
  | { kind: "text"; text: string }
  | { kind: "permission"; requestId: string; tool: string; detail: string; rawInput?: string }
  /** 一个回合结束（工作层把控制权交回） */
  | { kind: "done"; summary?: string }
  | { kind: "error"; message: string };

export interface WorkerStartOptions {
  /** 绑定的项目路径 */
  cwd: string;
  /** profile 命令，如 claude / claude-internal / tclaude */
  command: string;
  /** 权限模式 */
  permissionMode: string;
  /** 单回合最大 turn 数，传给 SDK */
  maxTurns?: number;
  /** 单回合超时，避免真实工作层卡死 */
  timeoutMs?: number;
  /** 允许/拒绝工具列表，遵循 Claude Code SDK 语义 */
  allowedTools?: string[];
  disallowedTools?: string[];
  /** 续接的底层 session_id（如果是 resume） */
  resumeId?: string;
}

/**
 * 工作层引擎接口。一个实例驱动一个连续会话。
 * 实现：MockWorker（回显）、SdkWorker（TS Agent SDK）。
 */
export abstract class WorkerEngine extends EventEmitter {
  abstract readonly engineName: string;
  protected workerSessionId?: string;

  constructor(protected opts: WorkerStartOptions) {
    super();
    this.workerSessionId = opts.resumeId;
  }

  get sessionId(): string | undefined {
    return this.workerSessionId;
  }

  /** 投递一轮用户输入，工作层开始干活。 */
  abstract send(text: string): Promise<void>;

  /** 回应一个权限请求。 */
  abstract resolvePermission(requestId: string, approve: boolean, updatedInput?: Record<string, unknown>): void;

  /** 打断当前正在执行的回合（graceful interrupt，wait for current response to settle）。 */
  abstract interrupt(): Promise<void>;

  /** 关闭会话，释放资源。 */
  abstract close(): Promise<void>;

  protected emitEvent(ev: WorkerEvent): void {
    this.emit("event", ev);
  }

  onEvent(cb: (ev: WorkerEvent) => void): void {
    this.on("event", cb);
  }
}
