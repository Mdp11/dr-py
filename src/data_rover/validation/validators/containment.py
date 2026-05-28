from __future__ import annotations

from ..issue import Issue, Severity
from ..scope import Scope


class ContainmentValidator:
    def validate(self, model, scope: Scope) -> list[Issue]:
        issues: list[Issue] = []
        mm = model.metamodel
        containment_rels = [
            r for r in model.relationships.values() if mm.is_containment(r.type_name)
        ]

        # single-parent: each target contained at most once
        parents: dict[str, list[str]] = {}
        for r in containment_rels:
            parents.setdefault(r.target_id, []).append(r.source_id)
        for target_id, srcs in parents.items():
            if len(srcs) > 1 and scope.includes(target_id):
                issues.append(
                    Issue(
                        Severity.ERROR,
                        f"Element {target_id} has {len(srcs)} containment parents "
                        "(must have at most one)",
                        [target_id],
                    )
                )

        # acyclic: detect a cycle in child -> parent edges
        parent_of = {t: s[0] for t, s in parents.items()}
        for start in parent_of:
            seen: set[str] = set()
            node: str | None = start
            while node is not None and node not in seen:
                seen.add(node)
                node = parent_of.get(node)
            if node is not None and scope.includes(start):
                issues.append(
                    Issue(
                        Severity.ERROR,
                        f"Containment cycle detected involving element {start}",
                        [start],
                    )
                )
                break

        return issues
