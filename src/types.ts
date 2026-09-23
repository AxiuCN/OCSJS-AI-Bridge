/**
 * 配置与领域类型。
 *
 * 敏感值（访问令牌、API Key）在 loadConfig 结束时被就地擦除，
 * 后续代码不可能再读到明文；出网请求所需的明文在加载阶段单独交给运行时。
 */

export const BACKEND_KINDS = ["ollama", "openai_chat", "openai_responses"] as const;
export type BackendKind = (typeof BACKEND_KINDS)[number];

export interface BackendCapabilities {
  /** 是否支持图片输入 */
  vision: boolean;
  /** 是否支持“思考/推理”开关（Ollama 的 think） */
  thinking: boolean;
}

export interface BackendConfig {
  name: string;
  kind: BackendKind;
  baseUrl: string;
  model: string;
  capabilities: BackendCapabilities;
  /** 单次尝试的硬超时，运行时会再与剩余总预算取小 */
  timeoutSeconds: number;
  /** 该后端的并发上限，防止 OCS 多线程搜题时打爆本地模型 */
  maxConcurrency: number;
  /** openai_chat / openai_responses 需要 */
  apiKey?: string;
  /** openai_responses 的 reasoning.effort */
  reasoningEffort?: string;
  /** 由配置显式覆盖，缺省时按 kind 推导 */
  endpointPath?: string;
}

export interface RouteConfig {
  type: string;
  backends: string[];
}

export interface ServerConfig {
  listen: string;
  accessToken: string;
  deadlineSeconds: number;
  maxBodyBytes: number;
  corsOrigins: string[];
}

export interface LimitsConfig {
  imageTimeoutSeconds: number;
  maxImages: number;
  maxImageBytes: number;
  minAttemptSeconds: number;
  imageConcurrency: number;
}

export interface AnswerConfig {
  separator: string;
  requireDeclaredImages: boolean;
}

export interface Config {
  server: ServerConfig;
  limits: LimitsConfig;
  answer: AnswerConfig;
  backends: BackendConfig[];
  strategy: string;
  routes: RouteConfig[];
}

/** 出网调用需要的明文凭据，与 Config 分离保存。 */
export interface Secrets {
  accessToken: string;
  backendApiKeys: Map<string, string>;
}

export interface LoadedConfig {
  config: Config;
  secrets: Secrets;
  /** 加载期产生的非致命提示（值被截断、后端未被引用等），启动时打印一次 */
  warnings: string[];
}

export const SENSITIVE_MASK = "***";
