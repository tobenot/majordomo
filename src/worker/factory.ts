import { WorkerEngine, WorkerStartOptions } from "./types";
import { MockWorker } from "./mockWorker";
import { ClaudeCodeWorker } from "./claudeCodeWorker";
import { isCommandAvailable } from "./commandUtils";
import { SdkWorker } from "./sdkWorker";
import { createLogger } from "../core/logger";

const log = createLogger("worker:factory");

export type EngineChoice = "auto" | "sdk" | "cli" | "claude" | "mock";

/**
 * 根据配置与环境选择工作层引擎。
 * - mock       → 始终回显
 * - sdk        → 强制使用可选 @anthropic-ai/claude-code SDK（未安装则降级 mock）
 * - cli/claude → 强制使用 profile.command 的 CLI（不可用则降级 mock）
 * - auto       → SDK 包可解析则 SDK；否则 CLI 可用则 CLI；否则 mock
 */
export function createWorker(choice: EngineChoice, opts: WorkerStartOptions): WorkerEngine {
  if (choice === "mock") return new MockWorker(opts);

  const cliAvailable = isCommandAvailable(opts.command);

  if (choice === "sdk") {
    // 不能在同步工厂里 await 探测 SDK，直接创建；SdkWorker 会在 send 时自检并报错。
    return new SdkWorker(opts);
  }

  if (choice === "cli" || choice === "claude") {
    if (cliAvailable) return new ClaudeCodeWorker(opts);
    log.warn(`worker.engine=${choice} 但命令 "${opts.command}" 不可用，降级到 mock`);
    return new MockWorker(opts);
  }

  // auto：优先 SDK（如果依赖已安装），否则 CLI，否则 mock。
  if (isSdkResolvable()) {
    log.info("检测到 @anthropic-ai/claude-code，使用 TypeScript SDK 引擎");
    return new SdkWorker(opts);
  }
  if (cliAvailable) {
    log.info(`检测到工作层命令 "${opts.command}"，使用 Claude Code CLI 引擎`);
    return new ClaudeCodeWorker(opts);
  }
  log.info(`未检测到 SDK 或工作层命令 "${opts.command}"，使用 mock 引擎（开箱即跑）`);
  return new MockWorker(opts);
}

/** 当前会用哪个引擎名（用于 welcome/doctor 展示，不真正启动会话）。 */
export function resolveEngineName(choice: EngineChoice, command: string): string {
  if (choice === "mock") return "mock";
  const sdk = isSdkResolvable();
  const cli = isCommandAvailable(command);
  if (choice === "sdk") return sdk ? "sdk" : "sdk(未安装，运行时降级/报错)";
  if (choice === "cli" || choice === "claude") return cli ? "cli" : "mock(降级)";
  if (sdk) return "sdk";
  if (cli) return "cli";
  return "mock";
}

export function isSdkResolvable(): boolean {
  try {
    require.resolve("@anthropic-ai/claude-code");
    return true;
  } catch {
    return false;
  }
}
