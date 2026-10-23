#!/usr/bin/env python3
"""Windows installer for iPhoneduo helper local backend and Chrome Native Messaging."""
import json
import os
from pathlib import Path
import secrets
import sys

LABEL = 'com.aigoodbro.apple-helper'
HOST = 'com.aigoodbro.apple_helper'
EXTENSION_ID = 'agooghaedakdaimodmlajgkgondpjjil'
SOURCE = Path(__file__).resolve().parent


def main():
    if sys.platform != 'win32':
        print("提示：当前非 Windows 环境，正在以 Windows 目标模式准备生成文件...")
    
    appdata = Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData/Local'))
    runtime = appdata / 'ApplePurchaseHelper'
    runtime.mkdir(parents=True, exist_ok=True)

    # 1. Generate or preserve authentication token
    token_file = runtime / 'token'
    if not token_file.exists():
        token_file.write_text(secrets.token_urlsafe(48), encoding='utf-8')
    print(f"[1/4] 后台凭据已就绪: {token_file}")

    # 2. Copy JAR and launcher files
    jar_source = None
    for candidate in ['apple-helper-1023v1.jar', 'apple-helper.jar', 'build/apple-helper.jar', 'work/backend/build/apple-helper.jar']:
        p = SOURCE / candidate
        if p.exists():
            jar_source = p
            break
    
    if jar_source and jar_source.exists():
        target_jar = runtime / 'apple-helper.jar'
        target_jar.write_bytes(jar_source.read_bytes())
        print(f"[2/4] Java 后台文件已部署: {target_jar}")
    else:
        print("[2/4] 警告：未找到 apple-helper.jar，请确保构建完成后放置于同级目录。")

    # Copy native_host.bat & native_host.py
    native_bat = runtime / 'native_host.bat'
    native_bat.write_text('@echo off\njava -jar "%LOCALAPPDATA%\\ApplePurchaseHelper\\apple-helper.jar" --native-messaging %*\n', encoding='utf-8')
    if (SOURCE / 'native_host.py').exists():
        (runtime / 'native_host.py').write_bytes((SOURCE / 'native_host.py').read_bytes())

    # 3. Create start_backend.bat & start_backend_silent.vbs
    start_bat_content = f"""@echo off
chcp 65001 >nul
title Apple Purchase Helper Backend
cd /d "%LOCALAPPDATA%\\ApplePurchaseHelper"
set APPLE_HELPER_STATE_DIR={runtime}
set APPLE_HELPER_TOKEN_FILE={token_file}
echo ========================================================
echo   iPhoneduo助手aigoodbro Java 后台监控服务已启动
echo   请保持此窗口开启，或双击 start_backend_silent.vbs 静默运行
echo ========================================================
echo.
java --add-modules jdk.httpserver -jar apple-helper.jar
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo 后台运行异常结束，请检查是否已安装 Java 17 或 21。
    pause
)
"""
    (runtime / 'start_backend.bat').write_text(start_bat_content, encoding='utf-8')
    (SOURCE / 'start_backend.bat').write_text(start_bat_content, encoding='utf-8')

    silent_vbs_content = 'Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run "cmd /c start_backend.bat", 0, False\n'
    (runtime / 'start_backend_silent.vbs').write_text(silent_vbs_content, encoding='utf-8')
    (SOURCE / 'start_backend_silent.vbs').write_text(silent_vbs_content, encoding='utf-8')

    # 4. Generate Native Messaging Host JSON Manifest
    manifest_path = runtime / f"{HOST}.json"
    manifest = {
        'name': HOST,
        'description': 'iPhoneduo助手aigoodbro Windows Java 后台连接器',
        'path': str(native_bat.resolve()),
        'type': 'stdio',
        'allowed_origins': [f"chrome-extension://{EXTENSION_ID}/"]
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"[3/4] Chrome Native Messaging 配置文件已生成: {manifest_path}")

    # 5. Register in Windows Registry
    if sys.platform == 'win32':
        import winreg
        reg_key_path = fr"Software\Google\Chrome\NativeMessagingHosts\{HOST}"
        try:
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, reg_key_path) as key:
                winreg.SetValueEx(key, None, 0, winreg.REG_SZ, str(manifest_path.resolve()))
            print(f"[4/4] 注册表项已写入: HKCU\\{reg_key_path} -> {manifest_path}")
            print("\n安装完成！请双击运行 start_backend.bat 启动后台监控，并在 Chrome 打开扩展。")
        except Exception as e:
            print(f"[4/4] 写入注册表失败: {e}\n请尝试以管理员身份运行此脚本。")
    else:
        print("[4/4] 当前非 Windows 系统，注册表写入已跳过。在 Windows 环境运行将自动写入 HKCU。")


if __name__ == '__main__':
    main()
