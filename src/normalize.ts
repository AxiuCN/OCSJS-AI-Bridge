/**
 * 题目归一：把 OCS 题库请求转成与上游协议无关的题目表示。
 *
 * 行为契约对齐现有 response_service 的 normalize_question：
 * - 题干与选项里的图片地址替换为 `[题干/材料图片 n]` / `[选项 X 图片 n]` 标记
 * - 挖空统一标记为 `[BLANK_n]`（下标/括号内空白/连续下划线三种写法）
 * - 结构化字段（material / subquestions / ...）递归处理并带作用域前缀
 * - 同一地址只下载一次，语义标签合并到同一个附件上
 */

import {
  asTrimmedString,
  isBlank,
  isRecord,
  isSequence,
  optionLabel,
  type Attachment,
  type NormalizedQuestion,
} from "./domain.js";

const URL_PATTERN = /https?:\/\/[^\s<>"'\])}，。；;]+/giu;
const BLANK_PATTERN = /([(（[])[ \t\u00a0]{2,}([)）\]])|(?:_{3,}|＿{2,}|﹍{2,})/gu;

/** 只有修改版 OCS 才会输出的字段；出现任一即视为非原版 OCS 请求。 */
const EXTENDED_OCS_FIELDS = [
  "option_items",
  "images",
  "attachments",
  "material",
  "subquestions",
  "shared_options",
  "matching_groups",
  "native_type",
  "blank_count",
  "underline_count",
] as const;

const QUESTION_TYPE_ALIASES: Record<string, string> = {
  singlechoice: "single",
  single_choice: "single",
  单选: "single",
  单选题: "single",
  multiplechoice: "multiple",
  multiple_choice: "multiple",
  多选: "multiple",
  多选题: "multiple",
  judgment: "judgement",
  truefalse: "judgement",
  true_false: "judgement",
  判断: "judgement",
  判断题: "judgement",
  fillblank: "completion",
  fill_blank: "completion",
  填空: "completion",
  填空题: "completion",
  简答: "completion",
  简答题: "completion",
};

const CORRECT_WORDS = new Set(["true", "t", "yes", "1", "对", "是", "正确", "√"]);
const INCORRECT_WORDS = new Set(["false", "f", "no", "0", "错", "否", "错误", "×", "x"]);

export function splitOptions(value: unknown): string[] {
  if (isSequence(value)) {
    return value.map((item) => asTrimmedString(item)).filter((item) => item.length > 0);
  }
  const text = asTrimmedString(value);
  if (!text) return [];
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 把各种挖空写法统一成 [BLANK_n]，编号接在已有编号之后。 */
export function normalizeBlanks(value: string): string {
  const existing = [...value.matchAll(/\[BLANK_(\d+)\]/giu)].map((matched) => Number(matched[1]));
  let counter = existing.length > 0 ? Math.max(...existing) : 0;
  return value.replace(BLANK_PATTERN, (_match, open?: string, close?: string) => {
    counter += 1;
    const marker = `[BLANK_${counter}]`;
    return open !== undefined && close !== undefined ? `${open}${marker}${close}` : marker;
  });
}
export function normalizeQuestionType(value: unknown, options: readonly string[]): string {
  const raw = asTrimmedString(value).toLowerCase();
  const aliased = QUESTION_TYPE_ALIASES[raw] ?? raw;
  if (aliased && !["unknown", "undefined", "null", "none"].includes(aliased)) {
    return aliased;
  }
  if (options.length > 0) {
    const normalized = new Set(
      options.map((option) => option.replace(/[\s、,，;；:：.．()（）]/gu, "").toLowerCase()),
    );
    if (options.length === 2 && [...normalized].every((item) => CORRECT_WORDS.has(item) || INCORRECT_WORDS.has(item))) {
      return "judgement";
    }
    // 原版 OCS 的其它平台不一定稳定提供 type。保留一个不预设单选/多选的
    // 选择类型，让模型按题意返回一个或多个选项字母。
    return "choice";
  }
  return "completion";
}

function incomingAttachments(value: unknown): Attachment[] {
  if (!isSequence(value)) return [];
  const result: Attachment[] = [];
  value.forEach((item, index) => {
    if (typeof item === "string") {
      const trimmed = item.trim();
      result.push({
        label: `未分类图片 ${index + 1}`,
        sourceUrl: trimmed.startsWith("http") ? trimmed : "",
        dataUrl: trimmed.startsWith("data:") ? trimmed : "",
      });
      return;
    }
    if (!isRecord(item)) return;
    result.push({
      label: asTrimmedString(item.label) || `未分类图片 ${index + 1}`,
      sourceUrl: asTrimmedString(item.source_url) || asTrimmedString(item.url),
      dataUrl: asTrimmedString(item.data_url) || asTrimmedString(item.data),
    });
  });
  return result;
}

/**
 * 把文本里的图片地址替换成标记，并把 (地址, 标签) 交给收集器。
 *
 * 顶层与深层的作用域写法不同，因此由调用方给出标签模板：
 *   顶层 `图片 {n}`   → 「题干/材料图片 1」「选项 A图片 1」
 *   深层 `图片 {n}`   → 「material图片 1」「subquestions 1/options 1图片 1」
 * 作用域自身已带必要的空格（如 `选项 A`、`subquestions 1`），模板不再追加空格。
 */
function replaceUrls(
  text: string,
  scope: string,
  labelTemplate: string,
  collect: (sourceUrl: string, label: string) => void,
): string {
  let index = 0;
  return text.replace(URL_PATTERN, (matched) => {
    index += 1;
    const marker = `${scope}${labelTemplate.replace("{n}", String(index))}`;
    collect(matched, marker);
    return `[${marker}]`;
  });
}

export function normalizeQuestion(payload: Record<string, unknown>): NormalizedQuestion {
  const rawTitle = asTrimmedString(payload.title);
  const rawOptions = splitOptions(payload.option_items ?? payload.options);
  const supplied = incomingAttachments(payload.images ?? payload.attachments);

  const discovered: Attachment[] = [];
  const collect = (sourceUrl: string, label: string): void => {
    discovered.push({ label, sourceUrl, dataUrl: "" });
  };

  const titleWithImages = replaceUrls(rawTitle, "题干/材料", "图片 {n}", collect);
  const optionsWithImages = rawOptions.map((option, index) =>
    replaceUrls(option, `选项 ${optionLabel(index)}`, "图片 {n}", collect),
  );

  const contextKeys = [
    "material",
    "subquestions",
    "shared_options",
    "matching_groups",
    "native_type",
    "blank_count",
    "underline_count",
  ] as const;
  const rawContext: Record<string, unknown> = {};
  for (const key of contextKeys) {
    if (!isBlank(payload[key])) rawContext[key] = payload[key];
  }

  const normalizeContext = (value: unknown, scope: string): unknown => {
    if (isRecord(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        result[key] = normalizeContext(item, `${scope}/${key}`);
      }
      return result;
    }
    if (isSequence(value)) {
      return value.map((item, index) => normalizeContext(item, `${scope} ${index + 1}`));
    }
    if (typeof value !== "string") return value;
    return normalizeBlanks(replaceUrls(value, scope, "图片 {n}", collect));
  };

  const context: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawContext)) {
    context[key] = normalizeContext(value, key);
  }

  // 扁平选项与结构化子题可能指向同一张图，只送一次，但保留全部语义标签。
  const deduplicated: Attachment[] = [];
  const seen = new Map<string, number>();
  for (const item of discovered) {
    const existing = seen.get(item.sourceUrl);
    if (existing === undefined) {
      seen.set(item.sourceUrl, deduplicated.length);
      deduplicated.push(item);
      continue;
    }
    const previous = deduplicated[existing]!;
    const labels = [...new Set([...previous.label.split("；"), item.label])];
    deduplicated[existing] = { label: labels.join("；"), sourceUrl: item.sourceUrl, dataUrl: previous.dataUrl };
  }

  // OCSJS 5.x 的图片题优化：题库配置通过 data.images.handler 提交纯 data URL 数组，
  // 顺序与它内部的 [图片N] 严格一致（题干 URL 在前、选项 URL 在后）。
  // 这些图片浏览器已经下载好了，服务端不该再按 URL 下载一遍，否则同一张图会重复上传。
  const anonymousSupplied = supplied.filter((item) => !item.sourceUrl && item.dataUrl);
  const allSuppliedAnonymous = supplied.length > 0 && anonymousSupplied.length === supplied.length;

  const suppliedByUrl = new Map<string, Attachment[]>();
  for (const item of supplied) {
    if (!item.sourceUrl) continue;
    const list = suppliedByUrl.get(item.sourceUrl);
    if (list) list.push(item);
    else suppliedByUrl.set(item.sourceUrl, [item]);
  }

  const attachments: Attachment[] = [];
  const used = new Set<Attachment>();

  if (allSuppliedAnonymous && anonymousSupplied.length === deduplicated.length) {
    // 数量完全对齐时按顺序绑定，沿用服务端解析出的语义标签（题干/选项 N），
    // 这样模型仍能知道每张图属于谁，同时不再触发服务端下载。
    deduplicated.forEach((item, index) => {
      const suppliedItem = anonymousSupplied[index]!;
      used.add(suppliedItem);
      attachments.push({ label: item.label, sourceUrl: item.sourceUrl, dataUrl: suppliedItem.dataUrl });
    });
  } else {
    for (const item of deduplicated) {
      const candidates = suppliedByUrl.get(item.sourceUrl) ?? [];
      const reused = candidates.find((candidate) => !used.has(candidate));
      if (reused) {
        used.add(reused);
        attachments.push({ label: item.label, sourceUrl: item.sourceUrl, dataUrl: reused.dataUrl });
      } else {
        attachments.push(item);
      }
    }
  }

  for (const item of supplied) {
    if (!used.has(item)) attachments.push(item);
  }

  const title = normalizeBlanks(titleWithImages);
  const options = optionsWithImages.map((option) => normalizeBlanks(option));
  const standardOcs = !EXTENDED_OCS_FIELDS.some((key) => !isBlank(payload[key]));

  return {
    questionType: normalizeQuestionType(payload.type ?? payload.question_type, options),
    title,
    options,
    originalOptions: rawOptions,
    attachments,
    context,
    standardOcs,
  };
}
