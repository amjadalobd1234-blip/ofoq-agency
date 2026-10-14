#!/usr/bin/env bash
# Install-time only: the video pipeline never downloads a portrait during inference.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT/assets/avatars/man-1.png"
URL="${1:?Provide the Unsplash portrait URL}"

# Keep a user-supplied portrait; retry an empty file left by an interrupted install.
[[ -s "$TARGET" ]] && exit 0
mkdir -p "$(dirname "$TARGET")"
TEMP="$(mktemp "$TARGET.part.XXXXXX")"
trap 'rm -f "$TEMP"' EXIT

if command -v wget >/dev/null 2>&1; then
  download=(wget -q --tries=3 "$URL" -O "$TEMP")
elif command -v curl >/dev/null 2>&1; then
  download=(curl --fail --location --retry 3 --silent --show-error "$URL" --output "$TEMP")
else
  echo 'Install wget or curl to download the default avatar.' >&2
  exit 1
fi
"${download[@]}" || {
  echo 'Could not download the default avatar from Unsplash. Check your connection or provide assets/avatars/man-1.png.' >&2
  exit 1
}
[[ -s "$TEMP" ]] || { echo 'Unsplash returned an empty avatar image.' >&2; exit 1; }
# The request includes fm=png; reject an HTML error or a mislabeled JPEG before preflight.
"${PYTHON_BIN:-python3}" - "$TEMP" <<'PY'
from pathlib import Path
import struct
import sys

with Path(sys.argv[1]).open('rb') as image:
    header = image.read(24)
if (len(header) != 24 or header[:8] != b'\x89PNG\r\n\x1a\n'
        or header[12:16] != b'IHDR'
        or struct.unpack('>II', header[16:24]) != (512, 512)):
    raise SystemExit('Unsplash did not return a 512x512 PNG portrait.')
PY
mv "$TEMP" "$TARGET"
echo "Downloaded default avatar to $TARGET"
