from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Element:
    id: str
    type_name: str
    properties: dict[str, Any] = field(default_factory=dict)
    rev: int = 0
