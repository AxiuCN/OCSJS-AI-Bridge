/**
 * 多后端实测：真实 HTTP + 真实上游，验证候选链降级与能力过滤。
 *
 * 用临时配置启动一个独立端口的服务实例，不触碰工作区的 config.jsonc：
 *   - primary  : Ollama，但故意指向不存在的模型 → 必然 404，属于后端级失败
 *   - secondary: Ollama，真实可用模型
 * 期望：
 *   1) 纯文本题：primary 失败后自动降级到 secondary 并成功
 *   2) 图片题：primary 被跳过（无视觉能力）→ secondary 也无视觉 → 明确报错，不猜
 *
 * 用法：npx tsx scripts/smoke-multibackend.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.OLLAMA_BASE_URL ?? "http://192.168.18.10:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
const TOKEN = "multibackend-smoke-token";
const PORT = 8123;

const workdir = mkdtempSync(join(tmpdir(), "ocs-bridge-multi-"));
const configPath = join(workdir, "config.jsonc");

interface Check {
  name: string;
  ok: boolean;
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
          name: "primary-broken",
          kind: "ollama",
          base_url: BASE,
          model: "definitely-not-installed:1b",
          capabilities: { vision: true, thinking: false },
          timeout_seconds: 30,
          max_concurrency: 2,
        },
        {
          name: "secondary-real",
          kind: "ollama",
          base_url: BASE,
          model: MODEL,
          capabilities: { vision: false, thinking: false },
          timeout_seconds: 120,
          max_concurrency: 2,
        },
      ],
      strategy: "auto",
      routes: [{ type: "*", backends: ["primary-broken", "secondary-real"] }],
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
      // 服务尚未就绪，继续等待
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

const PIXEL = `data:image/png;base64,${Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFklEQVQoz2P8z8Dwn4GKgIlhFIxsAAB2ogQBpFEYbwAAAABJRU5ErkJggg==",
  "base64",
).toString("base64")}`;

async function ask(payload: Record<string, unknown>, timeoutMs = 180_000): Promise<Record<string, unknown>> {
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
  console.log("多后端实测：primary 使用不存在的模型，secondary 使用真实模型\n");

  let child: ChildProcess | undefined;
  try {
    // 不用 "pipe"：沙箱环境禁止为子进程创建管道（EPERM），日志交给服务自身输出。
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

    // 1) 纯文本题：应降级到 secondary 并成功
    const started = Date.now();
    const text = await ask({ title: "1+1 等于几？", options: "1\n2\n3", type: "single" });
    const textMs = Date.now() - started;
    const warnings = Array.isArray(text.warnings) ? (text.warnings as string[]) : [];
    const textOk = text.code === 1 && text.answer === "2" && String(text.model).startsWith("secondary-real/");
    checks.push({
      name: "纯文本题降级到可用后端",
      ok: textOk,
      detail: `code=${text.code} answer=${JSON.stringify(text.answer)} model=${text.model} 耗时 ${textMs}ms`,
    });

    // 2) 降级过程必须回传给客户端（否则 OCS 端只能看到"换个后端了"却无从得知）
    const downgradeNoted = warnings.some((item) => item.includes("primary-broken") && item.includes("作答失败"));
    checks.push({
      name: "warnings 记录降级到哪个后端失败",
      ok: downgradeNoted,
      detail: downgradeNoted ? JSON.stringify(warnings[0]).slice(0, 140) : `warnings=${JSON.stringify(warnings)}`,
    });

    // 3) 图片题：secondary 未声明视觉能力必须被跳过；primary 因模型不存在而失败。
    //    最终报错必须同时点出这两个真实原因（断言要具体，不能用宽泛字符串蒙混）。
    const image = await ask({
      title: "这张图是什么颜色？",
      options: "红色\n绿色",
      type: "single",
      images: [{ source_url: "https://cx.test/x.png", data_url: PIXEL }],
    });
    const message = String(image.message ?? "");
    const skippedForVision = message.includes("secondary-real: 不具备视觉能力");
    const primaryFailure = message.includes("primary-broken");
    const imageOk = image.code === 0 && skippedForVision && primaryFailure;
    checks.push({
      name: "图片题：无视觉能力的后端被跳过，且报错点出每个候选的真实原因",
      ok: imageOk,
      detail: `code=${image.code} 跳过原因=${skippedForVision} 主候选失败=${primaryFailure} message=${JSON.stringify(message).slice(0, 200)}`,
    });
  } finally {
    child?.kill();
    rmSync(workdir, { recursive: true, force: true });
  }

  console.log("结果：");
  for (const check of checks) {
    console.log(`  [${check.ok ? "符合预期" : "不符合预期"}] ${check.name}`);
    console.log(`      ${check.detail}`);
  }
  const failed = checks.filter((check) => !check.ok).length;
  console.log(failed === 0 ? "\n全部符合预期" : `\n有 ${failed} 项不符合预期`);
  if (failed > 0) process.exitCode = 1;
}

await main();
