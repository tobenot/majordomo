import * as fs from "fs";
import * as path from "path";
import { Hook, HookContext } from "../types";

/**
 * Diary hook: appends a one-line entry to the project diary.
 * Format: `- HH:mm [sessionId] text`
 * Writes to both the configured diaryDir AND project/.majordomo/diary/.
 */
export class DiaryHook implements Hook {
  readonly name = "diary";

  constructor(private diaryDir: string, private projectDiaryDir?: string) {}

  run(context: HookContext): void {
    const dirs = [this.diaryDir];
    if (this.projectDiaryDir) dirs.push(this.projectDiaryDir);

    const now = new Date();
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const oneLine = (context.workerText || context.text).replace(/\s+/g, " ").slice(0, 200);

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${date}.md`);
      fs.appendFileSync(file, `- ${time} [${context.sessionId}] ${oneLine}\n`, { encoding: "utf8" });
    }
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
