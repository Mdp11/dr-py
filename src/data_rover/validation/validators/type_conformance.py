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
        return (isinstance(value, (int, float)) and not isinstance(value, bool))
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
            for name, value in el.properties.items():
                pdef = defs.get(name)
                if pdef is None or value is None:
                    continue
                values = value if isinstance(value, list) else [value]
                for item in values:
                    if not value_conforms(item, pdef.datatype, mm):
                        issues.append(Issue(
                            Severity.ERROR,
                            f"{el.type_name}.{name}: value {item!r} is not a "
                            f"valid {pdef.datatype}",
                            [el.id],
                        ))
        return issues
