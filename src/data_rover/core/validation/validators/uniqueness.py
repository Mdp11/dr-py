from __future__ import annotations

from typing import Any, Hashable

from ..containment_context import containment_parents
from ..issue import Issue, Severity
from ..scope import Scope


def _frozen(value: Any) -> Hashable:
    if isinstance(value, dict):
        return tuple(sorted((k, _frozen(v)) for k, v in value.items()))
    if isinstance(value, list):
        return tuple(_frozen(v) for v in value)
    return value


class UniquenessValidator:
    """Flags elements that share the same identity.

    Two elements are identical when they share `type_name`, their containment
    parent (or both are unowned), and either match on the type's effective
    `key` properties or, when no key is declared, match on all `properties`.
    """

    def validate(self, model, scope: Scope) -> list[Issue]:
        mm = model.metamodel
        parents = containment_parents(model)

        groups: dict[tuple[str, str | None, Hashable], list[str]] = {}
        keyed_values: dict[tuple[str, str | None, Hashable], tuple[Any, ...]] = {}
        for el in model.elements.values():
            owner = parents.get(el.id, [None])[0]
            key = mm.effective_element_key(el.type_name)
            if key is None:
                signature: Hashable = _frozen(el.properties)
            else:
                key_values = tuple(_frozen(el.properties.get(k)) for k in key)
                signature = key_values
                keyed_values[(el.type_name, owner, signature)] = key_values
            groups.setdefault((el.type_name, owner, signature), []).append(el.id)

        issues: list[Issue] = []
        for group_key, ids in groups.items():
            if len(ids) < 2:
                continue
            in_scope = [i for i in ids if scope.includes(i)]
            if len(in_scope) < 2:
                continue
            type_name = group_key[0]
            key = mm.effective_element_key(type_name)
            if key is not None:
                values = keyed_values[group_key]
                descriptor = ", ".join(f"{k}={v!r}" for k, v in zip(key, values))
            else:
                descriptor = "no key — all properties match"
            primary = in_scope[0]
            for dup in in_scope[1:]:
                issues.append(
                    Issue(
                        Severity.ERROR,
                        f"Duplicate {type_name} element {dup}: matches {primary} "
                        f"({descriptor})",
                        [dup, primary],
                    )
                )
        return issues
