@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."

echo [1/4] 检查 Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo   未找到 node，请先安装 Node.js 22 或更高版本：https://nodejs.org/
  exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo   Node.js %%v

echo [2/4] 检查配置...
if not exist "config.jsonc" (
  echo   缺少 config.jsonc，正在从 config.example.jsonc 复制...
  copy /y "config.example.jsonc" "config.jsonc" >nul
)
if not exist ".env" (
  echo   缺少 .env，正在从 .env.example 复制...
  copy /y ".env.example" ".env" >nul
  echo   [警告] .env 仍是模板内容：请填写 OLLAMA_BASE_URL / OLLAMA_MODEL，
  echo          并把 SERVICE_ACCESS_TOKEN 改成一段长随机值，然后再重新启动。
)

echo [3/4] 安装依赖并构建...
if not exist "node_modules" call npm install
call npm run build
if errorlevel 1 (
  echo   构建失败，请检查上面的 TypeScript 报错。
  exit /b 1
)

echo [4/4] 启动服务（Ctrl+C 停止）...
node --env-file-if-exists=.env dist\server.js
endlocal
