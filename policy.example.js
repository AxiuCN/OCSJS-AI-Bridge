/**
 * 可选策略钩子示例。
 *
 * 用法：
 *   1. 复制本文件到你的配置目录，例如 `.dsh/multi/policy.js`
 *   2. 在对应 config.jsonc 里加：
 *        "policy": { "file": "./policy.js", "timeout_ms": 100 }
 *   3. 启动服务。之后修改本文件**无需重启**（按 mtime 热重载）
 *
 * 返回值：
 *   - 后端名数组（按尝试顺序），例如 ["deepseek-flash", "ollama-local"]
 *   - 也可返回对象以覆盖单次参数：
 *       [{ name: "deepseek-flash", timeoutSeconds: 30, think: false }]
 *   - 返回 null / undefined / 空数组 → 回退 config.routes 的默认顺序
 *   - 抛错或超过 timeout_ms → 同样回退默认顺序，原因写入响应 warnings
 *   - 返回未配置的后端名会被忽略
 *
 * 上下文 ctx：
 *   {
 *     now: Date,            // 当前时间
 *     questionType: string, // single / multiple / judgement / completion / ...
 *     hasImages: boolean,   // 本题是否带图
 *     imageCount: number,
 *     backendNames: string[], // 配置里所有后端名
 *     defaultOrder: string[]  // 按 routes 算出的默认候选链
 *   }
 *
 * 约束：
 *   - 这里只决定候选链；超时预算、能力过滤、降级仍由服务端统一保证
 *   - 不要发网络请求、读大文件或同步等待——它会在每次答题前执行
 *
 * 注意：下面用到的后端名必须与你的 config.jsonc 中 backends[].name 一致。
 */

export function decide(ctx) {
  const hour = ctx.now.getHours();

  // 1) 图片题只交给有视觉能力的后端（服务端也会兜底过滤）
  if (ctx.hasImages) {
    return ["deepseek-flash", "qwen-deepseek"];
  }

  // 2) 夜间时段（22:00–08:00）某些云模型有折扣，优先使用
  const isDiscountWindow = hour >= 22 || hour < 8;
  if (isDiscountWindow) {
    return ["qwen-deepseek", "deepseek-flash"];
  }

  // 3) 判断 / 填空题走本地，省调用
  if (ctx.questionType === "judgement" || ctx.questionType === "completion") {
    return ["ollama-local", "deepseek-flash"];
  }

  // 4) 其余题型：云端优先，本地兜底
  return ["deepseek-flash", "qwen-deepseek", "ollama-local"];
}
