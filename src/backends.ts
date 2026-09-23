/**
 * 后端实例化：把配置里的每个后端翻译成对应的协议适配器。
 *
 * 明文凭据只在这里被取用一次，适配器实例持有后不再经由 Config 传播。
 */

import { OllamaBackend } from "./upstream/ollama.js";
import { OpenAiChatBackend } from "./upstream/openai_chat.js";
import { OpenAiResponsesBackend } from "./upstream/openai_responses.js";
import type { UpstreamBackend } from "./upstream/base.js";
import type { BackendConfig, Secrets } from "./types.js";

export interface BackendEntry {
  config: BackendConfig;
  backend: UpstreamBackend;
}

export function createBackend(config: BackendConfig, secrets: Secrets, fetchImpl: typeof fetch = fetch): BackendEntry {
  const apiKey = secrets.backendApiKeys.get(config.name) ?? "";
  switch (config.kind) {
    case "ollama":
      return {
        config,
        backend: new OllamaBackend({ name: config.name, url: config.baseUrl, fetchImpl }),
      };
    case "openai_chat":
      return {
        config,
        backend: new OpenAiChatBackend({ name: config.name, url: config.baseUrl, apiKey, fetchImpl }),
      };
    case "openai_responses":
      return {
        config,
        backend: new OpenAiResponsesBackend({ name: config.name, url: config.baseUrl, apiKey, fetchImpl }),
      };
  }
}

/** 启动自检：ollama 之外的协议都依赖 api_key，缺失要在启动时就说清楚。 */
export function missingCredentials(backends: readonly BackendConfig[], secrets: Secrets): string[] {
  return backends
    .filter((backend) => backend.kind !== "ollama" && !secrets.backendApiKeys.get(backend.name))
    .map((backend) => `${backend.name}(${backend.kind}) 缺少 api_key`);
}
