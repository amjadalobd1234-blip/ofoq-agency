import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))
from tts_generate import scene_samples, tempo_filters, fit_segment
from avatar_generate import inference_args, check_installation
from offline import disable_network


class WrapperTests(unittest.TestCase):
    def test_voice_timings_match_video_scene_boundaries(self):
        self.assertEqual(scene_samples(30, 30), [0, 216000, 1080000, 1368000, 1440000])
        for duration in (5, 15, 30, 60):
            for fps in (24, 25, 30, 60):
                boundaries = scene_samples(duration, fps)
                self.assertEqual(boundaries[-1], duration * 48000)
                self.assertTrue(all(a < b for a, b in zip(boundaries, boundaries[1:])))

    def test_tempo_filter_chains_within_ffmpeg_supported_range(self):
        self.assertEqual(tempo_filters(1), "atempo=1.00000000")
        self.assertEqual(tempo_filters(3), "atempo=2,atempo=1.50000000")

    def test_voice_segment_padding_command_without_shell(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, target = Path(temporary) / "a.wav", Path(temporary) / "b.wav"
            with wave.open(str(source), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(48000)
                audio.writeframes(bytes(48000 * 2))
            with patch("tts_generate.subprocess.run") as run:
                fit_segment(source, target, 96000, "ffmpeg")
                args = run.call_args.args[0]
                self.assertIsInstance(args, list)
                self.assertIn("atempo=1.00000000,aresample=48000,apad,atrim=end_sample=96000", args)
                self.assertTrue(run.call_args.kwargs["check"])
            with self.assertRaisesRegex(ValueError, "النص أطول"):
                fit_segment(source, target, 4800, "ffmpeg")

    def test_avatar_command_selects_cpu_and_never_enables_model_download_enhancers(self):
        args = inference_args(Path("/sad"), Path("/a face.png"), Path("/voice.wav"), Path("/results"), "cpu")
        self.assertIn("--cpu", args)
        self.assertIn("/a face.png", args)
        self.assertNotIn("--enhancer", args)
        self.assertNotIn("--cpu", inference_args(Path("/sad"), Path("/a.png"), Path("/b.wav"), Path("/r"), "cuda"))

    def test_missing_models_fail_before_importing_torch(self):
        with tempfile.TemporaryDirectory() as temporary, self.assertRaises(FileNotFoundError):
            check_installation(Path(temporary), "cpu")

    def test_network_guard_blocks_python_inference_connections(self):
        import socket
        with patch.object(socket, "create_connection"), patch.object(socket.socket, "connect"), patch.object(socket.socket, "connect_ex"):
            disable_network()
            with self.assertRaisesRegex(RuntimeError, "Network disabled"):
                socket.create_connection(("example.com", 443))

class PipelineWrapperTests(unittest.TestCase):
    def test_tts_generates_three_segments_and_exact_duration_with_mock_piper(self):
        import types
        from tts_generate import generate_voice
        spoken = []
        class FakeVoice:
            @staticmethod
            def load(model, use_cuda):
                return FakeVoice()

            def synthesize_wav(self, text, audio, syn_config):
                spoken.append((text, syn_config.length_scale))
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(48000)
                audio.writeframes(bytes(48000 * 2))

        def fitted(source, target, samples, ffmpeg):
            with wave.open(str(target), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(48000)
                audio.writeframes(bytes(samples * 2))

        fake_piper = types.SimpleNamespace(PiperVoice=FakeVoice, SynthesisConfig=lambda **kwargs: types.SimpleNamespace(**kwargs))
        with tempfile.TemporaryDirectory() as temporary:
            model, output = Path(temporary) / "voice.onnx", Path(temporary) / "voice.wav"
            model.write_bytes(b"mock")
            Path(str(model) + ".json").write_text("{}")
            with patch.dict(sys.modules, {"piper": fake_piper}), patch("tts_generate.disable_network"), patch("tts_generate.fit_segment", side_effect=fitted):
                generate_voice({"duration": 15, "hook": "hook", "body": "body", "cta": "cta"}, model, output, rate=2)
            self.assertEqual(spoken, [("hook", .5), ("body", .5), ("cta", .5)])
            with wave.open(str(output)) as audio:
                self.assertEqual(audio.getnframes(), 15 * 48000)

    def test_avatar_copies_new_result_and_restores_working_directory(self):
        import os
        from avatar_generate import generate_avatar
        previous_cwd = Path.cwd()
        previous_argv = sys.argv[:]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "sad"
            root.mkdir()
            source, audio, results = Path(temporary) / "person.png", Path(temporary) / "voice.wav", Path(temporary) / "results"
            source.write_bytes(b"mock picture")
            audio.write_bytes(b"mock audio")
            def fake_inference(*args, **kwargs):
                work = Path(sys.argv[sys.argv.index("--result_dir") + 1])
                (work / "new-result.mp4").write_bytes(b"new video")
            with patch("avatar_generate.check_installation"), patch("avatar_generate.shutil.which", return_value="/usr/bin/ffmpeg"), patch("avatar_generate.runpy.run_path", side_effect=fake_inference), patch.dict(os.environ):
                output = generate_avatar(root, source, audio, results)
            self.assertEqual(output.read_bytes(), b"new video")
            self.assertEqual(list(results.iterdir()), [results / "avatar.mp4"])
        self.assertEqual(Path.cwd(), previous_cwd)
        self.assertEqual(sys.argv, previous_argv)


if __name__ == "__main__":
    unittest.main()
