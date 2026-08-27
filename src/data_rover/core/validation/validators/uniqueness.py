from __future__ import annotations

from ...model.indexes import UniqKey
from ..issue import Issue, Severity
from ..pipeline import EntityValidator
from ..scope import Scope


class UniquenessValidator(EntityValidator):
    """Flags elements that share the same identity.

    Two elements are identical when they share `type_name`, their containment
    parent (or both are unowned), and either match on the type's effective
    `key` (properties and, for ``out:``/``in:`` key entries, the multiset of
    connected element ids) or, when no key is declared, match on all
    ``properties``.

    The grouping itself is maintained incrementally by the model's
    :class:`~data_rover.core.model.indexes.IndexSet`; this validator only
    reads ``uniq_groups`` / ``uniq_key_of`` / ``duplicate_keys`` and
    ``element_order``. All work happens in :meth:`validate_global` (it needs
    the scope to avoid double-reporting), keyed on each duplicate group's
    *primary* member — the group member that comes first in
    ``model.elements`` insertion order, read off ``element_order`` so no run
    ever enumerates the model.
    """

    check_name = "uniqueness"

    def validate_global(self, model, scope: Scope) -> list[Issue]:
        indexes = model.indexes
        if not indexes.duplicate_keys:
            return []

        # element insertion order decides the primary of each group and
        # keeps the report deterministic
        order = indexes.element_order
        issues: list[Issue] = []
        if scope.ids is None:
            ordered_keys = sorted(
                indexes.duplicate_keys,
                key=lambda k: min(order[i] for i in indexes.uniq_groups[k]),
            )
            for group_key in ordered_keys:
                ids = sorted(indexes.uniq_groups[group_key], key=order.__getitem__)
                primary = ids[0]
                for dup in ids[1:]:
                    issues.append(self._issue(model, group_key, dup, primary))
        else:
            for entity_id in scope.ids:
                group_key = indexes.uniq_key_of.get(entity_id)
                if group_key is None or group_key not in indexes.duplicate_keys:
                    continue
                primary = min(indexes.uniq_groups[group_key], key=order.__getitem__)
                if entity_id != primary:
                    issues.append(self._issue(model, group_key, entity_id, primary))
        return issues

    def _issue(self, model, group_key: UniqKey, dup: str, primary: str) -> Issue:
        type_name = group_key[0]
        spec = model.metamodel.effective_element_key_spec(type_name)
        if spec is None:
            descriptor = "no key — all properties match"
        else:
            signature = group_key[2]
            assert isinstance(signature, tuple)  # keyed: (prop_values, rel_values)
            prop_values, rel_values = signature
            parts = [f"{k}={v!r}" for k, v in zip(spec.properties, prop_values)]
            for kr, endpoints in zip(spec.relationships, rel_values):
                parts.append(f"{kr.direction}:{kr.rel_type}→[{', '.join(endpoints)}]")
            descriptor = ", ".join(parts)
        return Issue(
            Severity.ERROR,
            f"Duplicate {type_name} element {dup}: matches {primary} ({descriptor})",
            [dup, primary],
        )
