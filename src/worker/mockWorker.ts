import { randomUUID } from "crypto";
import { WorkerEngine, WorkerStartOptions } from "./types";

/**
 * 回显工作层：无需任何凭证，用于演示整条链路（输入 → 工作层 → 人设层汇报）。
 *
 * 行为：
 * - 投递输入后，分几段"流式"回显，再 done。
 * - 若输入里含危险词（rm / delete / 删除），模拟一次权限请求，演示批准流程。
 */
export class MockWorker extends WorkerEngine {
  readonly engineName = "mock";
  private pendingPermissions = new Map<string, () => void>();
  private running = false;

  constructor(opts: WorkerStartOptions) {
    super(opts);
    if (!this.workerSessionId) {
      this.workerSessionId = `mock-${randomUUID().slice(0, 8)}`;
      setTimeout(() => this.emitEvent({ kind: "session_id", id: this.workerSessionId! }), 0);
    }
  }

  async send(text: string): Promise<void> {
    if (this.running) {
      this.emitEvent({ kind: "error", message: "上一个 mock 回合尚未结束" });
      return;
    }

    this.running = true;
    try {
      const dangerous = /\b(rm|delete|drop|del)\b|删除|清空/i.test(text);

      if (dangerous) {
        const requestId = randomUUID();
        this.emitEvent({
          kind: "permission",
          requestId,
          tool: "Bash",
          detail: `（演示）工作层想执行可能有破坏性的操作：${text.slice(0, 60)}`,
        });
        await new Promise<void>((resolve) => {
          this.pendingPermissions.set(requestId, resolve);
        });
      }

      const chunks = [
        `收到指令：「${text}」。`,
        "（这是 MockWorker 回显引擎，未接真实 Claude Code。）",
        "已模拟分析需求、读取相关文件、给出方案。",
        "回合完成。要接真实工作层，请安装并登录 Claude Code SDK 后把 config 的 worker.engine 设为 \"sdk\" / \"auto\"。",
      ];

      for (const c of chunks) {
        await delay(180);
        this.emitEvent({ kind: "text", text: c });
      }
      await delay(120);
      this.emitEvent({ kind: "done", summary: `已处理：${text}` });
    } finally {
      this.running = false;
    }
  }

  resolvePermission(requestId: string, approve: boolean, _updatedInput?: Record<string, unknown>): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (resolve) {
      this.pendingPermissions.delete(requestId);
      if (approve) {
        this.emitEvent({ kind: "text", text: "（已获批准，继续执行）" });
      } else {
        this.emitEvent({ kind: "text", text: "（已被拒绝，跳过该操作）" });
      }
      resolve();
    }
  }

  async close(): Promise<void> {
    this.pendingPermissions.clear();
    this.running = false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
