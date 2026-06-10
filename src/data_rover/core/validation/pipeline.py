from __future__ import annotations

from typing import Callable, Protocol

from .issue import Issue
from .scope import Scope


class Validator(Protocol):
    """Per-entity validation protocol.

    The pipeline drives iteration over the model ONCE and hands every entity
    to every validator, so each method must be O(entity) (use the metamodel
    lookup caches and ``model.indexes`` instead of scanning the model dicts).
    Checks that genuinely need a whole-model or whole-scope pass (e.g. the
    exhaustive containment-cycle sweep, uniqueness grouping) belong in
    :meth:`validate_global`, which runs once per validation run.
    """

    def validate_element(self, model, el) -> list[Issue]: ...
    def validate_relationship(self, model, rel) -> list[Issue]: ...
    def validate_global(self, model, scope: Scope) -> list[Issue]: ...


class EntityValidator:
    """No-op base for validators: override only the hooks you need.

    Also provides a standalone ``validate(model, scope)`` so a single
    validator can be exercised on its own (tests, ad-hoc tooling) with the
    exact iteration semantics of the pipeline.
    """

    def validate_element(self, model, el) -> list[Issue]:
        return []

    def validate_relationship(self, model, rel) -> list[Issue]:
        return []

    def validate_global(self, model, scope: Scope) -> list[Issue]:
        return []

    def validate(self, model, scope: Scope | None = None) -> list[Issue]:
        return ValidationPipeline([self]).validate(model, scope)


class ValidationPipeline:
    def __init__(self, validators: list[Validator]) -> None:
        self._validators = list(validators)

    def validate(
        self,
        model,
        scope: Scope | None = None,
        on_validator: Callable[[str], None] | None = None,
    ) -> list[Issue]:
        scope = scope or Scope.all()
        if on_validator is not None:
            for validator in self._validators:
                on_validator(type(validator).__name__)
        validators = self._validators
        issues: list[Issue] = []
        if scope.ids is None:
            for el in model.elements.values():
                for validator in validators:
                    issues.extend(validator.validate_element(model, el))
            for rel in model.relationships.values():
                for validator in validators:
                    issues.extend(validator.validate_relationship(model, rel))
        else:
            for entity_id in scope.ids:
                el = model.elements.get(entity_id)
                if el is not None:
                    for validator in validators:
                        issues.extend(validator.validate_element(model, el))
                    continue
                rel = model.relationships.get(entity_id)
                if rel is not None:
                    for validator in validators:
                        issues.extend(validator.validate_relationship(model, rel))
                # ids resolving to neither are silently skipped (the entity may
                # have been deleted since the scope was computed)
        for validator in validators:
            issues.extend(validator.validate_global(model, scope))
        return issues


def default_pipeline() -> "ValidationPipeline":
    # imported here to avoid a circular import at module load time
    from .validators.containment import ContainmentValidator
    from .validators.endpoint_typing import EndpointTypingValidator
    from .validators.facets import FacetsValidator
    from .validators.multiplicity import MultiplicityValidator
    from .validators.type_conformance import TypeConformanceValidator
    from .validators.uniqueness import UniquenessValidator

    return ValidationPipeline(
        [
            TypeConformanceValidator(),
            MultiplicityValidator(),
            FacetsValidator(),
            EndpointTypingValidator(),
            ContainmentValidator(),
            UniquenessValidator(),
        ]
    )
