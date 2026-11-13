/**
 * 策略钩子：每次请求前由用户自己的 JS 文件决定「用哪些后端、按什么顺序」。
 *
 * 设计边界：
 * - 只决定候选链，不碰超时预算、能力过滤、降级规则——那些仍由路由层统一保证
 * - 文件由用户 DIY（不入库），因此任何加载/执行/返回值异常都必须回退默认顺序，
 *   绝不能让一段脚本把整条答题链路搞挂
 * - 支持热重载：按文件 mtime 判断，改完下一个请求即生效，无需重启
 */

import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";

import type { Logger } from "./logger.js";

/** 传给策略脚本的上下文（不含题目文本，避免把手写脚本暴露在题目内容上） */
export interface PolicyContext {
  /** 当前时间，用于时段策略（如夜间折扣） */
  now: Date;
  /** 归一后的题型，如 single / multiple / judgement */
  questionType: string;
  /** 本请求是否带图 */
  hasImages: boolean;
  imageCount: number;
  /** 配置里所有后端名，脚本可据此判断可用集合 */
  backendNames: string[];
  /** 按 routes 算出的默认候选链，便于「只微调」 */
  defaultOrder: string[];
}

/** 策略返回的单个候选，可覆盖该后端的默认超时与思考开关 */
export interface PolicyCandidate {
  name: string;
  /** 覆盖后端配置的 timeout_seconds（仍会被剩余总预算裁剪） */
  timeoutSeconds?: number;
  /** 覆盖后端能力声明里的 thinking 开关 */
  think?: boolean;
}

export interface PolicyDecision {
  candidates: PolicyCandidate[];
  /** 回退、忽略无效项等过程说明，最终并入响应 warnings */
  notes: string[];
}

type PolicyFunction = (context: PolicyContext) => unknown;

export interface PolicyEvaluatorOptions {
  /** 策略文件绝对路径；不配置则不启用 */
  file?: string | undefined;
  timeoutMs?: number | undefined;
  logger: Logger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 安全预览任意值，供提示信息使用。
 *
 * JSON.stringify 遇到循环引用或 BigInt 会抛错——而这段代码可能位于策略的
 * 正常返回路径上，一旦抛出就会冲出 decide()，导致整次作答失败。
 * 这里必须吞掉序列化异常，只用于展示。
 */
function safePreview(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (typeof text === "string") return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  } catch {
    // 循环引用 / BigInt / Proxy 抛错时退到类型描述
  }
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return "无法展示的值";
  }
}

/** 把策略返回值规范化为候选链：字符串或 { name, timeoutSeconds?, think? } 都接受。 */
export function normalizeDecision(
  raw: unknown,
  allowed: ReadonlySet<string>,
): { candidates: PolicyCandidate[]; notes: string[] } {
  if (!Array.isArray(raw)) {
    return { candidates: [], notes: [`策略返回值不是数组（实际为 ${typeof raw}）`] };
  }
  const candidates: PolicyCandidate[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    let entry: PolicyCandidate | undefined;
    if (typeof item === "string") {
      entry = { name: item };
    } else if (isRecord(item) && typeof item.name === "string") {
      entry = { name: item.name };
      const timeout = item.timeoutSeconds ?? item.timeout_seconds;
      if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) {
        entry.timeoutSeconds = timeout;
      }
      if (typeof item.think === "boolean") entry.think = item.think;
    }

    if (!entry) {
      notes.push(`策略返回了无法识别的候选项：${safePreview(item)}`);
      continue;
    }
    if (!allowed.has(entry.name)) {
      notes.push(`策略引用了未配置的后端 ${entry.name}，已忽略`);
      continue;
    }
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    candidates.push(entry);
  }

  return { candidates, notes };
}

export class PolicyEvaluator {
  private readonly file?: string | undefined;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private cached?: PolicyFunction;
  private cachedMtimeMs = -1;
  private warnedUnavailable = false;

  constructor(options: PolicyEvaluatorOptions) {
    this.file = options.file;
    this.timeoutMs = options.timeoutMs ?? 100;
    this.logger = options.logger;
  }

  get enabled(): boolean {
    return Boolean(this.file);
  }

  /** 加载或热重载策略模块；mtime 未变时直接复用。 */
  private async load(): Promise<PolicyFunction> {
    const file = this.file!;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch (error) {
      throw new Error(`无法读取策略文件：${(error as Error).message}`);
    }
    if (this.cached && this.cachedMtimeMs === mtimeMs) return this.cached;

    // 带 mtime 查询串绕开 ESM 模块缓存，实现热重载
    const module = (await import(`${pathToFileURL(file).href}?v=${mtimeMs}`)) as {
      decide?: unknown;
      default?: unknown;
    };
    const decide = module.decide ?? module.default;
    if (typeof decide !== "function") {
      throw new Error("策略文件必须导出 decide 函数（export function decide(ctx)）");
    }
    this.cached = decide as PolicyFunction;
    this.cachedMtimeMs = mtimeMs;
    this.logger.info("策略文件已加载", { file, mtime_ms: Math.round(mtimeMs) });
    return this.cached;
  }

  private async withTimeout(value: unknown): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve(value),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`执行超过 ${this.timeoutMs}ms`)), this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * 计算本次请求的候选链。
   * 任何失败都回退到 defaultOrder——宁可退化成静态路由，也不能中断答题。
   */
  async decide(context: PolicyContext): Promise<PolicyDecision> {
    const fallback = (notes: string[] = []): PolicyDecision => ({
      candidates: context.defaultOrder.map((name) => ({ name })),
      notes,
    });

    if (!this.file) return fallback();

    let decide: PolicyFunction;
    try {
      decide = await this.load();
    } catch (error) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        this.logger.warn("策略文件不可用，改用默认顺序", { file: this.file, reason: (error as Error).message });
      }
      return fallback([`策略文件不可用（${(error as Error).message}），已回退默认顺序`]);
    }

    let result: unknown;
    try {
      result = decide(context);
      result = await this.withTimeout(result);
    } catch (error) {
      this.logger.warn("策略执行失败，改用默认顺序", { reason: (error as Error).message });
      return fallback([`策略执行失败（${(error as Error).message}），已回退默认顺序`]);
    }

    // 规范化同样可能因异常值（循环引用 / Proxy / 非预期结构）抛错，
    // 必须与策略执行同等地兜住——否则会冲出 decide()，让整次作答失败。
    let normalized: { candidates: PolicyCandidate[]; notes: string[] };
    try {
      normalized = normalizeDecision(result, new Set(context.backendNames));
    } catch (error) {
      this.logger.warn("策略返回值无法解析，改用默认顺序", { reason: (error as Error).message });
      return fallback([`策略返回值无法解析（${(error as Error).message}），已回退默认顺序`]);
    }

    if (normalized.candidates.length === 0) {
      return fallback([...normalized.notes, "策略未给出可用后端，已回退默认顺序"]);
    }
    return normalized;
  }
}
