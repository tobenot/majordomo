import * as readline from "readline";
import { spawnSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { tmpdir, platform } from "os";
import { join } from "path";
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
  // 黑石海滩主题扩展：彩虹色条(亮青/亮紫) + 蜂蜜色
  honey: "\x1b[38;5;214m",   // 蜂蜜琥珀
};

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

type PromptMode = "normal" | "permission" | "ask";

function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * TUI 客户端：连到 core daemon，发送指令、渲染结构化消息。
 * Phase 2: raw mode stdin, multi-line buffer, no readline.
 */
export class TuiClient {
  private ws!: WebSocket;
  private currentSession?: string;
  private sessionState: SessionState = "idle";
  private pendingInput?: string;
  private personaName = "指挥官";
  private pendingPermission?: { requestId: string; sessionId: string };
  private pendingAsk?: { requestId: string; sessionId: string; questions: AskQuestion[] };

  // ── raw mode state ──
  private buf = "";
  private cursor = 0;
  private history: string[] = [];
  private historyIdx = -1;
  private renderedLines = 0;

  // ponytail: special input modes for permission/ask — single-line blocking
  private promptMode: PromptMode = "normal";
  private specialBuf = "";

  // ponytail: paste accumulation in raw mode — bracketed markers or char-by-char
  private pasting = false;

  // ponytail: single-entry kill ring — Ctrl+K/U/W save, Ctrl+Y yanks
  private killBuf = "";

  // misc
  private pendingFirstInput?: string;
  private lastEscTime = 0;

