import * as path from "path";
import { Hook, HookConfig } from "./types";
import { DiaryHook } from "./builtin/diaryHook";
import { NotifyHook } from "./builtin/notifyHook";
import { ShellHook } from "./builtin/shellHook";
import { MarkdownReportHook } from "./builtin/markdownReportHook";
import { NotifierBus } from "../notify/factory";

export interface HookDependencies {
  diaryDir: string;
  notifier: NotifierBus;
  projectRoot: string;
}

/**
 * Returns a factory function that creates Hook instances from config.
 * Uses dependency injection so HookRunner doesn't need to know about deps.
 */
export function createHookFactory(deps: HookDependencies): (config: HookConfig) => Hook {
  return (config: HookConfig): Hook => {
    switch (config.type) {
      case "diary":
        return new DiaryHook(deps.diaryDir, path.join(deps.projectRoot, ".majordomo", "diary"));
      case "notify":
        return new NotifyHook(deps.notifier);
      case "shell": {
        const cwd = config.cwd
          ? (config.cwd.startsWith(".") ? path.resolve(deps.projectRoot, config.cwd) : config.cwd)
          : deps.projectRoot;
        return new ShellHook({
          command: config.command,
          cwd,
          shell: config.shell,
          timeoutMs: config.timeoutMs,
        });
      }
      case "markdown_report": {
        const outputDir = path.resolve(deps.projectRoot, config.output_dir ?? ".majordomo/reports");
        return new MarkdownReportHook(outputDir);
      }
      default:
        throw new Error(`未知 hook 类型: ${(config as any).type}`);
    }
  };
}
