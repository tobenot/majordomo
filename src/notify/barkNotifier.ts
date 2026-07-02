import { Notifier } from "./types";
import { BarkConfig } from "../core/config";
import { createLogger } from "../core/logger";

const log = createLogger("notify:bark");

/**
 * Bark 手机推送（人设复命 → 手机弹出）。见设计稿 §3.4。
 *
 * 与 PowershellNotifier 是两层接力：你在电脑前靠本机弹窗，离场了靠 Bark。
 * best-effort：推送失败只 warn，绝不影响中枢主流程。
 */
export class BarkNotifier implements Notifier {
  readonly name = "bark";

  constructor(private cfg: BarkConfig) {}

  async notify(message: string): Promise<void> {
    if (!this.cfg.deviceKey) {
      log.warn("Bark 缺少 deviceKey（配置 bark.deviceKey 或 env BARK_DEVICE_KEY），跳过推送");
      return;
    }
    const base = this.cfg.baseUrl.replace(/\/+$/, "");
    const url = `${base}/${encodeURIComponent(this.cfg.deviceKey)}/${encodeURIComponent(message.slice(0, 400))}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const resp = await fetch(url, { method: "GET", signal: controller.signal });
      if (!resp.ok) log.warn(`Bark 推送返回 HTTP ${resp.status}`);
    } catch (e) {
      log.warn(`Bark 推送失败: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
