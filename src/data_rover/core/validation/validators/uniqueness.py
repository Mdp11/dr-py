from __future__ import annotations

from ...model.indexes import UniqKey
from ..issue import Issue, Severity
from ..pipeline import EntityValidator
from ..scope import Scope


class UniquenessValidator(EntityValidator):
    """Flags elements that share the same identity.

    Two elements are identical when they share `type_name`, their containment
    parent (or both are unowned), and either match on the type's effective
    `key` properties or, when no key is declared, match on all `properties`.

    The grouping itself is maintained incrementally by the model's
    :class:`~data_rover.core.model.indexes.IndexSet`; this validator only
    reads ``uniq_groups`` / ``uniq_key_of`` / ``duplicate_keys``. All work
    happens in :meth:`validate_global` (it needs the scope to avoid
    double-reporting), keyed on each duplicate group's *primary* member —
    the group member that comes first in ``model.elements`` insertion order.
    """

    def validate_global(self, model, scope: Scope) -> list[Issue]:
        indexes = model.indexes
        if not indexes.duplicate_keys:
            return []

        issues: list[Issue] = []
        if scope.ids is None:
            # element insertion order decides the primary of each group and
            # keeps the report deterministic
            position = {eid: i for i, eid in enumerate(model.elements)}
            ordered_keys = sorted(
                indexes.duplicate_keys,
                key=lambda k: min(position[i] for i in indexes.uniq_groups[k]),
            )
            for group_key in ordered_keys:
                ids = sorted(indexes.uniq_groups[group_key], key=position.__getitem__)
                primary = ids[0]
                for dup in ids[1:]:
                    issues.append(self._issue(model, group_key, dup, primary))
        else:
            position = None
            for entity_id in scope.ids:
                group_key = indexes.uniq_key_of.get(entity_id)
                if group_key is None or group_key not in indexes.duplicate_keys:
                    continue
                if position is None:
                    # built at most once per scoped run, and only when the
                    # scope actually touches a duplicate group
                    position = {eid: i for i, eid in enumerate(model.elements)}
                ids = sorted(indexes.uniq_groups[group_key], key=position.__getitem__)
                primary = ids[0]
                if entity_id != primary:
                    issues.append(self._issue(model, group_key, entity_id, primary))
        return issues

    def _issue(self, model, group_key: UniqKey, dup: str, primary: str) -> Issue:
        type_name = group_key[0]
        key = model.metamodel.effective_element_key(type_name)
        if key is not None:
            values = group_key[2]
            assert isinstance(values, tuple)  # keyed signature is a value tuple
            descriptor = ", ".join(f"{k}={v!r}" for k, v in zip(key, values))
        else:
            descriptor = "no key — all properties match"
        return Issue(
            Severity.ERROR,
            f"Duplicate {type_name} element {dup}: matches {primary} ({descriptor})",
            [dup, primary],
        )
