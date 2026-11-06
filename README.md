# OCS AI 桥接服务

让 [OCSJS](https://github.com/ocsjs/ocsjs) 通过可插拔的 AI 后端完成课程题目自动作答，OCS 端只需填一份题库配置。

- **对 OCS 零改动** — 实现与原版题库服务一致的 `POST /v1/answer` 协议，OCS 端只改题库配置（AnswererWrapper）
- **后端不限定本地** — 本地 Ollama、在线 OpenAI 兼容服务、OpenAI Responses 服务都是平级的可插拔后端
- **服务端决定路由** — 按题型选候选链，失败自动降级，全部在总时间预算内完成
- **不伪造能力** — 解析失败、无图可读、后端无视觉能力等情况一律明确报错，绝不返回猜测的答案

> 运行期零第三方依赖，只需 Node.js 22.9+。服务本体已在 Windows 端到端实测，**Linux 未在开发环境实测** —— 部署前请先跑 `npm run doctor`（见「已知限制」）。

---

## 安装

```bash
# 1) 安装依赖（仅开发依赖：typescript / tsx）
npm install

# 2) 准备配置
cp config.example.jsonc config.jsonc
cp .env.example .env
#    编辑 .env：至少填 SERVICE_ACCESS_TOKEN、OLLAMA_BASE_URL、OLLAMA_MODEL

# 3) 部署自检：逐项确认运行环境、配置与后端连通性
npm run doctor

# 4) 构建并启动
npm run build
npm start
```

启动后：

```bash
curl http://127.0.0.1:8000/health
```

`/health` 会返回版本、监听地址、脱敏后的后端清单与路由，可用于 OCS 的题库连通性探测。

> Linux 常驻运行见 [deploy/README.md](deploy/README.md)；Windows 可一键启动：

```powershell
.\deploy\start.bat
```

---

## 配置 OCSJS

在 `OCS → 通用 → 全局设置 → 题库配置` 中粘贴 `ocs-answerer-wrapper.json.example` 的内容，并把两处占位符换成你的实际值：

- `https://your-service.example.com` → 你的服务地址
- `change-me` → 与 `.env` 中 `SERVICE_ACCESS_TOKEN` 相同的值

请求使用原版 OCS 提供的 `title` / `options` / `type` 三个字段（5.x 可再加 `images`，见下），期望返回：

```js
res.code === 1 ? [res.question, res.answer] : [res.message, undefined]
```

### OCSJS 5.x

模板已适配 5.x，可直接用：

- `responseType: "json"` —— `contentType` 在 5.x 已标记废弃（旧写法仍能跑）
- `data.images` 用**字段解析器**提交 `env.images` —— 5.x 会自己把题干/选项里的图片下载并转成 PNG data URL 传过来，服务端不必再按 URL 下载一次，能绕开超星图片的登录态/防盗链。**注意不能写成 `"images": "${images}"`**：占位符替换是字符串替换，数组会被逗号拼接、破坏 data URL。
- 域名白名单：5.x 会校验题库 URL 是否在脚本头 `@connect` 里。用**全域名通用版**（`@connect *`）不受限；否则需把服务地址加进 `@connect`。
- 保存配置前会做恶意代码检测（仅警告不阻断）。本模板的 handler 只读 `res` 字段，不会触发。

建议的高级设置：

- **搜题最大耗时** — 设为界面允许的最大值（180 秒）；服务端 `deadline_seconds` 默认 170 秒，预留了网络与序列化余量
- **线程数量** — 先用 `1`；本地模型建议保持较低并发（服务端已按 `max_concurrency` 限制每个后端）
- **答案分隔符** — 保留默认的 `#`
- 初次测试建议选择「不保存也不提交」

---

## 配置参考

`config.jsonc` 支持注释与尾随逗号，字符串里可用 `${VAR}` / `${VAR:-默认值}` 引用环境变量。
**引用了未设置且无默认值的变量时，启动会直接失败并指出字段路径**，不会静默使用错误地址。

### 服务与限额

| 字段 | 默认值 | 说明 |
|---|---|---|
| `server.listen` | `0.0.0.0:8000` | 监听地址；只想本机访问可改 `127.0.0.1:8000` |
| `server.access_token` | 空 | 与 OCS 题库配置里的 `X-Access-Token` 一致；留空则不校验（仅限本机调试） |
| `server.deadline_seconds` | `170` | **总时间预算**，所有后端尝试共享，不叠加 |
| `server.max_body_bytes` | `8388608` | 请求体上限 |
| `server.cors_origins` | `[]` | OCS 走 `GM_xmlhttpRequest`，无需 CORS；留空即不发送 CORS 头 |
| `limits.image_timeout_seconds` | `30` | 单张图片下载超时 |
| `limits.max_images` | `24` | 单题最多处理图片数 |
| `limits.max_image_bytes` | `12582912` | 单张图片大小上限 |
| `limits.min_attempt_seconds` | `5` | 剩余预算低于该值就不再尝试候选后端 |
| `limits.image_concurrency` | `4` | 图片并发下载数 |
| `answer.separator` | `#` | 多答案分隔符，**必须包含 `#`** |
| `answer.require_declared_images` | `true` | 题目声明有图却一张都读不到时拒绝作答 |

### 后端（`backends`）

三种 `kind` 对应三种上游协议：

| `kind` | 请求 | 图片传递 | 结构化输出 | 推理开关 |
|---|---|---|---|---|
| `ollama` | `POST {base_url}/api/chat` | `message.images`（纯 base64） | `format: "json"` | `think` |
| `openai_chat` | `POST {base_url}/v1/chat/completions` | content 里的 `image_url` | `response_format` | 无（忽略 `reasoning_effort`） |
| `openai_responses` | `POST {base_url}/v1/responses` | `input_image` | `text.format` | `reasoning.effort` |

公共字段：

| 字段 | 说明 |
|---|---|
| `name` | 后端唯一名，路由通过它引用 |
| `base_url` | 站点根地址、`/v1` 地址或完整端点都可；远端地址强制 `https`，本机回环可用 `http` |
| `model` | 模型名 |
| `capabilities.vision` | **是否支持图片输入**，默认 `false` |
| `capabilities.thinking` | 是否支持「思考」开关，默认 `false` |
| `timeout_seconds` | 单次尝试硬超时（运行时会再与剩余预算取小） |
| `max_concurrency` | 该后端并发上限 |
| `api_key` | `openai_chat` / `openai_responses` 必填 |
| `reasoning_effort` | 仅 `openai_responses` 使用 |
| `endpoint_path` | 需要自定义端点时使用 |

> **能力必须如实声明**：服务**不会**按模型名推断能力。声明 `vision: false` 的后端在遇到图片题时会被跳过并记入 `warnings`；若所有候选都不支持视觉，请求会明确失败。
>
> 想确认本机 Ollama 各模型的实际能力，可只读查询：
> ```bash
> curl http://<ollama-host>:11434/api/tags
> ```
> 响应里每个模型的 `capabilities` 字段即为其支持的能力列表。

### 路由（`routes`）

```jsonc
"routes": [
  { "type": "multiple",   "backends": ["online-responses", "ollama-local"] },
  { "type": "*",          "backends": ["ollama-local"] }
]
```

- `backends` 是**候选链**：按顺序尝试，失败换下一个，直到成功或用尽预算
- `type` 精确匹配优先，`"*"` 为兜底；同一题型命中多条时以第一条为准
- 常见题型：`single` / `multiple` / `judgement` / `completion` / `line` / `fill` / `reader`，以及上游自定义题型
- `/v1/answer` **不提供**后端选择字段（OCS 也传不了），选择与降级完全由服务端决定

推荐起步策略：本地 Ollama 承担纯文本题，在线后端承担多选、主观题与图片题（按实测质量调整）。

---

## 运行行为

### 超时预算

```
收到请求 ──── 总预算 170s ────────────────────────────►
   候选 1 [min(自身超时, 剩余)]   候选 2 [min(自身超时, 剩余)]
                                  └─ 成功即返回；剩余 < min_attempt_seconds 则放弃
```

- 任何单个候选都不可能吃穿总预算
- 剩余预算消耗过半后**不再开启「思考」**，把时间留给出答案
- 全部候选耗尽仍未成功 → `code:0` 并列出每个候选的失败原因

### 降级规则

| 情况 | 处理 |
|---|---|
| 连接失败 / 超时 / HTTP 4xx-5xx / 响应非 JSON / 缺 `answer` / 空答案 | **后端级**：记 warning，换下一候选 |
| 题目含图但一张都读不出 | **题目级**：立即 `code:0`，不降级 |
| 候选后端 `vision: false` 却遇到图片题 | 跳过该候选并记 warning |
| 所有候选都不具备视觉能力 | 明确报错，不静默猜测 |
| 模型输出夹带解释、带 Markdown 围栏 | 容错解析并记入 `warnings` |

### 响应格式

成功：

```json
{
  "code": 1,
  "message": "ok",
  "question": "中国的首都是哪座城市？",
  "answer": "北京",
  "confidence": 1,
  "model": "ollama-local/qwen3.5:9b",
  "warnings": []
}
```

失败（HTTP 仍为 200，与既有服务一致）：

```json
{ "code": 0, "message": "所有候选后端均未能作答（ollama-local: 上游返回 HTTP 404..." }
```

`X-Access-Token` 无效时返回 HTTP 401；请求体超限返回 HTTP 413。

---

## 开发

```bash
npm run typecheck         # 源码 + 测试的类型检查
npm test                  # 单元与契约测试
npm run doctor            # 部署自检：环境 / 配置 / 每个后端真实连通性
npm run smoke             # 接真实 Ollama 的 10 项实测（需要 .env 里的 OLLAMA_* 可用）
npm run smoke:multi       # 多后端降级实测（真实 HTTP + 真实上游，使用临时配置）
npm run smoke:routing     # 按题型路由实测（两个真实模型，用响应 model 字段证明分流）
npm run smoke:concurrency # 并发实测：模拟 OCS 多线程搜题，验证并发闸与结果隔离
npm run show-config       # 打印脱敏后的配置摘要
```

目录结构：

```
src/
  server.ts        入口：配置 → 服务 → 优雅关闭
  config.ts        JSONC 解析、${ENV} 展开、启动校验、敏感值擦除
  httpapi.ts       /v1/answer 与 /health、鉴权、限额
  routing.ts       候选链、超时预算、能力过滤、降级
  normalize.ts     题型与选项归一、图片标记、挖空标记   ┐
  images.ts         data URL 校验、下载、MIME 嗅探       ├ 领域层（与协议无关）
  format.ts        答案 → OCS 可回填字符串               ┘
  prompt.ts        中立请求模型
  upstream/        三个协议适配器 + 容错解析
```

**关键边界**：领域层只实现一次，三种适配器共用——OCS 的回填行为不会因为换后端而变化。

---

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 启动报「配置校验失败」 | 消息里会指出字段路径；常见是未设置 `OLLAMA_BASE_URL` 之类被引用的环境变量 |
| 启动报「后端凭据缺失」 | `openai_chat` / `openai_responses` 后端没有 `api_key` |
| `code:0` 且提示「没有拿到任何可读图片」 | 题目图片 URL 需要登录态或已过期；可在浏览器侧安装异步取图补丁，让 OCS 提交 data URL |
| `code:0` 且提示「不具备视觉能力」 | 候选后端都声明了 `vision: false`；为图片题配置支持视觉的后端 |
| `code:0` 且提示「时间预算不足」 | 前面的候选耗时过长；提高 `deadline_seconds`、降低 `timeout_seconds`，或把更快的后端排到前面 |
| 日志出现「上游响应里没有 message.content」或「上游返回了空 content」 | Ollama 的**偶发**行为：请求成功（HTTP 200）但正文为空，实测多发于并发请求或长时间思考后。已自动**关闭 thinking 重试一次**；若重试仍失败，日志里会带上 `done_reason` / `eval_count` / `thinking 长度`，据此判断是截断、空输出还是上游格式变化 |
| 单题耗时经常 30–70 秒 | `capabilities.thinking` 为 `true` 时模型会先长时间思考。实测同一题关闭思考后从 30–70 秒降到 4–10 秒，代价是答案质量略降；预算紧张或并发较多时建议关闭 |
| 答案与预期格式不符 | 查看响应 `warnings`，其中记录了跳过的后端与解析容错过程 |

---

## 已知限制

- **原版 OCS 不传图片数组** — 图片 URL 混在题干或选项文本里，由服务端下载；受登录态保护的地址可能下载失败
- **原版 OCS 不传 DOM 结构** — 下划线、挖空样式、共用选项对应关系、材料层级无法复原；这类题以 OCS 自身能提取和回填的内容为准
- **本地小模型的格式稳定性弱于线上模型** — 建议按题型路由，并把关键题型交给更强的后端
- **验证范围（请先读这一条）** — 服务本体在开发环境（Windows）完成了端到端实测：题库协议、三种上游协议、路由与预算、并发、降级都有真实链路证据。
  **Linux 端未在开发环境实测**：开发机没有 Linux（无 WSL 发行版、无容器/虚拟化工具）。跨平台风险已通过契约测试与静态审计排除——运行期零第三方依赖、无原生模块、纯 ESM、未使用任何平台相关 API——但"没跑过"就是没跑过。
  所以**部署到任何平台前，请先运行 `npm run doctor`**：它会打印当前平台与架构，并真实请求配置里的每个后端。这是部署流程的第一步，不是遗留待办
