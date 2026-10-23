@echo off
cd /d "%~dp0"
echo 正在安装 iPhoneduo助手 Windows 后台与 Chrome 连接器...
where py >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    py -3 install_windows.py
) else (
    python install_windows.py
)
echo.
pause
