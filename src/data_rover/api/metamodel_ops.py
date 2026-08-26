"""Metamodel-op plumbing.

The metamodel and the diagram layout are MATERIALIZED HEADS
(``ModelRow.metamodel_id`` -> immutable ``MetamodelRow`` versions;
``metamodel_layouts``), so metamodel ops must never reach the model applier.
This module is their applier — the fourth sibling of ``routes/ops.py``'s
model applier, ``artifact_ops`` and ``view_ops``:

- ``metamodel.rebind`` swaps the IN-MEMORY metamodel (``session.metamodel``,
  ``model.metamodel``, ``model.indexes.rebuild()`` to re-derive the per-type
  caches — the search index is kept, since the indexed text does not depend
  on the metamodel) and stages the durable rows (new ``MetamodelRow`` at
  ``prior_version + 1`` carrying the author's verbatim blob, ``ModelRow``
  repointed) on the caller's DB transaction. The caller (``create_commit``)
  applies this module FIRST so the batch's model ops validate against the
  candidate schema — the whole point of a migration batch.
- ``metamodel.move_node`` ops rewrite the layout blob; ``pos: None`` removes
  a key. Presentation data: no validation beyond schema shape.

Inverses carry FULL PRIOR STATE (the prior YAML blob; a node's prior
position), never patches — the journal alone answers undo and diff, exactly
like artifact inverses. There is NO restore-mode parameter: a rebind's
"restore" is just another forward rebind to the prior blob (a fresh
``MetamodelRow`` version — the journal stays append-only), and a move's
inverse is just another move.

There is NO internal rollback: the in-memory swap is undone by
``_CommitUnwind``'s metamodel stage (restore ``prior_metamodel`` + rebuild
indexes + null the validation state), and ``db.rollback()`` discards the
staged rows — the same split of responsibilities as the artifact applier.

That split only works if the caller's ledger learns about the swap at the
INSTANT it happens, not when this function returns: the row staging that
follows the swap goes through ``db.flush()`` and can raise, and
``db.rollback()`` discards staged rows but restores NOTHING in memory. Hence
``on_swap`` — a callback invoked with the outgoing metamodel immediately
before ``session.metamodel`` is reassigned. It is the applier's whole
contribution to unwind correctness; everything else stays the caller's job.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

import yaml
from fastapi import HTTPException
from sqlalchemy.orm import Session as DbSession

from data_rover.core.metamodel.loader import MetamodelError, load_metamodel_str
from data_rover.core.metamodel.schema import Metamodel

from . import content
from .deps import Session
from .schemas import (
    MetamodelNodePos,
    MetamodelOpIn,
    MoveMetamodelNodeOp,
    RebindMetamodelOp,
)


@dataclass
class MetamodelBatchResult:
    """Everything one metamodel-op batch produced (twin of the other three
    ``*BatchResult`` types).

    ``prior_metamodel`` records the swapped-out metamodel for INSPECTION —
    it is NOT the channel an unwinding caller should register from. This
    object only exists once ``apply_metamodel_ops`` RETURNS, and the window
    between the swap and that return is precisely where a ``db.flush()`` can
    raise; a caller that must be able to undo the swap takes its handle from
    the ``on_swap`` callback instead (see the module docstring, and
    ``routes/commits.py``'s a3 step).

    The two row ids feed ``_persist_commit``'s ``from/to_metamodel_id``
    columns so every reader keyed off them (staleness guard, history
    ``is_rebind``, ``first_rebind_after``, ``_metamodel_structural``) keeps
    working unchanged."""

    canonical_ops: list[MetamodelOpIn] = field(default_factory=list)
    inverse_units: list[list[MetamodelOpIn]] = field(default_factory=list)
    rebound: bool = False
    prior_metamodel: Metamodel | None = None
    from_metamodel_id: str | None = None
    to_metamodel_id: str | None = None
    layout_touched: bool = False

    def inverse_ops(self) -> list[MetamodelOpIn]:
        """Flat inverse batch: applying it front-to-back undoes this batch."""
        return [op for unit in reversed(self.inverse_units) for op in unit]


def split_rebind(
    ops: list[MetamodelOpIn],
) -> tuple[RebindMetamodelOp | None, list[MoveMetamodelNodeOp]]:
    """At most ONE rebind per batch (422): two schema swaps in one rev have
    no meaning the journal could represent (which candidate did the model
    ops validate against?), and the inverse would be ambiguous."""
    rebinds = [op for op in ops if isinstance(op, RebindMetamodelOp)]
    moves = [op for op in ops if isinstance(op, MoveMetamodelNodeOp)]
    if len(rebinds) > 1:
        raise HTTPException(
            status_code=422,
            detail="a batch may contain at most one metamodel.rebind op",
        )
    return (rebinds[0] if rebinds else None), moves


def load_candidate(blob: str) -> Metamodel:
    """Parse+schema-check a candidate blob; 422 on anything bad."""
    try:
        return load_metamodel_str(blob)
    except (MetamodelError, yaml.YAMLError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def serialize_metamodel_blob(metamodel: Metamodel) -> str:
    """Re-serialize an in-memory metamodel to YAML — the degraded fallback
    used when no durable ``MetamodelRow`` blob is available (a session whose
    metamodel never landed in a durable row: legacy/test setups, uploads
    that predate content tables). Shared by ``GET /metamodel/raw`` and this
    module's ``current_blob`` so the two never drift on what "degraded"
    means."""
    return yaml.safe_dump(
        metamodel.model_dump(mode="json", exclude_none=True), sort_keys=False
    )


def current_blob(db: DbSession, project_id: str, session: Session) -> str:
    """The blob the rebind inverse must carry: the STORED source when a
    durable row exists (byte-exact, the author's comments included), else a
    re-serialization of the in-memory metamodel — the same degradation
    ``GET /metamodel/raw`` documents for legacy in-memory-only sessions."""
    row = content.get_model_row(db, project_id)
    if row is not None:
        mm_row = content.get_metamodel_row(db, row.metamodel_id)
        if mm_row is not None:
            return mm_row.blob
    assert session.metamodel is not None
    return serialize_metamodel_blob(session.metamodel)


def apply_metamodel_ops(
    db: DbSession,
    project_id: str,
    session: Session,
    ops: list[MetamodelOpIn],
    *,
    on_swap: Callable[[Metamodel], None] | None = None,
) -> MetamodelBatchResult:
    """Apply the metamodel family: rebind first (in-memory swap + staged
    rows), then layout moves (staged blob rewrite). Caller holds the
    ``write_mutex`` and owns the transaction; see the module docstring for
    the no-rollback contract.

    ``on_swap`` is called with the OUTGOING metamodel at the last instant
    before the in-memory swap, and therefore before any of the staging that
    can raise. Callers that must be able to unwind the swap (``create_commit``)
    register their handle from it rather than from this function's return
    value: everything between the swap and the return can fail, and by then
    the return value does not exist. Registration is EXACT — nothing before
    the swap point (a bad candidate, an unreadable prior blob) fires it, so a
    422 on a YAML typo never pays for an unwind that has nothing to undo.
    """
    res = MetamodelBatchResult()
    rebind, moves = split_rebind(ops)
    if rebind is not None:
        model = session.model
        assert model is not None and session.metamodel is not None
        candidate = load_candidate(rebind.blob)
        prior_blob = current_blob(db, project_id, session)
        model_row = content.get_model_row(db, project_id)
        from_id = model_row.metamodel_id if model_row is not None else None
        prior_version = 0
        if from_id is not None:
            prior = content.get_metamodel_row(db, from_id)
            prior_version = prior.version if prior is not None else 0
        res.prior_metamodel = session.metamodel
        # LAST statement before the in-memory state goes dirty: from here on,
        # a raise leaves a swapped session that only the caller's ledger can
        # put back (db.rollback() restores no in-memory state whatsoever).
        if on_swap is not None:
            on_swap(session.metamodel)
        session.metamodel = candidate
        model.metamodel = candidate
        model.indexes.rebuild(
            keep_search=True
        )  # mm-derived only; the search text is not
        # Persist unconditionally, even when the project has no ModelRow yet:
        # upsert_model_row self-creates one (content.py), so gating this on
        # model_row's presence bought nothing but a rebind with NULL
        # from/to_metamodel_id — invisible to the staleness guard's
        # unconditional-conflict branch, first_rebind_after, history's
        # is_rebind, and _metamodel_structural's diff rendering.
        mm_row = content.create_metamodel(
            db, name="", version=prior_version + 1, blob=rebind.blob
        )
        content.upsert_model_row(db, project_id, metamodel_id=mm_row.id)
        res.from_metamodel_id = from_id
        res.to_metamodel_id = mm_row.id
        res.rebound = True
        res.canonical_ops.append(rebind)
        res.inverse_units.append(
            [RebindMetamodelOp(kind="metamodel.rebind", blob=prior_blob)]
        )
    if moves:
        blob = content.get_metamodel_layout(db, project_id) or {}
        positions: dict = dict(blob.get("positions") or {})
        for op in moves:
            prior = positions.get(op.node)
            if op.pos is None:
                positions.pop(op.node, None)
            else:
                positions[op.node] = {"x": op.pos.x, "y": op.pos.y}
            inv_pos = (
                None
                if prior is None
                else MetamodelNodePos(x=float(prior["x"]), y=float(prior["y"]))
            )
            res.inverse_units.append(
                [
                    MoveMetamodelNodeOp(
                        kind="metamodel.move_node", node=op.node, pos=inv_pos
                    )
                ]
            )
            res.canonical_ops.append(op)
        content.stage_metamodel_layout(db, project_id, {"positions": positions})
        res.layout_touched = True
    return res
