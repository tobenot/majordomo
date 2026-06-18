import * as fs from "fs";
import * as path from "path";
import { expandHome, globalDir } from "./paths";
import { createLogger } from "./logger";

const log = createLogger("config");

export interface Profile {
  /** 工作层可执行命令：claude | claude-internal | tclaude ... */
  command: string;
  /** 个人规则目录（坑：内网版是 ~/.claude-internal 而非 ~/.claude） */
  personalDir: string;
}

export interface WorkerConfig {
  /** auto: SDK → CLI → mock；sdk: 可选 @anthropic-ai/claude-code；cli/claude: 直接调 profile.command；mock: 回显 */
  engine: "auto" | "sdk" | "cli" | "claude" | "mock";
  maxTurns?: number;
  timeoutMs?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface PersonaConfig {
  mode: "auto" | "api" | "template";
  name: string;
  style: string;
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
}

export const DEFAULT_CONFIG: Config = {
  host: "127.0.0.1",
  port: 4317,
  activeProfile: "home",
  profiles: {
    home: { command: "claude", personalDir: "~/.claude" },
    internal: { command: "claude-internal", personalDir: "~/.claude-internal" },
    tclaude: { command: "tclaude", personalDir: "~/.tclaude" },
  },
  permissionMode: "auto",
  worker: { engine: "auto", maxTurns: 8, timeoutMs: 10 * 60 * 1000 },
  persona: { mode: "auto", name: "指挥官", style: "cat-girl-maid" },
  notifiers: ["powershell", "console"],
  diaryDir: ".codebuddy/memory",
};

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
  ];
}

export interface LoadedConfig {
  config: Config;
  sources: string[];
}

export function loadConfig(projectRoot: string = process.cwd()): LoadedConfig {
  let cfg: Config = DEFAULT_CONFIG;
  const sources: string[] = [];
  for (const file of configCandidates(projectRoot)) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = parseJsonc(fs.readFileSync(file, "utf8")) as Partial<Config>;
      cfg = deepMerge(cfg, parsed);
      sources.push(file);
    } catch (e) {
      log.warn(`配置文件解析失败，已跳过: ${file}: ${(e as Error).message}`);
    }
  }
  // 自洽校验
  if (!cfg.profiles[cfg.activeProfile]) {
    log.warn(
      `activeProfile "${cfg.activeProfile}" 在 profiles 中不存在，回退到第一个可用 profile`
    );
    cfg.activeProfile = Object.keys(cfg.profiles)[0] ?? "home";
  }
  return { config: cfg, sources };
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
