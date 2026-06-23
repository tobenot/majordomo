import * as readline from "readline";
import { WebSocket } from "ws";
import { parseServerMessage, ClientMessage, SessionInfo, SessionState } from "../protocol/messages";
import { renderMarkdown } from "./markdown";

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

// ponytail: bracketed paste markers — terminal wraps pasted content in these
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * TUI 客户端：连到 core daemon，发送指令、渲染结构化消息。
 * 这是给纯键盘党 / 服务器场景用的前端，看的是和 Web 面板同一份状态。
 */
export class TuiClient {
  private ws!: WebSocket;
  private rl!: readline.Interface;
  private currentSession?: string;
  private sessionState: SessionState = "idle";
  private pendingInput?: string; // queued while session is busy
  private personaName = "指挥官";
  private pendingPermission?: { requestId: string; sessionId: string };
  private pendingAsk?: { requestId: string; sessionId: string; questions: AskQuestion[] };
  // ponytail: paste confirmation — multi-line paste isn't auto-submitted, user can review/discard
  private pendingPaste?: string;
  private ctrlJNext = false;
  private lastEscTime = 0;

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
    readline.emitKeypressEvents(process.stdin);
    const history: string[] = [];
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, history });
    process.stdout.write("\x1b[?2004h"); // ponytail: enable bracketed paste mode
    process.on("exit", () => process.stdout.write("\x1b[?2004l"));
    this.printBanner();
    this.prompt();
    this.rl.on("line", (line) => this.onLine(line));
    this.rl.on("SIGINT", () => {
      if (this.currentSession && this.sessionState !== "idle" && this.sessionState !== "error" && this.sessionState !== "closed") {
        // ponytail: interrupt clears the queued input — pasted floods don't keep firing after Ctrl+C
        this.pendingInput = undefined;
        this.buffer = [];
        this.pasteBuf = null;
        if (this.pasteDebounceTimer) { clearTimeout(this.pasteDebounceTimer); this.pasteDebounceTimer = null; }
        this.pasteDebounceLines = [];
        this.pendingPaste = undefined;
        this.send({ type: "interrupt", sessionId: this.currentSession });
        this.println(`\n${C.yellow}已请求打断（排队已清空）…${C.reset}`);
      } else {
        this.println(`\n${C.dim}再见，主人～${C.reset}`);
        process.exit(0);
      }
    });
    process.stdin.on("keypress", (_str, key) => {
      if (key.ctrl && key.name === "j") {
        this.ctrlJNext = true;
        this.rl.write("\n");
        return;
      }
      if (key.ctrl && key.name === "l") {
        process.stdout.write("\x1b[2J\x1b[H");
        this.rl.prompt(true);
        return;
      }
      if (key.name === "escape") {
        const now = Date.now();
        if (this.pendingPaste && now - this.lastEscTime < 500) {
          this.pendingPaste = undefined;
          this.println(`${C.yellow}粘贴块已删除${C.reset}`);
        }
        this.lastEscTime = now;
      }
    });
  }

  // ponytail: prompt reflects session state — user always knows if worker is busy
  private prompt(): void {
    if (this.pendingPaste) {
      const lines = this.pendingPaste.split("\n").length;
      this.rl.setPrompt(`${C.yellow}[累积 ${lines} 行，继续粘贴/打字发送，空行删除]${C.reset} > `);
      this.rl.prompt();
      return;
    }
    const tag = this.currentSession ? this.currentSession : "无会话";
    const busy = this.sessionState !== "idle" && this.sessionState !== "closed";
    const indicator = this.sessionState === "thinking" ? `${C.dim}…${C.reset}` :
                      this.sessionState === "waiting_permission" ? `${C.yellow}?${C.reset}` :
                      this.sessionState === "reporting" ? `${C.dim}…${C.reset}` : "";
    const bracket = busy ? C.dim : C.cyan;
    this.rl.setPrompt(`${indicator}${bracket}[${tag}]${C.reset} > `);
    this.rl.prompt();
  }

  private inlineMode = false;

  private println(s: string): void {
    if (this.inlineMode) {
      process.stdout.write("\n");
      this.inlineMode = false;
    }
    process.stdout.write(s + "\n");
    if (this.rl) this.rl.prompt(true);
  }

  private printBanner(): void {
    this.println(`${C.magenta}${C.bold}majordomo · 指挥官 TUI${C.reset}`);
    this.println(
      `${C.dim}Ctrl+J 换行 | Ctrl+L 清屏 | Esc+Esc 清空 | 输入即对话；行尾加 \\ 换行续写（空行取消）；命令：/new [名字]  /sessions  /resume <id>  /profile <名>  /help  /quit${C.reset}`
    );
  }

  // ── 输入处理 ──────────────────────────────────────────
  private pendingFirstInput?: string;
  // ponytail: backslash continuation = multiline input; stdlib readline has no Shift+Enter
  private buffer: string[] = [];
  // ponytail: bracketed-paste accumulator — null when not inside a paste block
  private pasteBuf: string[] | null = null;
  // ponytail: ConPTY (Windows) strips bracketed paste markers. Two-phase debounce:
  // phase 1 (first line): 10ms — imperceptible for normal Enter, catches fast paste floods.
  // phase 2 (second line+): 100ms — ConPTY can deliver lines with unpredictable gaps >10ms.
  // Single-line inputs pay only the 10ms phase-1 cost. Multi-line pastes get the generous window.
  private pasteDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pasteDebounceLines: string[] = [];

  private onLine(raw: string): void {
    // bracketed paste: terminal wraps pasted content in ESC[200~ ... ESC[201~.
    // Whole block becomes ONE message instead of one-line-per-submit.
    if (raw.startsWith(PASTE_START) || this.pasteBuf !== null) {
      let line = raw;
      if (raw.startsWith(PASTE_START)) {
        this.pasteBuf = this.pasteBuf ?? [];
        line = line.slice(PASTE_START.length);
      }
      const ended = line.endsWith(PASTE_END);
      if (ended) line = line.slice(0, -PASTE_END.length);
      this.pasteBuf!.push(line);
      if (ended) {
        const text = this.pasteBuf!.join("\n");
        this.pasteBuf = null;
        this.handlePastedText(text);
      }
      return;
    }

    // ponytail: two-phase ConPTY fallback
    if (this.pasteDebounceTimer !== null) {
      // phase 2: already have ≥1 pending line → paste detected, use generous window
      this.pasteDebounceLines.push(raw);
      clearTimeout(this.pasteDebounceTimer);
      this.pasteDebounceTimer = setTimeout(() => this.flushPasteDebounce(), 100);
      return;
    }
    // phase 1: first line, short window — if another line arrives, switches to phase 2
    this.pasteDebounceLines = [raw];
    this.pasteDebounceTimer = setTimeout(() => this.flushPasteDebounce(), 10);
  }

  private flushPasteDebounce(): void {
    this.pasteDebounceTimer = null;
    const lines = this.pasteDebounceLines;
    this.pasteDebounceLines = [];
    // ponytail: readline holds the last line without trailing \n in rl.line.
    // Inject \n to flush it through the normal debounce channel, then re-process.
    if (lines.length > 0 && this.rl.line) {
      this.pasteDebounceLines = lines;
      this.pasteDebounceTimer = setTimeout(() => this.flushPasteDebounce(), 10);
      this.rl.write("\n");
      return;
    }
    if (lines.length === 1) {
      this.processLine(lines[0]);
    } else {
      const text = lines.join("\n");
      this.handlePastedText(text);
    }
  }

  private processLine(raw: string): void {
    if (this.ctrlJNext) {
      this.ctrlJNext = false;
      if (!raw.trim() && !this.pendingPaste) { this.prompt(); return; }
      if (this.pendingPaste) { this.pendingPaste += "\n" + raw; }
      else { this.pendingPaste = raw; }
      this.prompt();
      return;
    }
    const line = raw.trim();
    if (this.pendingPaste) {
      if (!line) {
        // ponytail: empty line deletes entire accumulated paste block
        this.pendingPaste = undefined;
        this.println(`${C.yellow}粘贴块已删除${C.reset}`);
      } else {
        // ponytail: any typed text + Enter = append and submit
        const paste = this.pendingPaste;
        this.pendingPaste = undefined;
        this.submitText(paste + "\n" + line);
      }
      return;
    }
    if (this.pendingAsk) {
      this.handleAskAnswer(line);
      return;
    }
    if (this.pendingPermission) {
      this.handlePermissionAnswer(line);
      return;
    }
    // multiline continuation: empty line or command aborts a pending buffer
    if (this.buffer.length) {
      if (!line || line.startsWith("/")) {
        this.buffer = [];
        if (line.startsWith("/")) { this.handleCommand(line); return; }
        this.println(`${C.dim}（多行输入已取消）${C.reset}`);
        this.prompt();
        return;
      }
      if (line.endsWith("\\")) {
        this.buffer.push(line.slice(0, -1));
        this.rl.setPrompt(`${C.dim}…${C.reset} `);
        this.rl.prompt();
        return;
      }
      this.submitText([...this.buffer, line].join("\n"));
      this.buffer = [];
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
    // start multiline if line ends with backslash
    if (line.endsWith("\\")) {
      this.buffer.push(line.slice(0, -1));
      this.rl.setPrompt(`${C.dim}…${C.reset} `);
      this.rl.prompt();
      return;
    }
    this.submitText(line);
  }

  // ponytail: pasted block → accumulate mode. Single-line paste behaves like typed input.
  private handlePastedText(text: string): void {
    const t = text.replace(/^\n+/, "").replace(/\n+$/, "");
    if (!t) { this.prompt(); return; }
    if (!t.includes("\n")) {
      // ponytail: if already in accumulation mode, single-line paste appends too
      if (this.pendingPaste) {
        this.pendingPaste += "\n" + t;
        this.prompt();
        return;
      }
      this.onLine(t);
      return;
    }
    // multi-line: start or append to accumulation mode
    if (this.pendingPaste) {
      this.pendingPaste += "\n" + t;
    } else {
      this.pendingPaste = t;
    }
    this.prompt();
  }

  private submitText(text: string): void {
    if (!this.currentSession) {
      this.send({ type: "create_session", name: text.replace(/\n/g, " ").slice(0, 40).trim() || "新会话" });
      this.pendingFirstInput = text;
    } else if (this.sessionState !== "idle" && this.sessionState !== "error" && this.sessionState !== "closed") {
      // ponytail: busy → queue, auto-send when idle
      this.pendingInput = text;
      this.println(`${C.dim}（已排队，回合完成后自动发送）${C.reset}`);
    } else {
      this.send({ type: "user_input", sessionId: this.currentSession, text });
      this.sessionState = "thinking"; // 乐观更新，prompt 立即显示忙碌
    }
    this.prompt();
  }

  private handleCommand(line: string): void {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "new":
      case "clear":
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

  private handleAskAnswer(line: string): void {
    const p = this.pendingAsk!;
    this.pendingAsk = undefined;
    const parts = line.split(/[\s,]+/).filter(Boolean);
    const indexes = parts.map(Number).filter(n => !isNaN(n) && n >= 1);
    if (indexes.length === 0) {
      // Cancel / no selection
      this.send({ type: "permission_response", sessionId: p.sessionId, requestId: p.requestId, approve: false });
      this.println(`${C.yellow}已取消${C.reset}`);
      this.prompt();
      return;
    }
    // Build answers from selected indexes
    const answers: Record<string, string | string[]> = {};
    for (const q of p.questions) {
      const selected = indexes
        .filter(i => i <= q.options.length)
        .map(i => q.options[i - 1].label);
      // ponytail: per-question indexes for multi-question support would need a smarter UI
      if (selected.length === 0) {
        selected.push(q.options[0].label); // default to first option
      }
      answers[q.header] = q.multiSelect ? selected : selected[0];
    }
    this.send({
      type: "permission_response",
      sessionId: p.sessionId,
      requestId: p.requestId,
      approve: true,
      updatedInput: { answers },
    });
    this.println(`${C.green}已选择${C.reset}`);
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

  private renderAskUserQuestion(requestId: string, sessionId: string, rawInput: string): void {
    try {
      const data = JSON.parse(rawInput) as { questions?: AskQuestion[] };
      if (!data.questions?.length) throw new Error("no questions");
      this.pendingAsk = { requestId, sessionId, questions: data.questions };
      this.println(`${C.yellow}${C.bold}⚠ AskUserQuestion${C.reset}`);
      for (let qi = 0; qi < data.questions.length; qi++) {
        const q = data.questions[qi];
        const tag = q.multiSelect ? "多选" : "单选";
        this.println(`  ${C.bold}Q${qi + 1}: ${q.question}${C.reset} ${C.dim}[${tag}]${C.reset}`);
        for (let oi = 0; oi < q.options.length; oi++) {
          const opt = q.options[oi];
          const desc = opt.description ? `${C.dim} — ${opt.description}${C.reset}` : "";
          this.println(`    ${C.cyan}[${oi + 1}]${C.reset} ${opt.label}${desc}`);
        }
      }
      this.println(`${C.yellow}输入编号选择 (如 1,3 或 1 2 3，回车取消):${C.reset}`);
    } catch {
      // fallback: regular permission prompt
      this.pendingPermission = { requestId, sessionId };
      this.println(`${C.yellow}⚠ 工作层请求权限 [AskUserQuestion]${C.reset}`);
      this.println(`${C.yellow}批准吗? (y/n)${C.reset}`);
    }
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
        this.sessionState = msg.session.state;
        this.println(`${C.green}● 会话就绪: ${msg.session.name} (${msg.session.id}) engine=${msg.session.engine}${C.reset}`);
        if (this.pendingFirstInput) {
          this.send({ type: "user_input", sessionId: msg.session.id, text: this.pendingFirstInput });
          this.pendingFirstInput = undefined;
        }
        this.prompt();
        break;
      case "session_closed":
        if (this.currentSession === msg.sessionId) {
          this.currentSession = undefined;
          this.pendingInput = undefined;
        }
        this.println(`${C.dim}会话已关闭: ${msg.sessionId}${C.reset}`);
        break;
      case "sessions":
        this.printSessions(msg.sessions);
        break;
      case "history":
        this.println(`${C.dim}— 历史 (${msg.sessionId}) —${C.reset}`);
        for (const e of msg.entries) this.println(`${C.dim}${e.channel}:${C.reset} ${e.text}`);
        break;
      case "worker_message": {
        const isInline = msg.text.startsWith("\r");
        const body = renderMarkdown(isInline ? msg.text.slice(1) : msg.text);
        if (isInline) {
          // ponytail: \r-prefixed messages overwrite same line (thinking_tokens counter)
          process.stdout.write("\x1b[0G\x1b[0K");
          process.stdout.write(`${C.dim}工作层:${C.reset} ${body}`);
          this.inlineMode = true;
          if (this.rl) this.rl.prompt(true);
        } else {
          this.println(`${C.dim}工作层:${C.reset} ${body}`);
        }
        break;
      }
      case "persona_message":
        this.println(`${C.magenta}${C.bold}${this.personaName}:${C.reset} ${renderMarkdown(msg.text)}`);
        break;
      case "permission_request":
        if (msg.tool === "AskUserQuestion" && msg.rawInput) {
          this.renderAskUserQuestion(msg.requestId, msg.sessionId, msg.rawInput);
        } else {
          this.pendingPermission = { requestId: msg.requestId, sessionId: msg.sessionId };
          this.println(`${C.yellow}⚠ 工作层请求权限 [${msg.tool}]: ${msg.detail}${C.reset}`);
          this.println(`${C.yellow}批准吗? (y/n)${C.reset}`);
        }
        break;
      case "session_state":
        if (msg.sessionId === this.currentSession) {
          this.sessionState = msg.state;
        }
        if (msg.state === "thinking") this.println(`${C.dim}…工作层思考中${C.reset}`);
        if (msg.state === "idle" || msg.state === "error" || msg.state === "closed") {
          // ponytail: auto-send queued input after session goes idle
          if (this.pendingInput && msg.sessionId === this.currentSession) {
            const text = this.pendingInput;
            this.pendingInput = undefined;
            this.println(`${C.dim}> ${text}${C.reset}`);
            this.submitText(text);
            break; // submitText already calls prompt()
          }
          this.prompt();
        }
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
    // ponytail: show recent 10, rest still resumable by id
    const shown = sessions.slice(0, 10);
    const hidden = sessions.length - shown.length;
    this.println(`${C.cyan}— 会话列表${hidden > 0 ? `（最近 ${shown.length}，${hidden} 条旧会话已隐藏）` : ""} —${C.reset}`);
    for (const s of shown) {
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

interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskOption[];
}
interface AskOption {
  label: string;
  description: string;
}
