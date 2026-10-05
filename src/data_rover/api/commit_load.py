"""The partial model a commit is checked on, and the rounds that load it.

A commit never reads the model whole. ``plan_load`` names, from the batch alone,
the rows the check needs and reads them from the head tables in indexed queries;
``load_and_apply`` builds a partial ``Model`` from them (``core/model/partial.py``)
and runs the batch on it. A read the plan did not foresee raises ``NotLoaded``;
the whole batch then runs again on a fresh partial model that also holds what was
missing, never on the one that failed. ``MAX_ROUNDS`` bounds the loop: reaching
it is a bug in the plan.

What the plan loads, for the ids a batch names (update and delete targets,
relationship ends, id hints, and the ids held by element-valued properties):

- every named id's row, or its place in ``absent`` when neither table holds it
  (temp ids included: a lookup of one that nothing created is the same 422 the
  full model gives);
- for each delete root (a ``delete_element`` target, an id a round missed, and
  the target of every containment relationship the batch creates below an
  element it deletes):
  its containment subtree, every relationship incident to the subtree with that
  relationship's other end, and the referencers of the subtree's ids and of
  those relationships, with the subtree complete in edges and in referencers;
- for each referencer an id hint or a restore brings back: its referencers,
  complete;
- for each element the structural check can judge (an update target, a
  relationship end, a referencer): its containment parents and its ancestor
  chain, each complete in parents, and the targets of its references.

A hinted create has two names, its ``temp_id`` and its hint, and later ops may
use either; the plan counts both as the one element.

The relationships a batch deletes are not followed when the plan works out which
referencers certainly go with a delete (a subtree the batch detaches first
survives). Past ``MAX_SKIPPED`` of them the plan stops excluding and subtracts
only the delete roots, which judges more referencers, never fewer.

After a miss the plan is ``thorough``: it also judges the referencers inside the
deleted subtree, and judges nothing it loaded for other reasons, so a retry
loads about what the first round did.

The deleted subtree, the referencers and the ancestors are what the check reads
beyond the entities it names; the rest is the batch's own.
"""

from __future__ import annotations

import logging
from collections import Counter
from collections.abc import Callable, Collection, Iterable, Sequence
from dataclasses import dataclass, field
from itertools import batched
from typing import Any, assert_never

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import or_, select
from sqlalchemy.orm import Session as DbSession

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.model.partial import NotLoaded, PartialRows, build_partial_model

from .db_models import ElementRow, EntityRefRow, RelationshipRow
from .head import CHUNK, ref_props, refs_of
from .routes.ops import _apply_batch, _BatchResult
from .schemas import (
    CreateElementOp,
    CreateRelationshipOp,
    DeleteElementOp,
    DeleteRelationshipOp,
    ModelOpIn,
    TEMP_ID_PREFIX,
    UpdateElementOp,
    UpdateRelationshipOp,
)
from .serialize import parse_model_json

logger = logging.getLogger(__name__)

#: the most times one commit loads and runs its batch
MAX_ROUNDS = 8
#: deleted relationships past which the plan stops excluding them from the
#: deleted subtree (it then judges more, never less)
MAX_SKIPPED = 5000


class Refused(Exception):
    """A check run between the rounds' steps refuses the commit: ``response`` is
    the answer. Not an error, and never a reason to load more rows."""

    def __init__(self, response: JSONResponse) -> None:
        super().__init__("refused")
        self.response = response


# --- the walks ----------------------------------------------------------------


