import { EventEmitter } from "events";
import { WorkerEngine, WorkerEvent } from "../worker/types";
import { PersonaEngine } from "../persona/types";
import { Store } from "./store";
import { SessionInfo, SessionState, ServerMessage, HistoryEntry } from "../protocol/messages";
import { createLogger } from "./logger";

const log = createLogger("session");

/**
 * 单个会话的生命周期编排：把工作层的结构化事件，经人设层润色，向上抛成协议消息。
 *
 * 数据流：
 *   user_input → worker.send → (worker 流式 text 事件) → 聚合
 *                            → worker done → persona.report → persona_message
 *   worker permission → permission_request（等人类批准）
 *
 * Session 通过 emit("message", ServerMessage) 把所有要广播的消息抛给 daemon。
 */
export class Session extends EventEmitter {
  private workerTextBuf: string[] = [];
  private currentUserText = "";
  private turnFailed = false;

  constructor(
    public info: SessionInfo,
    private worker: WorkerEngine,
    private persona: PersonaEngine,
    private store: Store
  ) {
    super();
    this.wireWorker();
  }

  private wireWorker(): void {
    this.worker.onEvent((ev: WorkerEvent) => this.onWorkerEvent(ev));
  }

  private setState(state: SessionState): void {
    this.info.state = state;
    this.store.upsert(this.info);
    this.send({ type: "session_state", sessionId: this.info.id, state });
  }

  private send(msg: ServerMessage): void {
    this.emit("message", msg);
  }

  private record(channel: HistoryEntry["channel"], text: string): void {
    this.store.appendHistory({ sessionId: this.info.id, ts: Date.now(), channel, text });
  }

  private canAcceptInput(): boolean {
    return this.info.state === "idle" || this.info.state === "error";
  }

  async input(text: string): Promise<void> {
    if (!this.canAcceptInput()) {
      const message = `当前会话正处于 ${this.info.state}，请等本轮完成后再发送。`;
      this.send({ type: "error", sessionId: this.info.id, message });
      return;
    }

    this.currentUserText = text;
    this.workerTextBuf = [];
    this.turnFailed = false;
    this.record("user", text);
    this.setState("thinking");
    try {
      await this.worker.send(text);
    } catch (e) {
      this.turnFailed = true;
      this.setState("error");
      this.send({ type: "error", sessionId: this.info.id, message: (e as Error).message });
    }
  }

  resolvePermission(requestId: string, approve: boolean, updatedInput?: Record<string, unknown>): void {
    this.worker.resolvePermission(requestId, approve, updatedInput);
    if (this.info.state === "waiting_permission") this.setState("thinking");
  }

  private async onWorkerEvent(ev: WorkerEvent): Promise<void> {
    switch (ev.kind) {
      case "session_id":
        this.info.workerSessionId = ev.id;
        this.store.upsert(this.info);
        log.debug(`会话 ${this.info.id} 绑定底层 session_id=${ev.id}`);
        break;

      case "text":
        this.workerTextBuf.push(ev.text);
        this.record("worker", ev.text);
        this.send({ type: "worker_message", sessionId: this.info.id, text: ev.text });
        break;

      case "permission":
        this.setState("waiting_permission");
        this.send({
          type: "permission_request",
          sessionId: this.info.id,
          requestId: ev.requestId,
          tool: ev.tool,
          detail: ev.detail,
          rawInput: ev.rawInput,
        });
        break;

      case "done":
        if (this.turnFailed) {
          this.setState("error");
          break;
        }
        await this.report();
        break;

      case "error":
        this.turnFailed = true;
        this.setState("error");
        this.record("system", `ERROR: ${ev.message}`);
        this.send({ type: "error", sessionId: this.info.id, message: ev.message });
        break;
    }
  }

  /** 工作层回合结束，让人设层把结果总结成人话。 */
  private async report(): Promise<void> {
    this.setState("reporting");
    const workerText = this.workerTextBuf.join("\n").trim();
    let text: string;
    try {
      text = await this.persona.report({
        userText: this.currentUserText,
        workerText,
        sessionName: this.info.name,
      });
    } catch (e) {
      text = `（人设层异常，转述原始结果）${workerText.slice(0, 200)}`;
      log.warn(`人设层 report 异常: ${(e as Error).message}`);
    }
    this.record("persona", text);
    this.send({ type: "persona_message", sessionId: this.info.id, text });
    this.setState("idle");
  }

  async close(): Promise<void> {
    await this.worker.close();
    this.info.state = "closed";
    this.store.upsert(this.info);
  }
}
