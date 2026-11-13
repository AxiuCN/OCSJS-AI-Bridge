# AGENTS.md

This file provides project-level guidance to AI coding agents (DSH / Claude Code) when working with code in this repository.

## 项目概况

OCSJS AI 桥接服务 — 让 OCSJS（浏览器用户脚本）通过**可插拔的 AI 后端**完成课程题目自动作答。服务实现与 OCS 原版题库协议一致的 `POST /v1/answer`，对外是 OCS 的题库服务，对上是三种上游协议的适配层。**边界**：只做「AI 调用链的适配」，不改 OCSJS 前端、不重做题库协议、不重构参考项目。

- **单入口**：`src/server.ts` → 加载配置 → 启动 HTTP → 优雅关闭
- **分层**：接入层 `httpapi` → 领域层 `normalize`/`images`/`format` → 提示层 `prompt` → 路由层 `routing`/`policy` → 上游层 `upstream/*`；细节见 [`docs/架构.md`](docs/架构.md)
- **运行期零第三方依赖**：只用 Node 标准库（`node:http`、`fetch`、`node:test`），Node ≥ 22.9
- **回归**：`npm test`（当前 157 项）、`npm run typecheck`、`npm run build`
- **部署自检**：`npm run doctor`（环境 / 配置 / 每个后端真实连通性）

### 快速参考

| 命令 | 说明 |
|---|---|
| `npm test` | 单元与契约测试（157 项） |
| `npm run typecheck` | 源码 + 测试类型检查 |
| `npm run build` | 编译到 `dist/` |
| `npm start` | 构建产物启动（读 `.env` 与 `config.jsonc`） |
| `npm run doctor` | 部署自检，含真实上游请求 |
| `npm run smoke` / `smoke:multi` / `smoke:routing` / `smoke:concurrency` | 四类真实链路实测 |
| `npm run show-config` | 打印脱敏后的配置摘要 |

## 文档索引（按需阅读，别一次全读）

| 想了解 / 要改的东西 | 先读 |
|---|---|
| 目录结构、分层职责、请求数据流、配置三层 | [`docs/架构.md`](docs/架构.md) |
| OCS 题库协议、三种上游协议、图片机制、容错解析 | [`docs/协议与适配.md`](docs/协议与适配.md) |
| 候选链、超时预算、能力过滤、降级、策略钩子 | [`docs/路由与策略.md`](docs/路由与策略.md) |
| 测试套件、真实链路脚本、部署自检 | [`docs/测试.md`](docs/测试.md) |
| 已定案决策、待定项、验收标准、已知限制 | [`docs/待办与规划.md`](docs/待办与规划.md) |
| 验收结论与跨平台证据 | [`docs/验收记录.md`](docs/验收记录.md) |
| 盘符、部署机、本机工作区（**不入库**） | `docs/private/`（新克隆上不存在） |

## 约定

1. **ESM + TypeScript** — 全部 `import`/`export`，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
2. **中文** — 注释、日志、文档一律简体中文
3. **零运行时依赖** — 新增依赖前先确认标准库无法满足；`devDependencies` 仅 `typescript`/`tsx`/`@types/node`
4. **领域层与协议解耦** — 题型归一、图片处理、答案格式化只实现一次，三种适配器共用，不得在适配器内改动答案语义
5. **不伪造能力** — 解析失败、无图可读、无视觉能力、超时一律明确报错；能力以配置声明为准，不按模型名推断
6. **协议兼容优先** — `/v1/answer` + `{code,message,question,answer}` + `X-Access-Token` 保持不变，OCS 端零改动
7. **文档入库范围** — `AGENTS.md` 与 `docs/`（除 `docs/private/`）**入库**，与代码一同评审提交；`docs/private/` 放盘符、部署机与本机工作区，**不入库**，入库文档只写占位且**不得依赖**它；`CLAUDE.md`/`.claude/` 与 DSH 工作区目录仍忽略
8. **文档必须同步** — 功能/配置/协议变更时同批更新：`docs/` 对应册、`README.md`、本文件、`CHANGELOG.md`
9. **不擅自扩大改动** — 数据口径与契约类改动先给方案再动手；决策类条目见 [`docs/待办与规划.md`](docs/待办与规划.md)
10. **不执行 git 操作** — 改动完成后提供提交摘要（`prefix: 中文描述`），由用户手动提交

## 硬约束速查（改前必读；细节见各册）

1. **行尾** — `.gitattributes` 是 `* text=auto eol=lf`；`deploy/start.bat` 必须 CRLF、`deploy/*.service` 必须 LF，测试会校验
2. **不要整文件重写** — 会产出全文件 diff；只改必要行
3. **OCS 探测** — `/v1/answer` 的 HEAD/GET 必须返回 2xx 且免鉴权（OCS 用它们探测连通性），POST 才校验令牌
4. **图片直传** — 5.x 的 `images` 必须用字段解析器提交数组，写成 `"${images}"` 会被逗号拼接并破坏 data URL
5. **超时预算** — 单候选超时 = min(自身超时, 剩余预算)，任何候选都不得吃穿总预算
6. **能力过滤** — 含图时跳过未声明 `vision` 的后端；全部不支持则报错，不猜
7. **空正文** — Ollama 偶发空 `message.content`，会关闭 thinking 重试一次；重试仍空则报错
8. **策略钩子** — 只决定候选链；异常/超时/非法返回必须回退默认顺序，不得中断答题
9. **敏感值** — 令牌、API Key、内网地址不进仓库；配置只提交 `.example`
10. **跨平台** — Windows 与 Linux 都必须能跑，不得依赖平台专属路径/原生模块/Docker

## 测试

```bash
npm test                      # 全量（157 项）
npm run typecheck             # 类型检查
npm run doctor                # 部署自检（真实上游）
npm run smoke                 # 单后端真实链路（需要可用 Ollama）
```

套件清单与实测脚本说明见 [`docs/测试.md`](docs/测试.md)。

## 待办（摘要）

- **多后端合并配置**：当前三套配置各含一个后端、都监听 8000，需要合并成一份才能发挥路由与策略钩子的价值
- **路由默认值**：各题型优先本地还是云端，按实际答案质量定
- **缓存类功能**：OCS 无判分接口，错误答案无法自动纠正，暂不做
- 详细决策与已知限制见 [`docs/待办与规划.md`](docs/待办与规划.md)
