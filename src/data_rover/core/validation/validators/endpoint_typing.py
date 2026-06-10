from __future__ import annotations

from ...metamodel.schema import Metamodel
from ..issue import Issue, Severity
from ..pipeline import EntityValidator, MetamodelMemo

# (source ok, target ok, (source, target) pair matches one mapping)
_Decision = tuple[bool, bool, bool]


class EndpointTypingValidator(EntityValidator):
    def __init__(self) -> None:
        # decision memo per (rel type, source type, target type) — the number
        # of distinct combinations is metamodel-sized, so per-relationship
        # work collapses to a dict lookup; invalidation is handled by
        # MetamodelMemo (see its docstring)
        self._decisions: dict[tuple[str, str | None, str | None], _Decision] = {}
        self._memo = MetamodelMemo(self._decisions)

    def validate_relationship(self, model, rel) -> list[Issue]:
        mm = model.metamodel
        self._memo.sync(mm)
        src = model.elements.get(rel.source_id)
        tgt = model.elements.get(rel.target_id)
        src_type = None if src is None else src.type_name
        tgt_type = None if tgt is None else tgt.type_name
        key = (rel.type_name, src_type, tgt_type)
        decision = self._decisions.get(key)
        if decision is None:
            decision = self._decide(mm, rel.type_name, src_type, tgt_type)
            self._decisions[key] = decision
        src_ok, tgt_ok, pair_ok = decision
        if src_ok and tgt_ok and pair_ok:
            return []

        issues: list[Issue] = []
        rt = mm.relationship_type(rel.type_name)
        assert rt is not None  # a failing decision implies a known type
        if not src_ok:
            allowed = ", ".join(sorted({m.source for m in rt.mappings}))
            issues.append(
                Issue(
                    Severity.ERROR,
                    f"{rt.name}: source {src_type} is not one of [{allowed}]",
                    [rel.id],
                )
            )
        if not tgt_ok:
            allowed = ", ".join(sorted({m.target for m in rt.mappings}))
            issues.append(
                Issue(
                    Severity.ERROR,
                    f"{rt.name}: target {tgt_type} is not one of [{allowed}]",
                    [rel.id],
                )
            )
        if src_ok and tgt_ok and not pair_ok:
            issues.append(
                Issue(
                    Severity.ERROR,
                    f"{rt.name}: ({src_type}, {tgt_type}) "
                    f"matches no declared (source, target) mapping",
                    [rel.id],
                )
            )
        return issues

    @staticmethod
    def _decide(
        mm: Metamodel, rel_type: str, src_type: str | None, tgt_type: str | None
    ) -> _Decision:
        rt = mm.relationship_type(rel_type)
        if rt is None or not rt.mappings:
            return (True, True, True)
        # the endpoints are valid if they conform to ANY declared mapping
        # (subtype-aware on both ends).
        src_ok = src_type is None or any(
            mm.is_element_subtype(src_type, m.source) for m in rt.mappings
        )
        tgt_ok = tgt_type is None or any(
            mm.is_element_subtype(tgt_type, m.target) for m in rt.mappings
        )
        # but the actual (source, target) pair must match one single mapping
        pair_ok = (src_type is None or tgt_type is None) or any(
            mm.is_element_subtype(src_type, m.source)
            and mm.is_element_subtype(tgt_type, m.target)
            for m in rt.mappings
        )
        return (src_ok, tgt_ok, pair_ok)
