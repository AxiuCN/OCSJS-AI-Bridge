/**
 * 结构化日志：一行一个 JSON 对象，便于重定向到文件后检索。
 * 不引日志库，避免为 30 行功能增加依赖面。
 */

import { inspect } from "node:util";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export function resolveLogLevel(value: string | undefined): LogLevel {
  const normalized = (value ?? "info").trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(normalized) ? (normalized as LogLevel) : "info";
}

/** Error 不参与 JSON 序列化，需要显式摊平成字段。 */
function normalizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function serialize(fields: LogFields): string {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    output[key] = normalizeValue(value);
  }
  try {
    return JSON.stringify(output);
  } catch {
    return inspect(fields, { depth: 2, breakLength: Infinity });
  }
}

export interface LoggerOptions {
  level?: LogLevel;
  base?: LogFields;
  write?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? resolveLogLevel(process.env.BRIDGE_LOG_LEVEL);
  const base = options.base ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const threshold = LEVEL_ORDER[level];

  const build = (bound: LogFields): Logger => {
    const emit = (entryLevel: LogLevel) => (message: string, fields?: LogFields) => {
      if (LEVEL_ORDER[entryLevel] < threshold) return;
      write(
        serialize({
          ts: new Date().toISOString(),
          level: entryLevel,
          msg: message,
          ...bound,
          ...(fields ?? {}),
        }),
      );
    };
    return {
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
      child: (fields: LogFields) => build({ ...bound, ...fields }),
    };
  };

  return build(base);
}
