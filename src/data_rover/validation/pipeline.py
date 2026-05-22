from __future__ import annotations

from typing import Protocol

from .issue import Issue
from .scope import Scope


class Validator(Protocol):
    def validate(self, model, scope: Scope) -> list[Issue]: ...


class ValidationPipeline:
    def __init__(self, validators: list[Validator]) -> None:
        self._validators = list(validators)

    def validate(self, model, scope: Scope | None = None) -> list[Issue]:
        scope = scope or Scope.all()
        issues: list[Issue] = []
        for validator in self._validators:
            issues.extend(validator.validate(model, scope))
        return issues
