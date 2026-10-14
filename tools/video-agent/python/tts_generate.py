"""Local Piper narration, aligned to the three composition scenes without cutting words."""
import argparse
import json
import math
import subprocess
import tempfile
import wave
from pathlib import Path

from offline import disable_network


def scene_samples(duration, fps, sample_rate=48000):
    # Match JavaScript Math.round, including odd fps/frame counts.
    total = duration * fps
    frames = [0, math.floor(total * .15 + .5), math.floor(total * .75 + .5),
              math.floor(total * .95 + .5), total]
    return [math.floor(frame / fps * sample_rate + .5) for frame in frames]


def tempo_filters(ratio):
    filters = []
    while ratio > 2:
        filters.append("atempo=2")
        ratio /= 2
    filters.append(f"atempo={ratio:.8f}")
    return ",".join(filters)


def fit_segment(source, destination, samples, ffmpeg):
    seconds = samples / 48000
    with wave.open(str(source), "rb") as audio:
        original = audio.getnframes() / audio.getframerate()
    if original <= 0:
        raise ValueError("Piper produced empty audio")
    # Leave a short pause before the next scene. Never silently truncate speech.
    speed = max(1.0, original / max(.1, seconds - .08))
    if speed > 3:
        raise ValueError("النص أطول من المشهد. اختصر النص أو زد مدة الإعلان (لن يُقص الكلام).")
    filters = f"{tempo_filters(speed)},aresample=48000,apad,atrim=end_sample={samples}"
    subprocess.run([ffmpeg, "-nostdin", "-y", "-v", "error", "-i", str(source),
                    "-af", filters, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", str(destination)], check=True)


def generate_voice(script, model, output, rate=1., fps=30, ffmpeg="ffmpeg"):
    duration = script["duration"]
    if not isinstance(duration, int) or not 5 <= duration <= 60 or not 24 <= fps <= 60 or not .5 <= rate <= 2:
        raise ValueError("Invalid duration, fps or speech rate")
    model = Path(model).resolve()
    if not model.is_file() or not Path(str(model) + ".json").is_file():
        raise FileNotFoundError("Piper model/config missing. Run setup_models.sh first.")
    disable_network()
    from piper import PiperVoice, SynthesisConfig
    voice = PiperVoice.load(str(model), use_cuda=False)
    synthesis = SynthesisConfig(length_scale=1 / rate)
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    boundaries = scene_samples(duration, fps)
    with tempfile.TemporaryDirectory(prefix="piper-", dir=output.parent) as temporary:
        chunks = []
        for index, field in enumerate(("hook", "body", "cta")):
            text = script[field]
            if not isinstance(text, str) or not text.strip():
                raise ValueError(f"Empty {field}")
            raw = Path(temporary) / f"{field}-raw.wav"
            fitted = Path(temporary) / f"{field}.wav"
            with wave.open(str(raw), "wb") as audio:
                voice.synthesize_wav(text, audio, syn_config=synthesis)
            fit_segment(raw, fitted, boundaries[index + 1] - boundaries[index], ffmpeg)
            with wave.open(str(fitted), "rb") as audio:
                chunks.append(audio.readframes(audio.getnframes()))
        chunks.append(bytes((boundaries[4] - boundaries[3]) * 2))
        with wave.open(str(output), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(48000)
            audio.writeframes(b"".join(chunks))
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rate", type=float, default=1.)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()
    generate_voice(json.loads(args.script.read_text(encoding="utf-8")), args.model,
                   args.output, args.rate, args.fps, args.ffmpeg)


if __name__ == "__main__":
    main()
