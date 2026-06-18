import { randomUUID } from "crypto";
import { Session } from "./session";
import { Store } from "./store";
import { Config, resolveProfile } from "./config";
import { PersonaEngine } from "../persona/types";
import { createWorker, EngineChoice } from "../worker/factory";
import { SessionInfo, ServerMessage } from "../protocol/messages";
import { createLogger } from "./logger";

const log = createLogger("session-mgr");

/**
 * 会话池管理器：创建 / 续接 / 列出 / 关闭会话。
 * 这是指挥官"管理多个并发 session"的核心，也是 /resume 报菜名的数据源。
 */
export class SessionManager {
  private live = new Map<string, Session>();

  constructor(
    private cfg: Config,
    private store: Store,
    private persona: PersonaEngine,
    /** 任意会话产生消息时的广播回调 */
    private onMessage: (msg: ServerMessage) => void,
    /** 人设层完成一轮汇报时的回调（用于通知 + 日记） */
    private onReport: (sessionId: string, text: string) => void
  ) {}

  private attach(session: Session): Session {
    session.on("message", (msg: ServerMessage) => {
      this.onMessage(msg);
      if (msg.type === "persona_message") this.onReport(msg.sessionId, msg.text);
    });
    this.live.set(session.info.id, session);
    return session;
  }

  /** 当前活跃的 profile（用于切换；不影响已开会话）。 */
  setActiveProfile(profile: string): void {
    this.cfg.activeProfile = profile;
  }

  create(opts: { name?: string; cwd?: string; profile?: string }): SessionInfo {
    const id = randomUUID().slice(0, 8);
    const { name: profName, profile } = resolveProfile(this.cfg, opts.profile);
    const cwd = opts.cwd || process.cwd();
    const choice = this.cfg.worker.engine as EngineChoice;

    const worker = createWorker(choice, {
      cwd,
      command: profile.command,
      permissionMode: this.cfg.permissionMode,
      maxTurns: this.cfg.worker.maxTurns,
      timeoutMs: this.cfg.worker.timeoutMs,
      allowedTools: this.cfg.worker.allowedTools,
      disallowedTools: this.cfg.worker.disallowedTools,
    });

    const info: SessionInfo = {
      id,
      name: opts.name || `会话-${id}`,
      cwd,
      profile: profName,
      engine: worker.engineName,
      state: "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.upsert(info);

    const session = new Session(info, worker, this.persona, this.store);
    this.attach(session);
    log.info(`创建会话 ${id} (${info.name}) profile=${profName} engine=${worker.engineName}`);
    return info;
  }

  /** 续接一个历史会话：用存下的 workerSessionId + 原 profile 重建 worker。 */
  resume(sessionId: string): SessionInfo | null {
    if (this.live.has(sessionId)) return this.live.get(sessionId)!.info;

    const info = this.store.get(sessionId);
    if (!info) return null;

    const { profile } = resolveProfile(this.cfg, info.profile);
    const choice = this.cfg.worker.engine as EngineChoice;
    const worker = createWorker(choice, {
      cwd: info.cwd,
      command: profile.command,
      permissionMode: this.cfg.permissionMode,
      maxTurns: this.cfg.worker.maxTurns,
      timeoutMs: this.cfg.worker.timeoutMs,
      allowedTools: this.cfg.worker.allowedTools,
      disallowedTools: this.cfg.worker.disallowedTools,
      resumeId: info.workerSessionId,
    });

    info.engine = worker.engineName;
    info.state = "idle";
    this.store.upsert(info);

    const session = new Session(info, worker, this.persona, this.store);
    this.attach(session);
    log.info(`续接会话 ${sessionId} (${info.name}) workerSessionId=${info.workerSessionId ?? "新"}`);
    return info;
  }

  get(sessionId: string): Session | undefined {
    return this.live.get(sessionId);
  }

  /** 自动确保会话在内存里活着（list 来自 store，可能未加载）。 */
  ensureLive(sessionId: string): Session | null {
    if (this.live.has(sessionId)) return this.live.get(sessionId)!;
    return this.resume(sessionId) ? this.live.get(sessionId)! : null;
  }

  list(): SessionInfo[] {
    return this.store.list();
  }

  history(sessionId: string) {
    return this.store.readHistory(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const s = this.live.get(sessionId);
    if (s) {
      await s.close();
      this.live.delete(sessionId);
    }
  }

  async shutdown(): Promise<void> {
    for (const s of this.live.values()) {
      await s.close().catch(() => undefined);
    }
    this.live.clear();
  }
}
