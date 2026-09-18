"""Scenario registry and fixture files.

A scenario is a function returning a JSON-ready document. Its file is
``<name>.json`` under ``engine/fixtures/golden``; ``stale`` is what keeps the
committed files honest (see ``test_fixtures_current.py``).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "engine" / "fixtures" / "golden"

Scenario = Callable[[], Any]
_SCENARIOS: dict[str, Scenario] = {}


def scenario(name: str) -> Callable[[Scenario], Scenario]:
    def register(fn: Scenario) -> Scenario:
        if name in _SCENARIOS:
            raise ValueError(f"duplicate golden scenario {name!r}")
        _SCENARIOS[name] = fn
        return fn

    return register


def render(doc: Any) -> str:
    return json.dumps(doc, indent=2, ensure_ascii=False, allow_nan=False) + "\n"


def generate() -> dict[str, str]:
    """Every fixture file's text, keyed by file name."""
    from . import scenarios  # noqa: F401  (importing registers the scenarios)

    return {f"{name}.json": render(fn()) for name, fn in sorted(_SCENARIOS.items())}


def write(directory: Path = FIXTURE_DIR) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    files = generate()
    for path in directory.glob("*.json"):
        if path.name not in files:
            path.unlink()
    for name, text in files.items():
        (directory / name).write_text(text, encoding="utf-8")


def stale(directory: Path = FIXTURE_DIR) -> list[str]:
    """Names of fixture files that are missing, outdated or left over."""
    files = generate()
    on_disk = (
        {p.name for p in directory.glob("*.json")} if directory.is_dir() else set()
    )
    changed = [
        name
        for name, text in files.items()
        if name not in on_disk or (directory / name).read_text(encoding="utf-8") != text
    ]
    return sorted(changed + [name for name in on_disk if name not in files])
