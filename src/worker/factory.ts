import { WorkerEngine, WorkerStartOptions } from "./types";
import { MockWorker } from "./mockWorker";
import { SdkWorker } from "./sdkWorker";
import { createLogger } from "../core/logger";

const log = createLogger("worker:factory");

export type EngineChoice = "auto" | "sdk" | "mock";

/**
 * 根据配置与环境选择工作层引擎。
 * - mock → 始终回显
 * - sdk  → 强制使用 @anthropic-ai/claude-agent-sdk（未安装则降级 mock）
 * - auto → SDK 包可解析则 SDK；否则 mock
 *
 * 注意：工作层自 2026-07-02 起为**非主路径**（见 {@link SdkWorker}）。主产品是旁观原生
 * 窗口的中枢，这里选出的引擎只服务「TUI 驱动单会话」这条可选/验收路径。
 */
export function createWorker(choice: EngineChoice, opts: WorkerStartOptions): WorkerEngine {
  if (choice === "mock") return new MockWorker(opts);

  if (choice === "sdk") {
    if (isSdkResolvable()) return new SdkWorker(opts);
    log.warn("worker.engine=sdk 但未安装 @anthropic-ai/claude-agent-sdk，降级到 mock");
    return new MockWorker(opts);
  }

  if (isSdkResolvable()) {
    log.info("检测到 @anthropic-ai/claude-agent-sdk，使用常驻 TypeScript SDK 引擎");
    return new SdkWorker(opts);
  }

  log.info("未检测到 @anthropic-ai/claude-agent-sdk，使用 mock 引擎（开箱即跑）");
  return new MockWorker(opts);
}

/** 当前会用哪个引擎名（用于 welcome/doctor 展示，不真正启动会话）。 */
export function resolveEngineName(choice: EngineChoice, _command: string): string {
  if (choice === "mock") return "mock";
  const sdk = isSdkResolvable();
  if (choice === "sdk") return sdk ? "sdk" : "mock(降级)";
  return sdk ? "sdk" : "mock";
}

export function isSdkResolvable(): boolean {
  try {
    require.resolve("@anthropic-ai/claude-agent-sdk");
    return true;
  } catch {
    return false;
  }
}


