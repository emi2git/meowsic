#!/bin/zsh
# Start the Meowsic server. Env: MEOWSIC_PORT (5180), MEOWSIC_HOST (0.0.0.0), MEOWSIC_DATA,
# MEOWSIC_CERT + MEOWSIC_KEY for HTTPS. First run: uv venv .venv --python 3.12 && uv pip install -r requirements.txt
cd "${0:A:h}"
exec .venv/bin/python -m meowsic "$@"
