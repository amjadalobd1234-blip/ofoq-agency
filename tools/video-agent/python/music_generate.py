"""Deterministic, original synthesized C–Am–F–G accompaniment. No samples/API."""
import argparse
import math
from pathlib import Path

import numpy as np
from scipy.io import wavfile


def generate_music(duration: float, output: Path, sample_rate: int = 44100):
    if not math.isfinite(duration) or not 5 <= duration <= 60:
        raise ValueError("duration must be between 5 and 60 seconds")
    if not 8000 <= sample_rate <= 96000:
        raise ValueError("invalid sample rate")
    count = round(duration * sample_rate)
    music = np.zeros(count, dtype=np.float64)
    chords = [(60, 64, 67), (57, 60, 64), (53, 57, 60), (55, 59, 62)]
    beat_seconds = 60 / 96
    chord_seconds = beat_seconds * 4
    for start in np.arange(0, duration, beat_seconds):
        chord = chords[int(start / chord_seconds) % len(chords)]
        start_sample = round(start * sample_rate)
        length = min(round(beat_seconds * 1.8 * sample_rate), count - start_sample)
        time = np.arange(length) / sample_rate
        envelope = (1 - np.exp(-time * 45)) * np.exp(-time * 4)
        # Soft harmonics rather than a harsh square/saw wave.
        note = chord[int(round(start / beat_seconds)) % 3]
        frequency = 440 * 2 ** ((note - 69) / 12)
        tone = np.sin(2 * np.pi * frequency * time) + 0.18 * np.sin(4 * np.pi * frequency * time)
        bass = np.sin(2 * np.pi * (440 * 2 ** ((chord[0] - 12 - 69) / 12)) * time)
        music[start_sample:start_sample + length] += envelope * (tone * 0.35 + bass * 0.16)
    fade = min(round(sample_rate * 0.7), count // 2)
    music[:fade] *= np.linspace(0, 1, fade)
    music[-fade:] *= np.linspace(1, 0, fade)
    peak = np.max(np.abs(music))
    if peak:
        music = music / peak * 0.65
    # Two channels, PCM16, with headroom; composition ducks it under the voice.
    pcm = np.round(np.column_stack((music, music)) * 32767).astype(np.int16)
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    wavfile.write(output, sample_rate, pcm)
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration", type=float, default=15)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    generate_music(args.duration, args.output)


if __name__ == "__main__":
    main()
