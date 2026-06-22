import { PersonaEngine } from "./types";
import { ApiPersona } from "./apiPersona";
import { TemplatePersona } from "./templatePersona";
import { PersonaConfig } from "../core/config";
import { createLogger } from "../core/logger";

const log = createLogger("persona:factory");

/**
 * 按配置选择人设层实现。
 * - api      → 强制 API，缺密钥则降级模板
 * - template → 离线模板
 * - auto     → 有密钥走 API，否则模板（开箱即跑）
 */
export function createPersona(cfg: PersonaConfig): PersonaEngine {
  if (cfg.mode === "template") {
    return new TemplatePersona(cfg.name, cfg.projectInstructions);
  }

  const api = ApiPersona.fromEnv(cfg.name, cfg.style, cfg.projectInstructions);

  if (cfg.mode === "api") {
    if (api) return api;
    log.warn("persona.mode=api 但缺少 PERSONA_API_* 环境变量，降级到离线模板");
    return new TemplatePersona(cfg.name, cfg.projectInstructions);
  }

  // auto
  if (api) {
    log.info(`检测到人设层 API 配置，使用 ${api.apiFormat} 模式`);
    return api;
  }

  log.info("未检测到人设层 API 配置，使用离线模板（开箱即跑）");
  return new TemplatePersona(cfg.name, cfg.projectInstructions);
}
