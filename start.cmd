@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [Ferry] 需要 Node.js 22.5 或更高版本。
  echo  下载： https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if "%~1"=="" (
  node "bin\ferry.js" ui --open
  pause
) else (
  node "bin\ferry.js" %*
)
