/**
 * 策略钩子的契约测试。
 *
 * 重点：任何异常（文件缺失、脚本抛错、超时、返回值非法）都必须回退默认顺序，
 * 不能让一段 DIY 脚本把答题链路搞挂。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createLogger } from "../src/logger.js";
import { PolicyEvaluator, normalizeDecision, type PolicyContext } from "../src/policy.js";

const workdir = mkdtempSync(join(tmpdir(), "ocs-policy-"));
after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function silentLogger() {
  return createLogger({ write: () => {} });
}

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    now: new Date("2026-11-14T02:30:00+08:00"),
    questionType: "single",
    hasImages: false,
    imageCount: 0,
    backendNames: ["ollama-local", "deepseek-flash"],
    defaultOrder: ["ollama-local", "deepseek-flash"],
    ...overrides,
  };
}

function writePolicy(content: string): string {
  const file = join(workdir, `policy-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(file, content, "utf8");
  return file;
}

const DEFAULT_ORDER = ["ollama-local", "deepseek-flash"];

describe("policy：返回值规范化", () => {
  const allowed = new Set(["ollama-local", "deepseek-flash"]);

  it("接受字符串数组", () => {
    const result = normalizeDecision(["deepseek-flash", "ollama-local"], allowed);
    assert.deepEqual(
      result.candidates.map((item) => item.name),
      ["deepseek-flash", "ollama-local"],
    );
    assert.deepEqual(result.notes, []);
  });

  it("接受对象数组并保留 timeout / think 覆盖", () => {
    const result = normalizeDecision(
      [{ name: "deepseek-flash", timeoutSeconds: 30, think: true }],
      allowed,
    );
    assert.deepEqual(result.candidates, [{ name: "deepseek-flash", timeoutSeconds: 30, think: true }]);
  });

  it("过滤未配置的后端并说明原因", () => {
    const result = normalizeDecision(["nope", "ollama-local"], allowed);
    assert.deepEqual(result.candidates.map((item) => item.name), ["ollama-local"]);
    assert.match(result.notes[0]!, /未配置的后端 nope/u);
  });

  it("非数组返回空候选并说明原因", () => {
    const result = normalizeDecision({ name: "ollama-local" }, allowed);
    assert.deepEqual(result.candidates, []);
    assert.match(result.notes[0]!, /不是数组/u);
  });

  it("重复候选只保留第一个", () => {
    const result = normalizeDecision(["ollama-local", "ollama-local"], allowed);
    assert.equal(result.candidates.length, 1);
  });
});

describe("policy：执行与回退", () => {
  it("未配置文件时直接返回默认顺序", async () => {
    const evaluator = new PolicyEvaluator({ logger: silentLogger() });
    const decision = await evaluator.decide(context());
    assert.deepEqual(decision.candidates.map((item) => item.name), DEFAULT_ORDER);
    assert.deepEqual(decision.notes, []);
  });

  it("文件不存在时回退默认并记录原因", async () => {
    const evaluator = new PolicyEvaluator({ file: join(workdir, "missing.mjs"), logger: silentLogger() });
    const decision = await evaluator.decide(context());
    assert.deepEqual(decision.candidates.map((item) => item.name), DEFAULT_ORDER);
    assert.ok(decision.notes.some((note) => note.includes("不可用")));
  });

  it("正常返回时使用脚本给出的顺序", async () => {
    const file = writePolicy('export function decide() { return ["deepseek-flash"]; }');
    const evaluator = new PolicyEvaluator({ file, logger: silentLogger() });
    const decision = await evaluator.decide(context());
    assert.deepEqual(decision.candidates.map((item) => item.name), ["deepseek-flash"]);
  });

  it("脚本抛错时回退默认顺序", async () => {
    const file = writePolicy('export function decide() { throw new Error("boom"); }');
    const evaluator = new PolicyEvaluator({ file, logger: silentLogger() });
    const decision = await evaluator.decide(context());
    assert.deepEqual(decision.candidates.map((item) => item.name), DEFAULT_ORDER);
    assert.ok(decision.notes.some((note) => note.includes("boom")));
  });

  it("执行超时时回退默认顺序", async () => {
    const file = writePolicy("export function decide() { return new Promise(() => {}); }");
    const evaluator = new PolicyEvaluator({ file, timeoutMs: 20, logger: silentLogger() });
    const decision = await evaluator.decide(context());
    assert.deepEqual(decision.candidates.map((item) => item.name), DEFAULT_ORDER);
    assert.ok(decision.notes.some((note) => note.includes("超过 20ms")));
  });

  it("返回空数组时回退默认顺序", async () => {
    const file = writePolicy("export function decide() { return []; }");
    const evaluator = new PolicyEvaluator({ file, logger: silentLogger() });
    const decision = await evaluator.decide(context());
    assert.deepEqual(decision.candidates.map((item) => item.name), DEFAULT_ORDER);
    assert.ok(decision.notes.some((note) => note.includes("未给出可用后端")));
  });

  it("可读取上下文（题型 / 时间 / 是否带图）", async () => {
    const file = writePolicy(`
export function decide(ctx) {
  const hour = ctx.now.getHours();
  if (ctx.hasImages) return ["deepseek-flash"];
  if (ctx.questionType === "judgement" && hour >= 22) return ["ollama-local"];
  return ["deepseek-flash", "ollama-local"];
}
`);
    const evaluator = new PolicyEvaluator({ file, logger: silentLogger() });

    const imageDecision = await evaluator.decide(context({ hasImages: true, imageCount: 1 }));
    assert.deepEqual(imageDecision.candidates.map((item) => item.name), ["deepseek-flash"]);

    const nightJudgement = await evaluator.decide(
      context({ questionType: "judgement", now: new Date("2026-11-14T23:00:00+08:00") }),
    );
    assert.deepEqual(nightJudgement.candidates.map((item) => item.name), ["ollama-local"]);
  });

  it("策略返回循环引用对象时不崩溃，回退默认顺序", async () => {
    const file = writePolicy(`
export function decide() {
  const a = {};
  a.self = a;
  return [a];
}
`);
    const evaluator = new PolicyEvaluator({ file, logger: silentLogger() });
    const decision = await evaluator.decide(context());
    assert.deepEqual(decision.candidates.map((item) => item.name), DEFAULT_ORDER);
    assert.ok(decision.notes.some((note) => note.includes("无法识别")));
  });

  it("策略返回 BigInt 时不崩溃（序列化会抛 TypeError）", async () => {
    const file = writePolicy("export function decide() { return [{ name: 1n }]; }");
    const evaluator = new PolicyEvaluator({ file, logger: silentLogger() });
    const decision = await evaluator.decide(context());
    assert.deepEqual(decision.candidates.map((item) => item.name), DEFAULT_ORDER);
    assert.ok(decision.notes.some((note) => note.includes("无法识别")));
  });

  it("未知后端被过滤，但仍有有效候选时继续使用（不回退）", async () => {
    const file = writePolicy('export function decide() { return ["nope", "deepseek-flash"]; }');
    const evaluator = new PolicyEvaluator({ file, logger: silentLogger() });
    const decision = await evaluator.decide(context());
    assert.deepEqual(decision.candidates.map((item) => item.name), ["deepseek-flash"]);
    assert.ok(decision.notes.some((note) => note.includes("未配置的后端 nope")));
  });

  it("热重载：文件修改后无需重启即生效", async () => {
    const file = writePolicy('export function decide() { return ["ollama-local"]; }');
    const evaluator = new PolicyEvaluator({ file, logger: silentLogger() });

    const first = await evaluator.decide(context());
    assert.deepEqual(first.candidates.map((item) => item.name), ["ollama-local"]);

    writeFileSync(file, 'export function decide() { return ["deepseek-flash"]; }', "utf8");
    // 强制推进 mtime，避免同一毫秒内命中模块缓存
    const future = new Date(Date.now() + 2000);
    utimesSync(file, future, future);

    const second = await evaluator.decide(context());
    assert.deepEqual(second.candidates.map((item) => item.name), ["deepseek-flash"]);
  });
});