  constructor(private url: string) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on("open", () => {
        this.send({ type: "hello", client: "tui" });
        this.setupRawMode();
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

  // ── raw mode ───────────────────────────────────────────

  private setupRawMode(): void {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    this.printBanner();
    this.renderBuffer();

    process.stdin.on("keypress", (str, key) => {
      if (key.ctrl && key.name === "c") {
        this.handleCtrlC();
        return;
      }
      if (this.promptMode !== "normal") {
        this.handleSpecialKeypress(str, key);
        return;
      }
      // bracketed paste markers
      if (key.sequence === PASTE_START) {
        this.pasting = true;
        return;
      }
      if (this.pasting) {
        if (key.sequence === PASTE_END) {
          this.pasting = false;
          this.renderBuffer();
          return;
        }
        // accumulate paste text
        if (str) {
          this.insertAtCursor(str);
          this.renderBuffer();
        }
        return;
      }
      // ConPTY fallback: key.sequence might contain paste markers embedded in longer seq
      if (key.sequence?.includes(PASTE_START)) {
        this.pasting = true;
        this.insertAtCursor(key.sequence.replace(PASTE_START, "").replace(PASTE_END, ""));
        this.renderBuffer();
        return;
      }
      if (key.sequence?.includes(PASTE_END)) {
        this.pasting = false;
        this.renderBuffer();
        return;
      }

      // normal editing dispatch
      if (key.name === "return" && !key.shift) {
        this.submit();
      } else if ((key.name === "return" && key.shift) || (key.ctrl && key.name === "j")) {
        this.insertAtCursor("\n");
        this.renderBuffer();
      } else if (key.name === "backspace") {
        if (this.cursor > 0) {
          this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor);
          this.cursor--;
          this.historyIdx = -1;
          this.renderBuffer();
        }
      } else if (key.name === "delete") {
        if (this.cursor < this.buf.length) {
          this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(this.cursor + 1);
          this.historyIdx = -1;
          this.renderBuffer();
        }
      } else if (key.name === "left" || (key.ctrl && key.name === "b")) {
        if (this.cursor > 0) { this.cursor--; this.renderBuffer(); }
      } else if (key.name === "right" || (key.ctrl && key.name === "f")) {
        if (this.cursor < this.buf.length) { this.cursor++; this.renderBuffer(); }
      } else if ((key.ctrl && key.name === "a") || key.name === "home") {
        this.cursorToLineStart();
        this.renderBuffer();
      } else if ((key.ctrl && key.name === "e") || key.name === "end") {
        this.cursorToLineEnd();
        this.renderBuffer();
      } else if (key.ctrl && key.name === "k") {
        this.deleteToLineEnd();
        this.renderBuffer();
      } else if (key.ctrl && key.name === "u") {
        this.deleteToLineStart();
        this.renderBuffer();
      } else if (key.ctrl && key.name === "w") {
        this.deleteWordBackward();
        this.renderBuffer();
      } else if (key.ctrl && key.name === "y") {
        if (this.killBuf) {
          this.insertAtCursor(this.killBuf);
          this.renderBuffer();
        }
      } else if (key.ctrl && key.name === "g") {
        this.externalEditor();
      } else if (key.ctrl && key.name === "l") {
        process.stdout.write("\x1b[2J\x1b[H");
        this.renderedLines = 0;
        this.renderBuffer();
      } else if (key.name === "up") {
        this.historyUp();
        this.renderBuffer();
      } else if (key.name === "down") {
        this.historyDown();
        this.renderBuffer();
      } else if (key.name === "escape") {
        const now = Date.now();
        if (this.buf && now - this.lastEscTime < 500) {
          this.buf = "";
          this.cursor = 0;
          this.historyIdx = -1;
          this.println(`${C.yellow}已清空${C.reset}`);
        }
        this.lastEscTime = now;
        this.renderBuffer();
      } else if (str && !key.ctrl && !key.meta) {
        this.insertAtCursor(str);
        this.historyIdx = -1;
        this.renderBuffer();
      }
    });

    process.stdout.on("resize", () => this.renderBuffer());
    process.on("exit", () => { try { process.stdin.setRawMode(false); } catch { /* */ } });
  }

  // ── buffer ops ─────────────────────────────────────────

  private insertAtCursor(s: string): void {
    this.buf = this.buf.slice(0, this.cursor) + s + this.buf.slice(this.cursor);
    this.cursor += s.length;
  }

  private cursorToLineStart(): void {
    const prev = this.buf.lastIndexOf("\n", this.cursor - 1);
    this.cursor = prev >= 0 ? prev + 1 : 0;
  }

  private cursorToLineEnd(): void {
    const next = this.buf.indexOf("\n", this.cursor);
    this.cursor = next >= 0 ? next : this.buf.length;
  }

  private deleteToLineEnd(): void {
    const next = this.buf.indexOf("\n", this.cursor);
    const end = next >= 0 ? next : this.buf.length;
    if (end > this.cursor) {
      this.killBuf = this.buf.slice(this.cursor, end);
      this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(end);
      this.historyIdx = -1;
    }
  }

  private deleteToLineStart(): void {
    const prev = this.buf.lastIndexOf("\n", this.cursor - 1);
    const start = prev >= 0 ? prev + 1 : 0;
    if (this.cursor > start) {
      this.killBuf = this.buf.slice(start, this.cursor);
      this.buf = this.buf.slice(0, start) + this.buf.slice(this.cursor);
      this.cursor = start;
      this.historyIdx = -1;
    }
  }

  private deleteWordBackward(): void {
    const before = this.buf.slice(0, this.cursor);
    const m = before.match(/(\S+|\s+)$/);
    if (m) {
      this.killBuf = m[0];
      this.buf = before.slice(0, before.length - m[0].length) + this.buf.slice(this.cursor);
      this.cursor -= m[0].length;
      this.historyIdx = -1;
    }
  }

  // ── history ────────────────────────────────────────────

  private historyUp(): void {
    if (!this.history.length) return;
    if (this.historyIdx === -1) {
      this.historyIdx = this.history.length - 1;
    } else if (this.historyIdx > 0) {
      this.historyIdx--;
    }
    this.buf = this.history[this.historyIdx];
    this.cursor = this.buf.length;
  }

  private historyDown(): void {
    if (this.historyIdx === -1) return;
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx++;
      this.buf = this.history[this.historyIdx];
    } else {
      this.historyIdx = -1;
      this.buf = "";
    }
    this.cursor = this.buf.length;
  }

  // ── submit ─────────────────────────────────────────────

  private externalEditor(): void {
    process.stdin.setRawMode(false);
    const editor = process.env.EDITOR || process.env.VISUAL || (platform() === "win32" ? "notepad" : "vi");
    const tmp = join(tmpdir(), `mj-${Date.now()}.txt`);
    writeFileSync(tmp, this.buf, "utf-8");
    try {
      spawnSync(editor, [tmp], { stdio: "inherit" });
      this.buf = readFileSync(tmp, "utf-8").replace(/\r\n/g, "\n");
      this.cursor = Math.min(this.cursor, this.buf.length);
      process.stdin.setRawMode(true);
      readline.emitKeypressEvents(process.stdin);
      this.println(`${C.dim}编辑器已退出，buffer 已更新${C.reset}`);
    } finally {
      try { unlinkSync(tmp); } catch { /* */ }
    }
  }

