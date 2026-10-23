@echo off
chcp 65001 >nul
title iPhoneduo助手aigoodbro Windows 一键安装与配置
echo ========================================================
echo    iPhoneduo助手aigoodbro Windows 一键安装程序
echo ========================================================
echo.

cd /d "%~dp0"

:: 1. 检查 Java 环境
echo [1/5] 检查 Java 运行环境...
where java >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo 【错误】未检测到 Java 运行环境！
    echo iPhoneduo助手后台服务需要 Java 17 或 Java 21。
    echo.
    echo 请先下载并安装 Java (推荐 Adoptium OpenJDK 21 或 Oracle Java):
    echo 官方高速下载链接: https://adoptium.net/zh-CN/temurin/releases/?version=21
    echo.
    echo 安装好 Java 后，直接重新双击运行本脚本即可！
    echo.
    pause
    exit /b 1
)
java -version 2>&1 | findstr /i "version"
echo [1/5] Java 环境检测正常！
echo.

:: 2. 准备运行目录
set "RUNTIME=%LOCALAPPDATA%\ApplePurchaseHelper"
echo [2/5] 准备后台配置目录: %RUNTIME%
if not exist "%RUNTIME%" mkdir "%RUNTIME%"

:: 3. 部署核心 JAR 文件
echo [3/5] 部署 Java 后台核心程序...
set "FOUND_JAR="
if exist "apple-helper-1023v1.jar" (
    set "FOUND_JAR=apple-helper-1023v1.jar"
) else if exist "apple-helper.jar" (
    set "FOUND_JAR=apple-helper.jar"
) else if exist "build\apple-helper.jar" (
    set "FOUND_JAR=build\apple-helper.jar"
) else if exist "work\backend\build\apple-helper.jar" (
    set "FOUND_JAR=work\backend\build\apple-helper.jar"
)

if defined FOUND_JAR (
    copy /y "%FOUND_JAR%" "%RUNTIME%\apple-helper.jar" >nul
    echo      已从 %FOUND_JAR% 复制并安装为 apple-helper.jar
) else (
    echo 【警告】当前目录下未找到 apple-helper.jar，请确保文件未被杀毒软件误删！
)

:: 生成后台本地配对密钥 (Token)
if not exist "%RUNTIME%\token" (
    powershell -NoProfile -Command "[System.Guid]::NewGuid().ToString('N') + [System.Guid]::NewGuid().ToString('N')" > "%RUNTIME%\token"
)

:: 部署 native_host.bat (原生调用 Java 消息桥接，100%% 无需依赖 Python)
(
echo @echo off
echo java -jar "%%LOCALAPPDATA%%\ApplePurchaseHelper\apple-helper.jar" --native-messaging %%*
) > "%RUNTIME%\native_host.bat"
copy /y "%RUNTIME%\native_host.bat" "%~dp0native_host.bat" >nul 2>&1

:: 如果有 native_host.py 亦同步复制
if exist "native_host.py" copy /y "native_host.py" "%RUNTIME%\native_host.py" >nul

:: 部署启动脚本 start_backend.bat
(
echo @echo off
echo title Apple Purchase Helper Backend
echo cd /d "%%LOCALAPPDATA%%\ApplePurchaseHelper"
echo set APPLE_HELPER_STATE_DIR=%%LOCALAPPDATA%%\ApplePurchaseHelper
echo set APPLE_HELPER_TOKEN_FILE=%%LOCALAPPDATA%%\ApplePurchaseHelper\token
echo ========================================================
echo    iPhoneduo助手aigoodbro Java 后台监控服务已启动
echo    请保持此窗口开启，或双击 start_backend_silent.vbs 静默运行
echo ========================================================
echo.
echo 正在启动后台轮询监控...
echo.
echo 提示：关闭此黑框将暂停后台查询；再次使用双击本文件即可。
echo --------------------------------------------------------
echo.
java --add-modules jdk.httpserver -jar apple-helper.jar
if %%ERRORLEVEL%% NEQ 0 (
    echo.
    echo 后台运行异常结束，请检查是否已安装 Java 17 或 21。
    pause
)
) > "%RUNTIME%\start_backend.bat"
copy /y "%RUNTIME%\start_backend.bat" "%~dp0start_backend.bat" >nul

:: 部署静默启动脚本 start_backend_silent.vbs
(
echo Set WshShell = CreateObject("WScript.Shell"^)
echo WshShell.Run "cmd /c start_backend.bat", 0, False
) > "%RUNTIME%\start_backend_silent.vbs"
copy /y "%RUNTIME%\start_backend_silent.vbs" "%~dp0start_backend_silent.vbs" >nul

:: 4. 写入 Chrome Native Messaging 清单与注册表
echo [4/5] 配置 Chrome 原生消息通信 (Native Messaging)...
set "ESCAPED_PATH=%RUNTIME:\=\\%\\native_host.bat"
(
echo {
echo   "name": "com.aigoodbro.apple_helper",
echo   "description": "iPhoneduo助手aigoodbro Windows 后台连接器",
echo   "path": "%ESCAPED_PATH%",
echo   "type": "stdio",
echo   "allowed_origins": [
echo     "chrome-extension://agooghaedakdaimodmlajgkgondpjjil/"
echo   ]
echo }
) > "%RUNTIME%\com.aigoodbro.apple_helper.json"

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.aigoodbro.apple_helper" /ve /t REG_SZ /d "%RUNTIME%\com.aigoodbro.apple_helper.json" /f >nul
if %ERRORLEVEL% EQU 0 (
    echo [4/5] 注册表项已成功写入: HKCU\Software\Google\Chrome\NativeMessagingHosts\com.aigoodbro.apple_helper
) else (
    echo [4/5] 【提示】若写入注册表受限，请尝试以管理员身份运行本脚本。
)

:: 5. 写入安装凭据记录
echo {"version":"1023v1","runtime":"%RUNTIME:\=\\%","extensionId":"agooghaedakdaimodmlajgkgondpjjil"} > "%RUNTIME%\installation.json"
echo [5/5] 安装配置已全部就绪！
echo.
echo ========================================================
echo              Windows 安装已全部顺利完成！
echo ========================================================
echo.
echo 【下一步极简指引】：
echo.
echo 1. 双击运行当前目录下的「start_backend.bat」（或 start_backend_silent.vbs 静默运行）
echo 2. 在 Chrome 浏览器打开 chrome://extensions ，开启右上角「开发者模式」
echo 3. 点击「加载已解压的扩展程序」，选择本目录下的「extension」文件夹
echo 4. 打开扩展控制台，页面显示绿色「已连接本机 Java 后台」即可开始监控与下单！
echo.
set /p START_NOW="是否立即启动 Java 后台服务？(Y/N，默认Y): "
if /i "%START_NOW%"=="N" (
    echo 您可以稍后手动双击 start_backend.bat 启动后台。
) else (
    start "" "%RUNTIME%\start_backend.bat"
    echo 已为您在后台拉起 Java 服务窗口！
)
echo.
pause
