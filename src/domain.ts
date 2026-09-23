/**
 * 领域类型：与上游协议完全无关。
 *
 * 这一层是"回填行为不随后端变化"的保证——无论走 Ollama、chat/completions
 * 还是 Responses，题目归一、图片准备、答案格式化都在这里完成一次。
 */

export interface Attachment {
  /** 语义标签，例如「题干/材料图片 1」「选项 B 图片 1」 */
  label: string;
  /** 题目文本里出现的远端地址 */
  sourceUrl: string;
  /** 浏览器直接提交的 data URL */
  dataUrl: string;
}

export interface NormalizedQuestion {
  /** 归一后的题型：single / multiple / judgement / completion / line / fill / reader / choice ... */
  questionType: string;
  /** URL 已替换为 [题干/材料图片 n]、挖空已标记为 [BLANK_n] 的题干 */
  title: string;
  /** 同样处理过的选项文本 */
  options: string[];
  /** 未经标记的原始选项文本，用于把选项字母映射回原文 */
  originalOptions: string[];
  attachments: Attachment[];
  /** 修改版 OCS 才会传的结构化字段（material / subquestions 等） */
  context: Record<string, unknown>;
  /** 是否只使用了原版 OCS 的三个字段（title / options / type） */
  standardOcs: boolean;
}

/** 附件准备失败：属于题目级错误，不触发后端降级。 */
export class ImagePreparationError extends Error {
  override readonly name = "ImagePreparationError";
}

export function optionLabel(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSequence(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** 从任意值取出可读文本；用于把模型返回的嵌套结构摊平。 */
export function asTrimmedString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}
