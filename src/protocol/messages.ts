/**
 * core ↔ client 通信协议。
 *
 * 设计原则（见 docs/design/main-mind.md）：
 * - 全部结构化 JSON，不做屏幕抓取。
 * - 协议层从第一天就立好，TUI / Web / 未来远程都是同一份协议的客户端。
 * - 通信走 WebSocket，初期 localhost，未来加 TLS/CF Access 即可走网络。
 */

/** 会话在指挥官眼里的元信息（"报菜名"用的）。 */
export interface SessionInfo {
  id: string;
  /** 工作层底层 session_id（claude --resume 用），可能在首条消息后才拿到 */
  workerSessionId?: string;
  /** 人类给它起的名字 / 任务描述 */
  name: string;
  /** 绑定的项目路径 */
  cwd: string;
  /** 启动时绑定的 profile（绑死，不随全局切换变动） */
  profile: string;
  /** 使用的工作层引擎：claude | mock */
  engine: string;
  state: SessionState;
  createdAt: number;
  updatedAt: number;
}

export type SessionState =
  | "idle" // 空闲，等待输入
  | "thinking" // 工作层正在干活
  | "reporting" // 人设层正在汇报
  | "waiting_permission" // 等待人类批准高危操作
  | "error"
  | "closed";

/** 一条历史记录条目，TUI / Web 都用它渲染。 */
export interface HistoryEntry {
  sessionId: string;
  ts: number;
  channel: "user" | "worker" | "persona" | "system";
  text: string;
}

// ─────────────────────────────────────────────────────────────
// Client → Core
// ─────────────────────────────────────────────────────────────
export type ClientMessage =
  | { type: "hello"; client: "tui" | "web" | "remote" }
  | { type: "create_session"; name?: string; cwd?: string; profile?: string }
  | { type: "resume_session"; sessionId: string }
  | { type: "close_session"; sessionId: string }
  | { type: "list_sessions" }
  | { type: "get_history"; sessionId: string }
  | { type: "user_input"; sessionId: string; text: string }
  /** 透传斜杠命令给工作层 session，例如 /compact /model */
  | { type: "slash"; sessionId: string; command: string; args?: string }
  | { type: "switch_profile"; profile: string }
  | { type: "permission_response"; sessionId: string; requestId: string; approve: boolean };

// ─────────────────────────────────────────────────────────────
// Core → Client
// ─────────────────────────────────────────────────────────────
export type ServerMessage =
  | { type: "welcome"; activeProfile: string; profiles: string[]; engine: string; personaName: string }
  | { type: "session_created"; session: SessionInfo }
  | { type: "session_closed"; sessionId: string }
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "history"; sessionId: string; entries: HistoryEntry[] }
  | { type: "session_state"; sessionId: string; state: SessionState }
  /** 工作层流式输出（原始、结构化、未经人设润色） */
  | { type: "worker_message"; sessionId: string; text: string; final?: boolean }
  /** 人设层用人话汇报（指挥官的"嘴"） */
  | { type: "persona_message"; sessionId: string; text: string }
  /** 工作层想做高危操作，请人类批准 */
  | { type: "permission_request"; sessionId: string; requestId: string; tool: string; detail: string }
  | { type: "profile_switched"; profile: string }
  | { type: "error"; message: string; sessionId?: string };

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj.type === "string") return obj as ClientMessage;
  } catch {
    /* ignore */
  }
  return null;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj.type === "string") return obj as ServerMessage;
  } catch {
    /* ignore */
  }
  return null;
}
