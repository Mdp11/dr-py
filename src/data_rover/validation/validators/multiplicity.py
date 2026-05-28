from __future__ import annotations

from ...metamodel.multiplicity import Multiplicity
from ..issue import Issue, Severity
from ..scope import Scope


def _count(value) -> int:
    if value is None:
        return 0
    if isinstance(value, list):
        return len(value)
    return 1


class MultiplicityValidator:
    def validate(self, model, scope: Scope) -> list[Issue]:
        issues: list[Issue] = []
        mm = model.metamodel
        # property multiplicity
        for el in model.elements.values():
            if not scope.includes(el.id):
                continue
            for pdef in mm.effective_element_properties(el.type_name):
                mult = Multiplicity.parse(pdef.multiplicity)
                count = _count(el.properties.get(pdef.name))
                if not mult.count_ok(count):
                    issues.append(
                        Issue(
                            Severity.ERROR,
                            f"{el.type_name}.{pdef.name}: {count} value(s) violates "
                            f"multiplicity {pdef.multiplicity!r}",
                            [el.id],
                        )
                    )
        # relationship-end multiplicity (target end: targets per source)
        for rt in mm.relationships:
            if rt.abstract:
                continue
            target_mult = Multiplicity.parse(rt.target_multiplicity)
            source_mult = Multiplicity.parse(rt.source_multiplicity)
            for el in model.elements.values():
                if not scope.includes(el.id):
                    continue
                if mm.is_element_subtype(el.type_name, rt.source):
                    out = len(
                        [
                            r
                            for r in model.relationships.values()
                            if r.type_name == rt.name and r.source_id == el.id
                        ]
                    )
                    if not target_mult.count_ok(out):
                        issues.append(
                            Issue(
                                Severity.ERROR,
                                f"{rt.name}: element {el.id} has {out} target(s), "
                                f"violates target multiplicity "
                                f"{rt.target_multiplicity!r}",
                                [el.id],
                            )
                        )
                if mm.is_element_subtype(el.type_name, rt.target):
                    inc = len(
                        [
                            r
                            for r in model.relationships.values()
                            if r.type_name == rt.name and r.target_id == el.id
                        ]
                    )
                    if not source_mult.count_ok(inc):
                        issues.append(
                            Issue(
                                Severity.ERROR,
                                f"{rt.name}: element {el.id} has {inc} source(s), "
                                f"violates source multiplicity "
                                f"{rt.source_multiplicity!r}",
                                [el.id],
                            )
                        )
        return issues
