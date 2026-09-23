# 部署指南

服务是一个普通 HTTP 进程：Windows 与 Linux 上运行方式一致，运行期零第三方依赖（只需 Node.js ≥ 22.9）。

- Linux → systemd + 可选 Nginx（HTTPS 终止）
- Windows → `deploy\start.bat` 或注册为计划任务/服务

---

## 1. Linux（systemd）

### 1.1 准备运行用户与目录

```bash
sudo useradd --system --shell /usr/sbin/nologin --home /opt/ocs-ai-bridge ocsbridge
sudo mkdir -p /opt/ocs-ai-bridge
sudo chown -R "$USER" /opt/ocs-ai-bridge
```

### 1.2 放置代码并安装依赖

```bash
git clone <本仓库地址> /opt/ocs-ai-bridge
cd /opt/ocs-ai-bridge
npm install            # 只装 typescript / tsx 等开发依赖
npm run build          # 产出 dist/
```

### 1.3 生成配置与令牌

```bash
cp config.example.jsonc config.jsonc
cp .env.example .env

# 生成一段随机访问令牌
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

编辑 `.env`（**不要提交进仓库**）：

```env
SERVICE_ACCESS_TOKEN=<上面生成的随机串>
OLLAMA_BASE_URL=http://<ollama 主机>:11434
OLLAMA_MODEL=qwen3.5:9b
```

编辑 `config.jsonc`：按需增减后端与路由；`server.listen` 保持 `0.0.0.0:8000`（或改为仅内网网卡地址）。

### 1.4 部署自检

```bash
npm run doctor
```

它会逐项确认：Node 版本与平台、配置文件、配置校验、**每个后端的真实连通性**。全部通过后再进入下一步。

### 1.5 安装 systemd 单元

仓库提供的 `deploy/ocs-ai-bridge.service` 默认假设：

| 项 | 默认值 | 需要改吗 |
|---|---|---|
| `WorkingDirectory` | `/opt/ocs-ai-bridge` | 代码不在该路径时修改 |
| `User` / `Group` | `ocsbridge` | 按 1.1 创建的用户名修改 |
| `EnvironmentFile` | `/opt/ocs-ai-bridge/.env` | 配置放在别处时修改 |
| `ExecStart` | `/usr/bin/node ...` | 用 `which node` 确认实际路径（nvm 安装的 node 不在此路径） |

```bash
which node            # 确认 node 的真实路径，必要时改 ExecStart
sudo cp deploy/ocs-ai-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ocs-ai-bridge

systemctl status ocs-ai-bridge
journalctl -u ocs-ai-bridge -f      # 结构化 JSON 日志
```

> 若用 nvm 安装的 Node，`/usr/bin/node` 往往不存在。此时把 `ExecStart` 改成 node 的绝对路径，例如
> `/home/ocsbridge/.nvm/versions/node/v24.18.0/bin/node`，并把 `User` 设为该 node 的属主。

### 1.6 验证

```bash
curl -s http://127.0.0.1:8000/health
curl -s -X POST http://127.0.0.1:8000/v1/answer \
  -H 'Content-Type: application/json' \
  -H "X-Access-Token: $SERVICE_ACCESS_TOKEN" \
  -d '{"title":"1+1 等于几？","options":"1\n2\n3","type":"single"}'
```

期望分别得到 `{"ok":true,...}` 与 `{"code":1,...,"answer":"2",...}`。

---

## 2. Linux（Nginx + HTTPS，可选）

浏览器侧建议用 HTTPS，避免题库令牌明文传输。

```nginx
server {
    listen 443 ssl;
    server_name answer.example.com;

    ssl_certificate     /etc/nginx/ssl/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/privkey.pem;

    client_max_body_size 8m;

    # 服务端总预算默认 170s，代理超时略长，避免提前断开
    proxy_connect_timeout 30s;
    proxy_send_timeout    190s;
    proxy_read_timeout    190s;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

OCS 题库配置里的地址相应写成 `https://answer.example.com/v1/answer`。

---

## 3. Windows

```powershell
.\deploy\start.bat
```

脚本会依次：检查 Node → 缺失时从示例复制 `config.jsonc` 与 `.env` → 安装依赖并构建 → 启动服务。

若要常驻运行，可用任务计划程序或 [NSSM](https://nssm.cc/) 注册为服务，命令为：

```
node --env-file-if-exists=.env D:\OCSJS-AI-Bridge\dist\server.js
```

---

## 4. 防火墙与网络

| 方向 | 端口 | 说明 |
|---|---|---|
| 浏览器 → 本服务 | 8000（或 Nginx 443） | OCS 题库配置指向这里 |
| 本服务 → Ollama | 11434 | 宿主机 Ollama 需监听非 `127.0.0.1`（`OLLAMA_HOST=0.0.0.0`） |
| 本服务 → 在线后端 | 443 | 使用在线 AI 后端时才需要出网 |

本服务采用**服务端转调**，浏览器不直连 Ollama，因此无需为 Ollama 配置 CORS。

---

## 5. 升级与回滚

```bash
cd /opt/ocs-ai-bridge
git pull
npm install && npm run build
npm run doctor
sudo systemctl restart ocs-ai-bridge
```

服务收到 `SIGTERM` 后会：先断开空闲连接（避免 keep-alive 拖住退出），再给正在作答的请求最多 **30 秒**宽限期（可用环境变量 `SHUTDOWN_GRACE_MS` 调整），仍未结束才强制关闭——正在处理的题目不会被硬切。

因此 systemd 单元的 `TimeoutStopSec` 设为 **45 秒**（大于应用层宽限期并留余量）；若你用 `SHUTDOWN_GRACE_MS` 调小了宽限期，可同步调小该值。

---

## 6. 部署检查清单

- [ ] Node.js ≥ 22.9（`node --version`）
- [ ] `config.jsonc` 存在且 `server.access_token` 只引用 `${SERVICE_ACCESS_TOKEN}`
- [ ] `.env` 已填 `SERVICE_ACCESS_TOKEN` / `OLLAMA_BASE_URL` / `OLLAMA_MODEL`，且**不在版本控制中**
- [ ] 每个后端的 `capabilities` 与真实模型能力一致（不按模型名猜）
- [ ] 若含图片题，至少一个候选后端声明 `vision: true`
- [ ] `npm run doctor` 全部通过
- [ ] `deploy/ocs-ai-bridge.service` 里的 `WorkingDirectory` / `User` / `ExecStart` 与本机一致
- [ ] OCS 题库配置的 `X-Access-Token` 与服务端一致
- [ ] 首次测试选择「不保存也不提交」
