@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 双视角三维重建

where node >nul 2>&1
if errorlevel 1 (
  echo 未检测到 Node.js。请先安装后再双击本脚本：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo 首次启动，正在安装依赖...
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败。
    pause
    exit /b 1
  )
)

echo 正在启动开发服务器，浏览器将自动打开 http://localhost:5173
echo 关闭本窗口即可停止服务。
echo.
call npm run dev
if errorlevel 1 (
  echo.
  echo 启动失败。
  pause
  exit /b 1
)
