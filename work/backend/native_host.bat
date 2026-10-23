@echo off
setlocal
rem Launch native_host.py using py launcher or python in PATH
where py >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    py -3 "%~dp0native_host.py" %*
) else (
    python "%~dp0native_host.py" %*
)
