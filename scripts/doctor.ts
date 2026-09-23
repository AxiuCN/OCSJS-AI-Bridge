/**
 * 部署自检：一条命令确认这台机器是否具备运行条件。
 *
 * 用法：npm run doctor
 * 退出码：0 全部就绪；1 存在失败项（警告项不影响启动）
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { ConfigError, DEFAULT_CONFIG_PATH, loadConfig } from "../src/config.js";
import { createBackend, missingCredentials } from "../src/backends.js";
import { normalizeQuestion } from "../src/normalize.js";
import { buildPrompt } from "../src/prompt.js";
import { parseModelOutput, UpstreamError } from "../src/upstream/base.js";
import type { BackendConfig, LoadedConfig } from "../src/types.js";

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 9;

let failures = 0;
let warnings = 0;

function pass(message: string): void {
  console.log(`  [OK]   ${message}`);
}

function warn(message: string): void {
  warnings += 1;
  console.log(`  [警告] ${message}`);
}

function fail(message: string): void {
  failures += 1;
  console.log(`  [失败] ${message}`);
}

function checkNode(): void {
  console.log("\n1) 运行环境");
  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  const ok = major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
  const platform = `${process.platform}-${process.arch}`;
  if (ok) pass(`Node.js ${process.versions.node}（${platform}）`);
  else fail(`Node.js ${process.versions.node} 版本过低，需要 >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`);

  if (process.platform === "linux") {
    pass("当前为 Linux：建议用 deploy/ocs-ai-bridge.service 以 systemd 方式常驻");
  } else if (process.platform === "win32") {
    pass("当前为 Windows：可用 deploy/start.bat 启动，或注册为计划任务/服务");
  } else {
    warn(`未在 ${process.platform} 上验证过；本项目仅在 Windows 与 Linux 上验证`);
  }
  pass(`运行期第三方依赖：无（仅使用 Node 标准库）`);
}

function checkConfigFile(): string | undefined {
  console.log("\n2) 配置文件");
  const path = resolve(process.env.BRIDGE_CONFIG ?? DEFAULT_CONFIG_PATH);
  if (!existsSync(path)) {
    fail(`找不到 ${path}，请从 config.example.jsonc 复制一份`);
    return undefined;
  }
  pass(`已找到 ${path}`);
  if (!existsSync(resolve(".env"))) {
    warn("未找到 .env；若配置里引用了 ${VAR} 占位符，启动会失败");
  } else {
    pass("已找到 .env");
  }
  return path;
}

async function probeBackend(backend: BackendConfig, loaded: LoadedConfig): Promise<void> {
  const entry = createBackend(backend, loaded.secrets);
  const question = normalizeQuestion({ title: "1+1 等于几？", options: "1\n2\n3", type: "single" });
  const prompt = buildPrompt(question, []);
  // 探测超时不能写死：本地小模型冷启动实测可达 40s+，写死 30s 会产生假失败。
  // 以服务端总预算为准（并留出余量），同时打印出来，避免用户误判成后端故障。
  const probeTimeoutMs = Math.max(30_000, (loaded.config.server.deadlineSeconds + 10) * 1000);
  console.log(`  探测 ${backend.name}（超时 ${Math.round(probeTimeoutMs / 1000)}s，冷启动首次加载可能较慢）...`);
  try {
    const startedAt = Date.now();
    const raw = await entry.backend.complete({
      prompt,
      model: backend.model,
      think: false,
      signal: AbortSignal.timeout(probeTimeoutMs),
      ...(backend.reasoningEffort !== undefined ? { reasoningEffort: backend.reasoningEffort } : {}),
    });
    const parsed = parseModelOutput(raw.text, backend.name);
    pass(
      `${backend.name}(${backend.kind}/${backend.model}) 应答正常，耗时 ${Date.now() - startedAt}ms，返回 answer=${JSON.stringify(parsed.answer)}`,
    );
  } catch (error) {
    const message = error instanceof UpstreamError ? error.message : String(error);
    fail(
      `${backend.name}(${backend.kind}/${backend.model}) 不可用：${message}` +
        `（若为超时，可能是模型首次加载；可先手动调用一次预热，或调大 server.deadline_seconds）`,
    );
  }
}

async function main(): Promise<void> {
  console.log("OCS AI 桥接服务 · 部署自检");

  checkNode();
  const path = checkConfigFile();
  if (path === undefined) {
    console.log(`\n结果：${failures} 项失败，${warnings} 项警告`);
    process.exitCode = 1;
    return;
  }

  console.log("\n3) 配置校验");
  let loaded: LoadedConfig;
  try {
    loaded = loadConfig({ path });
  } catch (error) {
    if (error instanceof ConfigError) {
      fail(error.message);
      console.log(`\n结果：${failures} 项失败，${warnings} 项警告`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  pass(
    `配置有效：${loaded.config.backends.length} 个后端，${loaded.config.routes.length} 条路由，` +
      `总预算 ${loaded.config.server.deadlineSeconds}s`,
  );
  for (const item of loaded.warnings) warn(item);
  for (const item of missingCredentials(loaded.config.backends, loaded.secrets)) fail(item);
  if (!loaded.secrets.accessToken) warn("未设置 server.access_token：任何能访问该端口的人都能调用答题接口");

  console.log("\n4) 后端连通性（逐个发起一次真实请求；冷启动首次加载可能较慢）");
  for (const backend of loaded.config.backends) {
    await probeBackend(backend, loaded);
  }

  console.log(`\n结果：${failures} 项失败，${warnings} 项警告`);
  if (failures === 0) {
    console.log("环境就绪，可以执行 npm start 启动服务。");
    if (process.platform === "linux") {
      console.log("常驻运行：sudo cp deploy/ocs-ai-bridge.service /etc/systemd/system/ && sudo systemctl enable --now ocs-ai-bridge");
    }
  } else {
    console.log("请先解决失败项，再启动服务。");
    process.exitCode = 1;
  }
}

await main();
