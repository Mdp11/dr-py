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
            if rt is None:
                continue
            src = model.elements.get(rel.source_id)
            tgt = model.elements.get(rel.target_id)
            if src is not None and not mm.is_element_subtype(src.type_name, rt.source):
                issues.append(
                    Issue(
                        Severity.ERROR,
                        f"{rt.name}: source {src.type_name} is not a {rt.source}",
                        [rel.id],
                    )
                )
            if tgt is not None and not mm.is_element_subtype(tgt.type_name, rt.target):
                issues.append(
                    Issue(
                        Severity.ERROR,
                        f"{rt.name}: target {tgt.type_name} is not a {rt.target}",
                        [rel.id],
                    )
                )
        return issues
