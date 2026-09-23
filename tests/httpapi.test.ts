/**
 * HTTP 接入层测试：直接驱动真实 http.Server + fetch。
 *
 * 覆盖 OCS 依赖的四件事：/health 探测、令牌鉴权、超时/限额返回 code:0、
 * 以及响应形状与 decision 契约一致。
 */

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { createApp, type App } from "../src/httpapi.js";
import { EngineError } from "../src/routing.js";
import type { Logger } from "../src/logger.js";
import type { Config, LoadedConfig } from "../src/types.js";

const TOKEN = "unit-test-token";

function testLoaded(): LoadedConfig {
  const config: Config = {
    server: {
      listen: "127.0.0.1:0",
      accessToken: "***",
      deadlineSeconds: 30,
      maxBodyBytes: 1024,
      corsOrigins: [],
    },
    limits: {
      imageTimeoutSeconds: 5,
      maxImages: 4,
      maxImageBytes: 1024 * 1024,
      minAttemptSeconds: 2,
      imageConcurrency: 2,
    },
    answer: { separator: "#", requireDeclaredImages: true },
    backends: [
      {
        name: "ollama-local",
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434/api/chat",
        model: "qwen3.5:9b",
        capabilities: { vision: true, thinking: true },
        timeoutSeconds: 20,
        maxConcurrency: 1,
      },
    ],
    strategy: "auto",
    routes: [{ type: "*", backends: ["ollama-local"] }],
  };
  return { config, secrets: { accessToken: TOKEN, backendApiKeys: new Map() }, warnings: [] };
}

function silentLogger(sink: string[]): Logger {
  const write = (line: string): void => {
    sink.push(line);
  };
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (message, fields) => write(JSON.stringify({ message, ...fields })),
    error: (message, fields) => write(JSON.stringify({ message, ...fields })),
    child: () => logger,
  };
  return logger;
}

describe("HTTP 接入层", () => {
  const logs: string[] = [];
  let app: App;
  let base: string;
  let close: () => Promise<void>;

  before(async () => {
    app = createApp({ loaded: testLoaded(), version: "9.9.9", logger: silentLogger(logs) });
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  });

  after(async () => {
    await close();
  });

  function init(body: string, headers?: Record<string, string>): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    };
  }

  it("GET /health 返回探活信息且不泄露地址与密钥", async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.version, "9.9.9");
    assert.equal(body.auth_enabled, true);
    assert.equal(body.listen, "127.0.0.1:0");
    const { config, secrets } = testLoaded();
    const text = JSON.stringify(body);
    assert.ok(!text.includes(secrets.accessToken), "健康检查不能包含访问令牌");
    assert.ok(!text.includes(config.backends[0]!.baseUrl), "健康检查不能包含后端地址");
    const backends = body.backends as Array<Record<string, unknown>>;
    assert.equal(backends[0]?.name, "ollama-local");
    assert.equal(backends[0]?.vision, true);
  });

  it("GET / 与 HEAD /health 都可用于 OCS 连通性探测", async () => {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    const head = await fetch(`${base}/health`, { method: "HEAD" });
    assert.equal(head.status, 200);
  });

  it("POST /v1/answer 无令牌返回 401", async () => {
    const response = await fetch(`${base}/v1/answer`, init('{"title":"题目"}'));
    assert.equal(response.status, 401);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.code, 0);
  });

  it("X-Access-Token 与 Bearer 两种令牌都接受", async () => {
    for (const headers of [{ "x-access-token": TOKEN }, { authorization: `Bearer ${TOKEN}` }]) {
      const response = await fetch(`${base}/v1/answer`, init('{"title":"题目"}', headers));
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, unknown>;
      // 骨架阶段引擎未接线，因此是 code:0 + 明确原因，而不是 401
      assert.equal(body.code, 0);
      assert.match(String(body.message), /尚未接线/);
    }
  });

  it("请求体超限返回 413", async () => {
    const response = await fetch(`${base}/v1/answer`, init(`{"title":"${"x".repeat(2000)}"}`, { "x-access-token": TOKEN }));
    assert.equal(response.status, 413);
  });

  it("非法 JSON 与缺少 title 都返回 code:0 而非 500", async () => {
    const bad = await fetch(`${base}/v1/answer`, init("{不是 JSON", { "x-access-token": TOKEN }));
    assert.equal(bad.status, 200);
    assert.match(String(((await bad.json()) as Record<string, unknown>).message), /合法 JSON/);

    const noTitle = await fetch(`${base}/v1/answer`, init('{"options":"A. 甲"}', { "x-access-token": TOKEN }));
    assert.equal(noTitle.status, 200);
    assert.match(String(((await noTitle.json()) as Record<string, unknown>).message), /title/);

    const notObject = await fetch(`${base}/v1/answer`, init("[1,2,3]", { "x-access-token": TOKEN }));
    assert.equal(notObject.status, 200);
    assert.match(String(((await notObject.json()) as Record<string, unknown>).message), /JSON 对象/);
  });

  it("未知路径 404，错误方法 405", async () => {
    const notFound = await fetch(`${base}/nope`);
    assert.equal(notFound.status, 404);
    const wrongMethod = await fetch(`${base}/v1/answer`, { method: "GET" });
    assert.equal(wrongMethod.status, 405);
  });

  it("引擎就绪后按 OCS 契约返回 code:1", async () => {
    const ready = createApp({
      loaded: testLoaded(),
      version: "9.9.9",
      logger: silentLogger([]),
      answer: async (payload) => ({
        question: payload.title,
        answer: "A#C",
        confidence: 0.9,
        model: "qwen3.5:9b",
        warnings: ["示例告警"],
      }),
    });
    const server = ready.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/answer`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-access-token": TOKEN },
        body: JSON.stringify({ title: "1+1=?", options: "A. 1\nB. 2", type: "single" }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.code, 1);
      assert.equal(body.message, "ok");
      assert.equal(body.question, "1+1=?");
      assert.equal(body.answer, "A#C");
      assert.equal(body.confidence, 0.9);
      assert.deepEqual(body.warnings, ["示例告警"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("引擎抛出后端级错误时记入 error 日志并返回 code:0", async () => {
    const logs2: string[] = [];
    const failing = createApp({
      loaded: testLoaded(),
      version: "9.9.9",
      logger: silentLogger(logs2),
      answer: async () => {
        throw new Error("上游不可达");
      },
    });
    const server = failing.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/answer`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-access-token": TOKEN },
        body: JSON.stringify({ title: "题目" }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.code, 0);
      assert.match(String(body.message), /上游不可达/);
      assert.ok(logs2.some((line) => line.includes("未预期异常")));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("「所有候选失败」被当作后端级问题，而不是服务内部异常", async () => {
    const logs3: string[] = [];
    const failing = createApp({
      loaded: testLoaded(),
      version: "9.9.9",
      logger: silentLogger(logs3),
      answer: async () => {
        throw new EngineError("所有候选后端均未能作答", "primary: 上游返回 HTTP 404；secondary: 不具备视觉能力");
      },
    });
    const server = failing.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/answer`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-access-token": TOKEN },
        body: JSON.stringify({ title: "题目" }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.code, 0);
      // 每个候选的真实原因都要带到客户端，便于排查
      assert.match(String(body.message), /primary: 上游返回 HTTP 404/u);
      assert.match(String(body.message), /secondary: 不具备视觉能力/u);
      const joined = logs3.join("\n");
      assert.ok(joined.includes("后端级失败"), "应记为后端级失败");
      assert.ok(!joined.includes("未预期异常"), "不应被当成服务内部异常");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
