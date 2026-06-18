#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "./core/config";
import { CoreDaemon } from "./core/daemon";
import { runTui } from "./tui/client";
import { startWebServer } from "./web/server";
import { setVerbose, createLogger } from "./core/logger";

const log = createLogger("cli");

/** 极简 .env 加载（避免引 dotenv 依赖）。只填充未设置的变量。 */
function loadDotEnv(root: string): void {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

/** 尝试启动内嵌 daemon；若端口被占用（已有外部 daemon），返回 null。 */
async function ensureDaemon(
  cfg: ReturnType<typeof loadConfig>["config"],
  root: string
): Promise<CoreDaemon | null> {
  const daemon = new CoreDaemon(cfg, root);
  try {
    await daemon.start();
    return daemon;
  } catch (e: any) {
    if (e && e.code === "EADDRINUSE") {
      log.info(`检测到已有 daemon 在 ${cfg.host}:${cfg.port}，直接连接`);
      return null;
    }
    throw e;
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("commander")
    .description("majordomo · 指挥官 —— Claude Code 多会话调度器")
    .version("0.1.0")
    .option("-H, --host <host>", "core daemon host")
    .option("-p, --port <port>", "core daemon port", (v) => parseInt(v, 10))
    .option("-v, --verbose", "详细日志");

  const root = process.cwd();
  loadDotEnv(root);

  function buildCfg() {
    const opts = program.opts<{ host?: string; port?: number; verbose?: boolean }>();
    if (opts.verbose) setVerbose(true);
    const { config, sources } = loadConfig(root);
    if (opts.host) config.host = opts.host;
    if (opts.port) config.port = opts.port;
    return { config, sources };
  }

  // ── daemon：前台运行 core ──
  program
    .command("daemon")
    .description("前台运行 core daemon（长驻）")
    .action(async () => {
      const { config } = buildCfg();
      const d = new CoreDaemon(config, root);
      await d.start();
      log.info("daemon 已启动，Ctrl+C 退出");
      process.on("SIGINT", async () => {
        await d.stop();
        process.exit(0);
      });
    });

  // ── web：启动 Web 面板（必要时内嵌 daemon）──
  program
    .command("web")
    .description("启动 Web 面板（带立绘位/会话管理）")
    .option("--web-port <port>", "Web 端口（默认 daemon 端口+1）", (v) => parseInt(v, 10))
    .action(async (cmdOpts: { webPort?: number }) => {
      const { config } = buildCfg();
      const embedded = await ensureDaemon(config, root);
      const webPort = cmdOpts.webPort || config.port + 1;
      const info = await startWebServer({
        webHost: config.host,
        webPort,
        daemonHost: config.host,
        daemonPort: config.port,
      });
      log.info(`打开 http://${info.host}:${info.port}`);
      process.on("SIGINT", async () => {
        if (embedded) await embedded.stop();
        process.exit(0);
      });
    });

  // ── config：打印解析后的配置 ──
  program
    .command("config")
    .description("打印解析后的配置与来源")
    .action(() => {
      const { config, sources } = buildCfg();
      // eslint-disable-next-line no-console
      console.log("配置来源:", sources.length ? sources.join(", ") : "（仅默认值）");
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(config, null, 2));
    });

  // ── profile：切换活跃 profile（持久化）──
  program
    .command("profile <name>")
    .description("切换活跃 profile（claude/internal/tclaude），只影响新开会话")
    .action((name: string) => {
      const { config } = buildCfg();
      if (!config.profiles[name]) {
        log.error(`未知 profile: ${name}，可用: ${Object.keys(config.profiles).join(", ")}`);
        process.exit(1);
      }
      const { persistActiveProfile } = require("./core/config");
      persistActiveProfile(name);
      log.info(`已切换 activeProfile → ${name}`);
    });

  // ── 默认（attach）：内嵌 daemon + TUI ──
  program
    .command("attach", { isDefault: true })
    .description("连接 daemon 并进入 TUI（默认）")
    .action(async () => {
      const { config } = buildCfg();
      await ensureDaemon(config, root);
      // 给 daemon 一点点启动时间
      await new Promise((r) => setTimeout(r, 120));
      await runTui(config.host, config.port);
    });

  await program.parseAsync(process.argv);
}

main().catch((e) => {
  log.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
