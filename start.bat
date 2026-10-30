@echo off
chcp 65001 >nul
title 心灵港湾
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] 未检测到 Node.js，请先安装：https://nodejs.org/  然后重新双击本文件。
  pause
  exit /b 1
)

if not exist node_modules (
  echo [首次运行] 正在安装依赖，请稍等...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo [!] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo 心灵港湾启动中... 浏览器将自动打开 http://localhost:3000
if not defined XLGW_NO_BROWSER (
  start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:3000"
)
node server/index.js
pause
