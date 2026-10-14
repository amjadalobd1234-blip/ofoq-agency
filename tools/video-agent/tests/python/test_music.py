import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np
from scipy.io import wavfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))
from music_generate import generate_music


class MusicTests(unittest.TestCase):
    def test_valid_pcm_wav_duration_channels_and_fades(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "nested/music.wav"
            generate_music(5, output)
            with wave.open(str(output)) as audio:
                self.assertEqual(audio.getnchannels(), 2)
                self.assertEqual(audio.getsampwidth(), 2)
                self.assertEqual(audio.getframerate(), 44100)
                self.assertEqual(audio.getnframes(), 5 * 44100)
            rate, pcm = wavfile.read(output)
            self.assertEqual(pcm.dtype, np.int16)
            self.assertGreater(np.max(np.abs(pcm)), 1000)
            self.assertLess(np.max(np.abs(pcm)), 32767)
            self.assertTrue(np.all(pcm[0] == 0))
            self.assertTrue(np.all(pcm[-1] == 0))

    def test_deterministic_and_maximum_duration(self):
        with tempfile.TemporaryDirectory() as temporary:
            first, second = Path(temporary) / "a.wav", Path(temporary) / "b.wav"
            generate_music(60, first, sample_rate=8000)
            generate_music(60, second, sample_rate=8000)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(wavfile.read(first)[1].shape, (480000, 2))

    def test_invalid_durations(self):
        for duration in (-1, 0, 4, 61, float("nan"), float("inf")):
            with self.subTest(duration=duration), self.assertRaises(ValueError):
                generate_music(duration, Path("must-not-exist.wav"))

    def test_cli(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "music.wav"
            subprocess.run([sys.executable, str(ROOT / "python/music_generate.py"),
                            "--duration", "15", "--output", str(output)], check=True)
            self.assertEqual(wavfile.read(output)[1].shape[0], 15 * 44100)


if __name__ == "__main__":
    unittest.main()
