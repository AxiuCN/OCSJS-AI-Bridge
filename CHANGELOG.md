# Changelog

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