  private submit(): void {
    const text = this.buf.trim();
    this.buf = "";
    this.cursor = 0;
    this.historyIdx = -1;

    if (!text) { this.renderBuffer(); return; }
    if (text.startsWith("/")) { this.handleCommand(text); return; }

    if (text && !text.startsWith("/")) {
      this.history.push(text);
      // ponytail: cap history to prevent memory leak
      if (this.history.length > 1000) this.history.shift();
    }
    this.submitText(text);
  }

  // ── special modes (permission / ask) ───────────────────

  private handleSpecialKeypress(str: string, key: { name: string; ctrl?: boolean }): void {
    if (key.name === "return") {
      const answer = this.specialBuf;
      this.specialBuf = "";
      if (this.promptMode === "permission") {
        this.promptMode = "normal";
        this.handlePermissionAnswer(answer);
      } else if (this.promptMode === "ask") {
        this.promptMode = "normal";
        this.handleAskAnswer(answer);
      }
      this.renderBuffer();
      return;
    }
    if (key.ctrl && key.name === "c") {
      this.specialBuf = "";
      if (this.promptMode === "permission") {
        this.promptMode = "normal";
        this.handlePermissionAnswer("n");
      } else if (this.promptMode === "ask") {
        this.promptMode = "normal";
        this.handleAskAnswer("");
      }
      this.renderBuffer();
      return;
    }
    if (key.name === "backspace") {
      if (this.specialBuf.length > 0) {
        this.specialBuf = this.specialBuf.slice(0, -1);
      }
    } else if (str && !key.ctrl) {
      this.specialBuf += str;
    }
    this.renderBuffer();
  }

  // ── render ─────────────────────────────────────────────

  private renderBuffer(): void {
    // clear previous render
    if (this.renderedLines > 0) {
      process.stdout.write(`\x1b[${this.renderedLines}A\x1b[0J`);
    }

    const tag = this.currentSession ? this.currentSession : "无会话";
    const busy = this.sessionState !== "idle" && this.sessionState !== "closed";
    const indicator = this.sessionState === "thinking" ? `${C.dim}…${C.reset}` :
                      this.sessionState === "waiting_permission" ? `${C.yellow}?${C.reset}` :
                      this.sessionState === "reporting" ? `${C.dim}…${C.reset}` : "";
    const bracket = busy ? C.dim : C.cyan;
    const prefix = `${indicator}${bracket}[${tag}]${C.reset} > `;
    const pw = visLen(prefix);
    const indent = " ".repeat(pw);
    const cols = process.stdout.columns || 80;

    let cursorRow = 0, cursorCol = pw;
    let out = prefix;
    let lineCount = 1;

    const text = this.promptMode !== "normal" ? this.specialBuf : this.buf;

    // ponytail: special mode prompt overrides prefix
    if (this.promptMode === "permission") {
      process.stdout.write(`\x1b[0G\x1b[0K${C.yellow}批准吗? (y/n): ${this.specialBuf}${C.reset}`);
      this.renderedLines = 1;
      return;
    }
    if (this.promptMode === "ask") {
      process.stdout.write(`\x1b[0G\x1b[0K${C.yellow}输入编号选择 (回车取消): ${this.specialBuf}${C.reset}`);
      this.renderedLines = 1;
      return;
    }

    // find cursor screen position by iterating characters
    let col = pw;
    let row = 0;
    for (let i = 0; i < text.length; i++) {
      if (i === this.cursor) { cursorRow = row; cursorCol = col; }
      if (text[i] === "\n") {
        out += "\n" + indent;
        row++;
        col = pw;
        lineCount = row + 1;
        continue;
      }
      out += text[i];
      col++;
      if (col >= cols) {
        // ponytail: naive wrap — no word boundary detection, add when needed
        col = pw;
        row++;
        lineCount = row + 1;
      }
    }
    if (this.cursor >= text.length) {
      cursorRow = row;
      cursorCol = col;
    }

    process.stdout.write(out);

    // position cursor
    const up = lineCount - 1 - cursorRow;
    if (up > 0) process.stdout.write(`\x1b[${up}A`);
    process.stdout.write(`\x1b[${cursorCol + 1}G`);

    this.renderedLines = lineCount;
  }

