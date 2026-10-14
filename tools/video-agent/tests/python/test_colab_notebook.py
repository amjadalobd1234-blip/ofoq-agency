"""Execute the actual notebook parameter/run cells with only rendering mocked.

No Colab, GPU, models or IPython installation required. This is not Run All.
"""
import contextlib
import io
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

# Cell layout of video_agent.ipynb:
# 0 intro | 1 system check (shell) | 2 clone (python) | 3 system install (shell)
# 4 node/python/models install (shell) | 5 browser env (python) | 6 parameters | 7 run
PARAMS_CELL = 6
RUN_CELL = 7
BROWSER_CELL = 5
INSTALL_CELLS = (3, 4)


class ColabNotebookTests(unittest.TestCase):
    def setUp(self):
        notebook_path = Path(__file__).resolve().parents[2] / 'video_agent.ipynb'
        self.notebook = json.loads(notebook_path.read_text())
        self.assertEqual(len(self.notebook['cells']), 8)
        self.sources = [''.join(cell['source']) for cell in self.notebook['cells']]
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / 'tools' / 'video-agent'
        self.output = self.work / 'output'
        self.output.mkdir(parents=True)
        self.display = Mock()
        self.video = Mock()
        display_module = types.ModuleType('IPython.display')
        display_module.Video = self.video
        display_module.display = self.display
        self.modules = {
            'IPython': types.ModuleType('IPython'),
            'IPython.display': display_module,
        }
        self.scope = {'PROJECT_DIR': str(self.root)}
        with contextlib.redirect_stdout(io.StringIO()):
            exec(self.sources[PARAMS_CELL], self.scope)

    def cell(self, index):
        return self.sources[index]

    def run_cell(self):
        with patch.dict('sys.modules', self.modules), contextlib.redirect_stdout(io.StringIO()):
            exec(self.sources[RUN_CELL], self.scope)

    def test_no_cell_mixes_shell_magics_with_python_blocks(self):
        # A magic inside an indented block raises IndentationError in Jupyter.
        for index, source in enumerate(self.sources):
            for line in source.splitlines():
                self.assertIsNone(re.match(r'^\s+[!%]', line), f'cell {index} mixes shell with Python: {line!r}')
        for index in INSTALL_CELLS:
            continuation = False
            for line in self.sources[index].splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith('#') or continuation:
                    continuation = stripped.endswith('\\')
                    continue
                self.assertTrue(stripped.startswith('!'), f'cell {index} is not shell-only: {line!r}')
                continuation = stripped.endswith('\\')

    def test_install_cell_installs_chromium(self):
        install = ' '.join(self.cell(index) for index in INSTALL_CELLS)
        self.assertIn('apt-get install -y -qq gfortran ffmpeg chromium-browser', install)
        self.assertIn('npm install', install)

    def test_browser_env_cell_sets_variables_before_the_run_cell(self):
        source = self.cell(BROWSER_CELL)
        self.assertIn('os.environ["BROWSER_EXECUTABLE"]', source)
        self.assertIn('os.environ["PUPPETEER_EXECUTABLE_PATH"]', source)
        self.assertIn('/usr/bin/chromium-browser', source)
        self.assertIn('/usr/bin/chromium', source)
        self.assertIn('/usr/bin/google-chrome', source)
        self.assertFalse(any(line.strip().startswith(('!', '%')) for line in source.splitlines()))
        self.assertLess(BROWSER_CELL, RUN_CELL)
        self.assertLess(PARAMS_CELL, RUN_CELL)
        # The run cell forwards the environment (and therefore the browser paths) to npm start.
        self.assertIn('os.environ.copy()', self.cell(RUN_CELL))

    def test_browser_env_cell_prefers_an_existing_browser(self):
        browser = self.root / 'chromium'
        browser.write_text('#!/bin/sh\nexit 0\n')
        source = self.cell(BROWSER_CELL).replace('BROWSER_CANDIDATES = [', f'BROWSER_CANDIDATES = [\n    "{browser}",')
        before = {key: value for key, value in os.environ.items() if key.startswith(('BROWSER_', 'PUPPETEER_'))}
        # patch.dict restores os.environ so executing the cell cannot leak into the test process.
        with patch.dict(os.environ), contextlib.redirect_stdout(io.StringIO()):
            exec(source, {})
            self.assertEqual(os.environ['BROWSER_EXECUTABLE'], str(browser))
            self.assertEqual(os.environ['PUPPETEER_EXECUTABLE_PATH'], str(browser))
        after = {key: value for key, value in os.environ.items() if key.startswith(('BROWSER_', 'PUPPETEER_'))}
        self.assertEqual(after, before)

    def test_cell_seven_values_reach_cli_as_literal_arguments(self):
        self.scope['DESCRIPTION'] = 'عطر "ذهب"; $(touch unsafe)\n15 ثانية'
        old = self.output / 'old' / 'ad-old.mp4'
        old.parent.mkdir()
        old.touch()
        new = self.output / 'new' / 'ad-new.mp4'

        def fake_run(command, **kwargs):
            new.parent.mkdir()
            new.touch()
            (new.parent / 'avatar.mp4').touch()
            return subprocess.CompletedProcess(command, 0, stdout='generated', stderr='')

        with patch('subprocess.run', side_effect=fake_run) as run:
            self.run_cell()
        command = run.call_args.args[0]
        self.assertEqual(command, [
            'npm', 'start', '--', '--description', self.scope['DESCRIPTION'],
            '--template', self.scope['TEMPLATE'], '--productName', self.scope['PRODUCT_NAME'],
            '--benefit', self.scope['BENEFIT'], '--price', self.scope['PRICE'], '--non-interactive',
        ])
        kwargs = run.call_args.kwargs
        self.assertEqual(kwargs['cwd'], self.work)
        self.assertEqual(kwargs['stdin'], subprocess.DEVNULL)
        self.assertFalse(kwargs.get('shell', False))
        self.assertEqual(kwargs['env']['OUTPUT_DIR'], str(self.output))
        self.assertGreater(kwargs['timeout'], 0)
        self.video.assert_called_once_with(str(new), embed=True)
        self.display.assert_called_once_with(self.video.return_value)

    def test_failed_command_never_displays_stale_video(self):
        old = self.output / 'old' / 'ad-old.mp4'
        old.parent.mkdir()
        old.touch()
        with patch('subprocess.run', return_value=subprocess.CompletedProcess(
            ['npm'], 1, stdout='', stderr='missing models'
        )):
            with self.assertRaises(subprocess.CalledProcessError):
                self.run_cell()
        self.display.assert_not_called()

    def test_success_without_new_final_video_is_an_error(self):
        old = self.output / 'old' / 'ad-old.mp4'
        old.parent.mkdir()
        old.touch()
        with patch('subprocess.run', return_value=subprocess.CompletedProcess(
            ['npm'], 0, stdout='', stderr=''
        )):
            with self.assertRaises(FileNotFoundError):
                self.run_cell()
        self.display.assert_not_called()


if __name__ == '__main__':
    unittest.main()
