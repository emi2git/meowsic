"""Meowsic's audio → score pipeline (moved from Emi Music Note, archived 2026-11-27)."""
import os
from pathlib import Path

# Downloaded AI models live in ~/ai/models (set before any model library is imported).
MODELS = Path(os.environ.get("AI_MODELS", Path.home() / "ai" / "models"))
os.environ.setdefault("HF_HUB_CACHE", str(MODELS / "huggingface"))     # Whisper, Demucs
os.environ.setdefault("TORCH_HOME", str(MODELS / "torch"))             # Beat This
