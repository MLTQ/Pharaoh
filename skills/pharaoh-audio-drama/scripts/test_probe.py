#!/usr/bin/env python3
"""Standard-library tests for the read-only capability probe."""
import importlib.util
import pathlib
import subprocess
import unittest
from unittest.mock import patch

path = pathlib.Path(__file__).with_name('probe_sofalizer.py')
spec = importlib.util.spec_from_file_location('probe_sofalizer', path)
assert spec is not None and spec.loader is not None
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def test_missing_executable(self):
        with patch.object(probe.shutil, 'which', return_value=None):
            self.assertEqual(probe.probe('not-installed')[0], 2)

    def result(self, listing):
        with patch.object(probe.shutil, 'which', return_value='configured-ffmpeg'), \
             patch.object(probe.subprocess, 'run', side_effect=[
                 subprocess.CompletedProcess([], 0, listing, ''),
                 subprocess.CompletedProcess([], 0, 'ffmpeg test\n', '')]):
            return probe.probe('ffmpeg')

    def test_present(self):
        code, report = self.result(' ..C sofalizer A->A binaural\n ... pan A->A pan\n')
        self.assertEqual(code, 0)
        self.assertTrue(report['sofalizer'])
        self.assertTrue(report['siblings']['pan'])

    def test_absent(self):
        code, report = self.result(' ... pan A->A pan\n')
        self.assertEqual(code, 1)
        self.assertFalse(report['sofalizer'])

    def test_process_failure(self):
        with patch.object(probe.shutil, 'which', return_value='configured-ffmpeg'), \
             patch.object(probe.subprocess, 'run', return_value=
                          subprocess.CompletedProcess([], 1, '', 'failure')):
            self.assertEqual(probe.probe('ffmpeg')[0], 2)

    def test_timeout(self):
        with patch.object(probe.shutil, 'which', return_value='configured-ffmpeg'), \
             patch.object(probe.subprocess, 'run', side_effect=
                          subprocess.TimeoutExpired('ffmpeg', 30)):
            self.assertEqual(probe.probe('ffmpeg')[0], 2)


if __name__ == '__main__':
    unittest.main()
