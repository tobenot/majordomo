import { Notifier } from "./types";
import { PowershellNotifier } from "./powershellNotifier";
import { ConsoleNotifier } from "./consoleNotifier";
import { BarkNotifier } from "./barkNotifier";
import { BarkConfig } from "../core/config";
import { createLogger } from "../core/logger";

const log = createLogger("notify:factory");

/** 多通知器聚合：按顺序全部触发，单个失败不影响其他。 */
export class NotifierBus implements Notifier {
  readonly name = "bus";
  constructor(private notifiers: Notifier[]) {}

  notify(message: string): void {
    for (const n of this.notifiers) {
      try {
        void n.notify(message);
      } catch (e) {
        log.warn(`通知器 ${n.name} 失败: ${(e as Error).message}`);
      }
    }
  }
}

export function createNotifier(names: string[], bark?: BarkConfig): NotifierBus {
  const list: Notifier[] = [];
  for (const name of names) {
    switch (name) {
      case "powershell":
        if (process.platform === "win32") list.push(new PowershellNotifier());
        break;
      case "console":
        list.push(new ConsoleNotifier());
        break;
      case "bark":
        if (bark) list.push(new BarkNotifier(bark));
        else log.warn("notifiers 含 bark 但缺少 bark 配置，已跳过");
        break;
      default:
        log.warn(`未知通知器: ${name}`);
    }
  }
  if (list.length === 0) list.push(new ConsoleNotifier());
  return new NotifierBus(list);
}
