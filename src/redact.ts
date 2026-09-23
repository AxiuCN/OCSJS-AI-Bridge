/**
 * 脱敏投影：日志与 /health 只暴露"是什么"，不暴露"在哪"和"密钥"。
 * 白名单式构造，新增字段必须显式加进来，避免未来不小心把凭据带出去。
 */

import type { LoadedConfig } from "./types.js";

export interface BackendSummary {
  name: string;
  kind: string;
  model: string;
  vision: boolean;
  thinking: boolean;
  timeout_seconds: number;
  max_concurrency: number;
}

export interface ConfigSummary {
  version: string;
  listen: string;
  auth_enabled: boolean;
  deadline_seconds: number;
  strategy: string;
  backends: BackendSummary[];
  routes: Array<{ type: string; backends: string[] }>;
  answer_separator: string;
  max_images: number;
  require_declared_images: boolean;
}

export function summarizeConfig(loaded: LoadedConfig, version: string): ConfigSummary {
  const { config } = loaded;
  return {
    version,
    listen: config.server.listen,
    auth_enabled: Boolean(loaded.secrets.accessToken),
    deadline_seconds: config.server.deadlineSeconds,
    strategy: config.strategy,
    backends: config.backends.map((backend) => ({
      name: backend.name,
      kind: backend.kind,
      model: backend.model,
      vision: backend.capabilities.vision,
      thinking: backend.capabilities.thinking,
      timeout_seconds: backend.timeoutSeconds,
      max_concurrency: backend.maxConcurrency,
    })),
    routes: config.routes.map((route) => ({ type: route.type, backends: [...route.backends] })),
    answer_separator: config.answer.separator,
    max_images: config.limits.maxImages,
    require_declared_images: config.answer.requireDeclaredImages,
  };
}
