@echo off
title Apple Purchase Helper Backend
cd /d "%~dp0"
set APPLE_HELPER_STATE_DIR=/Users/lovelifeblackie/AppData/Local/ApplePurchaseHelper
set APPLE_HELPER_TOKEN_FILE=/Users/lovelifeblackie/AppData/Local/ApplePurchaseHelper/token
echo ===================================================
echo   iPhoneduo助手aigoodbro Java 后台监控服务
echo ===================================================
java --add-modules jdk.httpserver -jar apple-helper.jar
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo 后台运行异常结束，请检查是否已安装 Java 17+。
    pause
)
