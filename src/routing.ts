/**
 * 路由与超时预算：本服务的决策核心。
 *
 * 职责与边界：
 * - 按题型选出候选后端链，逐个尝试，直到成功或用尽预算
 * - 每个候选只用「总预算的剩余部分」，绝不串行重试叠加耗时
 * - 降级只针对后端级失败；题目级失败（如图片一张都读不出）立即终止
 * - 能力过滤：题目含图时跳过未声明 vision 的后端，并如实记入 warnings
 * - 成功或失败都必须是"有据可查"的，绝不返回未经验证的答案
 */

import { formatOcsAnswer } from "./format.js";
import { buildPrompt } from "./prompt.js";
import { normalizeQuestion } from "./normalize.js";
import { Semaphore, SemaphoreAbortedError } from "./semaphore.js";
import { parseModelOutput, UpstreamError, type RawResponse, type UpstreamBackend } from "./upstream/base.js";
import type { ImagePreparer } from "./images.js";
import type { Logger } from "./logger.js";
import { BackendError, type AnswerOutcome, type AnswerRequestPayload } from "./httpapi.js";
import type { BackendConfig, Config } from "./types.js";

export interface BackendCandidate {
  config: BackendConfig;
  backend: UpstreamBackend;
}

/**
 * 所有候选都试过仍无答案。
 *
 * 继承 BackendError 而非裸 Error：接入层据此把它当作"上游侧问题"记录，
 * 而不是"服务内部未预期异常"——这个区别直接影响线上排查方向。
 */
export class EngineError extends BackendError {
  override readonly name: string = "EngineError";
}

export interface EngineOptions {
  config: Config;
  backends: readonly BackendCandidate[];
  images: ImagePreparer;
  logger: Logger;
  /** 便于测试注入时间源 */
  now?: () => number;
}

interface AttemptContext {
  now: () => number;
  startedAt: number;
  signal: AbortSignal;
}

export class AnswerEngine {
  private readonly config: Config;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly images: ImagePreparer;
  private readonly candidates = new Map<string, BackendCandidate>();
  private readonly semaphores = new Map<string, Semaphore>();

  constructor(options: EngineOptions) {
    this.config = options.config;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger;
    this.images = options.images;
    for (const candidate of options.backends) {
      this.candidates.set(candidate.config.name, candidate);
      this.semaphores.set(candidate.config.name, new Semaphore(candidate.config.maxConcurrency));
    }
  }

  /** 按题型选候选链：精确匹配优先，`*` 兜底。 */
  routeFor(questionType: string): readonly string[] {
    const exact = this.config.routes.find((route) => route.type === questionType);
    const fallback = this.config.routes.find((route) => route.type === "*");
    const chosen = exact ?? fallback;
    if (!chosen) {
      throw new EngineError(`没有匹配题型 ${questionType} 的路由，且未配置 "*" 兜底路由`);
    }
    return chosen.backends;
  }

  private remainingSeconds(context: AttemptContext): number {
    return (this.config.server.deadlineSeconds * 1000 - (this.now() - context.startedAt)) / 1000;
  }

  /**
   * 本次尝试的硬超时与推理开关。
   *
   * - 超时取「后端自身配置」与「总预算剩余」的较小值，绝不允许单个候选吃穿预算
   * - 预算已被前面候选消耗到一半以下时，不再开启"思考"，把时间留给出答案
   */
  private planAttempt(
    context: AttemptContext,
    candidate: BackendConfig,
  ): { timeoutSeconds: number; think: boolean } {
    const remaining = this.remainingSeconds(context);
    const perAttempt = candidate.timeoutSeconds || this.config.server.deadlineSeconds;
    const timeoutSeconds = Math.max(1, Math.min(perAttempt, remaining));
    const budgetTight = remaining < this.config.server.deadlineSeconds / 2;
    return {
      timeoutSeconds,
      think: candidate.capabilities.thinking && !budgetTight,
    };
  }

