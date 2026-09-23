/**
 * 临时实测脚本（第 5 步）：把领域层 + 适配器接到真实 Ollama 上跑通。
 * 用法：npx tsx scripts/smoke-live.ts
 */

import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { formatOcsAnswer } from "../src/format.js";
import { ImagePreparer } from "../src/images.js";
import { normalizeQuestion } from "../src/normalize.js";
import { buildPrompt } from "../src/prompt.js";
import { parseModelOutput, UpstreamError } from "../src/upstream/base.js";
import { OllamaBackend } from "../src/upstream/ollama.js";
import { OpenAiChatBackend } from "../src/upstream/openai_chat.js";

const BASE = process.env.OLLAMA_BASE_URL ?? "http://192.168.18.10:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";

function tinyPng(): string {
  // 8x8 纯红 PNG，用于图片题实测
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVQoz2P8z8Dwn4GKgIlhFIxsAAB2ogQBpFEYbwAAAABJRU5ErkJggg==",
    "base64",
  );
  return `data:image/png;base64,${png.toString("base64")}`;
}

interface CaseResult {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

const results: CaseResult[] = [];
const seenImageHeaders: Array<{ referer: string; userAgent: string }> = [];

async function runCase(name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, ms: Date.now() - started });
  } catch (error) {
    const detail = error instanceof UpstreamError ? `${error.name}: ${error.message}` : String(error);
    results.push({ name, ok: false, detail, ms: Date.now() - started });
  }
}

