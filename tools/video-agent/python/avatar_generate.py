"""Run the pinned SadTalker locally. No fallback service or runtime model download."""
import argparse
import os
from pathlib import Path
import runpy
import shutil
import sys
import tempfile

from offline import disable_network

REQUIRED_MODELS = (
    "checkpoints/SadTalker_V0.0.2_256.safetensors",
    "checkpoints/mapping_00229-model.pth.tar",
    "gfpgan/weights/alignment_WFLW_4HG.pth",
    "gfpgan/weights/detection_Resnet50_Final.pth",
)


def check_installation(root, device):
    for relative in ("inference.py", *REQUIRED_MODELS):
        filename = root / relative
        if not filename.is_file() or filename.stat().st_size == 0:
            raise FileNotFoundError(f"Missing {filename}. Run python/setup_models.sh first.")
    disable_network()
    import torch
    import torchvision  # noqa: F401
    import facexlib  # noqa: F401
    import safetensors  # noqa: F401
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but not available. Install a matching torch build or select cpu.")


def inference_args(root, source, audio, results, device):
    args = [str(root / "inference.py"), "--source_image", str(source),
            "--driven_audio", str(audio), "--result_dir", str(results),
            "--checkpoint_dir", str(root / "checkpoints"), "--size", "256",
            "--preprocess", "crop", "--still", "--batch_size", "1"]
    if device == "cpu":
        args.append("--cpu")
    return args


def generate_avatar(root, source, audio, results, device="cpu", ffmpeg="ffmpeg"):
    root, source, audio, results = [Path(p).resolve() for p in (root, source, audio, results)]
    check_installation(root, device)
    if not source.is_file() or source.suffix.lower() not in (".png", ".jpg", ".jpeg"):
        raise ValueError("Provide a consented local PNG/JPG portrait in DEFAULT_AVATAR.")
    if not audio.is_file():
        raise FileNotFoundError(audio)
    executable = shutil.which(ffmpeg)
    if not executable:
        raise FileNotFoundError("FFmpeg is required by SadTalker")
    os.environ["PATH"] = str(Path(executable).parent) + os.pathsep + os.environ.get("PATH", "")
    os.environ["IMAGEIO_FFMPEG_EXE"] = executable
    results.mkdir(parents=True, exist_ok=True)
    previous_cwd, previous_argv = Path.cwd(), sys.argv[:]
    previous_path = sys.path[:]
    try:
        os.chdir(root)
        sys.path.insert(0, str(root))
        # Unique work directory: never pick a stale video from an earlier run.
        with tempfile.TemporaryDirectory(prefix="sadtalker-", dir=results) as temporary:
            sys.argv = inference_args(root, source, audio, Path(temporary), device)
            runpy.run_path(str(root / "inference.py"), run_name="__main__")
            videos = list(Path(temporary).glob("*.mp4"))
            if len(videos) != 1 or not videos[0].stat().st_size:
                raise RuntimeError("SadTalker did not produce a video. Check the portrait/face detection logs.")
            target = results / "avatar.mp4"
            shutil.copyfile(videos[0], target)
            return target
    finally:
        os.chdir(previous_cwd)
        sys.argv = previous_argv
        sys.path[:] = previous_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path)
    parser.add_argument("--driven_audio", type=Path)
    parser.add_argument("--result_dir", type=Path)
    parser.add_argument("--sadtalker_dir", type=Path, default=Path(__file__).resolve().parents[1] / "vendor/SadTalker")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check_installation(args.sadtalker_dir.resolve(), args.device)
        print("SadTalker local files/dependencies OK")
    else:
        if not all((args.source, args.driven_audio, args.result_dir)):
            parser.error("--source, --driven_audio and --result_dir are required")
        generate_avatar(args.sadtalker_dir, args.source, args.driven_audio,
                        args.result_dir, args.device, args.ffmpeg)


if __name__ == "__main__":
    main()
