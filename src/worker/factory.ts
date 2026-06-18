import { WorkerEngine, WorkerStartOptions } from "./types";
import { MockWorker } from "./mockWorker";
import { ClaudeCodeWorker, isCommandAvailable } from "./claudeCodeWorker";
import { createLogger } from "../core/logger";

const log = createLogger("worker:factory");

export type EngineChoice = "auto" | "claude" | "mock";

/**
 * 根据配置与环境选择工作层引擎。
 * - mock   → 始终回显
 * - claude → 强制真实，命令不可用则报错降级 mock（防御）
 * - auto   → 命令可用走 claude，否则 mock（开箱即跑）
 */
export function createWorker(choice: EngineChoice, opts: WorkerStartOptions): WorkerEngine {
  if (choice === "mock") {
    return new MockWorker(opts);
  }

  const available = isCommandAvailable(opts.command);

  if (choice === "claude") {
    if (available) return new ClaudeCodeWorker(opts);
    log.warn(`worker.engine=claude 但命令 "${opts.command}" 不可用，降级到 mock`);
    return new MockWorker(opts);
  }

  // auto
  if (available) {
    log.info(`检测到工作层命令 "${opts.command}"，使用真实 Claude Code 引擎`);
    return new ClaudeCodeWorker(opts);
  }
  log.info(`未检测到工作层命令 "${opts.command}"，使用 mock 引擎（开箱即跑）`);
  return new MockWorker(opts);
}

/** 当前会用哪个引擎名（用于 welcome 消息展示，不真正启动）。 */
export function resolveEngineName(choice: EngineChoice, command: string): string {
  if (choice === "mock") return "mock";
  const available = isCommandAvailable(command);
  if (choice === "claude") return available ? "claude" : "mock(降级)";
  return available ? "claude" : "mock";
}