  // ── output ─────────────────────────────────────────────

  private clearRender(): void {
    if (this.renderedLines > 0) {
      process.stdout.write(`\x1b[${this.renderedLines}A\x1b[0J`);
    }
  }

  private println(s: string): void {
    this.clearRender();
    process.stdout.write(s + "\n");
    this.renderBuffer();
  }

  // ── control ────────────────────────────────────────────

  private handleCtrlC(): void {
    this.buf = "";
    this.cursor = 0;
    this.historyIdx = -1;
    if (this.currentSession && this.sessionState !== "idle" && this.sessionState !== "error" && this.sessionState !== "closed") {
      this.pendingInput = undefined;
      this.send({ type: "interrupt", sessionId: this.currentSession });
      this.println(`${C.yellow}已请求打断（排队已清空）…${C.reset}`);
    } else {
      this.println(`\n${C.dim}再见，主人～${C.reset}`);
      process.exit(0);
    }
  }

  // ── banner ─────────────────────────────────────────────

  private printBanner(): void {
    this.println(`${C.magenta}${C.bold}majordomo · 指挥官 TUI${C.reset}`);
    this.println(
      `${C.dim}Ctrl+J/Shift+Enter 换行 | Enter 提交 | Ctrl+L 清屏 | Esc+Esc 清空 | Ctrl+Y 粘贴删除 | Ctrl+G 编辑器 | Ctrl+C 打断\n` +
      `命令：/new [名字]  /sessions  /resume <id>  /profile <名>  /help  /quit${C.reset}`
    );
  }

  // ── submit / commands (logic unchanged from readline version) ──

  private submitText(text: string): void {
    if (!this.currentSession) {
      this.send({ type: "create_session", name: text.replace(/\n/g, " ").slice(0, 40).trim() || "新会话" });
      this.pendingFirstInput = text;
    } else if (this.sessionState !== "idle" && this.sessionState !== "error" && this.sessionState !== "closed") {
      this.pendingInput = text;
      this.println(`${C.dim}（已排队，回合完成后自动发送）${C.reset}`);
    } else {
      this.send({ type: "user_input", sessionId: this.currentSession, text });
      this.sessionState = "thinking";
    }
    this.renderBuffer();
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
    this.renderBuffer();
  }

  // ── permission / ask answer handlers ───────────────────

  private handleAskAnswer(line: string): void {
    const p = this.pendingAsk!;
    this.pendingAsk = undefined;
    const parts = line.split(/[\s,]+/).filter(Boolean);
    const indexes = parts.map(Number).filter(n => !isNaN(n) && n >= 1);
    if (indexes.length === 0) {
      this.send({ type: "permission_response", sessionId: p.sessionId, requestId: p.requestId, approve: false });
      this.println(`${C.yellow}已取消${C.reset}`);
      return;
    }
    const answers: Record<string, string | string[]> = {};
    for (const q of p.questions) {
      const selected = indexes
        .filter(i => i <= q.options.length)
        .map(i => q.options[i - 1].label);
      if (selected.length === 0) selected.push(q.options[0].label);
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
      // ponytail: enter ask mode — single-line input for answer
      this.promptMode = "ask";
      this.specialBuf = "";
      this.renderBuffer();
    } catch {
      this.pendingPermission = { requestId, sessionId };
      this.println(`${C.yellow}⚠ 工作层请求权限 [AskUserQuestion]${C.reset}`);
      this.promptMode = "permission";
      this.specialBuf = "";
      this.renderBuffer();
    }
  }

  // ── message rendering ──────────────────────────────────

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
          this.clearRender();
          process.stdout.write(`\x1b[0G\x1b[0K${C.dim}工作层:${C.reset} ${body}\n`);
          this.renderBuffer();
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
          this.promptMode = "permission";
          this.specialBuf = "";
          this.renderBuffer();
        }
        break;
      case "session_state":
        if (msg.sessionId === this.currentSession) {
          this.sessionState = msg.state;
        }
        if (msg.state === "thinking") this.println(`${C.dim}…工作层思考中${C.reset}`);
        if (msg.state === "idle" || msg.state === "error" || msg.state === "closed") {
          if (this.pendingInput && msg.sessionId === this.currentSession) {
            const text = this.pendingInput;
            this.pendingInput = undefined;
            this.println(`${C.dim}> ${text}${C.reset}`);
            this.submitText(text);
            break;
          }
          this.renderBuffer();
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
