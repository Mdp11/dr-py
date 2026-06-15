from __future__ import annotations

import datetime

from ...metamodel.schema import FLOAT_INFINITIES, Metamodel
from ..issue import Issue, Severity
from ..pipeline import EntityValidator, MetamodelMemo


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
        if isinstance(value, bool):
            return False
        if isinstance(value, (int, float)):
            return True
        # the infinite floats travel as canonical string tokens (JSON has no
        # infinity literal); accept those alongside real numbers
        return value in FLOAT_INFINITIES
    if datatype == "date":
        if isinstance(value, datetime.date):
            return True
        # JSON has no native date type, so accept ISO-8601 strings as a
        # well-defined wire format for transported model files.
        if isinstance(value, str):
            try:
                datetime.date.fromisoformat(value)
            except ValueError:
                return False
            return True
        return False
    return False


class TypeConformanceValidator(EntityValidator):
    def __init__(self) -> None:
        # per-type memo of {prop name: (datatype, is element reference)},
        # keeping the per-entity hot path free of metamodel lookups (which go
        # through pydantic private-attribute access); invalidation is handled
        # by MetamodelMemo (see its docstring)
        self._element_defs: dict[str, dict[str, tuple[str, bool]]] = {}
        self._relationship_defs: dict[str, dict[str, tuple[str, bool]]] = {}
        self._memo = MetamodelMemo(self._element_defs, self._relationship_defs)

    def _defs(
        self, mm: Metamodel, type_name: str, of_element: bool
    ) -> dict[str, tuple[str, bool]]:
        self._memo.sync(mm)
        cache = self._element_defs if of_element else self._relationship_defs
        defs = cache.get(type_name)
        if defs is None:
            props = (
                mm.effective_element_properties(type_name)
                if of_element
                else mm.effective_relationship_properties(type_name)
            )
            defs = {p.name: (p.datatype, mm.is_element_type(p.datatype)) for p in props}
            cache[type_name] = defs
        return defs

    def validate_element(self, model, el) -> list[Issue]:
        defs = self._defs(model.metamodel, el.type_name, of_element=True)
        return self._check(el.type_name, el.id, defs, el.properties, model)

    def validate_relationship(self, model, rel) -> list[Issue]:
        defs = self._defs(model.metamodel, rel.type_name, of_element=False)
        return self._check(rel.type_name, rel.id, defs, rel.properties, model)

    def _check(self, type_name, owner_id, defs, properties, model) -> list[Issue]:
        out: list[Issue] = []
        mm = model.metamodel
        for name, value in properties.items():
            pdef = defs.get(name)
            if pdef is None or value is None:
                continue
            datatype, is_reference = pdef
            values = value if isinstance(value, list) else [value]
            if is_reference:
                for item in values:
                    out.extend(
                        self._reference_issues(
                            type_name, owner_id, name, item, datatype, model
                        )
                    )
            else:
                for item in values:
                    if not value_conforms(item, datatype, mm):
                        out.append(
                            Issue(
                                Severity.ERROR,
                                f"{type_name}.{name}: value {item!r} is not a "
                                f"valid {datatype}",
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
                    f"{type_name}.{prop_name}: reference {item!r} points to no element",
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
