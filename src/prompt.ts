/**
 * 提示构建：把归一后的题目 + 已准备好的图片，装成一个与上游协议无关的请求模型。
 *
 * 三种适配器都消费同一个 `PromptPayload`，各自翻译成自己的协议形状；
 * 适配器不允许再碰答案语义，也不允许改写指令文本——指令属于领域层。
 */

import { optionLabel, type NormalizedQuestion } from "./domain.js";
import type { PreparedImage } from "./images.js";

export interface PromptPayload {
  /** system / instructions 文本 */
  instructions: string;
  /** 题目 JSON 原文（适配器按自己的协议包装，不要改动内容） */
  userPayloadText: string;
  /** 按序排列的图文块：先给一段"这张图属于谁"的说明，再给图本身 */
  content: PromptContentBlock[];
}

export type PromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; dataUrl: string; label: string };

const STANDARD_SHAPE_HINTS: Record<string, string> = {
  single: "单选题 answer 返回选项字母，例如 A",
  multiple: '多选题 answer 返回选项字母数组，例如 ["A", "C"]',
  choice: "选择题按题意返回一个选项字母，或在多选时返回选项字母数组",
  judgement: "判断题 answer 只返回 正确 或 错误",
  line: "连线题 answer 返回按左侧项目顺序排列的一维字符串数组",
  fill: "完形填空 answer 返回各小题选项字母的一维顺序数组",
  reader: "阅读理解 answer 返回各小题答案的一维顺序数组；选择子题使用选项字母",
};

const EXTENDED_SHAPE_HINTS: Record<string, string> = {
  single: "单选题 answer 返回选项字母，例如 A",
  multiple: '多选题 answer 返回选项字母数组，例如 ["A", "C"]',
  evaluation: '测评选择题 answer 返回选项字母数组，例如 ["A", "C"]',
  judgement: "判断题 answer 只返回 正确 或 错误",
  shortanswer: "简答、名词解释或论述题 answer 直接返回可填写正文",
  calculation: "计算题 answer 直接返回可填写的计算过程和结果正文",
  accounting: "分录题 answer 返回按作答区顺序排列的字符串数组",
  writing: "写作题 answer 直接返回可填写正文",
  fill: "完形填空 answer 返回各小题选项字母的顺序数组",
  cloze: "完形填空 answer 返回各小题选项字母的顺序数组",
  line: "连线或匹配题 answer 返回按左侧项目顺序排列的右侧值数组",
  matching: "连线或匹配题 answer 返回 pairs 数组，每项包含 left 和 right",
  ordering: "排序题 answer 返回按正确顺序排列的选项字母或选项文本数组",
  reader: "阅读理解 answer 按子题顺序返回答案数组；混合题型可返回带 answer 的对象数组",
  reading: "阅读理解 answer 按子题顺序返回答案数组；混合题型可返回带 answer 的对象数组",
  listening: "听力复合题 answer 按子题顺序返回答案数组；混合题型可返回带 answer 的对象数组",
  shared_options: "共用选项题 answer 按子题顺序返回所选共用选项字母或文本数组",
  composite: "资料/复合题 answer 按 subquestions 顺序返回答案数组，必须保留每个子题的答案结构",
  poll: "投票题没有唯一知识答案，不要臆造；answer 返回空字符串",
  oral: "口语题需要录音作答，answer 返回空字符串",
  oral_evaluation: "口语测评需要录音作答，answer 返回空字符串",
};

const STANDARD_FALLBACK_HINT = "answer 只返回字符串或一维字符串数组";
const EXTENDED_FALLBACK_HINT = "按题目要求返回字符串、数组或保留对应关系的对象";

/** 以 [BLANK_n] 标记为准计算挖空数量，兼容显式 blank_count。 */
export function countBlanks(title: string, explicit: unknown): number {
  const matched = Number(explicit);
  const explicitCount = Number.isFinite(matched) && matched > 0 ? Math.trunc(matched) : 0;
  const markers = title.match(/\[BLANK_\d+\]/giu)?.length ?? 0;
  return Math.max(explicitCount, markers);
}

/** 是否按原版 OCS 的保守口径作答：只有三个标准字段、且没有结构化上下文。 */
export function usesStandardOcsShape(question: NormalizedQuestion): boolean {
  return question.standardOcs && Object.keys(question.context).length === 0;
}

export function buildInstructions(question: NormalizedQuestion): string {
  const blankCount = countBlanks(question.title, question.context.blank_count);
  const completionHint = blankCount
    ? "填空题 answer 返回按 [BLANK_n] 顺序排列的字符串数组"
    : "填空/主观题若只有一个作答区，answer 直接返回可填写正文；有多个作答区才返回顺序数组";

  if (usesStandardOcsShape(question)) {
    const shapeHint = STANDARD_SHAPE_HINTS[question.questionType] ?? STANDARD_FALLBACK_HINT;
    const completionShape =
      question.questionType === "completion" ? completionHint : "主观题 answer 只放可直接填写的正文";
    return (
      "你是原版 OCS 的课程题目答题服务。只输出 JSON 对象 " +
      '{"answer": ..., "confidence": 0到1}，不要解释、不要 Markdown。' +
      "原版 OCS 只提供题干、换行分隔的选项和基础题型，不要假设存在额外 DOM 结构。" +
      "若服务端从题干或选项 URL 下载到了图片，必须依据附件前的题干/选项标签判断对应关系。" +
      "answer 只能是字符串或一维字符串数组；不得返回嵌套对象。" +
      `${shapeHint}。${completionShape}。`
    );
  }

  const shapeHint = EXTENDED_SHAPE_HINTS[question.questionType] ?? EXTENDED_FALLBACK_HINT;
  const completionShape =
    question.questionType === "completion" || question.questionType === "other"
      ? completionHint
      : "主观题 answer 只放可直接填写的正文";
  return (
    "你是 OCS 的课程题目答题服务。只输出 JSON 对象 " +
    '{"answer": ..., "confidence": 0到1}，不要解释、不要 Markdown。' +
    "必须严格依据附件前的对应标签判断图片属于题干、材料还是某个选项。" +
    "[BLANK_n] 表示第 n 个挖空，[UNDERLINE]...[/UNDERLINE] 表示原文下划线，答案必须保持顺序和对应关系。" +
    `${shapeHint}。${completionShape}。`
  );
}

/** 题干 + 选项 + 结构化上下文，作为一条 JSON 文本交给模型。 */
export function buildUserPayload(question: NormalizedQuestion): string {
  const payload: Record<string, unknown> = {
    question_type: question.questionType,
    title: question.title,
    options: question.options.map((text, index) => ({ label: optionLabel(index), text })),
  };
  Object.assign(payload, question.context);
  return JSON.stringify(payload, null, 2);
}

export function buildPrompt(question: NormalizedQuestion, images: readonly PreparedImage[]): PromptPayload {
  const userPayloadText = buildUserPayload(question);
  const content: PromptContentBlock[] = [{ type: "text", text: userPayloadText }];
  images.forEach((image, index) => {
    content.push({
      type: "text",
      text: `[附件 ${index + 1} 对应关系] ${image.label}。紧随其后的图片只属于这个标签。`,
    });
    content.push({ type: "image", dataUrl: image.dataUrl, label: image.label });
  });
  return { instructions: buildInstructions(question), userPayloadText, content };
}
