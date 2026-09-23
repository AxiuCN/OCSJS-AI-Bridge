/**
 * 优雅关闭。
 *
 * 目的：重启服务时不要硬切正在作答的请求（单题预算可达 deadline_seconds），
 * 但也不能被空闲的 keep-alive 连接拖住不退出。
 *
 * 顺序：
 *   1) 停止接收新连接，并立刻断开所有**空闲**连接（OCS 端会自行重连新实例）
 *   2) 给仍在处理的请求一段宽限期
 *   3) 宽限期结束仍未结束，才强制关闭
 */

export interface ClosableServer {
  close(callback: () => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

export interface ShutdownOptions {
  /** 给活跃请求的宽限期（毫秒） */
  graceMs?: number;
  /** 关闭完成后的回调；调用方可在其中退出进程 */
  onClosed?: () => void;
  /** 记录"仍在等待活跃请求" */
  onWaiting?: (activeHint: string) => void;
  /** 记录"宽限期耗尽，强制关闭" */
  onForced?: () => void;
  setTimeoutImpl?: typeof setTimeout;
}

export const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

/** 记录本次关闭是否走到了强制关闭，便于测试断言与日志说明。 */
export interface ShutdownHandle {
  forced: boolean;
}

export function gracefulShutdown(server: ClosableServer, options: ShutdownOptions = {}): ShutdownHandle {
  const graceMs = options.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const setTimer = options.setTimeoutImpl ?? setTimeout;
  const handle: ShutdownHandle = { forced: false };

  // 空闲连接立刻断掉，避免 keep-alive 让 close() 迟迟不回调。
  server.closeIdleConnections?.();

  const timer = setTimer(() => {
    handle.forced = true;
    options.onForced?.();
    server.closeAllConnections?.();
    options.onClosed?.();
  }, graceMs);
  timer.unref?.();

  server.close(() => {
    // 活跃请求已全部处理完，取消宽限计时并正常退出。
    clearTimeout(timer);
    options.onClosed?.();
  });

  options.onWaiting?.(`等待活跃请求结束（最多 ${graceMs}ms）`);
  return handle;
}
