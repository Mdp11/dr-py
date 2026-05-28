from __future__ import annotations

import re

from ..issue import Issue, Severity
from ..scope import Scope


class FacetsValidator:
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
                    issues.extend(self._check(el.id, name, pdef, item))
        return issues

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
