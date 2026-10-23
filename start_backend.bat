@echo off
chcp 65001 >nul
title Apple Purchase Helper Backend
cd /d "%~dp0"
set "APPLE_HELPER_STATE_DIR=%LOCALAPPDATA%\ApplePurchaseHelper"
set "APPLE_HELPER_TOKEN_FILE=%LOCALAPPDATA%\ApplePurchaseHelper\token"
echo ========================================================
echo   iPhoneduo助手aigoodbro Java 后台监控服务已启动
echo   请保持此窗口开启，或双击 start_backend_silent.vbs 静默运行
echo ========================================================
echo.
set "JAR_FILE=apple-helper.jar"
if not exist "%JAR_FILE%" if exist "apple-helper-1023v1.jar" set "JAR_FILE=apple-helper-1023v1.jar"
if not exist "%JAR_FILE%" if exist "%LOCALAPPDATA%\ApplePurchaseHelper\apple-helper.jar" set "JAR_FILE=%LOCALAPPDATA%\ApplePurchaseHelper\apple-helper.jar"

java --add-modules jdk.httpserver -jar "%JAR_FILE%"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo 后台运行异常结束，请检查是否已安装 Java 17 或 21。
    pause
)
