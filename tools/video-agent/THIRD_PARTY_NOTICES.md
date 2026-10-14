# Licensing and ownership notes

This repository's integration code, templates, and procedural music generator do not transfer ownership of third-party software, models, fonts, or likenesses to Ofoq. This is a technical inventory, not legal advice or a certification of commercial rights. No blanket “100% owned / unrestricted open source / permanently free” claim is made.

| Component | Terms to review |
| --- | --- |
| Remotion 4.0.535 | [Custom Remotion license](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md), also shipped in `node_modules/remotion/LICENSE.md`. Free eligibility includes individuals, for-profit organizations with up to three employees, nonprofits, and evaluation. Other for-profit organizations require a Company License. It is source-available, not an unconditional OSI-style open-source license. |
| Piper TTS 1.3.0 | [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl), GPL-3.0; redistribution may impose corresponding-source and license obligations. Do not assume the archived MIT Piper implementation's license applies to this version. |
| Piper voices | [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices). Each voice/dataset can have separate terms. Setup saves the selected voice's MODEL_CARD; read it before commercial use or redistribution. Arabic voice weights are downloaded, not included in this repository. |
| SadTalker source | [OpenTalker/SadTalker](https://github.com/OpenTalker/SadTalker), Apache-2.0 at the pinned source revision. This is not a blanket relicensing of all bundled research assets or pretrained models. |
| SadTalker/face model weights | Review upstream release, pretrained-model, facexlib, face-reconstruction and dataset notices separately. Do not infer unrestricted commercial rights solely from the source repository license. |
| PyTorch / Torchvision | BSD-style licenses and bundled third-party notices. The separate compatibility environment contains older packages; keep it local, use trusted weights, and review security updates before distributing it. |
| NumPy / SciPy | BSD-3-Clause and third-party notices. Music here is synthesized procedurally rather than copied from a sample library. |
| FFmpeg | LGPL/GPL depends on the actual build and enabled codecs; review your distribution and local codec/patent obligations. |
| fluent-ffmpeg | MIT; upstream package is deprecated/unmaintained. Included as requested, used only for local FFprobe orchestration. |
| Chrome/Chromium | Local installation has its own distribution/license terms. No browser binary is shipped here. The tool detects an already installed browser (`PUPPETEER_EXECUTABLE_PATH`, `BROWSER_EXECUTABLE`, or the usual system paths) and never downloads one at runtime. |
| puppeteer-core | Apache-2.0. Used only by `npm run doctor` to drive the locally installed browser; it downloads no browser binary itself. |
| Portrait / font / agency logo | Use only assets with appropriate rights. Obtain explicit permission to animate a real person's likeness and use it in an advertisement. Replace the included simple SVG mark with the approved agency logo if required. |

Installation downloads software/weights from third-party repositories. After installation, runtime does not rely on hosted inference, billing APIs, subscriptions to generation services, or API keys. This independence does not eliminate hardware costs, upstream licenses, maintenance, or the need to archive your legally obtained dependencies for long-term reproducibility.
