from __future__ import annotations

from ...metamodel.multiplicity import Multiplicity
from ...metamodel.schema import EndConstraint, Metamodel
from ..issue import Issue, Severity
from ..pipeline import EntityValidator, MetamodelMemo

# (property name, raw multiplicity spec, parsed multiplicity)
_PropMult = tuple[str, str, Multiplicity]


def _count(value) -> int:
    if value is None:
        return 0
    if isinstance(value, list):
        return len(value)
    return 1


class MultiplicityValidator(EntityValidator):
    def __init__(self) -> None:
        # per-type memos keeping the per-entity hot path free of metamodel
        # lookups (which go through pydantic private-attribute access);
        # invalidation is handled by MetamodelMemo (see its docstring)
        self._element_mults: dict[str, tuple[_PropMult, ...]] = {}
        self._relationship_mults: dict[str, tuple[_PropMult, ...]] = {}
        self._end_constraints: dict[str, tuple[EndConstraint, ...]] = {}
        self._memo = MetamodelMemo(
            self._element_mults, self._relationship_mults, self._end_constraints
        )

    def _prop_mults(
        self, mm: Metamodel, type_name: str, of_element: bool
    ) -> tuple[_PropMult, ...]:
        cache = self._element_mults if of_element else self._relationship_mults
        mults = cache.get(type_name)
        if mults is None:
            props = (
                mm.effective_element_properties(type_name)
                if of_element
                else mm.effective_relationship_properties(type_name)
            )
            # "0..*" can never be violated; drop it from the hot path
            mults = tuple(
                (p.name, p.multiplicity, mult)
                for p in props
                if (mult := Multiplicity.parse(p.multiplicity)).lower > 0
                or mult.upper is not None
            )
            cache[type_name] = mults
        return mults

    def validate_element(self, model, el) -> list[Issue]:
        issues: list[Issue] = []
        mm = model.metamodel
        self._memo.sync(mm)
        # property multiplicity
        properties = el.properties
        for name, spec, mult in self._prop_mults(mm, el.type_name, of_element=True):
            count = _count(properties.get(name))
            if not mult.count_ok(count):
                issues.append(
                    Issue(
                        Severity.ERROR,
                        f"{el.type_name}.{name}: {count} value(s) violates "
                        f"multiplicity {spec!r}",
                        [el.id],
                    )
                )
        # relationship-end multiplicity, via precomputed per-type constraints
        # and the model's incremental degree counters
        constraints = self._end_constraints.get(el.type_name)
        if constraints is None:
            constraints = tuple(mm.end_constraints(el.type_name))
            self._end_constraints[el.type_name] = constraints
        if constraints:
            indexes = model.indexes
            for ec in constraints:
                if ec.end == "target":
                    out = indexes.count_out(el.id, ec.rel_type_name)
                    if not ec.multiplicity.count_ok(out):
                        rt = mm.relationship_type(ec.rel_type_name)
                        assert rt is not None  # constraints come from the mm
                        issues.append(
                            Issue(
                                Severity.ERROR,
                                f"{ec.rel_type_name}: element {el.id} has {out} "
                                f"target(s), violates target multiplicity "
                                f"{rt.target_multiplicity!r}",
                                [el.id],
                            )
                        )
                else:
                    inc = indexes.count_in(el.id, ec.rel_type_name)
                    if not ec.multiplicity.count_ok(inc):
                        rt = mm.relationship_type(ec.rel_type_name)
                        assert rt is not None
                        issues.append(
                            Issue(
                                Severity.ERROR,
                                f"{ec.rel_type_name}: element {el.id} has {inc} "
                                f"source(s), violates source multiplicity "
                                f"{rt.source_multiplicity!r}",
                                [el.id],
                            )
                        )
        return issues

    def validate_relationship(self, model, rel) -> list[Issue]:
        issues: list[Issue] = []
        mm = model.metamodel
        self._memo.sync(mm)
        properties = rel.properties
        for name, spec, mult in self._prop_mults(mm, rel.type_name, of_element=False):
            count = _count(properties.get(name))
            if not mult.count_ok(count):
                issues.append(
                    Issue(
                        Severity.ERROR,
                        f"{rel.type_name}.{name}: {count} value(s) violates "
                        f"multiplicity {spec!r}",
                        [rel.id],
                    )
                )
        return issues
