from __future__ import annotations

from ..issue import Issue, Severity
from ..pipeline import EntityValidator
from ..scope import Scope


def _walk_reaches_cycle(indexes, start: str, safe: set[str]) -> bool:
    """Walk the first-parent chain from `start`; True if it reaches a cycle.

    `safe` memoizes nodes known to terminate, so a sweep over the whole model
    stays O(elements) overall instead of O(elements * depth).
    """
    seen: set[str] = set()
    node: str | None = start
    while node is not None and node not in seen and node not in safe:
        seen.add(node)
        node = indexes.first_parent(node)
    if node is None or node in safe:
        safe.update(seen)
        return False
    return True


class ContainmentValidator(EntityValidator):
    def validate_element(self, model, el) -> list[Issue]:
        # single-parent: each element contained at most once
        parents = model.indexes.parents_of(el.id)
        if len(parents) > 1:
            return [
                Issue(
                    Severity.ERROR,
                    f"Element {el.id} has {len(parents)} containment parents "
                    "(must have at most one)",
                    [el.id],
                )
            ]
        return []

    def validate_global(self, model, scope: Scope) -> list[Issue]:
        issues: list[Issue] = []
        indexes = model.indexes
        safe: set[str] = set()
        if scope.ids is None:
            # exhaustive sweep: report the first containment cycle reached from
            # any contained element (one representative issue per run, matching
            # the historical behaviour)
            for start in indexes.containment_parents:
                if _walk_reaches_cycle(indexes, start, safe):
                    issues.append(
                        Issue(
                            Severity.ERROR,
                            f"Containment cycle detected involving element {start}",
                            [start],
                        )
                    )
                    break
        else:
            # scoped run: the per-entity parent-chain walk covers exactly the
            # scoped elements (cycles entirely outside the scope are the full
            # sweep's responsibility)
            for entity_id in scope.ids:
                if entity_id not in model.elements:
                    continue
                if _walk_reaches_cycle(indexes, entity_id, safe):
                    issues.append(
                        Issue(
                            Severity.ERROR,
                            f"Containment cycle detected involving element {entity_id}",
                            [entity_id],
                        )
                    )
        return issues
