from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Multiplicity:
    lower: int
    upper: int | None  # None == unbounded ("*")

    @property
    def is_single(self) -> bool:
        return self.upper == 1

    @property
    def required(self) -> bool:
        return self.lower >= 1

    def count_ok(self, count: int) -> bool:
        if count < self.lower:
            return False
        if self.upper is not None and count > self.upper:
            return False
        return True

    @staticmethod
    def parse(spec: str) -> Multiplicity:
        spec = spec.strip()
        try:
            if ".." in spec:
                lo, hi = spec.split("..", 1)
                lower = int(lo)
                upper = None if hi.strip() == "*" else int(hi)
            elif spec == "*":
                lower, upper = 0, None
            else:
                lower = upper = int(spec)
        except ValueError as exc:
            raise ValueError(f"Invalid multiplicity: {spec!r}") from exc
        return Multiplicity(lower, upper)
