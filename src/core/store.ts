import * as fs from "fs";
import * as path from "path";
import { SessionInfo, HistoryEntry } from "../protocol/messages";
import { globalDir, ensureDir, sessionsDbPath, historyDir } from "./paths";
import { createLogger } from "./logger";

const log = createLogger("store");

/**
 * 会话元信息 + 历史的持久化。
 *
 * 设计取舍：初期用 JSON 文件而非 SQLite，避免 Windows 上 native 模块编译痛点。
 * 协议层不依赖存储实现，未来要换 SQLite 只动这个文件。
 *
 * - 元信息：单文件 ~/.majordomo/sessions.json
 * - 历史：每会话一个 ~/.majordomo/history/<id>.jsonl（追加写）
 */
export class Store {
  private sessions = new Map<string, SessionInfo>();

  constructor() {
    ensureDir(globalDir());
    ensureDir(historyDir());
    this.load();
  }

  private load(): void {
    const file = sessionsDbPath();
    if (!fs.existsSync(file)) return;
    try {
      const arr = JSON.parse(fs.readFileSync(file, "utf8")) as SessionInfo[];
      for (const s of arr) this.sessions.set(s.id, s);
      log.debug(`加载了 ${this.sessions.size} 个历史会话`);
    } catch (e) {
      log.warn(`会话库读取失败: ${(e as Error).message}`);
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(
        sessionsDbPath(),
        JSON.stringify([...this.sessions.values()], null, 2),
        "utf8"
      );
    } catch (e) {
      log.warn(`会话库写入失败: ${(e as Error).message}`);
    }
  }

  upsert(info: SessionInfo): void {
    info.updatedAt = Date.now();
    this.sessions.set(info.id, info);
    this.persist();
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  remove(id: string): void {
    this.sessions.delete(id);
    this.persist();
  }

  // ── 历史 ──────────────────────────────────────────────
  private historyFile(id: string): string {
    return path.join(historyDir(), `${id}.jsonl`);
  }

  appendHistory(entry: HistoryEntry): void {
    try {
      fs.appendFileSync(this.historyFile(entry.sessionId), JSON.stringify(entry) + "\n", "utf8");
    } catch (e) {
      log.warn(`历史写入失败: ${(e as Error).message}`);
    }
  }

  readHistory(id: string): HistoryEntry[] {
    const file = this.historyFile(id);
    if (!fs.existsSync(file)) return [];
    try {
      return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as HistoryEntry);
    } catch (e) {
      log.warn(`历史读取失败: ${(e as Error).message}`);
      return [];
    }
  }
}