async function askOnce(options: {
  payload: Record<string, unknown>;
  backend: OllamaBackend | OpenAiChatBackend;
  think?: boolean;
  timeoutMs?: number;
}): Promise<{ raw: string; answer: string; confidence: number; notes: string[]; imageCount: number }> {
  const question = normalizeQuestion(options.payload);
  const preparer = new ImagePreparer({
    imageTimeoutSeconds: 20,
    maxImages: 8,
    maxImageBytes: 4 * 1024 * 1024,
    imageConcurrency: 2,
    requireDeclaredImages: true,
  });
  const timeoutMs = options.timeoutMs ?? 180_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const prepared = await preparer.prepare(question, controller.signal);
    const prompt = buildPrompt(question, prepared.images);
    const raw = await options.backend.complete({
      prompt,
      model: MODEL,
      think: options.think ?? false,
      signal: controller.signal,
    });
    const parsed = parseModelOutput(raw.text, options.backend.name);
    return {
      raw: raw.text,
      answer: formatOcsAnswer(parsed.answer, question, "#"),
      confidence: parsed.confidence,
      notes: parsed.notes,
      imageCount: prepared.images.length,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const ollama = new OllamaBackend({ name: "ollama-local", url: `${BASE}/api/chat` });
  const chatCompat = new OpenAiChatBackend({
    name: "ollama-chat-compat",
    url: `${BASE}/v1/chat/completions`,
    apiKey: "ollama",
  });

  await runCase("1. 纯文本单选（Ollama 原生 /api/chat）", async () => {
    const result = await askOnce({
      payload: {
        title: "中国的首都是哪座城市？",
        options: "上海\n北京\n广州\n深圳",
        type: "single",
      },
      backend: ollama,
    });
    return `answer=${JSON.stringify(result.answer)} confidence=${result.confidence} 原始=${result.raw.slice(0, 80)}`;
  });

  await runCase("2. 纯文本多选（think 开启）", async () => {
    const result = await askOnce({
      payload: {
        title: "下列哪些是编程语言？",
        options: "Python\nHTML\nRust\nCSS",
        type: "multiple",
      },
      backend: ollama,
      think: true,
    });
    return `answer=${JSON.stringify(result.answer)} confidence=${result.confidence}`;
  });

  await runCase("3. 判断题", async () => {
    const result = await askOnce({
      payload: { title: "1+1=2 是否正确？", options: "正确\n错误", type: "judgement" },
      backend: ollama,
    });
    return `answer=${JSON.stringify(result.answer)}`;
  });

  await runCase("4. 填空题（多空顺序）", async () => {
    const result = await askOnce({
      payload: { title: "中国的首都是____，最大的城市是____。", type: "completion" },
      backend: ollama,
    });
    return `answer=${JSON.stringify(result.answer)}`;
  });

  await runCase("5. 图片题（Ollama 原生，data URL 直传）", async () => {
    const result = await askOnce({
      payload: {
        title: "这张图片的主要颜色是什么？只回答颜色名。",
        options: "红色\n绿色\n蓝色",
        type: "single",
        images: [{ label: "题干图片", data_url: tinyPng() }],
      },
      backend: ollama,
    });
    return `answer=${JSON.stringify(result.answer)} 图片数=${result.imageCount}`;
  });

  await runCase("6. 图片题（chat/completions 兼容端点）", async () => {
    const result = await askOnce({
      payload: {
        title: "这张图片的主要颜色是什么？只回答颜色名。",
        options: "红色\n绿色\n蓝色",
        type: "single",
        images: [{ label: "题干图片", data_url: tinyPng() }],
      },
      backend: chatCompat,
    });
    return `answer=${JSON.stringify(result.answer)} 图片数=${result.imageCount}`;
  });

  // 起一个临时图片服务，验证"服务端自己下载图片 + 原版口径字母映射"这条真实链路。
  const imageServer = createServer((request, response) => {
    seenImageHeaders.push({
      referer: String(request.headers.referer ?? ""),
      userAgent: String(request.headers["user-agent"] ?? ""),
    });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVQoz2P8z8Dwn4GKgIlhFIxsAAB2ogQBpFEYbwAAAABJRU5ErkJggg==",
      "base64",
    );
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(png);
  });
  await new Promise<void>((resolve) => imageServer.listen(0, "127.0.0.1", resolve));
  const imagePort = (imageServer.address() as AddressInfo).port;
  const imageUrl = `http://127.0.0.1:${imagePort}/color.png`;

  await runCase("7. 原版 OCS 口径：服务端自行下载图片 + 选项字母映射回原文", async () => {
    // 原版 OCS 只传 title/options/type，图片 URL 混在题干里，因此这里不传 images 字段。
    const result = await askOnce({
      payload: {
        title: `这张图片 ${imageUrl} 的主要颜色是什么？`,
        options: "红色\n绿色\n蓝色",
        type: "single",
      },
      backend: ollama,
    });
    const headerNote = seenImageHeaders.some((item) => item.referer.includes("chaoxing"))
      ? "取图带超星 Referer"
      : "取图未带预期请求头";
    return `answer=${JSON.stringify(result.answer)}（期望选项原文而非字母）图片数=${result.imageCount} ${headerNote}`;
  });
  imageServer.close();

  await runCase("8. 纯文本选项含英文单词时不得被拆成字母（first/third）", async () => {
    const result = await askOnce({
      payload: {
        title: "Which word means 安静的？",
        options: "first\nquiet\nthird",
        type: "single",
      },
      backend: ollama,
    });
    return `answer=${JSON.stringify(result.answer)}`;
  });

  await runCase("9. 超时必须被中止（预期失败）", async () => {
    await askOnce({
      payload: { title: "写一篇 2000 字的文章。", type: "completion" },
      backend: ollama,
      timeoutMs: 700,
    });
    return "未超时——需要复查超时机制";
  });

  await runCase("10. 不存在的模型必须报错（预期失败）", async () => {
    const question = normalizeQuestion({ title: "1+1=?", options: "1\n2", type: "single" });
    const prompt = buildPrompt(question, []);
    await new OpenAiChatBackend({ name: "bad", url: `${BASE}/v1/chat/completions`, apiKey: "x" }).complete({
      prompt,
      model: "not-a-real-model:1b",
      think: false,
      signal: AbortSignal.timeout(30_000),
    });
    return "未报错——需要复查错误处理";
  });

  let failures = 0;
  for (const result of results) {
    const expectedFailure = result.name.startsWith("9.") || result.name.startsWith("10.");
    const verdict = result.ok === !expectedFailure ? "符合预期" : "不符合预期";
    if (result.ok === expectedFailure) failures += 1;
    console.log(`[${verdict}] ${result.name} (${result.ms}ms)`);
    console.log(`    ${result.detail}`);
  }
  console.log(failures === 0 ? "\n全部符合预期" : `\n有 ${failures} 项不符合预期`);
}

await main();
