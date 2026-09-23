/**
 * OpenAI Responses 协议适配器：POST {base_url}/v1/responses。
 *
 * 与现有 response_service 的上游调用保持同一形状（instructions / input content 块 /
 * reasoning.effort / text.format / store:false），这样既有部署可以平滑迁移过来对拍。
 */

import { asRecord, asText, postJson, UpstreamError, type RawResponse, type UpstreamBackend, type UpstreamRequestContext } from "./base.js";

export interface OpenAiResponsesBackendOptions {
  name: string;
  url: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export function buildResponsesBody(context: UpstreamRequestContext): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  for (const block of context.prompt.content) {
    if (block.type === "text") {
      content.push({ type: "input_text", text: block.text });
      continue;
    }
    // 归属说明已由 prompt 层生成在前一个 text 块里，这里只负责把图放上去。
    content.push({ type: "input_image", image_url: block.dataUrl, detail: "auto" });
  }

  const body: Record<string, unknown> = {
    model: context.model,
    instructions: context.prompt.instructions,
    input: [{ role: "user", content }],
    text: { format: { type: "json_object" } },
    store: false,
  };
  if (context.reasoningEffort) body.reasoning = { effort: context.reasoningEffort };
  return body;
}

export function buildResponsesResponse(body: unknown, backendName: string): RawResponse {
  const record = asRecord(body);
  let text = asText(record?.output_text);
  if (text === undefined) {
    const output = record?.output;
    for (const item of Array.isArray(output) ? output : []) {
      const entry = asRecord(item);
      const content = entry?.content;
      for (const child of Array.isArray(content) ? content : []) {
        const block = asRecord(child);
        if (block?.type === "output_text" || block?.type === "text") {
          const candidate = asText(block.text);
          if (candidate !== undefined) {
            text = candidate;
            break;
          }
        }
      }
      if (text !== undefined) break;
    }
  }
  if (text === undefined) {
    throw new UpstreamError("上游响应里没有文本答案", backendName);
  }
  const response: RawResponse = { text };
  const usage = asRecord(record?.usage);
  if (usage) response.usage = usage;
  return response;
}

export class OpenAiResponsesBackend implements UpstreamBackend {
  readonly name: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiResponsesBackendOptions) {
    this.name = options.name;
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(context: UpstreamRequestContext): Promise<RawResponse> {
    const body = buildResponsesBody(context);
    const { parsed } = await postJson(
      this.name,
      this.url,
      body,
      { authorization: `Bearer ${this.apiKey}` },
      context.signal,
      this.fetchImpl,
    );
    return buildResponsesResponse(parsed, this.name);
  }
}
