from __future__ import annotations

import sys
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class Relationship:
    id: str
    type_name: str
    source_id: str
    target_id: str
    properties: dict[str, Any] = field(default_factory=dict)
    rev: int = 0

    def __post_init__(self) -> None:
        # one shared string per type name across the whole model
        self.type_name = sys.intern(self.type_name)
