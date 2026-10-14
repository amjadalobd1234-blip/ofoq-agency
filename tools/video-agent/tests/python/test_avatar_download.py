"""Offline tests for the Colab/local setup portrait download (no network or models)."""
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
import zlib


TOOL_ROOT = Path(__file__).resolve().parents[2]
URL = 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=512&h=512&fit=crop&fm=png'


def png_chunk(kind, content):
    return (struct.pack('>I', len(content)) + kind + content
            + struct.pack('>I', zlib.crc32(kind + content) & 0xffffffff))


def square_png(width=512, height=512):
    row = b'\x00' + (b'\x80\x80\x80' * width)
    return (b'\x89PNG\r\n\x1a\n'
            + png_chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + png_chunk(b'IDAT', zlib.compress(row * height))
            + png_chunk(b'IEND', b''))


class AvatarDownloadTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.work = self.root / 'tools/video-agent'
        (self.work / 'python').mkdir(parents=True)
        self.script = self.work / 'python/download_avatar.sh'
        shutil.copyfile(TOOL_ROOT / 'python/download_avatar.sh', self.script)
        self.avatar = self.work / 'assets/avatars/man-1.png'
        self.fixture = self.root / '512.png'
        self.fixture.write_bytes(square_png())
        self.log = self.root / 'wget.log'
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        stub = bin_dir / 'wget'
        stub.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$AVATAR_TEST_LOG"
output=''
while [ "$#" -gt 0 ]; do
    if [ "$1" = '-O' ]; then shift; output="$1"; break; fi
    shift
done
[ -n "$output" ] || exit 2
case "${AVATAR_TEST_MODE:-ok}" in
    fail) printf 'partial' > "$output"; exit 8 ;;
    empty) : > "$output" ;;
    invalid) printf '<html>not an image</html>' > "$output" ;;
    *) cp "$AVATAR_TEST_PNG" "$output" ;;
esac
''')
        stub.chmod(0o755)
        self.env = {
            **os.environ,
            'PATH': f"{bin_dir}:{os.environ.get('PATH', '')}",
            'AVATAR_TEST_LOG': str(self.log),
            'AVATAR_TEST_PNG': str(self.fixture),
        }

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def run_download(self):
        # Start elsewhere: the helper must resolve assets relative to its own location.
        return subprocess.run(['bash', str(self.script), URL], cwd=self.root,
                              env=self.env, capture_output=True, text=True, timeout=10)

    def run_notebook_cell(self):
        nb = json.loads((TOOL_ROOT / 'video_agent.ipynb').read_text())
        source = ''.join(nb['cells'][5]['source'])
        self.assertTrue(source.startswith('%%bash\n'))
        self.assertIn(URL, source)
        # %%bash executes the remaining lines in a shell and raises on nonzero exit.
        return subprocess.run(['bash', '-c', source.split('\n', 1)[1]], cwd=self.work,
                              env=self.env, capture_output=True, text=True, timeout=10)

    def test_notebook_downloads_missing_avatar_and_does_not_replace_custom_portrait(self):
        result = self.run_notebook_cell()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.avatar.read_bytes(), self.fixture.read_bytes())
        self.assertEqual(len(self.calls()), 1)
        self.assertIn(URL, self.calls()[0])
        self.assertEqual(list(self.avatar.parent.glob('*.part.*')), [])

        self.avatar.write_bytes(b'approved local portrait')
        result = self.run_notebook_cell()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.avatar.read_bytes(), b'approved local portrait')
        self.assertEqual(len(self.calls()), 1)

    def test_local_download_repairs_an_empty_avatar(self):
        self.avatar.parent.mkdir(parents=True)
        self.avatar.touch()
        result = self.run_download()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.avatar.read_bytes(), self.fixture.read_bytes())
        self.assertEqual(len(self.calls()), 1)

    def test_network_failure_does_not_leave_a_partial_avatar(self):
        self.env['AVATAR_TEST_MODE'] = 'fail'
        result = self.run_notebook_cell()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Could not download the default avatar', result.stderr)
        self.assertFalse(self.avatar.exists())
        self.assertEqual(list(self.avatar.parent.glob('*.part.*')), [])

    def test_empty_or_non_png_response_is_rejected_and_can_be_retried(self):
        for mode in ('empty', 'invalid'):
            with self.subTest(mode=mode):
                self.env['AVATAR_TEST_MODE'] = mode
                result = self.run_download()
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.avatar.exists())
                self.assertEqual(list(self.avatar.parent.glob('*.part.*')), [])
        self.env['AVATAR_TEST_MODE'] = 'ok'
        self.assertEqual(self.run_download().returncode, 0)
        self.assertEqual(self.avatar.read_bytes(), self.fixture.read_bytes())

    def test_wrong_dimensions_are_rejected(self):
        self.fixture.write_bytes(square_png(256, 256))
        result = self.run_download()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('512x512 PNG', result.stderr)
        self.assertFalse(self.avatar.exists())
        self.assertEqual(list(self.avatar.parent.glob('*.part.*')), [])

    def test_setup_models_calls_the_same_install_time_downloader(self):
        setup = (TOOL_ROOT / 'python/setup_models.sh').read_text()
        self.assertIn(f'bash python/download_avatar.sh "{URL}"', setup)
        self.assertLess(setup.index('bash python/download_avatar.sh'),
                        setup.index('fetch "$BASE/$VOICE.onnx"'))


if __name__ == '__main__':
    unittest.main()
