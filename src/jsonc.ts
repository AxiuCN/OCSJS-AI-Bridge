/**
 * JSONC 解析：标准 JSON + `//` 行注释 + 尾随逗号。
 *
 * 只使用标准库实现，避免为一件小事引入依赖。剥离注释时会跟踪字符串状态，
 * 因此 `"http://host"` 里的 `//` 与字符串内的 `,]` 都不会被误伤。
 */

export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        if (next !== undefined) {
          out += next;
          i += 1;
        }
        continue;
      }
      if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      if (i < text.length) out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** 去掉对象/数组末尾多余逗号（仅在字符串外生效）。 */
export function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        const next = text[i + 1];
        if (next !== undefined) {
          out += next;
          i += 1;
        }
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j += 1;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 解析 JSONC 文本。
 * @throws SyntaxError 语法错误时抛出，带位置信息
 */
export function parseJsonc(text: string): unknown {
  // Windows 记事本等编辑器会写入 UTF-8 BOM，标准 JSON.parse 不接受，这里统一剥掉。
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const cleaned = stripTrailingCommas(stripJsonComments(withoutBom));
  return JSON.parse(cleaned) as unknown;
}