def _walk(
    db: DbSession,
    project_id: str,
    starts: Collection[str],
    containment_types: Collection[str],
    *,
    down: bool,
    skip: Collection[str] = (),
) -> set[str]:
    """The elements reached from ``starts`` along containment relationships, the
    starts that exist included: ``down`` follows source to target, otherwise
    target to source. ``UNION`` drops a row it already holds, so a containment
    cycle ends the walk. The relationships in ``skip`` are not followed."""
    types = sorted(containment_types)
    near, far = (
        (RelationshipRow.source_id, RelationshipRow.target_id)
        if down
        else (RelationshipRow.target_id, RelationshipRow.source_id)
    )
    found: set[str] = set()
    for chunk in batched(sorted(starts), CHUNK):
        walk = (
            select(ElementRow.id.label("id"))
            .where(ElementRow.project_id == project_id, ElementRow.id.in_(chunk))
            .cte("walk", recursive=True)
        )
        if types:
            walk = walk.union(
                select(far).where(
                    RelationshipRow.project_id == project_id,
                    RelationshipRow.type_name.in_(types),
                    near == walk.c.id,
                    *([RelationshipRow.id.not_in(sorted(skip))] if skip else []),
                )
            )
        found.update(db.execute(select(walk.c.id)).scalars())
    return found


def subtree_ids(
    db: DbSession,
    project_id: str,
    roots: Collection[str],
    containment_types: Collection[str],
    skip: Collection[str] = (),
) -> set[str]:
    """The roots that exist and every element they contain, transitively, not
    following the relationships in ``skip``."""
    return _walk(db, project_id, roots, containment_types, down=True, skip=skip)


def ancestor_ids(
    db: DbSession,
    project_id: str,
    starts: Collection[str],
    containment_types: Collection[str],
) -> set[str]:
    """The starts that exist and every element that contains one, transitively."""
    return _walk(db, project_id, starts, containment_types, down=False)


# --- what a batch names ----------------------------------------------------------


@dataclass
class _Named:
    #: every id to look up
    ids: set[str] = field(default_factory=set)
    #: elements the structural check can judge: update targets, relationship
    #: ends, the ids creates bring in
    touched: set[str] = field(default_factory=set)
    delete_roots: set[str] = field(default_factory=set)
    #: relationships an op updates or deletes
    relationships: set[str] = field(default_factory=set)
    deleted_relationships: set[str] = field(default_factory=set)
    #: ids a create reinstates: an id hint, or the canonical id of a restore
    hinted: set[str] = field(default_factory=set)
    #: (source, target) of each containment relationship the batch creates, one
    #: pair per op, each end the representative of its names (``names``): a
    #: target attached below an element a later delete removes goes with it
    attachments: list[tuple[str, str]] = field(default_factory=list)
    names: _Names = field(default_factory=lambda: _Names())


def _reinstated_id(op: CreateElementOp | CreateRelationshipOp) -> str | None:
    """The id a create takes: its hint, or, without the ``tmp_`` prefix (a
    restore), its own ``temp_id``."""
    if op.temp_id.startswith(TEMP_ID_PREFIX):
        return op.id
    return op.temp_id


class _Names:
    """The names a hinted create answers to, its ``temp_id`` and its hint, which
    later ops use interchangeably. Names are grouped (union-find), so an op
    costs one lookup however many names a reused temp id or hint has taken."""

    def __init__(self) -> None:
        self._parent: dict[str, str] = {}

    def rep(self, name: str) -> str:
        """The one name every name of the same element maps to."""
        root = name
        while (up := self._parent.get(root, root)) != root:
            root = up
        while name != root:  # path compression
            self._parent[name], name = root, self._parent[name]
        return root

    def join(self, a: str, b: str) -> None:
        a, b = self.rep(a), self.rep(b)
        self._parent.setdefault(b, b)
        self._parent[a] = b

    def groups(self) -> dict[str, set[str]]:
        """Every group, by representative, of the names that have been joined."""
        out: dict[str, set[str]] = {}
        for name in list(self._parent):
            out.setdefault(self.rep(name), set()).add(name)
        return out


