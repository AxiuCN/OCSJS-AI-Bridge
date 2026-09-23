/**
 * 上游适配器测试：用打桩 fetch 断言请求形状与响应解析。
 *
 * 这里只验证"协议翻译"是否正确——答案语义（字母映射、判断归一）由领域层测试负责。
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import { normalizeQuestion } from "../src/normalize.js";
import type { PreparedImage } from "../src/images.js";
import { buildPrompt, type PromptPayload } from "../src/prompt.js";
import {
  UpstreamError,
  parseModelOutput,
  postJson,
  type UpstreamRequestContext,
} from "../src/upstream/base.js";
import { OllamaBackend, buildOllamaBody, buildOllamaResponse, extractBase64 } from "../src/upstream/ollama.js";
import { OpenAiChatBackend, buildChatBody, buildChatResponse } from "../src/upstream/openai_chat.js";
import { OpenAiResponsesBackend, buildResponsesBody, buildResponsesResponse } from "../src/upstream/openai_responses.js";

const PIXEL = `data:image/png;base64,${Buffer.from("png").toString("base64")}`;
const ANSWER_JSON = JSON.stringify({ answer: ["A", "C"], confidence: 0.9 });

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function stubFetch(
  responder: (captured: Captured) => Response | Promise<Response>,
): { impl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const captured: Captured = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    calls.push(captured);
    return responder(captured);
  }) as typeof fetch;
  return { impl, calls };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function makePrompt(options: { withImage?: boolean } = {}): PromptPayload {
  const payload: Record<string, unknown> = {
    title: "看图 https://cx.test/stem.png",
    options: "甲\n乙",
    type: "single",
  };
  const images: PreparedImage[] =
    options.withImage === false ? [] : [{ label: "题干/材料图片 1", dataUrl: PIXEL }];
  return buildPrompt(
    normalizeQuestion(images.length > 0 ? { ...payload, images: [{ source_url: "https://cx.test/stem.png", data_url: PIXEL }] } : payload),
    images,
  );
}

function context(overrides: Partial<UpstreamRequestContext> = {}): UpstreamRequestContext {
  return {
    prompt: makePrompt(),
    model: "qwen3.5:9b",
    think: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("upstream：容错解析", () => {
  it("解析标准答案 JSON 并夹紧 confidence", () => {
    const parsed = parseModelOutput('{"answer":"A","confidence":3}', "b");
    assert.equal(parsed.answer, "A");
    assert.equal(parsed.confidence, 1);
    assert.deepEqual(parsed.notes, []);
  });

  it("confidence 非法时归零，不伪造置信度", () => {
    assert.equal(parseModelOutput('{"answer":"A","confidence":"高"}', "b").confidence, 0);
    assert.equal(parseModelOutput('{"answer":"A"}', "b").confidence, 0);
    assert.equal(parseModelOutput('{"answer":"A","confidence":true}', "b").confidence, 0);
  });

  it("剥离 Markdown 围栏并记录容错说明", () => {
    const parsed = parseModelOutput('```json\n{"answer":"B"}\n```', "b");
    assert.equal(parsed.answer, "B");
    assert.equal(parsed.notes.length, 1);
    assert.match(parsed.notes[0]!, /Markdown 围栏/u);
  });

  it("从夹杂解释文字的输出里抠出 JSON 对象", () => {
    const parsed = parseModelOutput('好的，答案是：{"answer":"C","confidence":0.5} 以上。', "b");
    assert.equal(parsed.answer, "C");
    assert.match(parsed.notes[0]!, /抠取/u);
  });

  it("字符串里的大括号不干扰抠取", () => {
    const parsed = parseModelOutput('{"answer":"a{b}c","confidence":0.1}', "b");
    assert.equal(parsed.answer, "a{b}c");
  });

  it("无法解析时抛上游错误，绝不返回猜测的答案", () => {
    for (const raw of ["", "   ", "完全不是 JSON", "[1,2,3]", '{"confidence":0.5}']) {
      assert.throws(
        () => parseModelOutput(raw, "backend-x"),
        (error: unknown) => {
          assert.ok(error instanceof UpstreamError);
          assert.equal(error.backendName, "backend-x");
          return true;
        },
        `输入 ${JSON.stringify(raw)} 应当抛错`,
      );
    }
  });
});

describe("upstream：postJson", () => {
  it("HTTP 错误码带出上游响应片段", async () => {
    const { impl } = stubFetch(() => new Response("model not found", { status: 404 }));
    await assert.rejects(
      () => postJson("b", "http://x.test/a", {}, {}, new AbortController().signal, impl),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamError);
        assert.match(error.message, /HTTP 404/u);
        assert.match(error.message, /model not found/u);
        return true;
      },
    );
  });

  it("连接失败与中止都被转成可读错误", async () => {
    const failing = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => postJson("b", "http://x.test/a", {}, {}, new AbortController().signal, failing),
      /无法连接上游/u,
    );

    const controller = new AbortController();
    controller.abort();
    const hanging = (async (_input: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new Error("aborted");
      return new Response("{}");
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => postJson("b", "http://x.test/a", {}, {}, controller.signal, hanging),
      /请求被中止/u,
    );
  });

  it("非 JSON 响应被明确拒绝", async () => {
    const { impl } = stubFetch(() => new Response("<html>502</html>", { status: 200 }));
    await assert.rejects(
      () => postJson("b", "http://x.test/a", {}, {}, new AbortController().signal, impl),
      /不是合法 JSON/u,
    );
  });
});

describe("upstream：Ollama（/api/chat）", () => {
  it("请求体把指令放进 system，并把图片转为纯 base64", () => {
    const body = buildOllamaBody(context(), true);
    assert.equal(body.model, "qwen3.5:9b");
    assert.equal(body.stream, false);
    assert.equal(body.format, "json");
    assert.equal(body.think, true);
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0]?.role, "system");
    assert.match(String(messages[0]?.content), /答题服务/u);
    assert.equal(messages[1]?.role, "user");
    const images = messages[1]?.images as string[];
    assert.equal(images.length, 1);
    assert.ok(!images[0]!.startsWith("data:"), "Ollama 需要不带 data: 前缀的 base64");
    assert.match(String(messages[1]?.content), /\[图片：题干\/材料图片 1\]/u);
  });

  it("think 为 false 时不发送该参数，避免给不支持的模型添麻烦", () => {
    const body = buildOllamaBody(context({ think: false }), true);
    assert.ok(!("think" in body));
  });

  it("纯 base64 输入被原样接受，data URL 被剥离前缀", () => {
    assert.equal(extractBase64(PIXEL), Buffer.from("png").toString("base64"));
    assert.equal(extractBase64("QUJD"), "QUJD");
    // 换行等空白必须清掉，否则上游会报 base64 非法
    assert.equal(extractBase64("QU\nJD"), "QUJD");
  });

  it("响应解析兼容 message.content 与旧版 response 字段", () => {
    const fromMessage = buildOllamaResponse({ message: { content: ANSWER_JSON }, eval_count: 12 }, "b");
    assert.equal(fromMessage.text, ANSWER_JSON);
    assert.deepEqual(fromMessage.usage, { eval_count: 12 });
    const fromLegacy = buildOllamaResponse({ response: ANSWER_JSON }, "b");
    assert.equal(fromLegacy.text, ANSWER_JSON);
    assert.equal(fromLegacy.usage, undefined);
  });

  it("缺少 content 时抛错，complete 打通请求链路", async () => {
    assert.throws(() => buildOllamaResponse({ message: {} }, "b"), UpstreamError);
    const { impl, calls } = stubFetch(() => jsonResponse({ message: { content: ANSWER_JSON } }));
    const backend = new OllamaBackend({ name: "ollama-local", url: "http://x.test/api/chat", fetchImpl: impl });
    const raw = await backend.complete(context());
    assert.equal(raw.text, ANSWER_JSON);
    assert.equal(calls[0]!.url, "http://x.test/api/chat");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["content-type"], "application/json");
  });
});

describe("upstream：OpenAI 兼容（/chat/completions）", () => {
  it("无图时 content 用纯字符串，保持旧服务兼容", () => {
    const body = buildChatBody(context({ prompt: makePrompt({ withImage: false }) }), true);
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.equal(typeof messages[1]?.content, "string");
    assert.deepEqual(body.response_format, { type: "json_object" });
  });

  it("有图时先给附件说明再给图，与 Responses 保持同一交错规则", () => {
    const body = buildChatBody(context(), true);
    const messages = body.messages as Array<Record<string, unknown>>;
    const parts = messages[1]?.content as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(parts));
    const imagePart = parts.find((part) => part.type === "image_url");
    assert.ok(imagePart, "应包含 image_url 块");
    assert.equal((imagePart!.image_url as Record<string, unknown>).url, PIXEL);
    // 图片前一项必须是它的归属说明
    const imageIndex = parts.indexOf(imagePart!);
    const labelPart = parts[imageIndex - 1]!;
    assert.equal(labelPart.type, "text");
    assert.match(String(labelPart.text), /\[附件 1 对应关系\] 题干\/材料图片 1/u);
  });

  it("响应解析报告 finish_reason，便于定位截断", () => {
    const raw = buildChatResponse(
      { choices: [{ message: { content: ANSWER_JSON }, finish_reason: "stop" }], usage: { total_tokens: 5 } },
      "b",
    );
    assert.equal(raw.text, ANSWER_JSON);
    assert.deepEqual(raw.usage, { total_tokens: 5 });
    assert.throws(
      () => buildChatResponse({ choices: [{ message: { content: null }, finish_reason: "length" }] }, "b"),
      /finish_reason=length/u,
    );
    assert.throws(() => buildChatResponse({ choices: [] }, "b"), UpstreamError);
  });

  it("complete 带上 Bearer 认证", async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ choices: [{ message: { content: ANSWER_JSON } }] }));
    const backend = new OpenAiChatBackend({
      name: "online-chat",
      url: "http://x.test/v1/chat/completions",
      apiKey: "sk-secret",
      fetchImpl: impl,
    });
    const raw = await backend.complete(context({ think: false }));
    assert.equal(raw.text, ANSWER_JSON);
    assert.equal(calls[0]!.headers.authorization, "Bearer sk-secret");
    assert.equal(calls[0]!.url, "http://x.test/v1/chat/completions");
  });
});

describe("upstream：OpenAI Responses（/v1/responses）", () => {
  it("请求体沿用既有形状：instructions + input 内容块 + json_object", () => {
    const body = buildResponsesBody(context({ reasoningEffort: "xhigh" }));
    assert.equal(body.model, "qwen3.5:9b");
    assert.match(String(body.instructions), /答题服务/u);
    assert.equal(body.store, false);
    assert.deepEqual(body.text, { format: { type: "json_object" } });
    assert.deepEqual(body.reasoning, { effort: "xhigh" });
    const input = body.input as Array<Record<string, unknown>>;
    const blocks = input[0]?.content as Array<Record<string, unknown>>;
    assert.equal(blocks.filter((block) => block.type === "input_image").length, 1);
    // 题目 JSON + 附件归属说明 = 2 个 input_text
    assert.equal(blocks.filter((block) => block.type === "input_text").length, 2);
    const imageIndex = blocks.findIndex((block) => block.type === "input_image");
    assert.match(String(blocks[imageIndex - 1]!.text), /\[附件 1 对应关系\] 题干\/材料图片 1/u);
  });

  it("未配推理强度时不发送 reasoning 字段", () => {
    const body = buildResponsesBody(context());
    assert.ok(!("reasoning" in body));
  });

  it("响应解析优先 output_text，其次遍历 output 内容块", () => {
    assert.equal(buildResponsesResponse({ output_text: ANSWER_JSON }, "b").text, ANSWER_JSON);
    const nested = {
      output: [{ content: [{ type: "output_text", text: ANSWER_JSON }] }],
      usage: { input_tokens: 3 },
    };
    const raw = buildResponsesResponse(nested, "b");
    assert.equal(raw.text, ANSWER_JSON);
    assert.deepEqual(raw.usage, { input_tokens: 3 });
    assert.throws(() => buildResponsesResponse({ output: [] }, "b"), /没有文本答案/u);
  });

  it("complete 打通请求链路", async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ output_text: ANSWER_JSON }));
    const backend = new OpenAiResponsesBackend({
      name: "online-responses",
      url: "http://x.test/v1/responses",
      apiKey: "sk-secret",
      fetchImpl: impl,
    });
    const raw = await backend.complete(context({ reasoningEffort: "high" }));
    assert.equal(raw.text, ANSWER_JSON);
    assert.equal(calls[0]!.headers.authorization, "Bearer sk-secret");
    assert.deepEqual(calls[0]!.body.reasoning, { effort: "high" });
  });
});
