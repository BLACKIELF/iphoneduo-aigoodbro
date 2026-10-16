"""Mock launchctl only; never installs or restarts a real service."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import install_macos


class LaunchRecoveryTests(unittest.TestCase):
    def run_case(self, codes, fails=False):
        results = [SimpleNamespace(returncode=code, stderr='fixture failure') for code in codes]
        with patch.object(install_macos.subprocess, 'run', side_effect=results) as run, patch.object(install_macos.time, 'sleep') as sleep:
            if fails:
                with self.assertRaises(SystemExit):
                    install_macos.bootstrap_service('gui/fixture', 'gui/fixture/helper', '/fixture/helper.plist')
            else:
                install_macos.bootstrap_service('gui/fixture', 'gui/fixture/helper', '/fixture/helper.plist')
            return run.call_count, sleep.call_count

    def test_success_once(self):
        self.assertEqual(self.run_case([0]), (1, 0))

    def test_transient_eio_then_success(self):
        self.assertEqual(self.run_case([5, 113, 0]), (3, 1))

    def test_already_loaded_after_eio(self):
        self.assertEqual(self.run_case([5, 0]), (2, 0))

    def test_other_error_is_not_retried(self):
        self.assertEqual(self.run_case([1], fails=True), (1, 0))

    def test_retry_is_bounded(self):
        self.assertEqual(self.run_case([5, 113] * 5, fails=True), (10, 4))


if __name__ == '__main__':
    unittest.main()
