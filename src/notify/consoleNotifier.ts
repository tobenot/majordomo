import { Notifier } from "./types";

/** 跨平台降级：把交接提醒打到 stderr。 */
export class ConsoleNotifier implements Notifier {
  readonly name = "console";

  notify(message: string): void {
    const ts = new Date().toLocaleTimeString();
    process.stderr.write(`\n\x1b[32m[${ts}] 🔔 交接提醒\x1b[0m\n${message}\n\n`);
  }
}
