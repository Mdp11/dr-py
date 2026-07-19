from __future__ import annotations

from typing import TYPE_CHECKING, Protocol
from collections.abc import Callable

from .issue import Issue
from .scope import Scope

if TYPE_CHECKING:
    from ..metamodel.schema import Metamodel


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


class MetamodelMemo:
    """Identity-keyed invalidation for per-metamodel lookup caches.

    Validators precompute metamodel-derived tables (effective properties,
    endpoint decisions, end constraints, ...) so the per-entity hot path is a
    plain dict lookup instead of a metamodel traversal. Those tables are only
    valid for the metamodel that produced them, so each validator registers
    its cache dicts here and calls :meth:`sync` at the top of every hook:
    when the incoming metamodel differs, every registered cache is cleared
    at once (no per-cache call ordering to get wrong).

    WHY identity, not equality: the check runs once per entity, so it must be
    a pointer comparison — pydantic equality would deep-compare the schema.
    Identity is also the correct invariant: the cached tables were derived
    from one specific object, and the strong reference kept in ``_mm``
    prevents that object from being garbage collected, so a new metamodel can
    never alias a dead one's ``id()`` and be mistaken for it.
    """

    def __init__(self, *caches: dict) -> None:
        self._mm: Metamodel | None = None
        self._caches = caches

    def sync(self, mm: Metamodel) -> None:
        """Clear all registered caches when `mm` is a different metamodel."""
        if mm is not self._mm:
            self._mm = mm
            for cache in self._caches:
                cache.clear()


class EntityValidator:
    """No-op base for validators: override only the hooks you need.

    Also provides a standalone ``validate(model, scope)`` so a single
    validator can be exercised on its own (tests, ad-hoc tooling) with the
    exact iteration semantics of the pipeline.

    Thread-safety: concrete validators carry per-metamodel memo caches
    (:class:`MetamodelMemo`) that are mutated during validation, so construct
    one pipeline (and thus one validator set) per request/thread — instances
    must not be shared concurrently across models with different metamodels.
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
        """Run every validator over the model (or the scoped subset).

        ``on_validator`` announces the validator roster: it is invoked once
        per validator class name, in pipeline order, BEFORE any validation
        work starts. It is NOT a per-validator progress signal — the pipeline
        interleaves all validators over a single entity sweep, so there is no
        "now running X" phase per validator.

        Scoped runs visit entities in the scope's insertion order (see
        :class:`~.scope.Scope`), so issue output is deterministic.
        """
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


def default_pipeline() -> ValidationPipeline:
    """Build the standard pipeline with a fresh instance of every validator.

    Thread-safety: the validators carry mutable per-metamodel memo caches, so
    construct one pipeline per request/thread; do not share a pipeline (or
    its validators) concurrently across models with different metamodels.
    """
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


if TYPE_CHECKING:
    # static conformance check: EntityValidator must satisfy the Validator
    # protocol (Protocol classes are structural, so a drifting signature
    # would otherwise only surface at a call site).
    _conformance_check: Validator = EntityValidator()
