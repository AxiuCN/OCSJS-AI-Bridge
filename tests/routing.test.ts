/**
 * 路由 / 超时预算 / 能力过滤 / 降级分类的测试。
 *
 * 全部使用打桩后端与可控时钟，不触网：这些规则是服务的决策核心，
 * 必须能在毫秒级、确定性地回归。
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import type { BackendConfig, Config } from "../src/types.js";
import { ImagePreparer, type ImageLimits } from "../src/images.js";
import { createLogger, type Logger } from "../src/logger.js";
import { AnswerEngine, EngineError, type BackendCandidate } from "../src/routing.js";
import { UpstreamError, type RawResponse, type UpstreamBackend, type UpstreamRequestContext } from "../src/upstream/base.js";

const PIXEL = `data:image/png;base64,${Buffer.from("png").toString("base64")}`;

const LIMITS: ImageLimits = {
  imageTimeoutSeconds: 5,
  maxImages: 4,
  maxImageBytes: 4096,
  imageConcurrency: 2,
  requireDeclaredImages: true,
};

function backendConfig(overrides: Partial<BackendConfig> & { name: string }): BackendConfig {
  return {
    kind: "ollama",
    baseUrl: "http://stub.test/api/chat",
    model: "stub-model",
    capabilities: { vision: true, thinking: false },
    timeoutSeconds: 30,
    maxConcurrency: 2,
    ...overrides,
  };
}

function makeConfig(overrides: {
  backends: BackendConfig[];
  routes?: Config["routes"];
  deadlineSeconds?: number;
}): Config {
  return {
    server: {
      listen: "127.0.0.1:0",
      accessToken: "***",
      deadlineSeconds: overrides.deadlineSeconds ?? 60,
      maxBodyBytes: 1024 * 1024,
      corsOrigins: [],
    },
    limits: {
      imageTimeoutSeconds: 5,
      maxImages: 4,
      maxImageBytes: 4096,
      minAttemptSeconds: 5,
      imageConcurrency: 2,
    },
    answer: { separator: "#", requireDeclaredImages: true },
    backends: overrides.backends,
    strategy: "auto",
    routes: overrides.routes ?? [{ type: "*", backends: overrides.backends.map((item) => item.name) }],
  };
}

interface TestBackendOptions {
  output?: string | (() => string);
  error?: Error | (() => Error);
  hang?: boolean;
  delayMs?: number;
  advance?: (ms: number) => void;
}

class TestBackend implements UpstreamBackend {
  readonly calls: UpstreamRequestContext[] = [];
  constructor(
    readonly name: string,
    private readonly options: TestBackendOptions,
  ) {}

  async complete(context: UpstreamRequestContext): Promise<RawResponse> {
    this.calls.push(context);
    if (this.options.delayMs) {
      this.options.advance?.(this.options.delayMs);
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }
    if (this.options.hang) {
      await new Promise((_resolve, reject) => {
        const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
        if (context.signal.aborted) {
          onAbort();
          return;
        }
        context.signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (this.options.error) {
      const error = this.options.error;
      throw typeof error === "function" ? error() : error;
    }
    const output = this.options.output;
    const text = typeof output === "function" ? output() : (output ?? '{"answer":"A","confidence":0.8}');
    return { text };
  }
}

function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function makeLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({ write: (line) => lines.push(line) });
  return { logger, lines };
}

function makeEngine(options: {
  config: Config;
  stubs: TestBackend[];
  clock: { now: () => number; advance: (ms: number) => void };
  logger?: Logger;
}): AnswerEngine {
  const backends: BackendCandidate[] = options.stubs.map((stub) => {
    const config = options.config.backends.find((item) => item.name === stub.name);
    assert.ok(config, `配置里应有后端 ${stub.name}`);
    return { config, backend: stub };
  });
  const images = new ImagePreparer(LIMITS, fetch);
  return new AnswerEngine({
    config: options.config,
    backends,
    images,
    logger: options.logger ?? makeLogger().logger,
    now: options.clock.now,
  });
}

const singleChoice = { title: "1+1=?", options: "1\n2\n3", type: "single" };

describe("routing：候选链与降级", () => {
  it("首选失败后自动降级到下一个候选，并记录降级过程", async () => {
    const clock = makeClock();
    const { logger, lines } = makeLogger();
    const primary = new TestBackend("primary", { error: () => new UpstreamError("上游 500", "primary", { status: 500 }) });
    const secondary = new TestBackend("secondary", { output: '{"answer":"B","confidence":0.7}' });
    const config = makeConfig({ backends: [backendConfig({ name: "primary" }), backendConfig({ name: "secondary" })] });
    const engine = makeEngine({ config, stubs: [primary, secondary], clock, logger });

    const outcome = await engine.answer(singleChoice, new AbortController().signal);
    assert.equal(outcome.answer, "2");
    assert.equal(outcome.model, "secondary/stub-model");
    assert.equal(outcome.confidence, 0.7);
    assert.equal(primary.calls.length, 1);
    assert.equal(secondary.calls.length, 1);
    // 降级过程必须回传给客户端，否则 OCS 端无从得知答案来自哪个后端
    assert.ok(
      outcome.warnings.some((item) => item.includes("primary") && item.includes("作答失败")),
      `warnings 应记录降级原因，实际为 ${JSON.stringify(outcome.warnings)}`,
    );
    assert.ok(lines.some((line) => line.includes("候选后端失败，准备降级")));
    assert.ok(lines.some((line) => line.includes("答题成功")));
  });

  it("解析不出答案 JSON 也属于后端级失败，会换下一个候选", async () => {
    const clock = makeClock();
    const broken = new TestBackend("broken", { output: "我不知道答案" });
    const good = new TestBackend("good", { output: '{"answer":"A"}' });
    const config = makeConfig({ backends: [backendConfig({ name: "broken" }), backendConfig({ name: "good" })] });
    const engine = makeEngine({ config, stubs: [broken, good], clock });
    const outcome = await engine.answer(singleChoice, new AbortController().signal);
    assert.equal(outcome.answer, "1");
  });

  it("空答案不被当成成功，继续降级", async () => {
    const clock = makeClock();
    const empty = new TestBackend("empty", { output: '{"answer":""}' });
    const good = new TestBackend("good", { output: '{"answer":"C"}' });
    const config = makeConfig({ backends: [backendConfig({ name: "empty" }), backendConfig({ name: "good" })] });
    const engine = makeEngine({ config, stubs: [empty, good], clock });
    const outcome = await engine.answer(singleChoice, new AbortController().signal);
    assert.equal(outcome.answer, "3");
  });

  it("全部候选失败时给出聚合原因，不返回任何答案", async () => {
    const clock = makeClock();
    const first = new TestBackend("first", { error: () => new UpstreamError("连不上", "first") });
    const second = new TestBackend("second", { output: "不是 JSON" });
    const config = makeConfig({ backends: [backendConfig({ name: "first" }), backendConfig({ name: "second" })] });
    const engine = makeEngine({ config, stubs: [first, second], clock });
    await assert.rejects(
      () => engine.answer(singleChoice, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof EngineError);
        assert.match(error.message, /所有候选后端均未能作答/u);
        assert.match(error.message, /first: 连不上/u);
        assert.match(error.message, /second: /u);
        return true;
      },
    );
  });

  it("路由按题型精确匹配优先，其次才是兜底", () => {
    const clock = makeClock();
    const config = makeConfig({
      backends: [backendConfig({ name: "local" }), backendConfig({ name: "online" })],
      routes: [
        { type: "multiple", backends: ["online", "local"] },
        { type: "*", backends: ["local"] },
      ],
    });
    const engine = makeEngine({ config, stubs: [], clock });
    assert.deepEqual(engine.routeFor("multiple"), ["online", "local"]);
    assert.deepEqual(engine.routeFor("single"), ["local"]);
    assert.deepEqual(engine.routeFor("judgement"), ["local"]);
  });

  it("没有匹配路由且无兜底时明确报错", () => {
    const clock = makeClock();
    const config = makeConfig({
      backends: [backendConfig({ name: "local" })],
      routes: [{ type: "single", backends: ["local"] }],
    });
    const engine = makeEngine({ config, stubs: [], clock });
    assert.throws(() => engine.routeFor("judgement"), /没有匹配题型 judgement/u);
  });
});

describe("routing：超时预算", () => {
  it("单个候选不得吃穿总预算：超时后仍能换下一个候选", async () => {
    const clock = makeClock();
    // hang 候选配 500ms 超时，延迟给 900ms：只有超时先生效，才会切换候选取回答案。
    const slow = new TestBackend("slow", { hang: true, delayMs: 900 });
    const fast = new TestBackend("fast", { output: '{"answer":"B"}' });
    const config = makeConfig({
      backends: [backendConfig({ name: "slow", timeoutSeconds: 0.5 }), backendConfig({ name: "fast" })],
      deadlineSeconds: 60,
    });
    const engine = makeEngine({ config, stubs: [slow, fast], clock });
    const started = Date.now();
    const outcome = await engine.answer(singleChoice, new AbortController().signal);
    const elapsed = Date.now() - started;
    assert.equal(outcome.answer, "2");
    assert.ok(elapsed < 3000, `应靠候选自身超时切换，实际耗时 ${elapsed}ms`);
    assert.ok(
      outcome.warnings.length >= 0 && slow.calls.length === 1 && fast.calls.length === 1,
      "两个候选都应被调用一次",
    );
  });

  it("剩余预算不足时放弃该候选，并说明原因", async () => {
    const clock = makeClock();
    // 首个候选失败并推进 56s：总预算 60s，剩余约 4s，低于 minAttemptSeconds(5s)
    const slow = new TestBackend("slow", {
      error: () => new UpstreamError("boom", "slow"),
      delayMs: 10,
      advance: () => clock.advance(56_000),
    });
    const third = new TestBackend("third", { output: '{"answer":"A"}' });
    const config = makeConfig({
      backends: [backendConfig({ name: "slow", timeoutSeconds: 60 }), backendConfig({ name: "third" })],
      deadlineSeconds: 60,
    });
    const engine = makeEngine({ config, stubs: [slow, third], clock });
    await assert.rejects(
      () => engine.answer(singleChoice, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof EngineError);
        assert.match(error.message, /third: 时间预算不足/u);
        return true;
      },
    );
    assert.equal(third.calls.length, 0, "预算不足的候选不应被调用");
  });

  it("预算充足时按后端能力开启思考", async () => {
    const clock = makeClock();
    const thinking = new TestBackend("thinking", { output: '{"answer":"A"}' });
    const config = makeConfig({
      backends: [backendConfig({ name: "thinking", capabilities: { vision: true, thinking: true } })],
      deadlineSeconds: 60,
    });
    const engine = makeEngine({ config, stubs: [thinking], clock });
    await engine.answer(singleChoice, new AbortController().signal);
    assert.equal(thinking.calls[0]!.think, true);
  });

  it("预算已被消耗过半时不再要求思考，把时间留给出答案", async () => {
    const clock = makeClock();
    // 推进 33s：剩余约 27s，低于总预算一半(30s)，后续候选不应再开思考
    const slow = new TestBackend("slow", {
      error: () => new UpstreamError("boom", "slow"),
      delayMs: 10,
      advance: () => clock.advance(33_000),
    });
    const second = new TestBackend("second", { output: '{"answer":"A"}' });
    const config = makeConfig({
      backends: [
        backendConfig({ name: "slow", capabilities: { vision: true, thinking: true } }),
        backendConfig({ name: "second", capabilities: { vision: true, thinking: true } }),
      ],
      deadlineSeconds: 60,
    });
    const engine = makeEngine({ config, stubs: [slow, second], clock });
    await engine.answer(singleChoice, new AbortController().signal);
    assert.equal(slow.calls[0]!.think, true, "首个候选预算充足，应开启思考");
    assert.equal(second.calls[0]!.think, false, "预算过半后不应再开启思考");
  });

  it("发起请求前检查信号：已中止时不调用任何后端", async () => {
    const clock = makeClock();
    const stub = new TestBackend("only", { output: '{"answer":"A"}' });
    const config = makeConfig({ backends: [backendConfig({ name: "only" })] });
    const engine = makeEngine({ config, stubs: [stub], clock });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => engine.answer(singleChoice, controller.signal));
    assert.equal(stub.calls.length, 0);
  });
});

describe("routing：能力过滤", () => {
  const imageQuestion = {
    title: "这张图是什么颜色？",
    options: "红色\n绿色",
    type: "single",
    images: [{ label: "题干图片", data_url: PIXEL }],
  };

  it("题目含图时跳过未声明 vision 的后端，并如实记入 warnings", async () => {
    const clock = makeClock();
    const blind = new TestBackend("blind", { output: '{"answer":"A"}' });
    const seeing = new TestBackend("seeing", { output: '{"answer":"B"}' });
    const config = makeConfig({
      backends: [
        backendConfig({ name: "blind", capabilities: { vision: false, thinking: false } }),
        backendConfig({ name: "seeing", capabilities: { vision: true, thinking: false } }),
      ],
    });
    const engine = makeEngine({ config, stubs: [blind, seeing], clock });
    const outcome = await engine.answer(imageQuestion, new AbortController().signal);
    // 图片题含 images 字段，属于修改版口径：选项字母不做原文映射，原样回填。
    assert.equal(outcome.answer, "B");
    assert.equal(outcome.model, "seeing/stub-model");
    assert.equal(blind.calls.length, 0, "无视觉能力的后端不得收到图片题");
    assert.equal(seeing.calls.length, 1);
    assert.ok(
      outcome.warnings.some((item) => item.includes("blind") && item.includes("vision")),
      `warnings 应说明跳过原因，实际为 ${JSON.stringify(outcome.warnings)}`,
    );
  });

  it("所有候选都没有视觉能力时明确报错，不静默猜测", async () => {
    const clock = makeClock();
    const blind = new TestBackend("blind", { output: '{"answer":"A"}' });
    const config = makeConfig({
      backends: [backendConfig({ name: "blind", capabilities: { vision: false, thinking: false } })],
    });
    const engine = makeEngine({ config, stubs: [blind], clock });
    await assert.rejects(
      () => engine.answer(imageQuestion, new AbortController().signal),
      (error: unknown) => {
        assert.ok(error instanceof EngineError);
        assert.match(error.message, /不具备视觉能力/u);
        return true;
      },
    );
    assert.equal(blind.calls.length, 0);
  });

  it("纯文本题可以交给无视觉能力的后端", async () => {
    const clock = makeClock();
    const blind = new TestBackend("blind", { output: '{"answer":"A"}' });
    const config = makeConfig({
      backends: [backendConfig({ name: "blind", capabilities: { vision: false, thinking: false } })],
    });
    const engine = makeEngine({ config, stubs: [blind], clock });
    const outcome = await engine.answer(singleChoice, new AbortController().signal);
    assert.equal(outcome.answer, "1");
    assert.equal(blind.calls.length, 1);
  });
});

describe("routing：题目级失败不降级", () => {
  it("图片一张都读不出时立即终止，不尝试任何后端", async () => {
    const clock = makeClock();
    const stub = new TestBackend("only", { output: '{"answer":"A"}' });
    const config = makeConfig({ backends: [backendConfig({ name: "only" })] });
    const failingFetch = (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const images = new ImagePreparer(LIMITS, failingFetch);
    const engine = new AnswerEngine({
      config,
      backends: [{ config: config.backends[0]!, backend: stub }],
      images,
      logger: makeLogger().logger,
      now: clock.now,
    });
    await assert.rejects(
      () =>
        engine.answer(
          { title: "图 https://cx.test/protected.png", options: "甲\n乙", type: "single" },
          new AbortController().signal,
        ),
      /没有拿到任何可读图片/u,
    );
    assert.equal(stub.calls.length, 0, "题目级失败不得触发后端调用");
  });
});
