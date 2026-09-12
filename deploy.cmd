@echo off
setlocal
if "%~1"=="" goto interactive
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
exit /b %ERRORLEVEL%

:interactive
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" --local
set "WO_DEPLOY_EXIT=%ERRORLEVEL%"
pause
exit /b %WO_DEPLOY_EXIT%
