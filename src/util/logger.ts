import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Minimal file logger. The TUI owns the terminal, so nothing ever goes to stdout. */
export class Logger {
  private fd: number | null = null;

  constructor(
    readonly level: LogLevel = "info",
    file?: string,
    private readonly scope = "chatty",
  ) {
    if (file && level !== "silent") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.fd = fs.openSync(file, "a");
    }
  }

  child(scope: string): Logger {
    const c = Object.create(this) as Logger;
    (c as unknown as { scope: string }).scope = scope;
    return c;
  }

  private write(level: LogLevel, msg: string, extra?: unknown): void {
    if (this.fd === null || ORDER[level] < ORDER[this.level]) return;
    let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${msg}`;
    if (extra !== undefined) {
      line += ` ${extra instanceof Error ? (extra.stack ?? extra.message) : safeJson(extra)}`;
    }
    try {
      fs.writeSync(this.fd, `${line}\n`);
    } catch {
      // logging must never crash the app
    }
  }

  debug(msg: string, extra?: unknown) {
    this.write("debug", msg, extra);
  }
  info(msg: string, extra?: unknown) {
    this.write("info", msg, extra);
  }
  warn(msg: string, extra?: unknown) {
    this.write("warn", msg, extra);
  }
  error(msg: string, extra?: unknown) {
    this.write("error", msg, extra);
  }

  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {}
      this.fd = null;
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const silentLogger = new Logger("silent");