def _scan(metamodel: Metamodel, ops: Sequence[ModelOpIn]) -> _Named:
    rp = ref_props(metamodel)
    # the names that are element-valued on any type: a patch does not say which
    # type it patches, and over-naming only loads a row or two more
    names = sorted(
        {n for by in (rp.element, rp.relationship) for ns in by.values() for n in ns}
    )
    named = _Named()
    for op in ops:
        if (
            isinstance(op, CreateElementOp | CreateRelationshipOp)
            and op.temp_id.startswith(TEMP_ID_PREFIX)
            and op.id is not None
        ):
            named.names.join(op.temp_id, op.id)
    rep = named.names.rep

    # Each set below holds representatives while the ops are read and every
    # name of each group once they are done (see the end), so the work is
    # linear in the batch whatever names a reused temp id or hint has taken.
    def refs(properties: dict[str, Any]) -> None:
        named.ids.update(rep(ref) for ref in refs_of(properties, names))

    for op in ops:
        if isinstance(op, CreateElementOp):
            if (hinted := _reinstated_id(op)) is not None:
                named.hinted.add(hinted)
                named.touched.add(rep(hinted))
            refs(op.properties)
        elif isinstance(op, UpdateElementOp):
            named.touched.add(rep(op.id))
            refs(op.properties_patch)
        elif isinstance(op, DeleteElementOp):
            named.delete_roots.add(rep(op.id))
        elif isinstance(op, CreateRelationshipOp):
            if (hinted := _reinstated_id(op)) is not None:
                named.hinted.add(hinted)
            source, target = rep(op.source_id), rep(op.target_id)
            named.touched.update((source, target))
            if metamodel.is_containment(op.type_name):
                named.attachments.append((source, target))
            refs(op.properties)
        elif isinstance(op, UpdateRelationshipOp):
            named.relationships.add(rep(op.id))
            refs(op.properties_patch)
        elif isinstance(op, DeleteRelationshipOp):
            named.relationships.add(rep(op.id))
            named.deleted_relationships.add(rep(op.id))
        else:
            assert_never(op)
    groups = named.names.groups()
    for found in (
        named.ids,
        named.touched,
        named.delete_roots,
        named.relationships,
        named.deleted_relationships,
    ):
        for name in [n for n in found if n in groups]:
            found |= groups[name]
    named.ids |= named.touched | named.delete_roots | named.relationships | named.hinted
    return named


# --- reading rows ------------------------------------------------------------------


class _Rows:
    """The rows read so far, and the ids looked up."""

    def __init__(self, db: DbSession, project_id: str) -> None:
        self.db = db
        self.project_id = project_id
        self.elements: dict[str, dict[str, Any]] = {}
        self.relationships: dict[str, dict[str, Any]] = {}
        #: ids looked up in both tables
        self.queried: set[str] = set()

    def _element_rows(self, where: Any) -> None:
        for r in self.db.execute(
            select(
                ElementRow.id,
                ElementRow.type_name,
                ElementRow.properties,
                ElementRow.rev,
                ElementRow.seq,
            ).where(ElementRow.project_id == self.project_id, where)
        ):
            self.elements[r.id] = {
                "id": r.id,
                "type_name": r.type_name,
                "properties": parse_model_json(r.properties),
                "rev": r.rev,
                "seq": r.seq,
            }

    def _relationship_rows(self, where: Any) -> set[str]:
        """Read the matching relationships, and the elements at their ends."""
        found: set[str] = set()
        ends: set[str] = set()
        for r in self.db.execute(
            select(
                RelationshipRow.id,
                RelationshipRow.type_name,
                RelationshipRow.source_id,
                RelationshipRow.target_id,
                RelationshipRow.properties,
                RelationshipRow.rev,
                RelationshipRow.seq,
            ).where(RelationshipRow.project_id == self.project_id, where)
        ):
            found.add(r.id)
            ends.update((r.source_id, r.target_id))
            if r.id not in self.relationships:
                self.relationships[r.id] = {
                    "id": r.id,
                    "type_name": r.type_name,
                    "source_id": r.source_id,
                    "target_id": r.target_id,
                    "properties": parse_model_json(r.properties),
                    "rev": r.rev,
                    "seq": r.seq,
                }
        self.load_elements(ends)
        return found

    def load_elements(self, ids: Iterable[str]) -> None:
        """Read the rows of ids known to be elements."""
        fresh = [i for i in dict.fromkeys(ids) if i not in self.elements]
        for chunk in batched(fresh, CHUNK):
            self._element_rows(ElementRow.id.in_(chunk))

    def probe(self, ids: Iterable[str]) -> None:
        """Look the ids up in both tables; one found in neither stays queried."""
        fresh = [i for i in dict.fromkeys(ids) if i not in self.queried]
        self.queried.update(fresh)
        for chunk in batched(fresh, CHUNK):
            self._element_rows(ElementRow.id.in_(chunk))
            self._relationship_rows(RelationshipRow.id.in_(chunk))

    def incident(self, ids: Collection[str]) -> set[str]:
        """Read every relationship with an end in ``ids``; their ids."""
        found: set[str] = set()
        for chunk in batched(sorted(ids), CHUNK):
            found |= self._relationship_rows(
                or_(
                    RelationshipRow.source_id.in_(chunk),
                    RelationshipRow.target_id.in_(chunk),
                )
            )
        return found

    def incoming_containment(
        self, ids: Collection[str], containment_types: Collection[str]
    ) -> None:
        types = sorted(containment_types)
        if not types:
            return
        for chunk in batched(sorted(ids), CHUNK):
            self._relationship_rows(
                RelationshipRow.target_id.in_(chunk)
                & RelationshipRow.type_name.in_(types)
            )

    def referencers(self, targets: Collection[str]) -> set[str]:
        """Read the entities whose references name ``targets``; their ids."""
        found: set[str] = set()
        for chunk in batched(sorted(targets), CHUNK):
            found.update(
                self.db.execute(
                    select(EntityRefRow.referencer_id).where(
                        EntityRefRow.project_id == self.project_id,
                        EntityRefRow.target_id.in_(chunk),
                    )
                ).scalars()
            )
        self.probe(found)
        return found

    def reference_targets(self, referencers: Collection[str]) -> None:
        """Read what the references of ``referencers`` name."""
        found: set[str] = set()
        for chunk in batched(sorted(referencers), CHUNK):
            found.update(
                self.db.execute(
                    select(EntityRefRow.target_id).where(
                        EntityRefRow.project_id == self.project_id,
                        EntityRefRow.referencer_id.in_(chunk),
                    )
                ).scalars()
            )
        self.probe(found)


