#!/usr/bin/python3
"""Install this project's already-built local monitor. No package downloads."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import secrets
import subprocess
import sys
import tempfile
import time

LABEL = 'com.aigoodbro.apple-helper'
HOST = 'com.aigoodbro.apple_helper'
EXTENSION_ID = 'agooghaedakdaimodmlajgkgondpjjil'
SOURCE = Path(__file__).resolve().parent
RUNTIME = Path.home() / 'Library/Application Support/ApplePurchaseHelper'
JAVA = Path(os.environ.get('APPLE_HELPER_JDK_BIN', '/opt/homebrew/opt/openjdk@21/bin')) / 'java'


def install_file(path, data, mode):
    if path.exists() and path.read_bytes() == data:
        path.chmod(mode)
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
        output.write(data)
    temporary.chmod(mode)
    temporary.replace(path)
    return True


def bootstrap_service(domain, target, plist_path):
    # launchd can briefly return EIO after bootout while removing the old job.
    for attempt in range(5):
        result = subprocess.run(['launchctl', 'bootstrap', domain, str(plist_path)], capture_output=True, text=True)
        if result.returncode == 0:
            return
        if result.returncode != 5:
            raise SystemExit('后台启动失败：' + result.stderr.strip())
        if subprocess.run(['launchctl', 'print', target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            return
        if attempt < 4:
            time.sleep(0.5 * (attempt + 1))
    raise SystemExit('后台启动失败，服务仍未加载：' + result.stderr.strip())


def main():
    if sys.platform != 'darwin':
        raise SystemExit('此安装器仅支持 macOS。')
    jar = SOURCE / 'build/apple-helper.jar'
    if not JAVA.is_file() or not jar.is_file():
        raise SystemExit('缺少 Java 21 或构建产物，请先运行 build.sh。')
    # Chrome executes native_host.py through its shebang, not this interpreter.
    python_check = subprocess.run(['/usr/bin/python3', '-c', 'import json, urllib.request'], capture_output=True)
    if python_check.returncode != 0:
        raise SystemExit('浏览器连接器需要可运行的 /usr/bin/python3，请先准备该依赖。')
    plist_path = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    manifest_path = Path.home() / 'Library/Application Support/Google/Chrome/NativeMessagingHosts' / (HOST + '.json')
    # Refuse to take ownership of unrelated installations with the same name.
    if plist_path.exists():
        old = plistlib.loads(plist_path.read_bytes())
        if old.get('Label') != LABEL or str(RUNTIME / 'apple-helper.jar') not in old.get('ProgramArguments', []):
            raise SystemExit('发现同名但来源不同的后台服务，未覆盖。')
    if manifest_path.exists() and json.loads(manifest_path.read_text()).get('path') != str(RUNTIME / 'native_host.py'):
        raise SystemExit('发现同名但来源不同的浏览器连接器，未覆盖。')
    RUNTIME.mkdir(parents=True, exist_ok=True, mode=0o700)
    RUNTIME.chmod(0o700)
    token = RUNTIME / 'token'
    if not token.exists():
        install_file(token, secrets.token_urlsafe(48).encode(), 0o600)
    token.chmod(0o600)
    changed = install_file(RUNTIME / 'apple-helper.jar', jar.read_bytes(), 0o600)
    install_file(RUNTIME / 'native_host.py', (SOURCE / 'native_host.py').read_bytes(), 0o700)
    for logname in ['stdout.log', 'stderr.log']:
        logpath = RUNTIME / logname
        logpath.touch(mode=0o600, exist_ok=True)
        logpath.chmod(0o600)
    plist = {
        'Label': LABEL,
        'ProgramArguments': [str(JAVA), '--add-modules', 'jdk.httpserver', '-jar', str(RUNTIME / 'apple-helper.jar')],
        'EnvironmentVariables': {'APPLE_HELPER_STATE_DIR': str(RUNTIME), 'APPLE_HELPER_TOKEN_FILE': str(token)},
        'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 30, 'Umask': 0o077,
        'StandardOutPath': str(RUNTIME / 'stdout.log'), 'StandardErrorPath': str(RUNTIME / 'stderr.log'),
        'WorkingDirectory': str(RUNTIME),
    }
    changed = install_file(plist_path, plistlib.dumps(plist), 0o600) or changed
    manifest = {'name': HOST, 'description': 'iPhoneduo助手aigoodbro 本机 Java 后台连接器',
                'path': str(RUNTIME / 'native_host.py'), 'type': 'stdio',
                'allowed_origins': ['chrome-extension://' + EXTENSION_ID + '/']}
    install_file(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2).encode(), 0o600)
    domain = 'gui/' + str(os.getuid())
    target = domain + '/' + LABEL
    loaded = subprocess.run(['launchctl', 'print', target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if loaded and changed:
        subprocess.run(['launchctl', 'bootout', target], check=True)
        loaded = False
    if not loaded:
        bootstrap_service(domain, target, plist_path)
    receipt = {'version': '1018v1', 'runtime': str(RUNTIME), 'extensionId': EXTENSION_ID,
               'jarSha256': hashlib.sha256(jar.read_bytes()).hexdigest(), 'launchAgent': str(plist_path)}
    install_file(RUNTIME / 'installation.json', json.dumps(receipt, ensure_ascii=False, indent=2).encode(), 0o600)
    print(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
