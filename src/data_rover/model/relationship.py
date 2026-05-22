from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Relationship:
    id: str
    type_name: str
    source_id: str
    target_id: str
    properties: dict[str, Any] = field(default_factory=dict)
    rev: int = 0
