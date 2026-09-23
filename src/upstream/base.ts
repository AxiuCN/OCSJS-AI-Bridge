/**
 * 上游适配器的公共契约。
 *
 * 适配器只做一件事：把中立的 `PromptPayload` 翻译成某个协议的请求，
 * 再把响应文本中答案 JSON 抠出来。它**不做**任何答案语义处理
 * （字母映射、判断归一、分隔符拼接都由领域层负责），
 * 也不读全局配置——模型、参数、超时全部由路由层注入。
 */

import type { PromptPayload } from "../prompt.js";

/** 未经解析的模型输出。解析失败要抛错，不要返回空壳。 */
export interface RawResponse {
  text: string;
  /** 上游返回的用量信息；拿不到就是 undefined，不编造 */
  usage?: Record<string, unknown>;
}

export interface UpstreamRequestContext {
  prompt: PromptPayload;
  /** 该后端本次尝试使用的模型名 */
  model: string;
  /** 是否要求上游开启"思考"（Ollama 的 think） */
  think: boolean;
  /** openai_responses 的 reasoning.effort */
  reasoningEffort?: string;
  /** 由路由层按剩余预算给出的超时信号 */
  signal: AbortSignal;
}

export interface UpstreamBackend {
  readonly name: string;
  /** 发起一次请求并返回模型原始输出文本 */
  complete(context: UpstreamRequestContext): Promise<RawResponse>;
}

/** 上游级失败：可被路由层降级到下一个候选。 */
export class UpstreamError extends Error {
  override readonly name = "UpstreamError";
  constructor(
    message: string,
    readonly backendName: string,
    readonly detail?: { status?: number },
  ) {
    super(message);
  }
}

/** 模型输出的解析结果。`notes` 记录容错过程，最终并入 OCS 响应的 warnings。 */
export interface ParsedAnswer {
  answer: unknown;
  confidence: number;
  notes: string[];
}

const FENCED_JSON = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu;

function extractJsonText(raw: string): { text: string; note?: string } {
  const trimmed = raw.trim();
  const fenced = FENCED_JSON.exec(trimmed);
  if (fenced?.[1]) {
    return { text: fenced[1].trim(), note: "模型输出带有 Markdown 围栏，已剥离后解析" };
  }
  return { text: trimmed };
}

/** 从夹杂解释文字的输出里抠出第一个完整 JSON 对象。 */
function sliceFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/**
 * 容错解析模型输出。
 *
 * 顺序：整体 JSON → 抠出第一个 JSON 对象。两者都失败就抛错——
 * 宁可让路由换下一个后端，也不能猜一个答案出来。
 */
export function parseModelOutput(raw: string, backendName: string): ParsedAnswer {
  if (!raw.trim()) {
    throw new UpstreamError("上游返回了空内容", backendName);
  }
  const { text, note } = extractJsonText(raw);
  const notes: string[] = note ? [note] : [];

  const candidates: Array<{ text: string; fromSlice: boolean }> = [{ text, fromSlice: false }];
  const sliced = sliceFirstJsonObject(text);
  if (sliced !== undefined && sliced !== text) candidates.push({ text: sliced, fromSlice: true });

  const failures: string[] = [];
  for (const candidate of candidates) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(candidate.text);
    } catch (error) {
      failures.push((error as Error).message);
      continue;
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      failures.push("顶层不是 JSON 对象");
      continue;
    }
    const record = decoded as Record<string, unknown>;
    if (!("answer" in record)) {
      failures.push("缺少 answer 字段");
      continue;
    }
    if (candidate.fromSlice) notes.push("模型输出含额外内容，已抠取其中的 JSON 对象");
    const rawConfidence = record.confidence;
    const confidence =
      typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
        ? Math.min(1, Math.max(0, rawConfidence))
        : 0;
    return { answer: record.answer, confidence, notes };
  }

  throw new UpstreamError(`模型输出不是可解析的答案 JSON：${failures.join("；")}`, backendName);
}

/** 统一的 fetch 包装：连接失败、HTTP 错误码、非 JSON 都转成可读的 UpstreamError。 */
export async function postJson(
  backendName: string,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<{ status: number; parsed: unknown; text: string }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    const reason = signal.aborted ? "请求被中止（超时或客户端断开）" : (error as Error).message;
    throw new UpstreamError(`无法连接上游：${reason}`, backendName);
  }

  const text = await response.text();
  if (!response.ok) {
    const preview = text.trim().slice(0, 2000);
    throw new UpstreamError(
      `上游返回 HTTP ${response.status}：${preview || response.statusText || "空响应"}`,
      backendName,
      { status: response.status },
    );
  }
  if (!text.trim()) {
    throw new UpstreamError("上游返回了空响应体", backendName);
  }
  try {
    return { status: response.status, parsed: JSON.parse(text) as unknown, text };
  } catch {
    throw new UpstreamError(`上游返回的不是合法 JSON：${text.trim().slice(0, 500)}`, backendName);
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
