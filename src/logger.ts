/**
 * Minimal leveled logger for x-mcp.
 *
 * Writes to stderr so stdout stays clean. Token-safe by construction: callers
 * must never pass tokens here (the issue forbids printing them). Levels:
 * debug < info < warn < error.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function parseLogLevel(value: string | undefined): LogLevel {
  const v = (value ?? "info").toLowerCase();
  if (v in LEVEL_ORDER) return v as LogLevel;
  return "info";
}

export class Logger {
  private readonly level: number;

  constructor(level: LogLevel = "info") {
    this.level = LEVEL_ORDER[level];
  }

  private write(level: LogLevel, msg: string): void {
    if (LEVEL_ORDER[level] < this.level) return;
    const ts = new Date().toISOString();
    console.error(`[${ts}] [${level.toUpperCase()}] ${msg}`);
  }

  debug(msg: string): void {
    this.write("debug", msg);
  }
  info(msg: string): void {
    this.write("info", msg);
  }
  warn(msg: string): void {
    this.write("warn", msg);
  }
  error(msg: string): void {
    this.write("error", msg);
  }
}
