import { Hook, HookContext, HookConfig, HooksConfig, HookEventType } from "./types";
import { createLogger } from "../core/logger";

const log = createLogger("hook-runner");

const AFTER_TASK_DEFAULTS: HookConfig[] = [
  { type: "diary" },
  { type: "notify" },
];

/**
 * Orchestrates hook execution for lifecycle events.
 *
 * Default behavior:
 * - after_task → [diary, notify] if not explicitly configured
 * - other events → nothing (only fire if explicitly configured)
 * - Explicit empty array [] suppresses defaults entirely
 *
 * Error isolation: a failing hook never blocks remaining hooks.
 */
export class HookRunner {
  private hooks = new Map<HookEventType, Hook[]>();
  private factory: (config: HookConfig) => Hook;

  constructor(
    hooksConfig: HooksConfig | undefined,
    factory: (config: HookConfig) => Hook,
  ) {
    this.factory = factory;
    this.init("after_task", hooksConfig?.after_task, AFTER_TASK_DEFAULTS);
    this.init("on_session_create", hooksConfig?.on_session_create);
    this.init("on_session_close", hooksConfig?.on_session_close);
    this.init("on_error", hooksConfig?.on_error);
  }

  private init(
    event: HookEventType,
    configs: HookConfig[] | undefined,
    defaults?: HookConfig[],
  ): void {
    const resolved = configs !== undefined ? configs : (defaults ?? []);
    this.hooks.set(event, resolved.map((c) => this.factory(c)));
  }

  async fire(context: HookContext): Promise<void> {
    for (const hook of this.hooks.get(context.eventType) ?? []) {
      try {
        await hook.run(context);
      } catch (e) {
        log.warn(`Hook "${hook.name}" 失败 (${context.eventType}): ${(e as Error).message}`);
      }
    }
  }
}
