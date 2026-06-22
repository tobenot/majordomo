import * as fs from "fs";
import * as path from "path";
import { Hook, HookContext } from "../types";

/**
 * Diary hook: appends a one-line entry to the project diary.
 * Extracted from src/core/diary.ts. Format: `- HH:mm [sessionId] text`
 */
export class DiaryHook implements Hook {
  readonly name = "diary";

  constructor(private diaryDir: string) {}

  run(context: HookContext): void {
    if (!fs.existsSync(this.diaryDir)) {
      fs.mkdirSync(this.diaryDir, { recursive: true });
    }
    const now = new Date();
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    // Use workerText (English) when available; fallback to persona text
    const oneLine = (context.workerText || context.text).replace(/\s+/g, " ").slice(0, 200);
    const file = path.join(this.diaryDir, `${date}.md`);
    fs.appendFileSync(file, `- ${time} [${context.sessionId}] ${oneLine}\n`, { encoding: "utf8" });
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
