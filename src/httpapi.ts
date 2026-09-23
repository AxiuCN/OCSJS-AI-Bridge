/**
 * HTTP 接入层：`POST /v1/answer`（OCS 题库协议）与 `GET /health`。
 *
 * 只使用 node:http，不引 Web 框架——端点只有两个，框架带来的依赖面不划算。
 * 响应形状与现有 response_service 保持一致，OCS 端零改动：
 *   成功 {"code":1,"message":"ok","question":...,"answer":...,"confidence":...,"model":...,"warnings":[...]}
 *   失败 {"code":0,"message":"<可读原因>"}
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { ImagePreparationError } from "./domain.js";
import { summarizeConfig } from "./redact.js";
import type { Logger } from "./logger.js";
import type { Config, LoadedConfig, Secrets } from "./types.js";

/** 题目级失败：不降级、直接以 code:0 结束。 */
export class QuestionError extends Error {
  override readonly name: string = "QuestionError";
}

/** 后端级失败：由路由层决定是否换下一个候选；路由层"全部候选失败"也继承它。 */
export class BackendError extends Error {
  override readonly name: string = "BackendError";
  constructor(message: string, readonly details?: string) {
    super(details ? `${message}（${details}）` : message);
  }
}

export interface AnswerRequestPayload {
  title: string;
  options: string | string[];
  type: string;
  [key: string]: unknown;
}

export interface AnswerOutcome {
  question: string;
  answer: string;
  confidence: number;
  model: string;
  warnings: string[];
}

export type AnswerHandler = (
  payload: AnswerRequestPayload,
  signal: AbortSignal,
) => Promise<AnswerOutcome>;

export interface AppDependencies {
  loaded: LoadedConfig;
  version: string;
  logger: Logger;
  /** 未注入时 /v1/answer 返回明确的"未接线"错误（第 1 步骨架状态） */
  answer?: AnswerHandler;
  allowedOrigins?: string[];
}

export interface App {
  config: Config;
  secrets: Secrets;
  logger: Logger;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  createHttpServer: () => Server;
}

interface BodyReadResult {
  ok: true;
  text: string;
}

interface BodyReadFailure {
  ok: false;
  status: number;
  message: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function ocsFailure(res: ServerResponse, message: string): void {
  sendJson(res, 200, { code: 0, message });
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyReadResult | BodyReadFailure> {
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  try {
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > maxBytes) {
        // 不提前 destroy socket：OCS 端只会看到网络错误，拿不到我们给出的原因。
        // 继续读完剩余数据，再返回明确的 413。
        tooLarge = true;
        chunks.length = 0;
        continue;
      }
      if (!tooLarge) chunks.push(buffer);
    }
  } catch {
    return { ok: false, status: 400, message: "读取请求体失败，连接可能已中断" };
  }
  if (tooLarge) {
    return { ok: false, status: 413, message: `请求体超过上限 ${maxBytes} 字节` };
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function extractToken(req: IncomingMessage): string {
  const header = req.headers["x-access-token"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return "";
}

function isAuthorized(req: IncomingMessage, secrets: Secrets): boolean {
  const expected = secrets.accessToken;
  if (!expected) return true;
  return constantTimeEquals(extractToken(req), expected);
}

function resolveCorsOrigin(req: IncomingMessage, allowed: string[]): string | undefined {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !origin) return undefined;
  if (allowed.includes("*")) return "*";
  return allowed.includes(origin) ? origin : undefined;
}

function applyCors(req: IncomingMessage, res: ServerResponse, allowed: string[]): void {
  const origin = resolveCorsOrigin(req, allowed);
  if (origin === undefined) return;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-headers", "content-type,x-access-token,authorization");
  res.setHeader("access-control-allow-methods", "POST,GET,HEAD,OPTIONS");
  if (origin !== "*") res.setHeader("vary", "Origin");
}

function normalizePayload(raw: unknown): AnswerRequestPayload | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "请求体必须是 JSON 对象";
  }
  const record = raw as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title) return "请求体缺少 title 字段（OCS 题库协议必填）";
  const optionsRaw = record.options;
  let options: string | string[] = "";
  if (typeof optionsRaw === "string") {
    options = optionsRaw;
  } else if (Array.isArray(optionsRaw)) {
    options = optionsRaw.map((item) => String(item));
  } else if (typeof record.option_items !== "undefined") {
    options = "";
  }
  const type = typeof record.type === "string" ? record.type.trim() : "unknown";
  return { ...record, title, options, type };
}

export function createApp(deps: AppDependencies): App {
  const { loaded, version, logger } = deps;
  const { config, secrets } = loaded;
  const allowedOrigins = deps.allowedOrigins ?? config.server.corsOrigins;
  const summary = summarizeConfig(loaded, version);

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      applyCors(req, res, allowedOrigins);
      const method = (req.method ?? "GET").toUpperCase();
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }

      if (path === "/health" || path === "/") {
        if (method !== "GET" && method !== "HEAD") {
          sendJson(res, 405, { code: 0, message: "只支持 GET/HEAD" });
          return;
        }
        // OCS 的题库连通性探测是 GET/HEAD /health，这里必须保持可用。
        sendJson(res, 200, { ok: true, ...summary });
        return;
      }

      if (path !== "/v1/answer") {
        sendJson(res, 404, { code: 0, message: `未知路径 ${path}` });
        return;
      }
      if (method !== "POST") {
        sendJson(res, 405, { code: 0, message: "/v1/answer 只支持 POST" });
        return;
      }
      if (!isAuthorized(req, secrets)) {
        sendJson(res, 401, { code: 0, message: "题库访问令牌无效" });
        return;
      }

      const body = await readBody(req, config.server.maxBodyBytes);
      if (!body.ok) {
        sendJson(res, body.status, { code: 0, message: body.message });
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body.text);
      } catch {
        ocsFailure(res, "请求体不是合法 JSON");
        return;
      }
      const payload = normalizePayload(parsed);
      if (typeof payload === "string") {
        ocsFailure(res, payload);
        return;
      }

      if (!deps.answer) {
        ocsFailure(res, "服务尚未接线答题引擎（当前为骨架版本）");
        return;
      }

      const controller = new AbortController();
      const onAborted = () => controller.abort();
      req.once("aborted", onAborted);
      const deadline = setTimeout(() => controller.abort(), config.server.deadlineSeconds * 1000);
      try {
        const outcome = await deps.answer(payload, controller.signal);
        sendJson(res, 200, { code: 1, message: "ok", ...outcome });
      } catch (error) {
        if (error instanceof QuestionError || error instanceof ImagePreparationError) {
          logger.warn("题目级失败，不降级", { reason: error.message });
          ocsFailure(res, error.message);
          return;
        }
        if (error instanceof BackendError) {
          logger.error("后端级失败", { reason: error.message });
          ocsFailure(res, error.message);
          return;
        }
        logger.error("答题发生未预期异常", { error });
        ocsFailure(res, `答题失败：${(error as Error).message}`);
      } finally {
        clearTimeout(deadline);
        req.off("aborted", onAborted);
      }
    })().catch((error: unknown) => {
      logger.error("请求处理异常", { error });
      if (!res.headersSent) ocsFailure(res, "服务内部错误");
      else res.end();
    });
  };

  const createHttpServer = (): Server => {
    const server = createServer(handler);
    // 略长于服务端总预算，避免客户端先断开时连接被提前掐掉。
    server.requestTimeout = (config.server.deadlineSeconds + 10) * 1000;
    server.headersTimeout = 60_000;
    server.keepAliveTimeout = 65_000;
    return server;
  };

  return { config, secrets, logger, handler, createHttpServer };
}
