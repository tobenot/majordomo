import * as fs from "fs";
import * as path from "path";
import { expandHome, globalDir } from "./paths";
import { createLogger } from "./logger";
import type { HooksConfig, HookConfig } from "../hooks/types";

const log = createLogger("config");

export interface Profile {
  /** 工作层可执行命令：claude | claude-internal | tclaude ... */
  command: string;
  /** 个人规则目录（坑：内网版是 ~/.claude-internal 而非 ~/.claude） */
  personalDir: string;
}

export interface WorkerConfig {
  /** auto: SDK → mock；sdk: @anthropic-ai/claude-agent-sdk 常驻会话；mock: 回显 */
  engine: "auto" | "sdk" | "mock";
  maxTurns?: number;
  timeoutMs?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface PersonaConfig {
  mode: "auto" | "api" | "template";
  name: string;
  style: string;
  /** 从 .majordomo/persona.md 加载的项目专属人设指令。 */
  projectInstructions?: string;
}

/** 中枢配置：Bifrost 上报入口。 */
export interface HubConfig {
  /** POST 上报路径（挂在 daemon 的 HTTP server 上，与 WebSocket 同端口）。 */
  ingestPath: string;
  /** 逐窗口 persona 复命的节流间隔（毫秒）：同一窗口两次复命至少隔这么久，避免高频 Stop 炸手机。 */
  personaThrottleMs: number;
}

/** Bark 手机推送配置。deviceKey 建议放 env（BARK_DEVICE_KEY），别进仓。 */
export interface BarkConfig {
  baseUrl: string;
  deviceKey?: string;
}

export interface Config {
  host: string;
  port: number;
  activeProfile: string;
  profiles: Record<string, Profile>;
  permissionMode: string;
  worker: WorkerConfig;
  persona: PersonaConfig;
  notifiers: string[];
  diaryDir: string;
  hub: HubConfig;
  bark?: BarkConfig;
  /** 工作流 hooks。不配置则 after_task 默认 diary+notify。 */
  hooks?: HooksConfig;
}

export const DEFAULT_CONFIG: Config = {
  host: "127.0.0.1",
  port: 4350, // 避开 WXWork 占用的 4317（见 memory）。Bifrost report.config.jsonc 上报地址与此对齐。
  activeProfile: "claude",
  profiles: {
    claude: { command: "claude", personalDir: "~/.claude" },
    internal: { command: "claude-internal", personalDir: "~/.claude-internal" },
    tclaude: { command: "tclaude", personalDir: "~/.tclaude" },
  },
  permissionMode: "auto",
  worker: { engine: "auto", timeoutMs: 10 * 60 * 1000 },
  persona: { mode: "auto", name: "指挥官", style: "cat-girl-maid" },
  notifiers: ["powershell", "console"],
  diaryDir: ".codebuddy/memory",
  hub: { ingestPath: "/ingest", personaThrottleMs: 15000 },
};

const WORKER_ENGINES = new Set(["auto", "sdk", "mock"]);
const PERSONA_MODES = new Set(["auto", "api", "template"]);

/**
 * 极简 JSONC 解析：去掉 // 行注释、/* *\/ 块注释、对象/数组尾逗号，再 JSON.parse。
 * 自洽防御：跳过字符串字面量内部，避免误删 URL 里的 //。
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inStr = false;
  let strCh = "";
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === strCh) {
        inStr = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      strCh = c;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  // 去掉尾逗号： ,} 或 ,]
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(out);
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (typeof base !== "object" || base === null) return (override as T) ?? base;
  const result: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const key of Object.keys(override ?? {})) {
    const ov = (override as any)[key];
    const bv = (base as any)[key];
    if (
      ov &&
      typeof ov === "object" &&
      !Array.isArray(ov) &&
      bv &&
      typeof bv === "object" &&
      !Array.isArray(bv)
    ) {
      result[key] = deepMerge(bv, ov);
    } else if (ov !== undefined) {
      result[key] = ov;
    }
  }
  return result as T;
}

/** 候选配置文件路径，按优先级从低到高（后者覆盖前者）。 */
function configCandidates(projectRoot: string): string[] {
  return [
    path.join(globalDir(), "config.jsonc"),
    path.join(globalDir(), "config.json"),
    path.join(projectRoot, "config.jsonc"),
    path.join(projectRoot, "config.json"),
    path.join(projectRoot, ".majordomo", "config.jsonc"),
    path.join(projectRoot, ".majordomo", "config.json"),
  ];
}

export interface LoadedConfig {
  config: Config;
  sources: string[];
}

export function loadConfig(projectRoot: string = process.cwd()): LoadedConfig {
  let cfg: Config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const sources: string[] = [];
  let globalActiveProfile: string | undefined;

  for (const file of configCandidates(projectRoot)) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = parseJsonc(fs.readFileSync(file, "utf8")) as Partial<Config>;
      if (isGlobalConfig(file) && typeof parsed.activeProfile === "string") {
        globalActiveProfile = parsed.activeProfile;
      }
      cfg = deepMerge(cfg, parsed);
      sources.push(file);
    } catch (e) {
      log.warn(`配置文件解析失败，已跳过: ${file}: ${(e as Error).message}`);
    }
  }

  // 加载人设指令：全局 base + 项目 append。
  const parts: string[] = [];
  const globalPersonaMd = path.join(globalDir(), "persona.md");
  if (fs.existsSync(globalPersonaMd)) {
    const g = fs.readFileSync(globalPersonaMd, "utf8").trim();
    if (g) parts.push(g);
    log.info(`加载全局人设: ${globalPersonaMd} (${g.length} 字符)`);
  }
  const projectPersonaMd = path.join(projectRoot, ".majordomo", "persona.md");
  if (fs.existsSync(projectPersonaMd)) {
    const p = fs.readFileSync(projectPersonaMd, "utf8").trim();
    if (p) {
      parts.push(p);
      log.info(`加载项目人设: ${projectPersonaMd} (${p.length} 字符)`);
    }
  }
  if (parts.length) {
    cfg.persona = { ...cfg.persona, projectInstructions: parts.join("\n\n") };
  }

  cfg = normalizeConfig(cfg);
  // activeProfile 是用户级偏好：profile 命令写全局配置，即使项目 config.jsonc 含 activeProfile 也应生效。
  if (globalActiveProfile && cfg.profiles[globalActiveProfile]) {
    cfg.activeProfile = globalActiveProfile;
  }

  if (!cfg.profiles[cfg.activeProfile]) {
    log.warn(
      `activeProfile "${cfg.activeProfile}" 在 profiles 中不存在，回退到第一个可用 profile`
    );
    cfg.activeProfile = Object.keys(cfg.profiles)[0] ?? "claude";
  }
  return { config: cfg, sources };
}

