/**
 * 进程入口：加载配置 → 启动 HTTP 服务 → 优雅关闭。
 *
 * 用法：
 *   node dist/server.js                 # 启动服务（默认读 config.jsonc）
 *   node dist/server.js --config=a.jsonc
 *   node dist/server.js show-config     # 打印脱敏后的配置摘要后退出
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError, DEFAULT_CONFIG_PATH, loadConfig } from "./config.js";
import { createBackend, missingCredentials } from "./backends.js";
import { createApp, type AnswerHandler } from "./httpapi.js";
import { ImagePreparer } from "./images.js";
import { createLogger, type Logger } from "./logger.js";
import { summarizeConfig } from "./redact.js";
import { AnswerEngine } from "./routing.js";
import { DEFAULT_SHUTDOWN_GRACE_MS, gracefulShutdown } from "./shutdown.js";
import type { LoadedConfig } from "./types.js";

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, "..", "package.json"), resolve(here, "..", "..", "package.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
      // 继续尝试下一个候选位置
    }
  }
  return "0.0.0";
}

export const VERSION = readVersion();

interface CliOptions {
  command: "serve" | "show-config";
  configPath: string | undefined;
}

export function parseArgs(argv: string[]): CliOptions {
  let command: CliOptions["command"] = "serve";
  let configPath: string | undefined;
  for (const arg of argv) {
    if (arg === "show-config" || arg === "--show-config") {
      command = "show-config";
      continue;
    }
    const matched = /^--config=(.+)$/.exec(arg);
    if (matched) {
      configPath = matched[1]!.trim();
      continue;
    }
  }
  return { command, configPath };
}

function splitListen(listen: string): { host: string; port: number } {
  const matched = /^(.*):(\d{1,5})$/.exec(listen);
  if (!matched) throw new Error(`server.listen 配置无效：${listen}`);
  return { host: matched[1]!, port: Number(matched[2]) };
}

/** 组装答题链路：后端实例 + 图片准备 + 路由引擎。 */
function createAnswerHandler(loaded: LoadedConfig, logger: Logger): AnswerHandler {
  const backends = loaded.config.backends.map((backend) => createBackend(backend, loaded.secrets));
  const images = new ImagePreparer({
    imageTimeoutSeconds: loaded.config.limits.imageTimeoutSeconds,
    maxImages: loaded.config.limits.maxImages,
    maxImageBytes: loaded.config.limits.maxImageBytes,
    imageConcurrency: loaded.config.limits.imageConcurrency,
    requireDeclaredImages: loaded.config.answer.requireDeclaredImages,
  });
  const engine = new AnswerEngine({ config: loaded.config, backends, images, logger });
  return (payload, signal) => engine.answer(payload, signal);
}

const logger = createLogger();

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  let loaded;
  try {
    loaded = loadConfig({ path: cli.configPath ?? process.env.BRIDGE_CONFIG ?? DEFAULT_CONFIG_PATH });
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error("配置校验失败", { reason: error.message });
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  for (const warning of loaded.warnings) logger.warn("配置提示", { detail: warning });

  // 非 ollama 后端没有凭据就必然失败，启动时先说清楚，别等答题时才暴露。
  for (const missing of missingCredentials(loaded.config.backends, loaded.secrets)) {
    logger.error("后端凭据缺失", { detail: missing });
  }

  if (cli.command === "show-config") {
    process.stdout.write(JSON.stringify(summarizeConfig(loaded, VERSION), null, 2) + "\n");
    return;
  }

  const app = createApp({
    loaded,
    version: VERSION,
    logger,
    answer: createAnswerHandler(loaded, logger),
  });
  const { host, port } = splitListen(app.config.server.listen);
  const server = app.createHttpServer();

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      logger.error("端口已被占用", { listen: app.config.server.listen });
    } else if (error.code === "EACCES") {
      logger.error("没有权限监听该端口", { listen: app.config.server.listen });
    } else {
      logger.error("HTTP 服务启动失败", { error });
    }
    process.exitCode = 1;
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("listening", resolveListen);
    server.once("error", rejectListen);
    server.listen(port, host);
  }).catch(() => {
    // 具体原因已由上面的 error 处理器记录
  });

  if (!server.listening) return;

  const summary = summarizeConfig(loaded, VERSION);
  logger.info("服务已启动", {
    version: VERSION,
    listen: `http://${app.config.server.listen}`,
    auth_enabled: summary.auth_enabled,
    deadline_seconds: summary.deadline_seconds,
    backends: summary.backends.map((backend) => `${backend.name}(${backend.kind}/${backend.model})`),
    routes: summary.routes.map((route) => `${route.type}->${route.backends.join(">")}`),
  });
  if (!summary.auth_enabled) {
    logger.warn("未设置 server.access_token：任何能访问该端口的人都能调用答题接口");
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // 宽限期可通过环境变量调整：默认 30s，够一题（170s 预算）的常见耗时；
    // 若把 deadline_seconds 调得很小，可相应调小这里，加快重启。
    const rawGrace = Number(process.env.SHUTDOWN_GRACE_MS);
    const graceMs = Number.isFinite(rawGrace) && rawGrace >= 0 ? rawGrace : DEFAULT_SHUTDOWN_GRACE_MS;
    logger.info("收到退出信号，开始优雅关闭", { signal, grace_ms: graceMs });
    gracefulShutdown(server, {
      graceMs,
      onWaiting: (hint) => logger.info(hint, { grace_ms: graceMs }),
      onForced: () => logger.warn("宽限期结束，强制关闭仍在处理的请求"),
      onClosed: () => {
        logger.info("已关闭");
        process.exit(0);
      },
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  logger.error("未捕获的启动错误", { error });
  process.exitCode = 1;
});
