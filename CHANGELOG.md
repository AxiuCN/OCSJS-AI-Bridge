# Changelog

## 0.3.2

**修复策略钩子的异常序列化与时区判断**

- `policy.ts`：提示信息改用安全预览。此前 `JSON.stringify` 遇到循环引用或 `BigInt` 会抛错，且发生在 `decide()` 的异常捕获之外，可能导致整次作答失败。
- `policy.ts`：返回值规范化整体纳入 `try/catch`，任何解析异常都回退默认顺序并记入 `warnings`。
- 文档与实现对齐：未知后端被忽略并记 note，**仍有有效候选时继续使用**，全部无效才回退默认顺序（此前文档写成一律回退）。
- `policy.example.js` 与服务器策略：时段判断改用 `Intl.DateTimeFormat` 显式指定 `Asia/Shanghai`，不再依赖宿主机时区（服务器为 UTC 时 22–8 判断会整体偏 8 小时）。
- `docs/路由与策略.md`：补充四项边界——超时只能中断异步等待、时区、热重载依赖 mtime、ctx 不含后端健康状态；示例代码改用 `Intl` 显式时区，与 `policy.example.js` 一致。
- `README.md`：标题与特性和「协议桥接 / 多后端编排 / 动态策略路由 / 多模态 / 弹性降级」对齐。
- 测试：新增 3 项（循环引用、BigInt、未知后端与有效候选并存），全量 161 项通过。

## 0.3.1

**文档入库：AGENTS.md 瘦身拆分，验收记录脱敏入库**

- `AGENTS.md` 从 98 行/10.5 KB 重写为快速参考与索引（项目概况、命令表、文档索引、约定、硬约束速查、测试、待办）。
- 按主题拆入 `docs/`：架构、协议与适配、路由与策略、测试、待办与规划、验收记录。
- 脱敏：内网地址、盘符、服务器路径移入 `docs/private/`（不入库）；入库文档只写占位且不依赖它。
- `ACCEPTANCE.md` 原为本地文件，现已脱敏为 `docs/验收记录.md` 入库，原文件归档到 `.dsh/CLAUDE留档/`。
- `.gitignore`：`AGENTS.md` 与 `ACCEPTANCE.md` 不再忽略，新增忽略 `docs/private/`。
- 无代码改动。

## 0.3.0

**新增策略钩子：按条件动态决定后端候选链**

- 配置：顶层 `policy: { "file": "./policy.js", "timeout_ms": 100 }`，`file` 相对 config.jsonc 所在目录解析。
- 脚本：每次请求前调用 `decide(ctx)`，返回后端名数组（按尝试顺序）。`ctx` 提供 `now` / `questionType` / `hasImages` / `imageCount` / `backendNames` / `defaultOrder`（不含题目文本）。
- 返回值：字符串数组，或 `{ name, timeoutSeconds?, think? }` 数组以覆盖单次超时与思考开关；返回 `null` / `undefined` / 空数组则回退 `routes` 默认顺序。
- 失败隔离：文件缺失、脚本抛错、执行超时（默认 100ms）、返回未配置的后端，一律回退默认顺序并把原因写入响应 `warnings`，不中断答题。
- 热重载：按文件 mtime 监听，改完下一个请求即生效，无需重启。
- 边界：策略只决定候选链；超时预算、能力过滤、降级仍由路由层保证，DIY 脚本绕不过去。
- 示例：`policy.example.js`（夜间折扣、图片题路由、简单题走本地、云端优先）。
- 测试：新增 16 项（策略 13 + 路由集成 3），全量 157 项通过。
- 文档：`README.md` 新增「策略钩子」一节，`config.example.jsonc` 增加注释示例。

## 0.2.1

**修复 OCS 题库列表探测显示「连接失败（405）」**

- 根因：OCS 的连通性探测（`probeAnswerer`）先发 HEAD，遇 405/501 回退 GET，且不携带令牌；只有 2xx~3xx 才显示「连接成功」。此前 `/v1/answer` 对两种方法都返回 405。
- 现在 HEAD 返回 200（只发头），GET 返回 `{ok, service, version}`，两者免鉴权且不含令牌与后端地址；POST 鉴权与答题逻辑不变。
- 测试：新增探测返回 2xx、不泄露敏感信息、POST 无令牌仍 401 三项。

## 0.2.0

**适配 OCSJS 5.x：图片题改由 OCS 直传，服务端不再重复下载**

- **图片题优化（v2 题库配置）**：OCSJS 5.x 新增 `env.images` / `env.suggestion_title` / `env.suggestion_options`，浏览器自己把题干与选项里的图片下载并转成 PNG data URL 后随请求提交。题库配置改用 `data.images` 字段解析器（`return (env) => env.images`）提交数组——**不能写成 `"images": "${images}"`**：占位符替换是字符串替换，数组会被逗号拼接并破坏 data URL。
- **服务端按顺序绑定**：`normalize.ts` 在收到的 data URL 数量与自身解析出的图片数量一致时，按出现顺序把图片绑回「题干/材料图片 N」「选项 X 图片 N」标签；数量不一致时退回原逻辑，不强行配对以免错位。
- **不再重复下载**：已有 data URL 的附件直接使用，服务端只为没有 data URL 的图片发起下载。原先「浏览器送一张、服务端再下一次」的重复开销，以及超星图片的登录态/防盗链失败，都随之消失。
- **协议字段更新**：模板 `contentType` 改为 `responseType`（`contentType` 在 5.x 已标记废弃，旧写法仍兼容）。
- **域名白名单**：5.x 会校验题库 URL 是否在脚本头 `@connect` 内；全域名通用版（`@connect *`）不受限，否则需手动添加。
- **安全检测**：5.x 保存配置前会扫描 handler 中的危险特征（仅警告不阻断）。本模板 handler 只读 `res` 字段，不会触发。
- 测试：新增「纯 data URL 顺序绑定」「数量不对齐不硬配」「已有 data URL 零下载」三项，全量 139 项通过。
- 文档：`README.md` 新增「OCSJS 5.x」小节。

## 0.1.1

**修复 Ollama 偶发空正文导致答题失败**

- 并发或长时间思考后，Ollama 可能返回 HTTP 200 但 `message.content` 为空。现改为抛出带 `done_reason` / `eval_count` / thinking 长度的专用错误，便于线上定位，并**关闭 thinking 自动重试一次**；重试成功会在响应 `warnings` 中留痕。
- 只重试一次，重试仍为空则明确报错，不伪造答案；已中止或超时的情况不重试，避免白耗预算。
- 测试：新增 6 项（诊断字段、空串与缺字段区分、重试成功、只重试一次、未开 thinking 时也重试、`notes` 传递），全量 136 项通过。

## 0.1.0

**初始实现：OCS 题库协议 ↔ 可插拔 AI 后端**

- 与原版 OCS 题库协议一致的 `POST /v1/answer`，OCS 端零改动。
- 可插拔后端：Ollama 原生 `/api/chat`、OpenAI 兼容 `/v1/chat/completions`、OpenAI Responses `/v1/responses`，规则由配置声明，不按模型名推断。
- 服务端路由与超时预算：候选链按题型分流、单候选吃穿不了总预算、能力过滤（无视觉后端跳过图片题）、后端级失败降级、题目级失败立即报错。
- 领域层（题型归一、图片处理、答案回填格式化）与协议解耦，三种适配器共用同一套行为。
- 130 项单元与契约测试；真实 Ollama 冒烟、多后端降级、按题型路由、并发四类实测脚本；`doctor` 部署自检。
