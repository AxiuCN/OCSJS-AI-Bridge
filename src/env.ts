/**
 * 环境变量读取与占位符展开。
 *
 * - `.env` 自解析（不引 dotenv）；真实环境变量优先于 .env 文件
 * - `${VAR}` / `${VAR:-default}` 展开，只对字符串值生效
 * - 仍含 `${` 的字符串一律视为错误，避免把字面量当成已配置的值
 */

import { existsSync, readFileSync } from "node:fs";

const PLACEHOLDER_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/;

export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
      const quote = value[0]!;
      if (value.endsWith(quote)) value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    result[key] = value;
  }
  return result;
}

/** 读取 .env（存在才读），不覆盖已存在的真实环境变量。 */
export function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const parsed = parseEnvFile(readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return parsed;
}

function lookup(name: string, fallback: string | undefined): string | undefined {
  const value = process.env[name];
  if (value !== undefined) return value;
  return fallback;
}

/** 展开字符串中的全部 `${VAR}` / `${VAR:-default}`；缺失且无默认值时报错。 */
export function expandString(value: string, path: string): string {
  let current = value;
  for (let round = 0; round < 16; round += 1) {
    const matched = PLACEHOLDER_PATTERN.exec(current);
    if (!matched) return current;
    const [token, name, fallback] = matched;
    const resolved = lookup(name!, fallback);
    if (resolved === undefined) {
      throw new Error(
        `配置项 ${path} 引用了未设置的环境变量 \${${name}}，且未提供默认值。` +
          `请在 .env 或系统环境变量中设置 ${name}。`,
      );
    }
    current = current.slice(0, matched.index) + resolved + current.slice(matched.index + token!.length);
  }
  return current;
}

/** 递归展开任意 JSON 结构里的字符串，非字符串原样返回。 */
export function expandDeep(value: unknown, path: string): unknown {
  if (typeof value === "string") return expandString(value, path);
  if (Array.isArray(value)) return value.map((item, index) => expandDeep(item, `${path}[${index}]`));
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      result[key] = expandDeep(item, path ? `${path}.${key}` : key);
    }
    return result;
  }
  return value;
}

/** 展开后仍残留 `${` 说明写法有问题（例如嵌套占位符或拼错的变量名）。 */
export function findUnresolvedPlaceholders(value: unknown, path: string): string[] {
  if (typeof value === "string") {
    return value.includes("${") ? [`${path} 展开后仍包含 \${ 占位符：${value}`] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findUnresolvedPlaceholders(item, `${path}[${index}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      findUnresolvedPlaceholders(item, path ? `${path}.${key}` : key),
    );
  }
  return [];
}