function isGlobalConfig(file: string): boolean {
  return path.dirname(file) === globalDir();
}

function normalizeConfig(cfg: Config): Config {
  if (!cfg || typeof cfg !== "object") cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (typeof cfg.host !== "string" || !cfg.host.trim()) cfg.host = DEFAULT_CONFIG.host;
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) cfg.port = DEFAULT_CONFIG.port;
  if (!cfg.profiles || typeof cfg.profiles !== "object" || Array.isArray(cfg.profiles)) {
    cfg.profiles = DEFAULT_CONFIG.profiles;
  }
  for (const [name, p] of Object.entries(cfg.profiles)) {
    if (!p || typeof p.command !== "string" || !p.command.trim()) {
      log.warn(`profile "${name}" 缺少 command，已移除`);
      delete cfg.profiles[name];
      continue;
    }
    if (typeof p.personalDir !== "string" || !p.personalDir.trim()) {
      p.personalDir = `~/.${p.command}`;
    }
  }
  if (Object.keys(cfg.profiles).length === 0) cfg.profiles = DEFAULT_CONFIG.profiles;
  if (!WORKER_ENGINES.has(cfg.worker?.engine)) cfg.worker = { ...cfg.worker, engine: DEFAULT_CONFIG.worker.engine };
  if (cfg.worker.maxTurns !== undefined && (!Number.isInteger(cfg.worker.maxTurns) || cfg.worker.maxTurns < 1)) {
    delete cfg.worker.maxTurns;
  }
  if (cfg.worker.timeoutMs !== undefined && (!Number.isInteger(cfg.worker.timeoutMs) || cfg.worker.timeoutMs < 1000)) {
    delete cfg.worker.timeoutMs;
  }
  if (!Array.isArray(cfg.worker.allowedTools)) delete cfg.worker.allowedTools;
  if (!Array.isArray(cfg.worker.disallowedTools)) delete cfg.worker.disallowedTools;
  if (!PERSONA_MODES.has(cfg.persona?.mode)) cfg.persona = { ...DEFAULT_CONFIG.persona, ...cfg.persona, mode: DEFAULT_CONFIG.persona.mode };
  if (!Array.isArray(cfg.notifiers)) cfg.notifiers = DEFAULT_CONFIG.notifiers;
  if (typeof cfg.diaryDir !== "string" || !cfg.diaryDir.trim()) cfg.diaryDir = DEFAULT_CONFIG.diaryDir;
  // 中枢配置
  if (!cfg.hub || typeof cfg.hub !== "object") cfg.hub = { ...DEFAULT_CONFIG.hub };
  if (typeof cfg.hub.ingestPath !== "string" || !cfg.hub.ingestPath.startsWith("/")) {
    cfg.hub.ingestPath = DEFAULT_CONFIG.hub.ingestPath;
  }
  if (!Number.isInteger(cfg.hub.personaThrottleMs) || cfg.hub.personaThrottleMs < 0) {
    cfg.hub.personaThrottleMs = DEFAULT_CONFIG.hub.personaThrottleMs;
  }
  // Bark：deviceKey 可从 env 兜底注入
  if (cfg.bark) {
    if (typeof cfg.bark.baseUrl !== "string" || !cfg.bark.baseUrl.trim()) delete cfg.bark;
    else if (!cfg.bark.deviceKey && process.env.BARK_DEVICE_KEY) cfg.bark.deviceKey = process.env.BARK_DEVICE_KEY;
  }
  // 校验 hooks 配置
  if (cfg.hooks) {
    const VALID_EVENTS = new Set(["after_task", "on_session_create", "on_session_close", "on_error"]);
    for (const [event, hooks] of Object.entries(cfg.hooks)) {
      if (!VALID_EVENTS.has(event) || !Array.isArray(hooks)) {
        delete (cfg.hooks as any)[event];
        log.warn(`hooks.${event} 无效，已忽略`);
        continue;
      }
      for (let i = (hooks as HookConfig[]).length - 1; i >= 0; i--) {
        const h = (hooks as HookConfig[])[i];
        if (!h || typeof h.type !== "string") {
          (hooks as HookConfig[]).splice(i, 1);
          log.warn(`hooks.${event}[${i}] 格式不正确，已移除`);
        }
      }
    }
    if (Object.keys(cfg.hooks).length === 0) delete cfg.hooks;
  }
  return cfg;
}

/** 解析某个 profile，展开 ~ 路径。 */
export function resolveProfile(cfg: Config, name?: string): { name: string; profile: Profile } {
  const pName = name && cfg.profiles[name] ? name : cfg.activeProfile;
  const p = cfg.profiles[pName];
  return {
    name: pName,
    profile: { command: p.command, personalDir: expandHome(p.personalDir) },
  };
}

/**
 * 持久化 activeProfile 切换。写到全局 config.jsonc（不静默改其他字段）。
 * 注意：profile 切换只影响新开 session，由调用方保证。
 */
export function persistActiveProfile(profile: string): void {
  const file = path.join(globalDir(), "config.jsonc");
  let existing: any = {};
  if (fs.existsSync(file)) {
    try {
      existing = parseJsonc(fs.readFileSync(file, "utf8"));
    } catch {
      existing = {};
    }
  } else {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  existing.activeProfile = profile;
  fs.writeFileSync(file, JSON.stringify(existing, null, 2), "utf8");
}
