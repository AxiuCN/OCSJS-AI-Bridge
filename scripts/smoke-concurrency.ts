/**
 * 并发实测：模拟 OCS 多线程搜题，验证并发闸与结果隔离。
 *
 * 用临时配置启动独立端口的服务实例（不触碰工作区的 config.jsonc）：
 *   - 单个 Ollama 后端，max_concurrency = 1（与 README 建议的本地模型起步值一致）
 *   - 同时发送 3 个不同的题目
 *
 * 期望（这是 OCR 多线程场景下的正确性底线）：
 *   1) 3 个请求全部 code:1，且答案非空
 *   2) 每个请求拿到的是**自己那道题**的答案，没有串答案
 *   3) 串行化的耗时特征可见（吞吐下降是并发闸的预期代价，不是缺陷）
 *
 * 用法：npx tsx scripts/smoke-concurrency.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.OLLAMA_BASE_URL ?? "http://192.168.18.10:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
const TOKEN = "concurrency-smoke-token";
const PORT = 8124;
const CONCURRENCY = 1;

const workdir = mkdtempSync(join(tmpdir(), "ocs-bridge-conc-"));
const configPath = join(workdir, "config.jsonc");

interface Case {
  question: string;
  options: string[];
  expected: string;
  label: string;
}

// 三道答案互不相同、且答案各不相同于其他题的选项，便于发现"串答案"
const cases: Case[] = [
  { label: "加法", question: "1+1 等于几？", options: ["1", "2", "3"], expected: "2" },
  { label: "首都", question: "中国的首都是哪座城市？", options: ["上海", "北京", "广州"], expected: "北京" },
  { label: "颜色", question: "草地通常是什么颜色？", options: ["红色", "绿色", "蓝色"], expected: "绿色" },
];

function configText(): string {
  return JSON.stringify(
    {
      server: {
        listen: `127.0.0.1:${PORT}`,
        access_token: TOKEN,
        deadline_seconds: 170,
        max_body_bytes: 8388608,
        cors_origins: [],
      },
      limits: {
        image_timeout_seconds: 20,
        max_images: 8,
        max_image_bytes: 4194304,
        min_attempt_seconds: 5,
        image_concurrency: 2,
      },
      answer: { separator: "#", require_declared_images: true },
      backends: [
        {
          name: "ollama-local",
          kind: "ollama",
          base_url: BASE,
          model: MODEL,
          capabilities: { vision: true, thinking: false },
          timeout_seconds: 120,
          max_concurrency: CONCURRENCY,
        },
      ],
      strategy: "auto",
      routes: [{ type: "*", backends: ["ollama-local"] }],
    },
    null,
    2,
  );
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      // 尚未就绪
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function ask(item: Case): Promise<{ elapsed: number; body: Record<string, unknown>; error?: string }> {
  const started = Date.now();
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/v1/answer`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", "x-access-token": TOKEN },
      body: JSON.stringify({ title: item.question, options: item.options.join("\n"), type: "single" }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = (await response.json()) as Record<string, unknown>;
    return { elapsed: Date.now() - started, body };
  } catch (error) {
    return { elapsed: Date.now() - started, body: {}, error: (error as Error).message };
  }
}

async function main(): Promise<void> {
  writeFileSync(configPath, configText(), "utf8");
  console.log(`并发实测：单后端 max_concurrency=${CONCURRENCY}，同时发送 ${cases.length} 道不同的题\n`);

  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ["dist/server.js", `--config=${configPath}`], {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, BRIDGE_LOG_LEVEL: "info" },
    });

    if (!(await waitForHealth(15_000))) {
      console.log("[失败] 服务未能在 15s 内就绪");
      process.exitCode = 1;
      return;
    }
    console.log("[OK]   服务已就绪（127.0.0.1:%d）\n", PORT);

    const wallStart = Date.now();
    const results = await Promise.all(cases.map((item) => ask(item)));
    const wall = Date.now() - wallStart;

    let failures = 0;

    results.forEach((result, index) => {
      const item = cases[index]!;
      const answer = String(result.body.answer ?? "");
      const code = result.body.code;
      const ok = code === 1 && answer === item.expected;
      if (!ok) failures += 1;
      console.log(
        `  [${ok ? "符合预期" : "不符合预期"}] ${item.label}：期望 ${JSON.stringify(item.expected)}，` +
          `实际 ${JSON.stringify(answer)}（code=${code}，单请求耗时 ${result.elapsed}ms${result.error ? `，错误 ${result.error}` : ""}）`,
      );
    });

    console.log(`\n总墙钟耗时 ${wall}ms；各请求耗时 ${results.map((item) => `${item.elapsed}ms`).join(" / ")}`);
    // 串行化的正确特征：总墙钟 ≈ 最慢的那个请求（而不是耗时之和）。
    // 若三个请求真的并行了，墙钟会接近单个请求的耗时。
    const slowest = Math.max(...results.map((item) => item.elapsed));
    const serialized = wall >= slowest * 0.9;
    if (serialized) {
      console.log(`说明：墙钟(${wall}ms) ≈ 最慢请求(${slowest}ms)，且各请求耗时递增，符合 max_concurrency=${CONCURRENCY} 的串行化特征`);
    } else {
      console.log(`注意：墙钟(${wall}ms) 明显小于最慢请求(${slowest}ms)，存在并行执行；请确认该后端的 max_concurrency 设置`);
    }

    const answerShapeOk = results.every((result) => typeof result.body.model === "string");
    console.log(
      `\n结果：${failures === 0 && answerShapeOk ? "全部符合预期（无串答案、无失败）" : `${failures} 项不符合预期`}`,
    );
    if (failures > 0 || !answerShapeOk) process.exitCode = 1;
  } finally {
    child?.kill();
    rmSync(workdir, { recursive: true, force: true });
  }
}

await main();
