#!/bin/zsh
# Makes transcribe/.venv (Python 3.11, exact versions from requirements.lock). Never in git.
# Models stay in ~/ai/models (HF_HUB_CACHE / TORCH_HOME). Needs brew ffmpeg + yt-dlp; MuseScore 4 for PDFs.
# --offline: install only from uv's cache (no downloads).
set -e
cd "${0:A:h}"
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python $1 -r requirements.lock
