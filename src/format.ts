/**
 * 答案格式化：把模型返回的任意结构转成 OCS 能回填的字符串。
 *
 * 行为契约对齐现有 response_service 的 format_ocs_answer：
 * - 原版 OCS：递归摊平为一维字符串，选择题把选项字母映射回原始选项文本
 * - 修改版 OCS：连线/匹配取 pairs，复合题保留 JSON 供浏览器绑定，其余按分隔符拼接
 * - 判断题归一为「正确 / 错误」
 * 这些规则与上游协议无关，三种适配器共用同一套。
 */

import { asTrimmedString, isRecord, isSequence, type NormalizedQuestion } from "./domain.js";

const CORRECT_WORDS = new Set(["true", "t", "yes", "1", "对", "是", "正确", "√"]);
const INCORRECT_WORDS = new Set(["false", "f", "no", "0", "错", "否", "错误", "×", "x"]);

const COMPOUND_TYPES = new Set(["reader", "reading", "listening", "composite"]);
const CHOICE_TYPES = new Set(["single", "multiple", "choice"]);
/** 字母答案需要归一为大写的题型（含完形/阅读/连线，原实现对它们同样归一）。 */
const LETTER_TYPES = new Set(["single", "multiple", "evaluation", "choice", "fill", "reader", "line"]);

