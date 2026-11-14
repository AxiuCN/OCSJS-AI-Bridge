import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "node:test";

import { parseConfigDocument } from "../src/config.js";
import { createApp, type AnswerRequestPayload } from "../src/httpapi.js";
import { ImagePreparer } from "../src/images.js";
import { normalizeQuestion } from "../src/normalize.js";
import type { Logger } from "../src/logger.js";
import { AnswerEngine } from "../src/routing.js";
import { Semaphore } from "../src/semaphore.js";
import type { UpstreamBackend } from "../src/upstream/base.js";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const payload: AnswerRequestPayload = { title: "synthetic question", options: ["first", "second"], type: "single" };
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function config(timeoutSeconds = 30) {
  return parseConfigDocument({
    server: { listen: "127.0.0.1:8000", deadline_seconds: 10, access_token: "synthetic-token" },
    limits: { image_timeout_seconds: 1, min_attempt_seconds: 1 },
    backends: [{ name: "fixture", kind: "ollama", base_url: "http://127.0.0.1:11434", model: "synthetic", timeout_seconds: timeoutSeconds, max_concurrency: 1 }],
    routes: [{ type: "*", backends: ["fixture"] }],
  }, []);
}

it("有效的小数秒图片超时转换为合法整数毫秒", async () => {
  const settings = config();
  let calls = 0;
  const images = new ImagePreparer({ ...settings.limits, imageTimeoutSeconds: 8.001, requireDeclaredImages: true }, async () => {
    calls += 1;
    return new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), { headers: { "content-type": "image/png" } });
  });
  const result = await images.prepare(normalizeQuestion({ title: "http://images.invalid/owned.png", type: "single" }), new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(result.images.length, 1);
});

it("排队请求获得额度后继续计入并发上限", async () => {
  const semaphore = new Semaphore(1);
  const gate1 = deferred(), gate2 = deferred(), gate3 = deferred();
  const entered1 = deferred(), entered2 = deferred(), entered3 = deferred();
  let active = 0, maximum = 0, thirdStarted = false;
  const task = (entered: ReturnType<typeof deferred>, gate: ReturnType<typeof deferred>) => async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    entered.resolve();
    await gate.promise;
    active -= 1;
  };
  const first = semaphore.run(new AbortController().signal, task(entered1, gate1));
  await entered1.promise;
  const second = semaphore.run(new AbortController().signal, task(entered2, gate2));
  gate1.resolve();
  await first;
  await entered2.promise;
  const handoff = semaphore.snapshot();
  const third = semaphore.run(new AbortController().signal, async () => {
    thirdStarted = true;
    await task(entered3, gate3)();
  });
  await delay(20);
  const overtook = thirdStarted;
  gate2.resolve();
  await second;
  await entered3.promise;
  gate3.resolve();
  await third;
  assert.equal(handoff.active, 1);
  assert.equal(overtook, false);
  assert.equal(maximum, 1);
  assert.equal(semaphore.snapshot().active, 0);
});

for (const elapsed of [1999, 1998, 1995, 1992, 1989]) {
  it(`剩余毫秒预算可以转换为合法计时器，已耗时 ${elapsed}ms`, async () => {
    const settings = config();
    let reads = 0, calls = 0;
    const backend: UpstreamBackend = { name: "fixture", async complete() {
      calls += 1;
      return { text: '{"answer":"A","confidence":1}' };
    } };
    const engine = new AnswerEngine({
      config: settings,
      backends: [{ config: settings.backends[0]!, backend }],
      images: new ImagePreparer({ ...settings.limits, requireDeclaredImages: true }),
      logger,
      now: () => ++reads <= 2 ? 0 : elapsed,
    });
    const answer = await engine.answer(payload, new AbortController().signal);
    assert.equal(answer.answer, "first");
    assert.equal(calls, 1);
  });
}

it("有效的 100ms 后端超时保持毫秒精度", async () => {
  const settings = config(0.1);
  const backend: UpstreamBackend = { name: "fixture", complete: ({ signal }) => new Promise((_resolve, reject) => {
    const abort = () => reject(new Error("synthetic timeout"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }) };
  const engine = new AnswerEngine({ config: settings, backends: [{ config: settings.backends[0]!, backend }], images: new ImagePreparer({ ...settings.limits, requireDeclaredImages: true }), logger });
  const keepAlive = setTimeout(() => {}, 1600);
  const started = performance.now();
  try {
    await assert.rejects(engine.answer(payload, new AbortController().signal));
    assert.ok(performance.now() - started < 500);
  } finally {
    clearTimeout(keepAlive);
  }
});

it("完整发送正文后客户端断开会取消仍在处理的请求", async () => {
  const entered = deferred(), released = deferred();
  let signal: AbortSignal | undefined;
  const app = createApp({
    loaded: { config: config(), secrets: { accessToken: "synthetic-token", backendApiKeys: new Map() }, warnings: [] },
    version: "test", logger,
    answer: async (request, received) => {
      signal = received;
      received.addEventListener("abort", released.resolve, { once: true });
      entered.resolve();
      await released.promise;
      return { question: request.title, answer: "synthetic", confidence: 1, model: "synthetic", warnings: [] };
    },
  });
  const server = app.createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const body = JSON.stringify(payload);
    const port = (server.address() as AddressInfo).port;
    const request = http.request(`http://127.0.0.1:${port}/v1/answer`, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-access-token": "synthetic-token" } });
    request.on("error", () => {});
    request.end(body);
    await entered.promise;
    request.destroy();
    await delay(80);
    assert.equal(signal?.aborted, true);
  } finally {
    released.resolve();
    await delay(10);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
