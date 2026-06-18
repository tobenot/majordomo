/* 极简日志：带时间戳和级别，写 stderr 不污染协议 stdout。 */

type Level = "debug" | "info" | "warn" | "error";

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

let verbose = false;
export function setVerbose(v: boolean): void {
  verbose = v;
}

function emit(level: Level, scope: string, args: unknown[]): void {
  if (level === "debug" && !verbose) return;
  const ts = new Date().toISOString().slice(11, 19);
  const color = process.stderr.isTTY ? COLORS[level] : "";
  const reset = process.stderr.isTTY ? RESET : "";
  const prefix = `${color}[${ts}] ${level.toUpperCase().padEnd(5)} ${scope}${reset}`;
  // eslint-disable-next-line no-console
  console.error(prefix, ...args);
}

export function createLogger(scope: string) {
  return {
    debug: (...a: unknown[]) => emit("debug", scope, a),
    info: (...a: unknown[]) => emit("info", scope, a),
    warn: (...a: unknown[]) => emit("warn", scope, a),
    error: (...a: unknown[]) => emit("error", scope, a),
  };
}

export type Logger = ReturnType<typeof createLogger>;
