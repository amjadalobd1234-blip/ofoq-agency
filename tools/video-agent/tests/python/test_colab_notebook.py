"""Execute the actual notebook parameter/run cells with only rendering mocked.

No Colab, GPU, models or IPython installation required. This is not Run All.
"""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


class ColabNotebookTests(unittest.TestCase):
    def setUp(self):
        notebook_path = Path(__file__).resolve().parents[2] / 'video_agent.ipynb'
        self.notebook = json.loads(notebook_path.read_text())
        self.assertEqual(len(self.notebook['cells']), 6)
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
            exec(self.source(4), self.scope)

    def source(self, index):
        return ''.join(self.notebook['cells'][index]['source'])

    def run_cell(self):
        with patch.dict('sys.modules', self.modules), contextlib.redirect_stdout(io.StringIO()):
            exec(self.source(5), self.scope)

    def test_cell_five_values_reach_cli_as_literal_arguments(self):
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