  async answer(payload: AnswerRequestPayload, signal: AbortSignal): Promise<AnswerOutcome> {
    const warnings: string[] = [];
    const question = normalizeQuestion(payload);

    // 题目级失败：这里抛出的 ImagePreparationError 会直接变成 code:0，不降级。
    const prepared = await this.images.prepare(question, signal);
    warnings.push(...prepared.warnings);

    const hasImages = prepared.images.length > 0;
    const candidateNames = this.routeFor(question.questionType);
    const context: AttemptContext = { now: this.now, startedAt: this.now(), signal };
    const prompt = buildPrompt(question, prepared.images);
    const failures: string[] = [];

    for (const name of candidateNames) {
      const candidate = this.candidates.get(name);
      if (!candidate) {
        failures.push(`${name}: 配置中不存在该后端`);
        continue;
      }

      // 能力过滤：不声明视觉的后端不能用来做图片题，明确跳过而不是让它猜。
      if (hasImages && !candidate.config.capabilities.vision) {
        warnings.push(`${name}: 未声明 vision 能力，题目含 ${prepared.images.length} 张图，已跳过该后端`);
        failures.push(`${name}: 不具备视觉能力`);
        continue;
      }

      const remaining = this.remainingSeconds(context);
      if (remaining < this.config.limits.minAttemptSeconds) {
        warnings.push(
          `${name}: 剩余预算 ${remaining.toFixed(1)}s 低于下限 ${this.config.limits.minAttemptSeconds}s，已放弃`,
        );
        failures.push(`${name}: 时间预算不足`);
        continue;
      }

      const plan = this.planAttempt(context, candidate.config);
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(plan.timeoutSeconds * 1000)]);
      const startedAt = this.now();
      try {
        const raw = await this.runCandidate(candidate, {
          prompt,
          signal: attemptSignal,
          think: plan.think,
        });
        const parsed = parseModelOutput(raw.text, name);
        const answer = formatOcsAnswer(parsed.answer, question, this.config.answer.separator);
        if (!answer) {
          throw new UpstreamError("模型返回了空答案", name);
        }
        const elapsedMs = this.now() - startedAt;
        this.logger.info("答题成功", {
          backend: name,
          kind: candidate.config.kind,
          model: candidate.config.model,
          question_type: question.questionType,
          images: prepared.images.length,
          elapsed_ms: elapsedMs,
          attempts: failures.length + 1,
        });
        return {
          question: String(payload.title ?? ""),
          answer,
          confidence: parsed.confidence,
          model: `${name}/${candidate.config.model}`,
          warnings: [...warnings, ...parsed.notes],
        };
      } catch (error) {
        const elapsedMs = this.now() - startedAt;
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn("候选后端失败，准备降级", {
          backend: name,
          elapsed_ms: elapsedMs,
          reason,
        });
        failures.push(`${name}: ${reason}`);
        // 降级原因回传给客户端：OCS 端只看得到最终结果，
        // 若不留痕，出现"答案质量下降"时无法判断是不是换了后端。
        if (!(error instanceof SemaphoreAbortedError)) {
          warnings.push(`${name}: 作答失败（${reason}），已尝试下一个候选`);
        }
        // 并发额度等待被中止说明整体已放弃，不再尝试后续候选。
        if (error instanceof SemaphoreAbortedError) break;
        continue;
      }
    }

    const detail = failures.length > 0 ? failures.join("；") : "";
    throw new EngineError("所有候选后端均未能作答", detail);
  }

  private async runCandidate(
    candidate: BackendCandidate,
    options: {
      prompt: ReturnType<typeof buildPrompt>;
      signal: AbortSignal;
      think: boolean;
    },
  ): Promise<RawResponse> {
    const semaphore = this.semaphores.get(candidate.config.name);
    const execute = (): Promise<RawResponse> =>
      candidate.backend.complete({
        prompt: options.prompt,
        model: candidate.config.model,
        think: options.think,
        signal: options.signal,
        ...(candidate.config.reasoningEffort !== undefined
          ? { reasoningEffort: candidate.config.reasoningEffort }
          : {}),
      });
    return semaphore ? semaphore.run(options.signal, execute) : execute();
  }
}
