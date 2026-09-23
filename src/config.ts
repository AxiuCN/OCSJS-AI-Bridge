/**
 * 配置加载与启动校验。
 *
 * 流程：读文件 → 解析 JSONC → 展开 ${ENV} → 结构校验与默认值 → 脱敏。
 * 校验失败一律抛 ConfigError，消息里只出现字段路径与原因，不回显任何值。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expandDeep, findUnresolvedPlaceholders, loadEnvFile } from "./env.js";
import { parseJsonc } from "./jsonc.js";
import {
  BACKEND_KINDS,
  SENSITIVE_MASK,
  type BackendCapabilities,
  type BackendConfig,
  type BackendKind,
  type Config,
  type LoadedConfig,
  type RouteConfig,
  type Secrets,
} from "./types.js";

export const DEFAULT_CONFIG_PATH = "config.jsonc";

const DEFAULT_LISTEN = "0.0.0.0:8000";
const DEFAULT_DEADLINE_SECONDS = 170;
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_IMAGE_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_IMAGES = 24;
const DEFAULT_MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DEFAULT_MIN_ATTEMPT_SECONDS = 5;
const DEFAULT_IMAGE_CONCURRENCY = 4;
const DEFAULT_SEPARATOR = "#";
const DEFAULT_REASONING_EFFORT = "xhigh";

const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

// 以下键集合同时用于两处：解析时的"未识别字段"告警，以及
// tests/config.test.ts 的"示例配置与代码是否漂移"契约测试。
export const TOP_LEVEL_KEYS = new Set([
  "server",
  "limits",
  "answer",
  "backends",
  "strategy",
  "routes",
]);
export const SERVER_KEYS = new Set(["listen", "access_token", "deadline_seconds", "max_body_bytes", "cors_origins"]);
export const LIMITS_KEYS = new Set([
  "image_timeout_seconds",
  "max_images",
  "max_image_bytes",
  "min_attempt_seconds",
  "image_concurrency",
]);
export const ANSWER_KEYS = new Set(["separator", "require_declared_images"]);
export const BACKEND_KEYS = new Set([
  "name",
  "kind",
  "base_url",
  "api_key",
  "model",
  "capabilities",
  "timeout_seconds",
  "max_concurrency",
  "reasoning_effort",
  "endpoint_path",
]);
export const CAPABILITY_KEYS = new Set(["vision", "thinking"]);
export const ROUTE_KEYS = new Set(["type", "backends"]);

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function fail(message: string): never {
  throw new ConfigError(message);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "数组";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warnUnknownKeys(source: Record<string, unknown>, allowed: Set<string>, path: string, warnings: string[]): void {
  const unknown = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    warnings.push(`${path} 含未识别的字段将被忽略：${unknown.join(", ")}`);
  }
}

function section(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  return isRecord(value) ? value : {};
}

function readString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  options: { required?: boolean; allowEmpty?: boolean } = {},
): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) {
    if (options.required) fail(`缺少必填配置项 ${path}`);
    return undefined;
  }
  if (typeof value !== "string") fail(`配置项 ${path} 必须是字符串，当前为 ${describe(value)}`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (options.required) fail(`配置项 ${path} 不能为空`);
    if (options.allowEmpty === false) return undefined;
    return undefined;
  }
  return trimmed;
}

function readBoolean(source: Record<string, unknown>, key: string, path: string, fallback: boolean): boolean {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") fail(`配置项 ${path} 必须是布尔值 true/false，当前为 ${describe(value)}`);
  return value;
}

function readNumber(
  source: Record<string, unknown>,
  key: string,
  path: string,
  fallback: number,
  bounds: { min?: number; max?: number; integer?: boolean },
): number {
  const value = source[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`配置项 ${path} 必须是数字，当前为 ${describe(value)}`);
  }
  if (bounds.integer && !Number.isInteger(value)) fail(`配置项 ${path} 必须是整数`);
  if (bounds.min !== undefined && value < bounds.min) fail(`配置项 ${path} 不能小于 ${bounds.min}`);
  if (bounds.max !== undefined && value > bounds.max) fail(`配置项 ${path} 不能大于 ${bounds.max}`);
  return value;
}

function readStringArray(source: Record<string, unknown>, key: string, path: string): string[] {
  const value = source[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`配置项 ${path} 必须是字符串数组`);
  return value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) fail(`配置项 ${path}[${index}] 必须是非空字符串`);
    return item.trim();
  });
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

interface ParsedUrl {
  protocol: string;
  hostname: string;
  pathname: string;
}

function parseUrl(value: string, path: string): ParsedUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`配置项 ${path} 不是合法 URL：${value}`);
  }
  return { protocol: url.protocol, hostname: url.hostname, pathname: url.pathname.replace(/\/+$/, "") };
}

function joinPath(base: string, suffix: string): string {
  return base.replace(/\/+$/, "") + suffix;
}

/** 推导出真正用于请求的地址；已写全路径的 base_url 原样保留（兼容既有部署）。 */
function resolveEndpoint(
  kind: BackendKind,
  baseUrl: string,
  endpointPath: string | undefined,
  path: string,
): string {
  if (endpointPath) {
    return endpointPath.startsWith("http") ? endpointPath : joinPath(baseUrl, endpointPath);
  }
  const { pathname } = parseUrl(baseUrl, path);
  switch (kind) {
    case "ollama":
      if (pathname.endsWith("/api/chat")) return baseUrl;
      if (pathname.endsWith("/api")) return joinPath(baseUrl, "/chat");
      return joinPath(baseUrl, "/api/chat");
    case "openai_chat":
      if (pathname.endsWith("/chat/completions")) return baseUrl;
      if (pathname.endsWith("/v1")) return joinPath(baseUrl, "/chat/completions");
      return joinPath(baseUrl, "/v1/chat/completions");
    case "openai_responses":
      if (pathname.endsWith("/v1/responses")) return baseUrl;
      if (pathname.endsWith("/v1")) return joinPath(baseUrl, "/responses");
      return joinPath(baseUrl, "/v1/responses");
  }
}

