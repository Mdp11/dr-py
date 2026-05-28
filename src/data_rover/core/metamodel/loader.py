from __future__ import annotations

from pathlib import Path

import yaml

from .check import check_metamodel
from .schema import Metamodel


class MetamodelError(Exception):
    """Raised when a metamodel document is malformed or invalid."""


def load_metamodel_str(text: str) -> Metamodel:
    data = yaml.safe_load(text) or {}
    try:
        mm = Metamodel.model_validate(data)
    except Exception as exc:
        raise MetamodelError(f"Malformed metamodel: {exc}") from exc
    errors = check_metamodel(mm)
    if errors:
        raise MetamodelError("Invalid metamodel:\n- " + "\n- ".join(errors))
    return mm


def load_metamodel_file(path: str | Path) -> Metamodel:
    return load_metamodel_str(Path(path).read_text(encoding="utf-8"))
