from __future__ import annotations

import re

from ...metamodel.schema import Metamodel, PropertyDef
from ..issue import Issue, Severity
from ..pipeline import EntityValidator, MetamodelMemo


class FacetsValidator(EntityValidator):
    def __init__(self) -> None:
        # per-type memo of the properties that actually carry a facet (most
        # carry none, so most entities are skipped with one dict lookup);
        # invalidation is handled by MetamodelMemo (see its docstring)
        self._element_defs: dict[str, dict[str, PropertyDef]] = {}
        self._relationship_defs: dict[str, dict[str, PropertyDef]] = {}
        self._memo = MetamodelMemo(self._element_defs, self._relationship_defs)

    def _defs(
        self, mm: Metamodel, type_name: str, of_element: bool
    ) -> dict[str, PropertyDef]:
        self._memo.sync(mm)
        cache = self._element_defs if of_element else self._relationship_defs
        defs = cache.get(type_name)
        if defs is None:
            props = (
                mm.effective_element_properties(type_name)
                if of_element
                else mm.effective_relationship_properties(type_name)
            )
            defs = {
                p.name: p
                for p in props
                if p.min is not None
                or p.max is not None
                or p.pattern is not None
                or p.max_length is not None
            }
            cache[type_name] = defs
        return defs

    def validate_element(self, model, el) -> list[Issue]:
        defs = self._defs(model.metamodel, el.type_name, of_element=True)
        if not defs:
            return []
        return self._check_properties(el.id, defs, el.properties)

    def validate_relationship(self, model, rel) -> list[Issue]:
        defs = self._defs(model.metamodel, rel.type_name, of_element=False)
        if not defs:
            return []
        return self._check_properties(rel.id, defs, rel.properties)

    def _check_properties(self, owner_id, defs, properties) -> list[Issue]:
        out: list[Issue] = []
        for name, pdef in defs.items():
            value = properties.get(name)
            if value is None:
                continue
            values = value if isinstance(value, list) else [value]
            for item in values:
                out.extend(self._check(owner_id, name, pdef, item))
        return out

    def _check(self, eid, name, pdef, item) -> list[Issue]:
        out: list[Issue] = []
        if isinstance(item, (int, float)) and not isinstance(item, bool):
            if pdef.min is not None and item < pdef.min:
                out.append(
                    Issue(Severity.ERROR, f"{name}: {item} below min {pdef.min}", [eid])
                )
            if pdef.max is not None and item > pdef.max:
                out.append(
                    Issue(Severity.ERROR, f"{name}: {item} above max {pdef.max}", [eid])
                )
        if isinstance(item, str):
            if pdef.pattern is not None and not re.fullmatch(pdef.pattern, item):
                out.append(
                    Issue(
                        Severity.ERROR,
                        f"{name}: {item!r} does not match pattern {pdef.pattern!r}",
                        [eid],
                    )
                )
            if pdef.max_length is not None and len(item) > pdef.max_length:
                out.append(
                    Issue(
                        Severity.ERROR,
                        f"{name}: length {len(item)} exceeds "
                        f"max_length {pdef.max_length}",
                        [eid],
                    )
                )
        return out
