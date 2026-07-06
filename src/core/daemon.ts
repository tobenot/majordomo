import * as path from "path";
import * as http from "http";
import * as fs from "fs";
import * as cp from "child_process";
import { WebSocketServer, WebSocket } from "ws";
import { Config, resolveProfile, persistActiveProfile } from "./config";
import { Store } from "./store";
import { SessionManager } from "./sessionManager";
import { createPersona } from "../persona/factory";
import { createNotifier, NotifierBus } from "../notify/factory";
import { resolveEngineName, EngineChoice } from "../worker/factory";
import { parseClientMessage, ServerMessage, ClientMessage } from "../protocol/messages";
import { HookRunner } from "../hooks/hookRunner";
import { createHookFactory } from "../hooks/factory";
import { HubService } from "../hub/hub";
import { IngestEnvelope } from "../hub/types";
import { resolvePublicDir, browserWsUrlFor, readAsset } from "../web/staticAssets";
import { popupSuppressPath } from "./paths";
import { createLogger } from "./logger";

const log = createLogger("daemon");

/**
 * 指挥官 core daemon：长驻进程，持有会话池 / 人设层 / 通知器 / 存储 / 中枢，
 * 对外暴露 WebSocket + HTTP（/ingest 接 Bifrost 上报）。
 * TUI / Web / 未来远程都是它的客户端，看同一份状态。
 */
export class CoreDaemon {
  private store = new Store();
  private persona = createPersona(this.cfg.persona);
  private notifier: NotifierBus = createNotifier(this.cfg.notifiers, this.cfg.bark);
  private hooks!: HookRunner;
  private mgr!: SessionManager;
  private hub!: HubService;
  private httpServer?: http.Server;
  private wss?: WebSocketServer;
  private clients = new Set<WebSocket>();
  private diaryDir: string;
  /** 浮窗页从 daemon 自身端口直供，连同源 WS。仅这几个白名单路径，防目录穿越。 */
  private static readonly POPUP_ASSETS = new Set(["/popup", "/popup.html", "/popup.js", "/popup.css", "/markdown.js"]);
  private popupPublicDir = resolvePublicDir();

  constructor(private cfg: Config, private projectRoot: string = process.cwd()) {
    this.diaryDir = path.resolve(projectRoot, cfg.diaryDir);
    this.hooks = new HookRunner(
      cfg.hooks,
      createHookFactory({
        diaryDir: this.diaryDir,
        notifier: this.notifier,
        projectRoot: this.projectRoot,
      }),
    );
    this.mgr = new SessionManager(
      cfg,
      this.store,
      this.persona,
      (msg) => this.broadcast(msg),
      this.hooks,
    );
    this.hub = new HubService(
      this.persona,
      this.notifier,
      (msg) => this.broadcast(msg),
      cfg.hub.personaThrottleMs,
    );
  }

  start(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const httpServer = http.createServer((req, res) => this.onHttp(req, res));
      this.httpServer = httpServer;
      // WebSocket 与 HTTP 共用同一端口：Bifrost 走 POST /ingest，前端走 WS upgrade。
      const wss = new WebSocketServer({ server: httpServer });
      this.wss = wss;
      wss.on("connection", (ws) => this.onConnection(ws));
      httpServer.on("error", (e) => reject(e));
      httpServer.listen(this.cfg.port, this.cfg.host, () => {
        log.info(`core daemon 监听 http+ws://${this.cfg.host}:${this.cfg.port}（上报入口 ${this.cfg.hub.ingestPath}）`);
        resolve({ host: this.cfg.host, port: this.cfg.port });
      });
    });
  }

  /** HTTP 分流：POST /ingest 收 Bifrost 上报；/healthz /readyz 健康检查。其余交给 WS upgrade。 */
  private onHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const urlPath = (req.url || "/").split("?")[0];

    if (urlPath === "/healthz" || urlPath === "/readyz") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, clients: this.clients.size, windows: this.hub.windows.list().length }));
      return;
    }

    // 浮窗页：daemon 自身端口直供，页面连同源 WS（就是这个端口）。白名单外一律 404。
    if (req.method === "GET" && CoreDaemon.POPUP_ASSETS.has(urlPath)) {
      const file = urlPath === "/popup" ? "/popup.html" : urlPath;
      const wsUrl = browserWsUrlFor(this.cfg.host, this.cfg.port);
      const asset = readAsset(this.popupPublicDir, file, wsUrl);
      if (asset) {
        res.writeHead(200, { "Content-Type": asset.contentType, "Cache-Control": "no-cache" });
        res.end(asset.body);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404");
      }
      return;
    }

    if (req.method === "POST" && urlPath === this.cfg.hub.ingestPath) {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy(); // 防爆
      });
      req.on("end", () => {
        try {
          const env = JSON.parse(body) as IngestEnvelope;
          this.hub.ingest(env);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          log.warn(`/ingest 解析失败: ${(e as Error).message}`);
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "bad json" }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404");
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
          assetNames: this.cfg.persona.assetNames,
        });
        this.sendTo(ws, { type: "sessions", sessions: this.mgr.list() });
        this.sendTo(ws, { type: "hub_snapshot", snapshot: this.hub.snapshot() });
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

      case "interrupt": {
        const session = this.mgr.ensureLive(msg.sessionId);
        if (!session) {
          this.sendTo(ws, { type: "error", message: `会话不存在: ${msg.sessionId}` });
          return;
        }
        await session.interrupt();
        break;
      }

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

      // ── 中枢三张表 ──
      case "hub_snapshot":
        this.sendTo(ws, { type: "hub_snapshot", snapshot: this.hub.snapshot() });
        break;

      case "todo_add":
        this.hub.addTodo(msg.text, msg.windowId);
        break;

      case "todo_set_status":
        this.hub.setTodoStatus(msg.id, msg.status);
        break;

      case "todo_remove":
        this.hub.removeTodo(msg.id);
        break;

      case "todo_clear_all":
        this.hub.clearAllTodos();
        break;

      case "acceptance_resolve":
        this.hub.resolveAcceptance(msg.id);
        break;

      case "acceptance_clear_all":
        this.hub.clearAllAcceptance();
        break;

      case "popup_suppress":
        try { fs.writeFileSync(popupSuppressPath(), "", "utf-8"); } catch { /* best-effort */ }
        log.info("弹窗已抑制（popup.suppress 写入）");
        break;

      case "popup_restore":
        try { fs.unlinkSync(popupSuppressPath()); } catch { /* not exist, fine */ }
        this.spawnPopup();
        break;
    }
  }

  private spawnPopup(): void {
    const script = path.join(this.projectRoot, "bifrost", "scripts", "popup-web.ps1");
    if (!fs.existsSync(script)) { log.warn("popup-web.ps1 不存在，跳过拉起弹窗"); return; }
    const popupUrl = `http://${this.cfg.host}:${this.cfg.port}/popup.html`;
    try {
      cp.spawn("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
        "-File", script, "-Url", popupUrl,
      ], { detached: true, stdio: "ignore", shell: false });
      log.info("弹窗已恢复（spawn popup-web.ps1）");
    } catch (e) { log.warn(`拉起弹窗失败: ${(e as Error).message}`); }
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
    this.httpServer?.close();
  }
}
