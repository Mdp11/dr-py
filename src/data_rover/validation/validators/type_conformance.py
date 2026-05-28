from __future__ import annotations

import datetime

from ...metamodel.schema import Metamodel
from ..issue import Issue, Severity
from ..scope import Scope


def value_conforms(value, datatype: str, metamodel: Metamodel) -> bool:
    if datatype in metamodel.enums:
        return value in metamodel.enums[datatype]
    if datatype == "string":
        return isinstance(value, str)
    if datatype == "boolean":
        return isinstance(value, bool)
    if datatype == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if datatype == "float":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if datatype == "date":
        return isinstance(value, datetime.date)
    return False


class TypeConformanceValidator:
    def validate(self, model, scope: Scope) -> list[Issue]:
        issues: list[Issue] = []
        mm = model.metamodel
        for el in model.elements.values():
            if not scope.includes(el.id):
                continue
            defs = {p.name: p for p in mm.effective_element_properties(el.type_name)}
            issues.extend(self._check(el.type_name, el.id, defs, el.properties, model))
        for rel in model.relationships.values():
            if not scope.includes(rel.id):
                continue
            defs = {
                p.name: p for p in mm.effective_relationship_properties(rel.type_name)
            }
            issues.extend(
                self._check(rel.type_name, rel.id, defs, rel.properties, model)
            )
        return issues

    def _check(self, type_name, owner_id, defs, properties, model) -> list[Issue]:
        out: list[Issue] = []
        mm = model.metamodel
        for name, value in properties.items():
            pdef = defs.get(name)
            if pdef is None or value is None:
                continue
            values = value if isinstance(value, list) else [value]
            if mm.is_element_type(pdef.datatype):
                for item in values:
                    out.extend(
                        self._reference_issues(
                            type_name, owner_id, name, item, pdef.datatype, model
                        )
                    )
            else:
                for item in values:
                    if not value_conforms(item, pdef.datatype, mm):
                        out.append(
                            Issue(
                                Severity.ERROR,
                                f"{type_name}.{name}: value {item!r} is not a "
                                f"valid {pdef.datatype}",
                                [owner_id],
                            )
                        )
        return out

    def _reference_issues(
        self, type_name, owner_id, prop_name, item, declared, model
    ) -> list[Issue]:
        if not isinstance(item, str):
            return [
                Issue(
                    Severity.ERROR,
                    f"{type_name}.{prop_name}: value {item!r} is not a "
                    f"valid {declared} reference",
                    [owner_id],
                )
            ]
        target = model.elements.get(item)
        if target is None:
            return [
                Issue(
                    Severity.ERROR,
                    f"{type_name}.{prop_name}: reference {item!r} points to "
                    f"no element",
                    [owner_id],
                )
            ]
        mm = model.metamodel
        if target.type_name != declared and not mm.is_element_subtype(
            target.type_name, declared
        ):
            return [
                Issue(
                    Severity.ERROR,
                    f"{type_name}.{prop_name}: reference {item!r} is "
                    f"{target.type_name}, expected {declared} or subtype",
                    [owner_id],
                )
            ]
        return []
