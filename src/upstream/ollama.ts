/**
 * Ollama 原生协议适配器：POST {base_url}/api/chat。
 *
 * 与 OpenAI 系协议的差异（这里负责吸收，核心层无感）：
 * - 指令走 messages 里的 system 角色，没有独立的 instructions 字段
 * - 图片是 message.images 里的**纯 base64**（不带 data: 前缀）
 * - 结构化输出用 format: "json"（老版本是顶层布尔）
 * - 推理开关是 think（布尔）；模型不支持时上游会报错，属于上游级失败
 */

import {
  asRecord,
  asText,
  postJson,
  UpstreamError,
  type RawResponse,
  type UpstreamBackend,
  type UpstreamRequestContext,
} from "./base.js";

export interface OllamaBackendOptions {
  name: string;
  url: string;
  /** 默认开启结构化输出；仅当上游明确拒绝 format 时才需要关掉 */
  structuredOutput?: boolean;
  fetchImpl?: typeof fetch;
}

const DATA_URL_PATTERN = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/iu;

export function extractBase64(dataUrl: string): string {
  const matched = DATA_URL_PATTERN.exec(dataUrl.trim());
  if (!matched) {
    // 已经是纯 base64 时原样使用，避免因为来源不同就报错
    return dataUrl.trim().replace(/\s+/gu, "");
  }
  return matched[2]!.replace(/\s+/gu, "");
}

export function buildOllamaBody(context: UpstreamRequestContext, structuredOutput: boolean): Record<string, unknown> {
  const contentParts: string[] = [];
  const images: string[] = [];
  for (const block of context.prompt.content) {
    if (block.type === "text") contentParts.push(block.text);
    else {
      contentParts.push(`[图片：${block.label}]`);
      images.push(extractBase64(block.dataUrl));
    }
  }

  const userMessage: Record<string, unknown> = { role: "user", content: contentParts.join("\n") };
  if (images.length > 0) userMessage.images = images;

  const body: Record<string, unknown> = {
    model: context.model,
    stream: false,
    messages: [
      { role: "system", content: context.prompt.instructions },
      userMessage,
    ],
  };
  if (structuredOutput) body.format = "json";
  // think 只在需要时显式下发，避免给不支持思考的模型带来额外失败面。
  if (context.think) body.think = true;
  return body;
}

/**
 * 上游返回了空正文。
 *
 * 这是 Ollama 的**偶发**行为，实测在并发请求或长时间思考后出现：
 * 请求本身成功（HTTP 200、done_reason 通常为 stop），但 message.content 为空。
 * 带上 done_reason / eval_count / thinking 长度，否则线上无法判断是截断、空输出还是格式变化。
 */
export class OllamaEmptyContentError extends UpstreamError {
  override readonly name: string = "OllamaEmptyContentError";
  constructor(
    message: string,
    backendName: string,
    readonly kind: "empty" | "missing",
  ) {
    super(message, backendName);
  }
}

export function buildOllamaResponse(body: unknown, backendName: string): RawResponse {
  const record = asRecord(body);
  const message = asRecord(record?.message);
  const content = message?.content;
  const text = asText(content) ?? asText(record?.response);
  if (text === undefined) {
    const doneReason = typeof record?.done_reason === "string" ? record.done_reason : "unknown";
    const evalCount = typeof record?.eval_count === "number" ? record.eval_count : "?";
    const thinkingLen = typeof message?.thinking === "string" ? message.thinking.length : 0;
    const keys = Object.keys(record ?? {}).join(",");
    if (content === "") {
      throw new OllamaEmptyContentError(
        `上游返回了空 content（done_reason=${doneReason}，eval_count=${evalCount}，thinking 长度=${thinkingLen}）`,
        backendName,
        "empty",
      );
    }
    throw new OllamaEmptyContentError(
      `上游响应里没有 message.content（done_reason=${doneReason}，响应键=${keys || "空"}）`,
      backendName,
      "missing",
    );
  }
  const usage: Record<string, unknown> = {};
  for (const key of ["prompt_eval_count", "eval_count", "total_duration", "done_reason"] as const) {
    const value = record?.[key];
    if (value !== undefined) usage[key] = value;
  }
  const response: RawResponse = { text };
  if (Object.keys(usage).length > 0) response.usage = usage;
  return response;
}

export class OllamaBackend implements UpstreamBackend {
  readonly name: string;
  private readonly url: string;
  private readonly structuredOutput: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaBackendOptions) {
    this.name = options.name;
    this.url = options.url;
    this.structuredOutput = options.structuredOutput ?? true;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async attempt(context: UpstreamRequestContext, think: boolean): Promise<RawResponse> {
    const body = buildOllamaBody({ ...context, think }, this.structuredOutput);
    const { parsed } = await postJson(this.name, this.url, body, {}, context.signal, this.fetchImpl);
    return buildOllamaResponse(parsed, this.name);
  }

  async complete(context: UpstreamRequestContext): Promise<RawResponse> {
    try {
      return await this.attempt(context, context.think);
    } catch (error) {
      // 已中止或已超时就不要重试了，否则只是白白多等一轮。
      if (!(error instanceof OllamaEmptyContentError) || context.signal.aborted) throw error;
      // 空正文是已知偶发问题，且"思考过长"是主要诱因。
      // 关闭 thinking 重试一次：实测耗时通常降到原来的 1/5，且能拿到正文。
      const retried = await this.attempt(context, false);
      return {
        ...retried,
        notes: [
          `上游首次未返回正文（${error.message}），已关闭 thinking 重试成功`,
          ...(retried.notes ?? []),
        ],
      };
    }
  }
}
