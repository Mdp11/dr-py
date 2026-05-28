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


def default_pipeline() -> "ValidationPipeline":
    # imported here to avoid a circular import at module load time
    from .validators.containment import ContainmentValidator
    from .validators.endpoint_typing import EndpointTypingValidator
    from .validators.facets import FacetsValidator
    from .validators.multiplicity import MultiplicityValidator
    from .validators.type_conformance import TypeConformanceValidator

    return ValidationPipeline(
        [
            TypeConformanceValidator(),
            MultiplicityValidator(),
            FacetsValidator(),
            EndpointTypingValidator(),
            ContainmentValidator(),
        ]
    )
