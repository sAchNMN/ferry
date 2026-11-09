@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0"
if errorlevel 1 exit /b 1

where node >nul 2>&1
if errorlevel 1 goto :no_node
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 23 || (major === 23 && minor >= 8) || (major === 22 && minor >= 15) ? 0 : 1)" >nul 2>&1
if errorlevel 1 goto :no_node

if not "%~1"=="" goto :forward
node "bin\ferry.js" ui --open
set "ferryExitCode=%ERRORLEVEL%"
pause
goto :finish

:forward
node "bin\ferry.js" %*
set "ferryExitCode=%ERRORLEVEL%"
goto :finish

:no_node
echo.
echo [Ferry] Node.js 22.15+ (22.x), or 23.8 and newer is required.
echo Download: https://nodejs.org/
echo.
set "ferryExitCode=1"
pause

:finish
popd
exit /b %ferryExitCode%
