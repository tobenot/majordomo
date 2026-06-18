import * as fs from "fs";
import * as path from "path";

/**
 * 增量写日记（Node 原生，跨平台，UTF-8 无 BOM）。
 * 沿用第二代习惯：一天一个文件 yyyy-MM-dd.md，每行带 HH:mm 时间戳，追加不覆盖。
 *
 * 用 Node 而非 write-diary.ps1：后者路径逻辑绑死在 majordomo 自身 repo，
 * 且 PowerShell 在 Linux 服务器上不可用。日记是人设层副作用，应跨平台。
 */
export function appendDiary(diaryDir: string, line: string): void {
  if (!fs.existsSync(diaryDir)) {
    fs.mkdirSync(diaryDir, { recursive: true });
  }
  const now = new Date();
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const file = path.join(diaryDir, `${date}.md`);
  fs.appendFileSync(file, `- ${time} ${line}\n`, { encoding: "utf8" });
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
