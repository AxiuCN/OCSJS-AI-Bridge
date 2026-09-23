/**
 * 优雅关闭的契约测试。
 *
 * 关键行为：
 * - 空闲连接立刻断开（避免 keep-alive 拖住退出），但不影响正在处理的请求
 * - 活跃请求在宽限期内正常完成
 * - 宽限期耗尽才强制关闭
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";

import { DEFAULT_SHUTDOWN_GRACE_MS, gracefulShutdown } from "../src/shutdown.js";

interface FakeServer {
  waiters: Array<() => void>;
  idleClosed: boolean;
  allClosed: boolean;
  readonly handle: { close: (callback: () => void) => unknown; closeIdleConnections: () => void; closeAllConnections: () => void };
}

function fakeServer(): FakeServer {
  const state: FakeServer = {
    waiters: [],
    idleClosed: false,
    allClosed: false,
    handle: {
      close: (callback: () => void) => {
        state.waiters.push(callback);
        return state.handle;
      },
      closeIdleConnections: () => {
        state.idleClosed = true;
      },
      closeAllConnections: () => {
        state.allClosed = true;
      },
    },
  };
  return state;
}

describe("优雅关闭：可控替身", () => {
  it("立刻断开空闲连接，先不强制关闭", () => {
    const state = fakeServer();
    let forced = false;
    gracefulShutdown(state.handle, { graceMs: 10_000, onForced: () => (forced = true) });
    assert.equal(state.idleClosed, true, "应立刻断开空闲连接");
    assert.equal(state.allClosed, false, "此时不应强制关闭活跃连接");
    assert.equal(forced, false);
  });

  it("活跃请求在宽限期内完成时，回调只触发一次且不强制关闭", () => {
    const state = fakeServer();
    let closed = 0;
    let forced = 0;
    gracefulShutdown(state.handle, { graceMs: 10_000, onClosed: () => (closed += 1), onForced: () => (forced += 1) });
    // 模拟请求处理完，close 回调触发
    state.waiters.forEach((callback) => callback());
    assert.equal(closed, 1);
    assert.equal(forced, 0);
    assert.equal(state.allClosed, false);
  });

  it("宽限期耗尽时强制关闭并回调", () => {
    const state = fakeServer();
    let closed = 0;
    let forced = 0;
    gracefulShutdown(state.handle, {
      graceMs: 5,
      onClosed: () => (closed += 1),
      onForced: () => (forced += 1),
    });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.equal(forced, 1, "应报告强制关闭");
        assert.equal(closed, 1, "仍应回调关闭完成");
        assert.equal(state.allClosed, true, "宽限期耗尽后应强制断开连接");
        resolve();
      }, 30);
    });
  });

  it("默认宽限期足够覆盖一题的默认预算量级", () => {
    assert.ok(DEFAULT_SHUTDOWN_GRACE_MS >= 10_000, `宽限期 ${DEFAULT_SHUTDOWN_GRACE_MS}ms 过短`);
  });
});

describe("优雅关闭：真实 HTTP 服务", () => {
  it("正在处理的请求不会被硬切", async () => {
    const server: Server = createServer((_request, response) => {
      setTimeout(() => response.end("done"), 60);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;

    const inflight = fetch(`http://127.0.0.1:${port}/slow`, { signal: AbortSignal.timeout(5000) });
    await new Promise((resolve) => setTimeout(resolve, 20));

    let forced = false;
    gracefulShutdown(server, { graceMs: 5000, onForced: () => (forced = true) });

    const response = await inflight;
    assert.equal(await response.text(), "done", "正在处理的请求应正常完成");
    assert.equal(forced, false, "请求完成前不应强制关闭");
    server.closeAllConnections?.();
  });

  it("宽限期耗尽时强制断开挂起的连接", async () => {
    const server: Server = createServer(() => {
      // 故意不响应，模拟卡住的上游
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;

    const inflight = fetch(`http://127.0.0.1:${port}/hang`, { signal: AbortSignal.timeout(5000) }).catch(
      (error: unknown) => error as Error,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    let forced = false;
    gracefulShutdown(server, { graceMs: 50, onForced: () => (forced = true) });

    const outcome = await inflight;
    assert.ok(outcome instanceof Error, "宽限期结束后挂起的请求应被断开，而不是无限等待");
    assert.equal(forced, true, "应报告强制关闭");
  });
});
