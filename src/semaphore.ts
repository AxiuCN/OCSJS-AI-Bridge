/**
 * 并发闸：限制每个后端同时在飞的请求数。
 *
 * OCS 可以多线程搜题，本地 9B 模型被并发打满会反而让所有请求都超时，
 * 因此每个后端有独立上限。等待期间若整体预算耗尽或客户端断开，立即放弃。
 */

export class SemaphoreAbortedError extends Error {
  override readonly name = "SemaphoreAbortedError";
}

export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`并发上限必须是正整数，当前为 ${limit}`);
    }
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }

  /** 在并发限制内执行；signal 中止时抛 SemaphoreAbortedError 而不是无声等待。 */
  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new SemaphoreAbortedError("等待并发额度时已中止");
    await this.waitForSlot(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private waitForSlot(signal: AbortSignal): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiting.indexOf(grant);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new SemaphoreAbortedError("等待并发额度时已中止"));
      };
      const grant = (): void => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      this.waiting.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** 当前在飞数量与排队长度，供健康检查/日志观测。 */
  snapshot(): { active: number; waiting: number; limit: number } {
    return { active: this.active, waiting: this.waiting.length, limit: this.limit };
  }
}
