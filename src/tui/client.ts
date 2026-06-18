import * as readline from "readline";
import { WebSocket } from "ws";
import { parseServerMessage, ClientMessage, SessionInfo } from "../protocol/messages";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  bold: "\x1b[1m",
};

/**
 * TUI 客户端：连到 core daemon，发送指令、渲染结构化消息。
 * 这是给纯键盘党 / 服务器场景用的前端，看的是和 Web 面板同一份状态。
 */
export class TuiClient {
  private ws!: WebSocket;
  private rl!: readline.Interface;
  private currentSession?: string;
  private personaName = "指挥官";
  private pendingPermission?: { requestId: string; sessionId: string };

  constructor(private url: string) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on("open", () => {
        this.send({ type: "hello", client: "tui" });
        this.setupReadline();
        resolve();
      });
      this.ws.on("message", (d) => this.onMessage(d.toString()));
      this.ws.on("error", (e) => reject(e));
      this.ws.on("close", () => {
        this.println(`${C.dim}与 core 的连接已断开。${C.reset}`);
        process.exit(0);
      });
    });
  }

  private send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private setupReadline(): void {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.printBanner();
    this.prompt();
    this.rl.on("line", (line) => this.onLine(line.trim()));
    this.rl.on("SIGINT", () => {
      this.println(`\n${C.dim}再见，主人～${C.reset}`);
      process.exit(0);
    });
  }

  private prompt(): void {
    const tag = this.currentSession ? this.currentSession : "无会话";
    this.rl.setPrompt(`${C.cyan}[${tag}]${C.reset} > `);
    this.rl.prompt();
  }

  private println(s: string): void {
    if (this.rl) {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
    }
    process.stdout.write(s + "\n");
    if (this.rl) this.rl.prompt(true);
  }

  private printBanner(): void {
    this.println(`${C.magenta}${C.bold}majordomo · 指挥官 TUI${C.reset}`);
    this.println(
      `${C.dim}输入即对话；命令：/new [名字]  /sessions  /resume <id>  /profile <名>  /help  /quit${C.reset}`
    );
  }

  // ── 输入处理 ──────────────────────────────────────────
  private onLine(line: string): void {
    if (this.pendingPermission) {
      this.handlePermissionAnswer(line);
      return;
    }
    if (!line) {
      this.prompt();
      return;
    }
    if (line.startsWith("/")) {
      this.handleCommand(line);
      return;
    }
    // 普通输入：无会话则自动建一个
    if (!this.currentSession) {
      this.send({ type: "create_session", name: line.slice(0, 20) });
      this.pendingFirstInput = line;
    } else {
      this.send({ type: "user_input", sessionId: this.currentSession, text: line });
    }
    this.prompt();
  }

  private pendingFirstInput?: string;

  private handleCommand(line: string): void {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "new":
        this.send({ type: "create_session", name: arg || undefined });
        break;
      case "sessions":
      case "ls":
        this.send({ type: "list_sessions" });
        break;
      case "resume":
        if (!arg) this.println(`${C.yellow}用法: /resume <sessionId>${C.reset}`);
        else this.send({ type: "resume_session", sessionId: arg });
        break;
      case "profile":
        if (!arg) this.println(`${C.yellow}用法: /profile <名字>${C.reset}`);
        else this.send({ type: "switch_profile", profile: arg });
        break;
      case "compact":
      case "model":
        if (this.currentSession)
          this.send({ type: "slash", sessionId: this.currentSession, command: cmd, args: arg });
        else this.println(`${C.yellow}先开一个会话${C.reset}`);
        break;
      case "help":
        this.printBanner();
        break;
      case "quit":
      case "exit":
        process.exit(0);
        break;
      default:
        this.println(`${C.yellow}未知命令: /${cmd}${C.reset}`);
    }
    this.prompt();
  }

  private handlePermissionAnswer(line: string): void {
    const approve = /^y(es)?$/i.test(line);
    const p = this.pendingPermission!;
    this.pendingPermission = undefined;
    this.send({
      type: "permission_response",
      sessionId: p.sessionId,
      requestId: p.requestId,
      approve,
    });
    this.println(approve ? `${C.green}已批准${C.reset}` : `${C.yellow}已拒绝${C.reset}`);
    this.prompt();
  }

  // ── 消息渲染 ──────────────────────────────────────────
  private onMessage(raw: string): void {
    const msg = parseServerMessage(raw);
    if (!msg) return;
    switch (msg.type) {
      case "welcome":
        this.personaName = msg.personaName;
        this.println(
          `${C.dim}已连接 · profile=${msg.activeProfile} · 工作层=${msg.engine} · 可用profile: ${msg.profiles.join(", ")}${C.reset}`
        );
        break;
      case "session_created":
        this.currentSession = msg.session.id;
        this.println(`${C.green}● 会话就绪: ${msg.session.name} (${msg.session.id}) engine=${msg.session.engine}${C.reset}`);
        if (this.pendingFirstInput) {
          this.send({ type: "user_input", sessionId: msg.session.id, text: this.pendingFirstInput });
          this.pendingFirstInput = undefined;
        }
        this.prompt();
        break;
      case "session_closed":
        if (this.currentSession === msg.sessionId) this.currentSession = undefined;
        this.println(`${C.dim}会话已关闭: ${msg.sessionId}${C.reset}`);
        break;
      case "sessions":
        this.printSessions(msg.sessions);
        break;
      case "history":
        this.println(`${C.dim}— 历史 (${msg.sessionId}) —${C.reset}`);
        for (const e of msg.entries) this.println(`${C.dim}${e.channel}:${C.reset} ${e.text}`);
        break;
      case "worker_message":
        this.println(`${C.dim}工作层:${C.reset} ${msg.text}`);
        break;
      case "persona_message":
        this.println(`${C.magenta}${C.bold}${this.personaName}:${C.reset} ${msg.text}`);
        break;
      case "permission_request":
        this.pendingPermission = { requestId: msg.requestId, sessionId: msg.sessionId };
        this.println(`${C.yellow}⚠ 工作层请求权限 [${msg.tool}]: ${msg.detail}${C.reset}`);
        this.println(`${C.yellow}批准吗? (y/n)${C.reset}`);
        break;
      case "session_state":
        if (msg.state === "thinking") this.println(`${C.dim}…工作层思考中${C.reset}`);
        break;
      case "profile_switched":
        this.println(`${C.green}已切换 profile → ${msg.profile}（只影响新开会话）${C.reset}`);
        break;
      case "error":
        this.println(`${C.yellow}错误: ${msg.message}${C.reset}`);
        break;
    }
  }

  private printSessions(sessions: SessionInfo[]): void {
    if (sessions.length === 0) {
      this.println(`${C.dim}（暂无会话，输入内容或 /new 创建）${C.reset}`);
      return;
    }
    this.println(`${C.cyan}— 会话列表 —${C.reset}`);
    for (const s of sessions) {
      const cur = s.id === this.currentSession ? `${C.green}*${C.reset}` : " ";
      const when = new Date(s.updatedAt).toLocaleString();
      this.println(`${cur} ${C.bold}${s.id}${C.reset} ${s.name} ${C.dim}[${s.profile}/${s.engine}] ${s.state} ${when}${C.reset}`);
    }
  }
}

export async function runTui(host: string, port: number): Promise<void> {
  const client = new TuiClient(`ws://${host}:${port}`);
  await client.start();
}
