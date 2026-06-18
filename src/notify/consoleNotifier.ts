import { Notifier } from "./types";

/** 跨平台降级：把交接提醒打到 stderr。 */
export class ConsoleNotifier implements Notifier {
  readonly name = "console";

  notify(message: string): void {
    // 如果检测到前台 TUI 处于活动交互状态，聪明地静默，避免在前台双重打印破坏游标喵！
    if (process.env.MAJORDOMO_TUI_ACTIVE === "true") return;

    const ts = new Date().toLocaleTimeString();
    process.stderr.write(`\n\x1b[32m[${ts}] 🔔 交接提醒\x1b[0m\n${message}\n\n`);
  }
}
