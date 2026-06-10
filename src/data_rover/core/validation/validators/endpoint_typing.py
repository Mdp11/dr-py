from __future__ import annotations

from ..issue import Issue, Severity
from ..scope import Scope


class EndpointTypingValidator:
    def validate(self, model, scope: Scope) -> list[Issue]:
        issues: list[Issue] = []
        mm = model.metamodel
        for rel in model.relationships.values():
            if not scope.includes(rel.id):
                continue
            rt = mm.relationship_type(rel.type_name)
            if rt is None or not rt.mappings:
                continue
            src = model.elements.get(rel.source_id)
            tgt = model.elements.get(rel.target_id)
            # the endpoints are valid if they conform to ANY declared mapping
            # (subtype-aware on both ends).
            src_ok = src is None or any(
                mm.is_element_subtype(src.type_name, m.source) for m in rt.mappings
            )
            tgt_ok = tgt is None or any(
                mm.is_element_subtype(tgt.type_name, m.target) for m in rt.mappings
            )
            # but the actual (source, target) pair must match one single mapping
            pair_ok = (src is None or tgt is None) or any(
                mm.is_element_subtype(src.type_name, m.source)
                and mm.is_element_subtype(tgt.type_name, m.target)
                for m in rt.mappings
            )
            if not src_ok:
                allowed = ", ".join(sorted({m.source for m in rt.mappings}))
                issues.append(
                    Issue(
                        Severity.ERROR,
                        f"{rt.name}: source {src.type_name} is not one of [{allowed}]",
                        [rel.id],
                    )
                )
            if not tgt_ok:
                allowed = ", ".join(sorted({m.target for m in rt.mappings}))
                issues.append(
                    Issue(
                        Severity.ERROR,
                        f"{rt.name}: target {tgt.type_name} is not one of [{allowed}]",
                        [rel.id],
                    )
                )
            if src_ok and tgt_ok and not pair_ok:
                issues.append(
                    Issue(
                        Severity.ERROR,
                        f"{rt.name}: ({src.type_name}, {tgt.type_name}) "
                        f"matches no declared (source, target) mapping",
                        [rel.id],
                    )
                )
        return issues
