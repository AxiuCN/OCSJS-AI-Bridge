/**
 * OpenAI 兼容协议适配器：POST {base_url}/v1/chat/completions。
 *
 * 覆盖大多数网关与自建兼容服务。差异点：
 * - 指令走 messages 里的 system 角色
 * - 图片用 content 数组里的 image_url 块（data URL 直接放进去）
 * - 结构化输出用 response_format: {type:"json_object"}
 * - 没有推理强度的通用参数：配了 reasoning_effort 也只能忽略（记入 notes，不假装支持）
 */

import { asRecord, asText, postJson, UpstreamError, type RawResponse, type UpstreamBackend, type UpstreamRequestContext } from "./base.js";

export interface OpenAiChatBackendOptions {
  name: string;
  url: string;
  apiKey: string;
  /** 默认开启结构化输出；上游不认 response_format 时可以关掉 */
  structuredOutput?: boolean;
  fetchImpl?: typeof fetch;
}

export function buildChatBody(context: UpstreamRequestContext, structuredOutput: boolean): Record<string, unknown> {
  const textParts: string[] = [];
  const contentParts: Array<Record<string, unknown>> = [];
  for (const block of context.prompt.content) {
    if (block.type === "text") {
      textParts.push(block.text);
      contentParts.push({ type: "text", text: block.text });
      continue;
    }
    // 归属说明已由 prompt 层生成在前一个 text 块里，这里只负责把图放上去。
    contentParts.push({ type: "image_url", image_url: { url: block.dataUrl } });
  }

  // 没有图片时用纯字符串 content，兼容不认 content 数组的旧服务。
  const hasImage = context.prompt.content.some((block) => block.type === "image");
  const userContent = hasImage ? contentParts : textParts.join("\n");

  const body: Record<string, unknown> = {
    model: context.model,
    stream: false,
    messages: [
      { role: "system", content: context.prompt.instructions },
      { role: "user", content: userContent },
    ],
  };
  if (structuredOutput) body.response_format = { type: "json_object" };
  return body;
}

export function buildChatResponse(body: unknown, backendName: string): RawResponse {
  const record = asRecord(body);
  const choices = record?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new UpstreamError("上游响应里没有 choices", backendName);
  }
  const first = asRecord(choices[0]);
  const message = asRecord(first?.message);
  const text = asText(message?.content);
  if (text === undefined) {
    const finishReason = asText(first?.finish_reason);
    throw new UpstreamError(
      `上游响应里没有 message.content${finishReason ? `（finish_reason=${finishReason}）` : ""}`,
      backendName,
    );
  }
  const response: RawResponse = { text };
  const usage = asRecord(record?.usage);
  if (usage) response.usage = usage;
  return response;
}

export class OpenAiChatBackend implements UpstreamBackend {
  readonly name: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly structuredOutput: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiChatBackendOptions) {
    this.name = options.name;
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.structuredOutput = options.structuredOutput ?? true;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(context: UpstreamRequestContext): Promise<RawResponse> {
    const body = buildChatBody(context, this.structuredOutput);
    const { parsed } = await postJson(
      this.name,
      this.url,
      body,
      { authorization: `Bearer ${this.apiKey}` },
      context.signal,
      this.fetchImpl,
    );
    return buildChatResponse(parsed, this.name);
  }
}