// 原实现使用 re.IGNORECASE，选项字母大小写都要能识别（如 "b" → "B"）。
const MULTI_LETTER_PATTERN = /^\s*[A-Z]\s*(?:[,，、#;；|]\s*[A-Z]\s*)+$/iu;
const LETTER_ONLY_PATTERN = /^[\sA-Z,，、#;；|]+$/iu;
const SINGLE_LETTER_PATTERN = /^\s*([A-Z])(?:[.、:：)）])?\s*$/iu;

function flattenStandardAnswer(answer: unknown, values: string[]): void {
  if (answer === null || answer === undefined) return;
  if (isRecord(answer)) {
    // 原实现优先处理 pairs：{"pairs": [{"left","right"}]} 只取右侧值。
    if ("pairs" in answer) {
      flattenStandardAnswer(answer.pairs, values);
      return;
    }
    const preferred = ["answer", "options", "text", "right", "value", "option", "content"] as const;
    for (const key of preferred) {
      if (key in answer) {
        flattenStandardAnswer(answer[key], values);
        return;
      }
    }
    for (const item of Object.values(answer)) flattenStandardAnswer(item, values);
    return;
  }
  if (isSequence(answer)) {
    for (const item of answer) flattenStandardAnswer(item, values);
    return;
  }
  const text = asTrimmedString(answer);
  if (text) values.push(text);
}

/** 选项字母 → 原始选项文本；非字母或越界的值原样保留。 */
function mapLettersToOptions(values: readonly string[], question: NormalizedQuestion): string[] {
  const mapped: string[] = [];
  for (const value of values) {
    const matched = SINGLE_LETTER_PATTERN.exec(value);
    if (matched) {
      const index = matched[1]!.toUpperCase().charCodeAt(0) - 65;
      if (index >= 0 && index < question.originalOptions.length) {
        mapped.push(question.originalOptions[index]!);
        continue;
      }
    }
    mapped.push(value);
  }
  return mapped;
}

/**
 * 取值层面的归一：字母转大写、判断题转「正确/错误」。
 * 字母归一对单选/多选/测评/选择都生效（原实现同样把 ["a","c"] 归一为 A#C）。
 */
function upperCaseSingleLetter(value: string): string {
  const matched = SINGLE_LETTER_PATTERN.exec(value);
  return matched ? matched[1]!.toUpperCase() : value;
}

function normalizeStandardValues(values: readonly string[], question: NormalizedQuestion): string[] {
  return values.map((value) => {
    const normalized = LETTER_TYPES.has(question.questionType) ? upperCaseSingleLetter(value) : value;
    if (question.questionType === "judgement") {
      const lowered = normalized.toLowerCase();
      if (CORRECT_WORDS.has(lowered)) return "正确";
      if (INCORRECT_WORDS.has(lowered)) return "错误";
    }
    return normalized;
  });
}

function formatStandardOcs(answer: unknown, question: NormalizedQuestion, separator: string): string {
  const values: string[] = [];
  // pairs 结构在摊平时会先取到 right（pairs 内的每一项），顺序即左侧顺序。
  flattenStandardAnswer(answer, values);

  if (CHOICE_TYPES.has(question.questionType) && question.originalOptions.length > 0) {
    const expanded: string[] = [];
    for (const value of values) {
      // 只有多选才拆 "A,C" 这类连写；单选保持原样，避免误拆选项文本。
      if (question.questionType !== "single" && MULTI_LETTER_PATTERN.test(value.toUpperCase())) {
        expanded.push(...(value.toUpperCase().match(/[A-Z]/gu) ?? []));
      } else {
        expanded.push(value);
      }
    }
    // 精确选项文本可能本身就是英文单词（如 first/third）。映射完成后直接返回，
    // 避免纯字母兜底把单词拆成 F#I#R...
    return normalizeStandardValues(mapLettersToOptions(expanded, question), question).join(separator);
  }

  return normalizeStandardValues(values, question).join(separator);
}

function flattenPairs(answer: unknown): unknown {
  if (isRecord(answer) && "pairs" in answer) return answer.pairs;
  return answer;
}

function formatExtendedAnswer(answer: unknown, question: NormalizedQuestion, separator: string): string {
  if (isRecord(answer)) {
    if ("options" in answer) return formatExtendedAnswer(answer.options, question, separator);
    if ("text" in answer) return formatExtendedAnswer(answer.text, question, separator);
    if (question.questionType === "line" || question.questionType === "matching") {
      if ("pairs" in answer) return formatExtendedAnswer(answer.pairs, question, separator);
      return Object.values(answer)
        .map((item) => asTrimmedString(item))
        .filter(Boolean)
        .join(separator);
    }
    return JSON.stringify(answer);
  }

  if (isSequence(answer)) {
    const needsJson =
      COMPOUND_TYPES.has(question.questionType) &&
      answer.some((item) => isRecord(item) || isSequence(item));
    if (needsJson) return JSON.stringify(answer);

    const values: string[] = [];
    for (const item of answer) {
      if (isRecord(item)) {
        const value =
          item.right ?? item.answer ?? item.value ?? item.option ?? (Object.keys(item).length === 1 ? Object.values(item)[0] : undefined);
        const text = asTrimmedString(value);
        if (text) values.push(text);
        continue;
      }
      const text = asTrimmedString(item);
      if (text) values.push(text);
    }
    // 数组里的单选字母同样加大写（如 ["a","c"] → A#C）；非字母原样保留。
    return values.map(upperCaseSingleLetter).join(separator);
  }

  const text = asTrimmedString(answer);
  if (question.questionType === "single") {
    const matched = SINGLE_LETTER_PATTERN.exec(text);
    if (matched) return matched[1]!.toUpperCase();
  }
  if (LETTER_TYPES.has(question.questionType) && text && LETTER_ONLY_PATTERN.test(text.toUpperCase())) {
    const letters = text.toUpperCase().match(/[A-Z]/gu) ?? [];
    if (letters.length > 0) return [...new Set(letters)].join(separator);
  }
  if (question.questionType === "judgement") {
    const lowered = text.toLowerCase();
    if (CORRECT_WORDS.has(lowered)) return "正确";
    if (INCORRECT_WORDS.has(lowered)) return "错误";
  }
  return text;
}

export function formatOcsAnswer(answer: unknown, question: NormalizedQuestion, separator: string): string {
  if (question.standardOcs) {
    return formatStandardOcs(answer, question, separator);
  }
  return formatExtendedAnswer(flattenPairs(answer), question, separator);
}