function validateEndpointScheme(kind: BackendKind, endpoint: string, path: string): void {
  const { protocol, hostname } = parseUrl(endpoint, path);
  if (protocol !== "http:" && protocol !== "https:") fail(`配置项 ${path} 只支持 http/https`);
  // 远端后端必须走 https，避免 API Key 明文出网；本机回环允许 http。
  if (kind !== "ollama" && protocol === "http:" && !isLoopbackHost(hostname)) {
    fail(`配置项 ${path} 指向远端地址时必须使用 https（当前为 http://${hostname}）`);
  }
}

function parseBackend(raw: unknown, index: number, warnings: string[]): BackendConfig {
  const path = `backends[${index}]`;
  if (!isRecord(raw)) fail(`配置项 ${path} 必须是对象`);
  warnUnknownKeys(raw, BACKEND_KEYS, path, warnings);

  const name = readString(raw, "name", `${path}.name`, { required: true })!;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    fail(`配置项 ${path}.name 只能包含字母、数字、点、下划线、连字符，当前为 ${name}`);
  }
  const kindRaw = readString(raw, "kind", `${path}.kind`, { required: true })!;
  if (!(BACKEND_KINDS as readonly string[]).includes(kindRaw)) {
    fail(`配置项 ${path}.kind 必须是 ${BACKEND_KINDS.join(" / ")} 之一，当前为 ${kindRaw}`);
  }
  const kind = kindRaw as BackendKind;

  const baseUrlDefault = kind === "ollama" ? "http://127.0.0.1:11434" : undefined;
  const baseUrl = readString(raw, "base_url", `${path}.base_url`, { required: baseUrlDefault === undefined });
  if (!baseUrl && !baseUrlDefault) fail(`配置项 ${path}.base_url 缺失（${kind} 后端必须显式填写）`);
  const effectiveBaseUrl = baseUrl ?? baseUrlDefault!;
  if (baseUrlDefault !== undefined && baseUrl === undefined) {
    warnings.push(`${path} 未配置 base_url，将使用本机默认 ${baseUrlDefault}`);
  }

  const model = readString(raw, "model", `${path}.model`, { required: true })!;

  const capabilityRaw = raw.capabilities;
  if (capabilityRaw !== undefined && !isRecord(capabilityRaw)) fail(`配置项 ${path}.capabilities 必须是对象`);
  const capabilitySource = isRecord(capabilityRaw) ? capabilityRaw : {};
  warnUnknownKeys(capabilitySource, CAPABILITY_KEYS, `${path}.capabilities`, warnings);
  // 能力默认一律为 false：不得按模型名推断，宁可少用也不能假装支持。
  const capabilities: BackendCapabilities = {
    vision: readBoolean(capabilitySource, "vision", `${path}.capabilities.vision`, false),
    thinking: readBoolean(capabilitySource, "thinking", `${path}.capabilities.thinking`, false),
  };

  const timeoutSeconds = readNumber(raw, "timeout_seconds", `${path}.timeout_seconds`, 120, {
    min: 0.1,
    max: 3600,
  });
  const maxConcurrency = readNumber(raw, "max_concurrency", `${path}.max_concurrency`, 2, {
    min: 1,
    max: 64,
    integer: true,
  });

  const apiKey = readString(raw, "api_key", `${path}.api_key`);
  if (kind !== "ollama") {
    if (apiKey === undefined) fail(`配置项 ${path}.api_key 缺失（${kind} 后端必须提供访问密钥）`);
  } else if (apiKey !== undefined) {
    warnings.push(`${path} 是 ollama 后端，api_key 仅在启用网关鉴权时才需要`);
  }

  let reasoningEffort = readString(raw, "reasoning_effort", `${path}.reasoning_effort`);
  if (kind === "openai_responses") {
    reasoningEffort = reasoningEffort ?? DEFAULT_REASONING_EFFORT;
    if (!REASONING_EFFORTS.has(reasoningEffort.toLowerCase())) {
      warnings.push(
        `${path}.reasoning_effort 取值 ${reasoningEffort} 不在已知集合内，将原样发送（上游可能拒绝）`,
      );
    }
    reasoningEffort = reasoningEffort.toLowerCase();
  } else if (reasoningEffort !== undefined) {
    warnings.push(`${path}.reasoning_effort 对 ${kind} 后端无对应参数，将被忽略`);
    reasoningEffort = undefined;
  }

  const endpointPath = readString(raw, "endpoint_path", `${path}.endpoint_path`);
  const endpoint = resolveEndpoint(kind, effectiveBaseUrl, endpointPath, `${path}.base_url`);
  validateEndpointScheme(kind, endpoint, `${path}.base_url`);

  const backend: BackendConfig = {
    name,
    kind,
    baseUrl: endpoint,
    model,
    capabilities,
    timeoutSeconds,
    maxConcurrency,
  };
  if (kind !== "ollama" && apiKey !== undefined) backend.apiKey = SENSITIVE_MASK;
  if (reasoningEffort !== undefined) backend.reasoningEffort = reasoningEffort;
  return backend;
}

