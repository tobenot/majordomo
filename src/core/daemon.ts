import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { Config, resolveProfile, persistActiveProfile } from "./config";
import { Store } from "./store";
import { SessionManager } from "./sessionManager";
import { appendDiary } from "./diary";
import { createPersona } from "../persona/factory";
import { createNotifier, NotifierBus } from "../notify/factory";
import { resolveEngineName, EngineChoice } from "../worker/factory";
import { parseClientMessage, ServerMessage, ClientMessage } from "../protocol/messages";
import { createLogger } from "./logger";

const log = createLogger("daemon");

/**
 * 指挥官 core daemon：长驻进程，持有会话池 / 人设层 / 通知器 / 存储，
 * 对外暴露 WebSocket。TUI / Web / 未来远程都是它的客户端，看同一份状态。
 */
export class CoreDaemon {
  private store = new Store();
  private persona = createPersona(this.cfg.persona);
  private notifier: NotifierBus = createNotifier(this.cfg.notifiers);
  private mgr: SessionManager;
  private wss?: WebSocketServer;
  private clients = new Set<WebSocket>();
  private diaryDir: string;

  constructor(private cfg: Config, private projectRoot: string = process.cwd()) {
    this.diaryDir = path.resolve(projectRoot, cfg.diaryDir);
    this.mgr = new SessionManager(
      cfg,
      this.store,
      this.persona,
      (msg) => this.broadcast(msg),
      (sessionId, text) => this.onReport(sessionId, text)
    );
  }

  start(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: this.cfg.host, port: this.cfg.port });
      this.wss = wss;
      wss.on("connection", (ws) => this.onConnection(ws));
      wss.on("listening", () => {
        log.info(`core daemon 监听 ws://${this.cfg.host}:${this.cfg.port}`);
        resolve({ host: this.cfg.host, port: this.cfg.port });
      });
      wss.on("error", (e) => reject(e));
    });
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    log.debug(`客户端接入，当前 ${this.clients.size} 个`);
    ws.on("message", (data) => {
      const msg = parseClientMessage(data.toString());
      if (!msg) {
        this.sendTo(ws, { type: "error", message: "无法解析的消息" });
        return;
      }
      this.dispatch(ws, msg).catch((e) =>
        this.sendTo(ws, { type: "error", message: (e as Error).message })
      );
    });
    ws.on("close", () => {
      this.clients.delete(ws);
      log.debug(`客户端断开，剩余 ${this.clients.size} 个`);
    });
    ws.on("error", (e) => log.warn(`客户端错误: ${e.message}`));
  }

  private async dispatch(ws: WebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "hello": {
        const engine = resolveEngineName(
          this.cfg.worker.engine as EngineChoice,
          resolveProfile(this.cfg).profile.command
        );
        this.sendTo(ws, {
          type: "welcome",
          activeProfile: this.cfg.activeProfile,
          profiles: Object.keys(this.cfg.profiles),
          engine,
          personaName: this.cfg.persona.name,
        });
        this.sendTo(ws, { type: "sessions", sessions: this.mgr.list() });
        break;
      }

      case "create_session": {
        const info = this.mgr.create({ name: msg.name, cwd: msg.cwd, profile: msg.profile });
        this.broadcast({ type: "session_created", session: info });
        break;
      }

      case "resume_session": {
        const info = this.mgr.resume(msg.sessionId);
        if (!info) {
          this.sendTo(ws, { type: "error", message: `会话不存在: ${msg.sessionId}` });
          return;
        }
        this.sendTo(ws, { type: "session_created", session: info });
        this.sendTo(ws, { type: "history", sessionId: info.id, entries: this.mgr.history(info.id) });
        break;
      }

      case "close_session":
        await this.mgr.close(msg.sessionId);
        this.broadcast({ type: "session_closed", sessionId: msg.sessionId });
        break;

      case "list_sessions":
        this.sendTo(ws, { type: "sessions", sessions: this.mgr.list() });
        break;

      case "get_history":
        this.sendTo(ws, {
          type: "history",
          sessionId: msg.sessionId,
          entries: this.mgr.history(msg.sessionId),
        });
        break;

      case "user_input": {
        const session = this.mgr.ensureLive(msg.sessionId);
        if (!session) {
          this.sendTo(ws, { type: "error", message: `会话不存在: ${msg.sessionId}` });
          return;
        }
        await session.input(msg.text);
        break;
      }

      case "slash": {
        // 透传斜杠命令给工作层（如 /compact /model）。当前作为普通输入投递。
        const session = this.mgr.ensureLive(msg.sessionId);
        if (!session) {
          this.sendTo(ws, { type: "error", message: `会话不存在: ${msg.sessionId}` });
          return;
        }
        const text = msg.args ? `/${msg.command} ${msg.args}` : `/${msg.command}`;
        await session.input(text);
        break;
      }

      case "switch_profile": {
        if (!this.cfg.profiles[msg.profile]) {
          this.sendTo(ws, { type: "error", message: `未知 profile: ${msg.profile}` });
          return;
        }
        this.cfg.activeProfile = msg.profile;
        this.mgr.setActiveProfile(msg.profile);
        try {
          persistActiveProfile(msg.profile);
        } catch (e) {
          log.warn(`持久化 profile 失败: ${(e as Error).message}`);
        }
        this.broadcast({ type: "profile_switched", profile: msg.profile });
        break;
      }

      case "permission_response": {
        const session = this.mgr.get(msg.sessionId);
        if (session) session.resolvePermission(msg.requestId, msg.approve, msg.updatedInput);
        break;
      }
    }
  }

  /** 人设层完成一轮汇报 → 触发通知 + 增量日记。 */
  private onReport(sessionId: string, text: string): void {
    try {
      this.notifier.notify(text);
    } catch (e) {
      log.warn(`通知失败: ${(e as Error).message}`);
    }
    try {
      const oneLine = text.replace(/\s+/g, " ").slice(0, 200);
      appendDiary(this.diaryDir, `[${sessionId}] ${oneLine}`);
    } catch (e) {
      log.warn(`写日记失败: ${(e as Error).message}`);
    }
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  async stop(): Promise<void> {
    await this.mgr.shutdown();
    this.wss?.close();
  }
}
