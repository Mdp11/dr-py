"""The commit's structural gate.

A commit lands unless it corrupts the model graph. Everything else the
validators report (conformance, rules) is the engine's to answer, and the
client reports the result with the commit.
"""

from __future__ import annotations

from collections.abc import Iterable

from data_rover.core.model.model import Model
from data_rover.core.validation.issue import Issue, IssueCategory
from data_rover.core.validation.pipeline import ValidationPipeline
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.validators.containment import ContainmentValidator
from data_rover.core.validation.validators.type_conformance import (
    TypeConformanceValidator,
)


def structural_blockers(model: Model, ids: Iterable[str]) -> list[Issue]:
    """STRUCTURAL issues (dangling element reference, second containment
    parent, containment cycle) over these ids."""
    issues = ValidationPipeline(
        [TypeConformanceValidator(), ContainmentValidator()]
    ).validate(model, Scope(ids))
    return [i for i in issues if i.category is IssueCategory.STRUCTURAL]