export function parseConfigDocument(raw: unknown, warnings: string[]): Config {
  if (!isRecord(raw)) fail("配置文件的根节点必须是对象");
  warnUnknownKeys(raw, TOP_LEVEL_KEYS, "配置根节点", warnings);

  const serverRaw = section(raw, "server");
  warnUnknownKeys(serverRaw, SERVER_KEYS, "server", warnings);
  const deadlineSeconds = readNumber(
    serverRaw,
    "deadline_seconds",
    "server.deadline_seconds",
    DEFAULT_DEADLINE_SECONDS,
    { min: 10, max: 3600 },
  );
  const accessToken = readString(serverRaw, "access_token", "server.access_token") ?? "";
  if (!accessToken) {
    warnings.push("server.access_token 为空：服务不校验访问令牌，公网部署务必设置");
  }
  const listen = readString(serverRaw, "listen", "server.listen") ?? DEFAULT_LISTEN;
  const listenMatch = /^(.*):(\d{1,5})$/.exec(listen);
  if (!listenMatch) fail(`配置项 server.listen 必须形如 0.0.0.0:8000，当前为 ${listen}`);
  const port = Number(listenMatch[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`配置项 server.listen 端口必须在 1-65535 之间`);

  const limitsRaw = section(raw, "limits");
  warnUnknownKeys(limitsRaw, LIMITS_KEYS, "limits", warnings);
  const limits = {
    imageTimeoutSeconds: readNumber(
      limitsRaw,
      "image_timeout_seconds",
      "limits.image_timeout_seconds",
      DEFAULT_IMAGE_TIMEOUT_SECONDS,
      { min: 1, max: 600 },
    ),
    maxImages: readNumber(limitsRaw, "max_images", "limits.max_images", DEFAULT_MAX_IMAGES, {
      min: 1,
      max: 200,
      integer: true,
    }),
    maxImageBytes: readNumber(limitsRaw, "max_image_bytes", "limits.max_image_bytes", DEFAULT_MAX_IMAGE_BYTES, {
      min: 1024,
    }),
    minAttemptSeconds: readNumber(
      limitsRaw,
      "min_attempt_seconds",
      "limits.min_attempt_seconds",
      DEFAULT_MIN_ATTEMPT_SECONDS,
      { min: 1, max: 120 },
    ),
    imageConcurrency: readNumber(
      limitsRaw,
      "image_concurrency",
      "limits.image_concurrency",
      DEFAULT_IMAGE_CONCURRENCY,
      { min: 1, max: 32, integer: true },
    ),
  };
  if (limits.minAttemptSeconds >= deadlineSeconds) {
    fail("配置项 limits.min_attempt_seconds 必须小于 server.deadline_seconds");
  }
  if (limits.imageTimeoutSeconds >= deadlineSeconds) {
    warnings.push(
      `limits.image_timeout_seconds(${limits.imageTimeoutSeconds}) 不小于总预算(${deadlineSeconds})，取图可能独占整个预算`,
    );
  }

  const answerRaw = section(raw, "answer");
  warnUnknownKeys(answerRaw, ANSWER_KEYS, "answer", warnings);
  const separator = readString(answerRaw, "separator", "answer.separator") ?? DEFAULT_SEPARATOR;
  if (!separator.includes("#")) {
    fail("配置项 answer.separator 必须包含 #，否则 OCS 无法按分隔符回填多答案");
  }
  const answer = {
    separator,
    requireDeclaredImages: readBoolean(
      answerRaw,
      "require_declared_images",
      "answer.require_declared_images",
      true,
    ),
  };

  const backendsRaw = raw.backends;
  if (!Array.isArray(backendsRaw) || backendsRaw.length === 0) {
    fail("配置项 backends 必须是非空数组，至少配置一个 AI 后端");
  }
  const backends = backendsRaw.map((item, index) => parseBackend(item, index, warnings));
  const seenNames = new Set<string>();
  for (const backend of backends) {
    if (seenNames.has(backend.name)) fail(`配置项 backends 中后端名重复：${backend.name}`);
    seenNames.add(backend.name);
  }

  const strategy = readString(raw, "strategy", "strategy") ?? "auto";

  const routesRaw = raw.routes;
  if (!Array.isArray(routesRaw) || routesRaw.length === 0) {
    fail("配置项 routes 必须是非空数组，至少给出一个兜底路由（type 为 \"*\"）");
  }
  const routes: RouteConfig[] = routesRaw.map((item, index) => {
    const path = `routes[${index}]`;
    if (!isRecord(item)) fail(`配置项 ${path} 必须是对象`);
    warnUnknownKeys(item, ROUTE_KEYS, path, warnings);
    const type = readString(item, "type", `${path}.type`, { required: true })!;
    const names = readStringArray(item, "backends", `${path}.backends`);
    if (names.length === 0) fail(`配置项 ${path}.backends 至少需要一个后端名`);
    for (const name of names) {
      if (!seenNames.has(name)) fail(`配置项 ${path}.backends 引用了未定义的后端：${name}`);
    }
    return { type: type.toLowerCase(), backends: names };
  });

  if (!routes.some((route) => route.type === "*")) {
    warnings.push('routes 中没有 type 为 "*" 的兜底路由：未命中的题型将无法作答');
  }

  const referenced = new Set(routes.flatMap((route) => route.backends));
  for (const backend of backends) {
    if (!referenced.has(backend.name)) {
      warnings.push(`后端 ${backend.name} 未被任何路由引用，当前不会收到请求`);
    }
  }

  // 单后端时把超时压进总预算，避免必然超时；多后端保留原值，由运行时的剩余预算裁剪。
  if (backends.length === 1) {
    const only = backends[0]!;
    if (only.timeoutSeconds > deadlineSeconds) {
      warnings.push(
        `后端 ${only.name} 的 timeout_seconds(${only.timeoutSeconds}) 超过总预算(${deadlineSeconds})，已自动收缩`,
      );
      only.timeoutSeconds = deadlineSeconds;
    }
  }

  return {
    server: {
      listen,
      accessToken: accessToken ? SENSITIVE_MASK : "",
      deadlineSeconds,
      maxBodyBytes: readNumber(serverRaw, "max_body_bytes", "server.max_body_bytes", DEFAULT_MAX_BODY_BYTES, {
        min: 1024,
      }),
      corsOrigins: readStringArray(serverRaw, "cors_origins", "server.cors_origins"),
    },
    limits,
    answer,
    backends,
    strategy: strategy.toLowerCase(),
    routes,
  };
}

function collectSecrets(raw: unknown, backends: BackendConfig[]): Secrets {
  const root = isRecord(raw) ? raw : {};
  const serverRaw = section(root, "server");
  const accessToken = typeof serverRaw.access_token === "string" ? serverRaw.access_token.trim() : "";
  const backendApiKeys = new Map<string, string>();
  const backendsRaw = Array.isArray(root.backends) ? root.backends : [];
  backendsRaw.forEach((item, index) => {
    const backend = backends[index];
    if (!backend || !isRecord(item)) return;
    const key = typeof item.api_key === "string" ? item.api_key.trim() : "";
    if (key) backendApiKeys.set(backend.name, key);
  });
  return { accessToken, backendApiKeys };
}

/** 读取并解析配置文件文本；不做校验。 */
export function readConfigText(path: string): string {
  if (!existsSync(path)) {
    fail(`找不到配置文件 ${path}。请复制 config.example.jsonc 为 config.jsonc 后再启动。`);
  }
  return readFileSync(path, "utf8");
}

export function loadConfigFile(path: string, warnings: string[]): unknown {
  const text = readConfigText(path);
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    fail(`配置文件 ${path} 不是合法 JSON/JSONC：${(error as Error).message}`);
  }
  const expanded = expandDeep(parsed, "");
  const unresolved = findUnresolvedPlaceholders(expanded, "");
  if (unresolved.length > 0) fail(`配置占位符无法解析：${unresolved.join("；")}`);
  return expanded;
}

export interface LoadOptions {
  path?: string | undefined;
  envFile?: string | false | undefined;
}

export function loadConfig(options: LoadOptions = {}): LoadedConfig {
  if (options.envFile !== false) loadEnvFile(resolve(options.envFile ?? ".env"));
  const path = resolve(options.path ?? process.env.BRIDGE_CONFIG ?? DEFAULT_CONFIG_PATH);
  const warnings: string[] = [];
  const raw = loadConfigFile(path, warnings);
  const config = parseConfigDocument(raw, warnings);
  const secrets = collectSecrets(raw, config.backends);
  return { config, secrets, warnings };
}
