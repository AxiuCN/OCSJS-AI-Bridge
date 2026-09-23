/**
 * 按题型路由实测：验证不同题型真的被送到不同后端。
 *
 * 与 smoke-multibackend 的区别：那个验证"同级候选的降级"，
 * 这个验证"按题型分流"——两条路由指向不同的真实模型，
 * 因此响应里的 model 字段可以直接证明请求落在了哪个后端上。
 *
 * 配置（临时，不触碰工作区的 config.jsonc）：
 *   judgement → judge-small  : deepseek-r1:14b（纯文本推理）
 *   *         → vision-model : qwen3.5:9b（有视觉能力）
 *
 * 用法：npx tsx scripts/smoke-routing.ts
 * 若某个模型未安装，对应用例会标记为"跳过"而不是失败。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.OLLAMA_BASE_URL ?? "http://192.168.18.10:11434";
const VISION_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
const TEXT_MODEL = process.env.OLLAMA_TEXT_MODEL ?? "deepseek-r1:14b";
const TOKEN = "routing-smoke-token";
const PORT = 8126;

const PIXEL = `data:image/png;base64,${Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVQoz2P8z8Dwn4GKgIlhFIxsAAB2ogQBpFEYbwAAAABJRU5ErkJggg==",
  "base64",
).toString("base64")}`;

const workdir = mkdtempSync(join(tmpdir(), "ocs-bridge-routing-"));
const configPath = join(workdir, "config.jsonc");

interface Check {
  name: string;
  status: "符合预期" | "不符合预期" | "跳过";
  detail: string;
}

const checks: Check[] = [];

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
          name: "judge-small",
          kind: "ollama",
          base_url: BASE,
          model: TEXT_MODEL,
          capabilities: { vision: false, thinking: false },
          timeout_seconds: 150,
          max_concurrency: 1,
        },
        {
          name: "vision-model",
          kind: "ollama",
          base_url: BASE,
          model: VISION_MODEL,
          capabilities: { vision: true, thinking: false },
          timeout_seconds: 150,
          max_concurrency: 1,
        },
      ],
      strategy: "auto",
      routes: [
        { type: "judgement", backends: ["judge-small"] },
        { type: "*", backends: ["vision-model"] },
      ],
    },
    null,
    2,
  );
}

async function installedModels(): Promise<Set<string>> {
  try {
    const response = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const body = (await response.json()) as { models?: Array<{ name?: string }> };
    return new Set((body.models ?? []).map((item) => item.name ?? ""));
  } catch {
    return new Set();
  }
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

async function ask(payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${PORT}/v1/answer`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", "x-access-token": TOKEN },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await response.json()) as Record<string, unknown>;
}

async function main(): Promise<void> {
  writeFileSync(configPath, configText(), "utf8");

  const installed = await installedModels();
  const textAvailable = installed.has(TEXT_MODEL);
  const visionAvailable = installed.has(VISION_MODEL);
  console.log(`按题型路由实测`);
  console.log(`  judgement → judge-small(${TEXT_MODEL})：${textAvailable ? "已安装" : "未安装"}`);
  console.log(`  *         → vision-model(${VISION_MODEL})：${visionAvailable ? "已安装" : "未安装"}\n`);

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

    // 1) 选择题应走 vision-model（* 兜底路由）
    if (!visionAvailable) {
      checks.push({ name: "选择题走兜底路由", status: "跳过", detail: `${VISION_MODEL} 未安装` });
    } else {
      const body = await ask({ title: "1+1 等于几？", options: "1\n2\n3", type: "single" }, 180_000);
      const model = String(body.model ?? "");
      const ok = body.code === 1 && model.startsWith("vision-model/");
      checks.push({
        name: "选择题走兜底路由（* → vision-model）",
        status: ok ? "符合预期" : "不符合预期",
        detail: `code=${body.code} model=${model} answer=${JSON.stringify(body.answer)}`,
      });
    }

    // 2) 判断题应走 judge-small（精确题型路由优先于兜底）
    if (!textAvailable) {
      checks.push({ name: "判断题走精确路由", status: "跳过", detail: `${TEXT_MODEL} 未安装` });
    } else {
      const body = await ask({ title: "1+1=2 这个说法正确吗？", options: "正确\n错误", type: "judgement" }, 180_000);
      const model = String(body.model ?? "");
      const ok = body.code === 1 && model.startsWith("judge-small/");
      checks.push({
        name: `判断题走精确路由（judgement → judge-small）`,
        status: ok ? "符合预期" : "不符合预期",
        detail: `code=${body.code} model=${model} answer=${JSON.stringify(body.answer)}`,
      });
    }

    // 3) 图片题只能交给声明了 vision 的后端：判断题路由里的 judge-small 无视觉能力，
    //    但题型是 judgement 时它不该被能力过滤掉（因为没有图）——这里验证的是
    //    "带图的判断题"会被跳过并最终回落到兜底路由，报错时如实说明原因。
    if (!textAvailable || !visionAvailable) {
      checks.push({ name: "带图判断题的能力处理", status: "跳过", detail: "模型未安装" });
    } else {
      const body = await ask(
        {
          title: "这张图里的等式成立吗？",
          options: "正确\n错误",
          type: "judgement",
          images: [{ source_url: "http://127.0.0.1:9/none.png", data_url: PIXEL }],
        },
        180_000,
      );
      // judgement 路由只配了 judge-small（vision:false）→ 应被跳过；
      // 由于该路由没有下一个候选，最终是"所有候选失败"，且原因须写明不具备视觉能力
      const message = String(body.message ?? "");
      const ok = body.code === 0 && message.includes("judge-small") && message.includes("不具备视觉能力");
      checks.push({
        name: "带图判断题：无视觉能力的候选被跳过并说明原因",
        status: ok ? "符合预期" : "不符合预期",
        detail: `code=${body.code} message=${JSON.stringify(message).slice(0, 160)}`,
      });
    }
  } finally {
    child?.kill();
    rmSync(workdir, { recursive: true, force: true });
  }

  console.log("结果：");
  for (const check of checks) {
    console.log(`  [${check.status}] ${check.name}`);
    console.log(`      ${check.detail}`);
  }
  const failed = checks.filter((check) => check.status === "不符合预期").length;
  const skipped = checks.filter((check) => check.status === "跳过").length;
  console.log(
    failed === 0
      ? `\n全部符合预期${skipped > 0 ? `（${skipped} 项因模型未安装跳过）` : ""}`
      : `\n有 ${failed} 项不符合预期`,
  );
  if (failed > 0) process.exitCode = 1;
}

await main();
