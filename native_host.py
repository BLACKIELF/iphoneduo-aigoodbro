#!/usr/bin/python3
"""Chrome Native Messaging -> authenticated loopback Java service.
No credentials or remote response text are logged. 1016v2.
"""
import json
import os
from pathlib import Path
import struct
import sys
import urllib.error
import urllib.request

HOST_ORIGIN = 'chrome-extension://agooghaedakdaimodmlajgkgondpjjil/'
SERVICE_URL = 'http://127.0.0.1:17371/command'
MAX_MESSAGE = 1024 * 1024
if sys.platform == 'win32':
    TOKEN_PATH = Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData/Local')) / 'ApplePurchaseHelper/token'
else:
    TOKEN_PATH = Path.home() / 'Library/Application Support/ApplePurchaseHelper/token'
ACTIONS = {'status', 'sync', 'start', 'stop', 'check'}


def read_exact(stream, size):
    chunks = []
    while size:
        part = stream.read(size)
        if not part:
            raise EOFError('Truncated message')
        chunks.append(part)
        size -= len(part)
    return b''.join(chunks)


def read_message(stream):
    header = stream.read(4)
    if not header:
        return None
    if len(header) < 4:
        header += read_exact(stream, 4 - len(header))
    size = struct.unpack('=I', header)[0]
    if not 0 < size <= MAX_MESSAGE:
        raise ValueError('Invalid message size')
    message = json.loads(read_exact(stream, size).decode('utf-8'))
    if not isinstance(message, dict) or message.get('action') not in ACTIONS:
        raise ValueError('Invalid command')
    return message


def write_message(stream, message):
    payload = json.dumps(message, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(payload) > MAX_MESSAGE:
        payload = b'{"ok":false,"error":"Backend response too large"}'
    stream.write(struct.pack('=I', len(payload)))
    stream.write(payload)
    stream.flush()


def forward(message):
    try:
        token = TOKEN_PATH.read_text().strip()
        if not token or (sys.platform != 'win32' and TOKEN_PATH.stat().st_mode & 0o077):
            return {'ok': False, 'error': '后台连接凭据缺失或权限异常，请重新安装后台'}
        request = urllib.request.Request(SERVICE_URL,
            data=json.dumps(message, ensure_ascii=False).encode('utf-8'),
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
            method='POST')
        # Never route local credentials through HTTP_PROXY or the system proxy.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(request, timeout=12) as response:
            raw = response.read(MAX_MESSAGE + 1)
        if len(raw) > MAX_MESSAGE:
            raise ValueError('Response too large')
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError('Invalid backend response')
        return result
    except urllib.error.HTTPError as error:
        if error.code == 401:
            return {'ok': False, 'error': '后台连接验证失败，请重新安装本机连接组件'}
        return {'ok': False, 'error': '后台未接受此操作，请检查后台日志'}
    except (OSError, ValueError, urllib.error.URLError):
        return {'ok': False, 'error': 'Java 后台未连接，请确认后台服务已启动后重新连接'}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    if sys.platform == 'win32':
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    # Chrome supplies its extension origin as argv[1]; reject invocation by another extension.
    if len(sys.argv) < 2 or sys.argv[1] != HOST_ORIGIN:
        return 1
    try:
        message = read_message(sys.stdin.buffer)
        if message is not None:
            write_message(sys.stdout.buffer, forward(message))
    except (EOFError, ValueError, UnicodeError, OSError):
        write_message(sys.stdout.buffer, {'ok': False, 'error': '本机消息格式无效'})
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
