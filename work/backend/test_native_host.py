import io
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import native_host as host


class NativeHostTest(unittest.TestCase):
    def read(self, data):
        return host.read_message(io.BytesIO(data))

    def test_framed_unicode(self):
        body = json.dumps({'action': 'status', 'label': '中文'}).encode()
        self.assertEqual(self.read(struct.pack('=I', len(body)) + body)['action'], 'status')

    def test_oversize(self):
        with self.assertRaises(ValueError):
            self.read(struct.pack('=I', host.MAX_MESSAGE + 1))

    def test_truncation(self):
        with self.assertRaises(EOFError):
            self.read(struct.pack('=I', 10) + b'{}')

    def test_unknown_action(self):
        body = b'{"action":"shell"}'
        with self.assertRaises(ValueError):
            self.read(struct.pack('=I', len(body)) + body)

    def test_wrong_origin(self):
        with patch.object(host.sys, 'argv', ['native_host.py', 'chrome-extension://wrong/']):
            self.assertEqual(host.main(), 1)

    def test_world_readable_token_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            token = Path(directory) / 'token'
            token.write_text('test-private-value')
            token.chmod(0o644)
            with patch.object(host, 'TOKEN_PATH', token):
                response = host.forward({'action': 'status'})
            self.assertFalse(response['ok'])
            self.assertNotIn('test-private-value', str(response))

    def test_output_framing(self):
        output = io.BytesIO()
        host.write_message(output, {'ok': True, 'text': '中文'})
        raw = output.getvalue()
        self.assertEqual(struct.unpack('=I', raw[:4])[0], len(raw[4:]))
        self.assertEqual(json.loads(raw[4:])['text'], '中文')


if __name__ == '__main__':
    unittest.main()
