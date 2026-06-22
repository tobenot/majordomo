import * as fs from "fs";
import * as path from "path";
import { Hook, HookContext } from "../types";

/**
 * Generates a markdown summary report after each task.
 *
 * Output: `.majordomo/reports/YYYY-MM-DD_HHmm_sessionName.md`
 * Content: session info table + persona summary + original request + worker output.
 */
export class MarkdownReportHook implements Hook {
  readonly name = "markdown_report";

  constructor(private outputDir: string) {}

  run(context: HookContext): void {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    const ts = new Date(context.timestamp);
    const dateStr = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}`;
    const timeStr = `${pad(ts.getHours())}${pad(ts.getMinutes())}`;
    const filename = `${dateStr}_${timeStr}_${sanitize(context.sessionName)}.md`;
    const filePath = path.join(this.outputDir, filename);

    const content = [
      `# Task Report: ${context.sessionName}`,
      "",
      "| Field | Value |",
      "|-------|-------|",
      `| **Session ID** | ${context.sessionId} |`,
      `| **Profile** | ${context.profile} |`,
      `| **Engine** | ${context.engine ?? "?"} |`,
      `| **Working Directory** | ${context.cwd} |`,
      `| **Timestamp** | ${context.timestamp} |`,
      "",
      "---",
      "",
      "## Summary",
      "",
      context.text || "*（无摘要）*",
      "",
      ...(context.userText
        ? ["", "## Original Request", "", "> " + context.userText.replace(/\n/g, "\n> ")]
        : []),
      ...(context.workerText
        ? ["", "## Worker Output", "", "```", context.workerText.slice(0, 4000), "```"]
        : []),
      "",
    ].join("\n");

    fs.writeFileSync(filePath, content, { encoding: "utf8" });
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80);
}