def _containment_types(metamodel: Metamodel) -> list[str]:
    return sorted(
        t.name for t in metamodel.relationships if metamodel.is_containment(t.name)
    )


def plan_load(
    db: DbSession,
    project_id: str,
    metamodel: Metamodel,
    ops: Sequence[ModelOpIn],
    extra: frozenset[str] = frozenset(),
    *,
    thorough: bool = False,
) -> PartialRows:
    """The rows ``ops`` need, read from the head tables (see the module
    docstring). Every id in ``extra`` is a delete root and a judged element:
    what a round found missing. ``thorough``, the plan for a batch that has
    already missed once, also judges the referencers inside the deleted subtree
    (the others are judged either way), never the rest of what it loads."""
    named = _scan(metamodel, ops)
    types = _containment_types(metamodel)
    rows = _Rows(db, project_id)
    rows.probe(named.ids | extra)

    # deletes: the subtree, what touches it, who points at it
    real_roots = {i for i in named.delete_roots | extra if i in rows.elements}
    subtree = subtree_ids(db, project_id, real_roots, types)
    # What certainly goes: the batch may detach part of a root's subtree before
    # it deletes the root, so the relationships it deletes are not followed.
    detached = named.deleted_relationships
    if not detached:
        deleted = set(subtree)
    elif len(detached) > MAX_SKIPPED:
        deleted = set(real_roots)
    else:
        deleted = subtree_ids(db, project_id, real_roots, types, detached)
    # The batch may attach an element below one a delete removes, which the rows
    # cannot say. Each attachment whose source can end up deleted (it is in a
    # deleted subtree, is deleted itself, or was attached into one) makes its
    # target a root too: the rounds then do not grow with their number, and
    # moving a subtree that nothing deletes loads nothing of it.
    rep = named.names.rep
    groups = named.names.groups()
    attached_to: dict[str, list[str]] = {}
    for source, target in named.attachments:
        attached_to.setdefault(source, []).append(target)
    doomed = {rep(i) for i in subtree | named.delete_roots | extra}
    frontier = set(doomed)
    while frontier:
        fresh = {t for s_ in frontier for t in attached_to.get(s_, ())} - doomed
        doomed |= fresh
        attached = {m for t in fresh for m in groups.get(t, (t,)) if m in rows.elements}
        below = subtree_ids(db, project_id, attached, types) if attached else set()
        subtree |= below
        frontier = fresh | ({rep(i) for i in below} - doomed)
        doomed |= frontier
    rows.load_elements(subtree)
    deleted_relationships = rows.incident(subtree) | {
        r for r in named.deleted_relationships if r in rows.relationships
    }
    referenced = subtree | deleted_relationships | named.hinted
    referencers = rows.referencers(referenced)

    # what the structural check judges, with its parent chains and references
    ends = {
        end
        for rid in named.relationships
        if (rel := rows.relationships.get(rid)) is not None
        for end in (rel["source_id"], rel["target_id"])
    }
    # After a miss the referencers inside the deleted subtree are judged too:
    # something the rows cannot say may have taken one out of it.
    candidates = named.touched | extra | ends
    candidates |= referencers if thorough else referencers - deleted
    judged = {i for i in candidates if i in rows.elements}
    chain = ancestor_ids(db, project_id, judged, types)
    rows.load_elements(chain)
    rows.incoming_containment(chain, types)
    rows.reference_targets(
        judged
        | {r for r in named.relationships | referencers if r in rows.relationships}
    )

    return PartialRows(
        elements=sorted(rows.elements.values(), key=lambda r: r["seq"]),
        relationships=sorted(rows.relationships.values(), key=lambda r: r["seq"]),
        absent=frozenset(
            i
            for i in rows.queried
            if i not in rows.elements and i not in rows.relationships
        ),
        edges_complete=frozenset(subtree),
        parents_complete=frozenset(chain),
        referencers_complete=frozenset(referenced),
    )


