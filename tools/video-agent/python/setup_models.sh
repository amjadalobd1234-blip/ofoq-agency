#!/usr/bin/env bash
# Only installation is online. Inference never invokes this script.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PYTHON="${PYTHON_BIN:-python3}"
SAD_PYTHON="${SADTALKER_SETUP_PYTHON:-python3.10}"
SAD_REV="cd4c0465ae0b54a6f85af57f5c65fec9fe23e7f8"
VOICE="${TTS_VOICE:-ar_JO-kareem-medium}"
[[ "$VOICE" =~ ^[a-z]{2}_[A-Z]{2}-[a-zA-Z0-9_]+-(low|medium|high|x_low)$ ]] || { echo 'Invalid voice name' >&2; exit 1; }
command -v curl >/dev/null
command -v ffmpeg >/dev/null || { echo 'Install system FFmpeg first.' >&2; exit 1; }
command -v ffprobe >/dev/null
"$SAD_PYTHON" -c 'import sys; assert sys.version_info[:2] == (3, 10), "SadTalker requires its separate Python 3.10 environment"'
mkdir -p models/piper vendor
fetch() {
  local url="$1" target="$2"
  [[ -s "$target" ]] && return
  mkdir -p "$(dirname "$target")"
  curl --fail --location --retry 3 "$url" --output "$target.part"
  mv "$target.part" "$target"
}
# Retain the voice's model card: model/dataset licenses differ from Piper's code license.
LOCALE="${VOICE%%-*}"; NAME_QUALITY="${VOICE#*-}"; NAME="${NAME_QUALITY%-*}"; QUALITY="${VOICE##*-}"
BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/${LOCALE%%_*}/$LOCALE/$NAME/$QUALITY"
fetch "$BASE/$VOICE.onnx" "models/piper/$VOICE.onnx"
fetch "$BASE/$VOICE.onnx.json" "models/piper/$VOICE.onnx.json"
fetch "$BASE/MODEL_CARD" "models/piper/$VOICE-MODEL_CARD"
if [[ ! -f vendor/SadTalker/inference.py ]]; then
  TEMP="$(mktemp -d)"
  trap 'rm -rf "$TEMP"' EXIT
  curl --fail --location --retry 3 "https://codeload.github.com/OpenTalker/SadTalker/tar.gz/$SAD_REV" -o "$TEMP/sadtalker.tar.gz"
  mkdir -p vendor/SadTalker
  tar -xzf "$TEMP/sadtalker.tar.gz" -C vendor/SadTalker --strip-components=1
  printf '%s\n' "$SAD_REV" > vendor/SadTalker/.ofoq-revision
fi
[[ -f vendor/SadTalker/.ofoq-revision && "$(cat vendor/SadTalker/.ofoq-revision)" == "$SAD_REV" ]] || {
  echo 'Unrecognized SadTalker install. Back it up and remove vendor/SadTalker before setup.' >&2; exit 1;
}
"$SAD_PYTHON" -m venv .venv-sadtalker
.venv-sadtalker/bin/python -m pip install 'pip<25' 'setuptools<70' wheel
# CPU is the default. Export PYTORCH_INDEX_URL for a suitable CUDA wheel index.
.venv-sadtalker/bin/python -m pip install torch==2.0.1 torchvision==0.15.2 \
  --index-url "${PYTORCH_INDEX_URL:-https://download.pytorch.org/whl/cpu}"
.venv-sadtalker/bin/python -m pip install -r python/requirements-sadtalker.txt
CHECKPOINTS="https://github.com/OpenTalker/SadTalker/releases/download/v0.0.2-rc"
for FILE in SadTalker_V0.0.2_256.safetensors mapping_00229-model.pth.tar; do
  fetch "$CHECKPOINTS/$FILE" "vendor/SadTalker/checkpoints/$FILE"
done
FACE="https://github.com/xinntao/facexlib/releases/download/v0.1.0"
for FILE in alignment_WFLW_4HG.pth detection_Resnet50_Final.pth; do
  fetch "$FACE/$FILE" "vendor/SadTalker/gfpgan/weights/$FILE"
done
# Record hashes of the locally installed weights for reproducibility/auditing.
"$PYTHON" - <<'PY'
import hashlib, json
from pathlib import Path
files = list(Path('models/piper').glob('*')) + list(Path('vendor/SadTalker/checkpoints').glob('*')) + list(Path('vendor/SadTalker/gfpgan/weights').glob('*'))
manifest = {}
for file in files:
    if file.is_file():
        h = hashlib.sha256()
        with file.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                h.update(block)
        manifest[str(file)] = h.hexdigest()
Path('models/installed-sha256.json').write_text(json.dumps(manifest, indent=2))
PY
.venv-sadtalker/bin/python python/avatar_generate.py --check --device cpu
echo 'Models installed. Add your licensed portrait, install local Chrome/Chromium, and configure .env.'
echo 'No portrait or Chrome is downloaded by this script. See README for license limitations.'
