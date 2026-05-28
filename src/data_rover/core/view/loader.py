from __future__ import annotations

import json
from pathlib import Path

from .schema import View


class ViewError(Exception):
    """Raised when a view document is malformed."""


def load_view_str(text: str) -> View:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ViewError(f"Malformed view JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ViewError("View document must be a JSON object")
    try:
        return View.model_validate(data)
    except Exception as exc:
        raise ViewError(f"Invalid view: {exc}") from exc


def load_view_file(path: str | Path) -> View:
    return load_view_str(Path(path).read_text(encoding="utf-8"))
