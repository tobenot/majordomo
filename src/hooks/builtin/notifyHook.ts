import { Hook, HookContext } from "../types";
import { NotifierBus } from "../../notify/factory";

/** Delegates to the existing NotifierBus (powershell/console/etc.). */
export class NotifyHook implements Hook {
  readonly name = "notify";

  constructor(private notifier: NotifierBus) {}

  run(context: HookContext): void {
    this.notifier.notify(context.text);
  }
}
