import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { WebSocket } from "ws";
import { Config } from "./config";
import { CoreDaemon } from "./daemon";

export interface SelfTestResult {
  ok: boolean;
  events: string[];
}

/**
 * 端到端自测：mock worker + template persona + WebSocket，验证创建会话、消息、权限、汇报。
 * 用 MAJORDOMO_HOME 临时目录隔离，不污染真实 ~/.majordomo。
 */
export async function runSelfTest(baseConfig: Config, projectRoot: string): Promise<SelfTestResult> {
  const tmpHome = path.join(projectRoot, ".codebuddy", "temp", `selftest-${Date.now()}`);
  const oldHome = process.env.MAJORDOMO_HOME;
  process.env.MAJORDOMO_HOME = tmpHome;

  const cfg: Config = JSON.parse(JSON.stringify(baseConfig));
  cfg.port = await pickPort(4500, 4800);
  cfg.worker.engine = "mock";
  cfg.persona.mode = "template";
  cfg.notifiers = ["console"];
  cfg.diaryDir = path.join(tmpHome, "diary");

  const events: string[] = [];
  const daemon = new CoreDaemon(cfg, projectRoot);

  try {
    await daemon.start();
    await driveClient(cfg.port, events);
    return { ok: true, events };
  } finally {
    await daemon.stop().catch(() => undefined);
    if (oldHome === undefined) delete process.env.MAJORDOMO_HOME;
    else process.env.MAJORDOMO_HOME = oldHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

function driveClient(port: number, events: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let sid = "";
    let reports = 0;
    const timer = setTimeout(() => reject(new Error("selftest timeout")), 15000);

    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", client: "tui" })));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      events.push(m.type);
      if (m.type === "welcome") {
        ws.send(JSON.stringify({ type: "create_session", name: "selftest" }));
      } else if (m.type === "session_created") {
        sid = m.session.id;
        ws.send(JSON.stringify({ type: "user_input", sessionId: sid, text: "hello" }));
      } else if (m.type === "persona_message") {
        reports++;
        if (reports === 1) {
          ws.send(JSON.stringify({ type: "user_input", sessionId: sid, text: "rm temporary file" }));
        } else {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      } else if (m.type === "permission_request") {
        ws.send(
          JSON.stringify({
            type: "permission_response",
            sessionId: m.sessionId,
            requestId: m.requestId,
            approve: true,
          })
        );
      } else if (m.type === "error") {
        clearTimeout(timer);
        reject(new Error(m.message));
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function pickPort(start: number, end: number): Promise<number> {
  const net = await import("net");
  for (let p = start; p <= end; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(p, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (ok) return p;
  }
  return 0;
}
