"""What a metamodel rebind checks on the head rows.

A rebind cannot be checked O(batch): the new metamodel decides what every row
means. These checks read the rows in ``seq`` pages and set-wise, so the memory
they hold is a page, plus the containment relationships as id pairs for the
cycle walk. The thin server cannot hold a row its applier does not understand,
so a rebind that leaves one is refused.
"""

from __future__ import annotations

from collections.abc import Collection

from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session as DbSession

from data_rover.core.metamodel.schema import Metamodel

from .db_models import ElementRow, EntityRefRow, RelationshipRow
from .serialize import parse_model_json

#: rows read per page
PAGE = 1000
#: ids a refusal names
LIMIT = 5


def containment_types(metamodel: Metamodel) -> list[str]:
    """The names of the containment relationship types, sorted."""
    return sorted(
        t.name for t in metamodel.relationships if metamodel.is_containment(t.name)
    )


def rebind_refusals(
    db: DbSession, project_id: str, metamodel: Metamodel, *, limit: int = LIMIT
) -> tuple[int, list[str]]:
    """How many entities ``metamodel`` cannot hold, and the first ``limit`` of
    their ids (elements first, then relationships, each in ``seq`` order). An
    entity is refused when its type is unknown, an element type is abstract, or
    a property it holds is not declared for its type."""
    count = 0
    first: list[str] = []

    for table, is_element in ((ElementRow, True), (RelationshipRow, False)):
        last = -1
        while True:
            page = db.execute(
                select(table.id, table.type_name, table.properties, table.seq)
                .where(table.project_id == project_id, table.seq > last)
                .order_by(table.seq)
                .limit(PAGE)
            ).all()
            if not page:
                break
            for entity_id, type_name, text, _seq in page:
                if is_element:
                    et = metamodel.element_type(type_name)
                    refused = et is None or et.abstract
                    declared = metamodel.effective_element_property_names(type_name)
                else:
                    refused = metamodel.relationship_type(type_name) is None
                    declared = metamodel.effective_relationship_property_names(
                        type_name
                    )
                if not refused and text != "{}":
                    refused = not parse_model_json(text).keys() <= declared
                if refused:
                    count += 1
                    if len(first) < limit:
                        first.append(entity_id)
            last = page[-1].seq
    return count, first


def containment_violations(
    db: DbSession,
    project_id: str,
    containment_types: Collection[str],
    *,
    limit: int = LIMIT,
) -> list[str]:
    """Up to ``limit`` ids of elements the relationships of ``containment_types``
    leave in a state no model may be in: first the elements with two containment
    parents, and, when there are none, an element on each containment cycle."""
    types = sorted(containment_types)
    if not types:
        return []
    in_types = (
        RelationshipRow.project_id == project_id,
        RelationshipRow.type_name.in_(types),
    )
    second_parents = list(
        db.execute(
            select(RelationshipRow.target_id)
            .where(*in_types)
            .group_by(RelationshipRow.target_id)
            .having(func.count() > 1)
            .order_by(RelationshipRow.target_id)
            .limit(limit)
        ).scalars()
    )
    if second_parents:
        return second_parents

    # every element now has at most one parent: the parent chains are a
    # functional graph, and a cycle is a chain that meets itself
    parent: dict[str, str] = {}
    last = -1
    while True:
        page = db.execute(
            select(
                RelationshipRow.source_id,
                RelationshipRow.target_id,
                RelationshipRow.seq,
            )
            .where(*in_types, RelationshipRow.seq > last)
            .order_by(RelationshipRow.seq)
            .limit(PAGE)
        ).all()
        if not page:
            break
        for source, target, _seq in page:
            parent[target] = source
        last = page[-1].seq

    cyclic: list[str] = []
    done: set[str] = set()
    for start in parent:
        if start in done:
            continue
        path: set[str] = set()
        node: str | None = start
        while node is not None and node not in done:
            if node in path:
                cyclic.append(node)
                break
            path.add(node)
            node = parent.get(node)
        done |= path
        if len(cyclic) >= limit:
            break
    return cyclic


def dangling_references(
    db: DbSession, project_id: str, *, limit: int = LIMIT
) -> list[str]:
    """Up to ``limit`` ids of the entities holding an element-valued reference
    to no element, in id order. Read after ``rebuild_refs``: which properties
    are references depends on the metamodel."""
    return list(
        db.execute(
            select(EntityRefRow.referencer_id)
            .where(
                EntityRefRow.project_id == project_id,
                ~exists().where(
                    ElementRow.project_id == EntityRefRow.project_id,
                    ElementRow.id == EntityRefRow.target_id,
                ),
            )
            .distinct()
            .order_by(EntityRefRow.referencer_id)
            .limit(limit)
        ).scalars()
    )