# --- the rounds ----------------------------------------------------------------------


def load_and_apply(
    db: DbSession,
    project_id: str,
    metamodel: Metamodel,
    ops: list[ModelOpIn],
    *,
    restore: bool,
    pre_apply: Callable[[Model], None] | None = None,
    post_apply: Callable[[Model, _BatchResult], Any] | None = None,
) -> tuple[Model, _BatchResult, Any]:
    """Load the rows ``ops`` need, run ``pre_apply`` on the partial model as it
    is before the batch, apply the batch, and run ``post_apply`` on the result
    (``post_apply``'s answer comes back as the third item). A read the rows
    cannot answer loads what is missing and runs all three again on a fresh
    partial model, up to ``MAX_ROUNDS`` times; past that the answer is a 500 and
    nothing has been written. The two hooks may raise ``Refused``."""
    extra: frozenset[str] = frozenset()
    missed: frozenset[str] = frozenset()
    rounds = 0
    for rounds in range(1, MAX_ROUNDS + 1):
        # After a miss the plan also judges the referencers inside the deleted
        # subtree, so a batch whose elements hold many references does not miss
        # on them one per round.
        rows = plan_load(db, project_id, metamodel, ops, extra, thorough=bool(missed))
        model = build_partial_model(metamodel, rows)
        try:
            if pre_apply is not None:
                pre_apply(model)
            res = _apply_batch(model, ops, restore=restore)
            checked = post_apply(model, res) if post_apply is not None else None
        except NotLoaded as miss:
            missed = miss.ids
            if missed <= extra:
                break  # loading it again would change nothing
            extra |= missed
            continue
        return model, res, checked
    counts = Counter(op.kind for op in ops)
    logger.error(
        "commit check did not converge: project=%s restore=%s rounds=%d ops=%d (%s) "
        "last miss=%s",
        project_id,
        restore,
        rounds,
        len(ops),
        ", ".join(f"{kind}={n}" for kind, n in sorted(counts.items())),
        sorted(missed)[:5],
    )
    raise HTTPException(status_code=500, detail="commit check did not converge")
