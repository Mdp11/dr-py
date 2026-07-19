"""Host-side dispatcher for the guest<->host bridge protocol.

A running snippet talks to the host over a newline-JSON pipe: one line in is
one request dict (``{"id": ..., "op": ..., ...}``), one line out is one
response dict echoing the same ``"id"``. :class:`BridgeDispatcher` is the
*host* side of that protocol — it never touches the sandbox/transport layer
(no wasmtime, no process/pipe handling), it just answers `dispatch()` calls
against an in-memory :class:`~data_rover.core.model.model.Model`.

Two invariants shape everything here:

- **Read-only against the live model.** Every read op (`element`,
  `elements_page`, `outgoing`, `incoming`, `parent`, `children`, `types`,
  `type_info`) only ever calls accessor methods on `Model`/`Metamodel` —
  never `create_element`/`set_property`/`connect`/... A snippet that only
  reads never needs a lock and can never corrupt the session's model.
- **Writes are dry-run recording, not application.** `record_op` never calls
  into `Model`'s mutation boundary either: it appends the op dict *verbatim*
  to `.ops` and returns. The op batch is a *proposal* — Task 11's route
  layer is the one that eventually validates it via `schemas.OPS_ADAPTER`
  and, if accepted, hands it to `POST /model/ops` (or the check-out/commit
  flow) the same way a human-driven client would. This keeps `bridge.py`
  free of any dependency on `data_rover.api.*` (it imports only
  `data_rover.core.*` and stdlib) and keeps a misbehaving/compromised guest
  from ever mutating the session's model directly — the worst it can do is
  hand back a bad batch, which is rejected at the same boundary a client
  request would be.

Op-dict *shape* is intentionally NOT validated here (see the module-level
note above): `record_op` accepts whatever dict the guest sends and merely
enforces size/count *caps* (`max_ops`, `max_op_bytes`). That keeps this
module free of a dependency on `data_rover.api.schemas.OPS_ADAPTER` (an API
concern) while still bounding how much a batch can cost to transport/store.

Wire quirk (deliberate, not a bug): a request's `"op"` field is polymorphic —
a `str` selects one of the fixed read ops by name (with extra params read
from other keys of the same request dict); a `dict` IS the `OpIn`-shaped
payload to record, i.e. an implicit `record_op` call. There is no separate
"op name" for writes. This is not an arbitrary choice: JSON (like the Python
dict literals used in this task's own test suite) has no way to carry two
values under the same repeated key — `{"id": 3, "op": "record_op", "op":
{...}}` collapses to a single `"op"` key holding the dict, last-write-wins,
before it ever reaches `dispatch()`. Rather than invent a second field name
nothing in the brief specifies, the dispatcher treats that collapse as the
wire format: a dict `"op"` *is* the write request.
"""

from __future__ import annotations

import json
from typing import Any
from collections.abc import Callable

from ..metamodel.schema import Metamodel
from ..model.element import Element
from ..model.model import Model
from ..model.relationship import Relationship

#: A recorded write op: a (verbatim, unvalidated) `OpIn`-shaped dict, e.g.
#: `{"kind": "delete_element", "id": "..."}`. Shape validation happens at the
#: API route boundary (Task 11), not here — see the module docstring.
RecordedOp = dict[str, Any]


class BridgeLimitError(Exception):
    """A bridge request would exceed a configured cap (`max_ops`,
    `max_op_bytes`, ...). Raised internally by op handlers and always caught
    by :meth:`BridgeDispatcher.dispatch`, which maps it to an error response
    — the guest's request loop needs a response for every request id, never
    an exception crossing the bridge boundary."""


class ReadOnlyError(Exception):
    """`record_op` was called on a dispatcher constructed with
    `record_ops=False`. Caught by `dispatch()` like `BridgeLimitError`."""


def _project_element(element: Element) -> dict[str, Any]:
    """Element -> plain dict: `{"id", "type", "name", "properties"}`.

    `name` is a display convenience (`properties.get("name")`, `None` when
    absent) — the full property bag is still there under `"properties"` for
    a snippet that needs more than the display name.
    """
    return {
        "id": element.id,
        "type": element.type_name,
        "name": element.properties.get("name"),
        "properties": dict(element.properties),
    }


def _project_relationship(rel: Relationship) -> dict[str, Any]:
    """Relationship -> plain dict. Same base shape as `_project_element`
    (`id`/`type`/`name`/`properties`) plus `source_id`/`target_id` — without
    those a relationship projection would be useless for graph navigation
    (the whole point of `outgoing`/`incoming`)."""
    return {
        "id": rel.id,
        "type": rel.type_name,
        "name": rel.properties.get("name"),
        "properties": dict(rel.properties),
        "source_id": rel.source_id,
        "target_id": rel.target_id,
    }


class BridgeDispatcher:
    """Answers one bridge request at a time against a `Model`.

    Construction is cheap (no copying: it holds the live `Model`/`Metamodel`
    by reference, exactly like the rest of the core layer). `record_ops`
    gates whether `record_op` is allowed at all — a preview/read-only
    snippet run constructs one with `record_ops=False` so even a
    protocol-level attempt to queue a mutation is rejected up front.
    """

    def __init__(
        self,
        model: Model,
        *,
        record_ops: bool,
        max_ops: int = 1000,
        max_op_bytes: int = 1024 * 1024,
        page_limit: int = 500,
    ) -> None:
        self.model = model
        # `Model.metamodel` is a required constructor field (never None), so
        # the dispatcher always has one without needing a separate kwarg.
        self.metamodel: Metamodel = model.metamodel
        self.record_ops = record_ops
        self.max_ops = max_ops
        self.max_op_bytes = max_op_bytes
        self.page_limit = page_limit
        #: Accumulated recorded ops, in call order. Never applied to `model`.
        self.ops: list[RecordedOp] = []
        self._op_bytes = 0

        self._read_ops: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
            "element": self._op_element,
            "elements_page": self._op_elements_page,
            "outgoing": self._op_outgoing,
            "incoming": self._op_incoming,
            "parent": self._op_parent,
            "children": self._op_children,
            "types": self._op_types,
            "type_info": self._op_type_info,
        }

    # -- dispatch -------------------------------------------------------

    def dispatch(self, req: dict[str, Any]) -> dict[str, Any]:
        """Handle one request dict, always returning a response dict that
        echoes `req.get("id")` — NEVER raises. See the module docstring for
        the polymorphic `"op"` field (`str` -> read op name, `dict` -> a
        `record_op` payload).

        The guest is untrusted: a malformed request (wrong param type, e.g.
        `{"op": "element", "element_id": ["x"]}` making `element_id`
        unhashable, or `{"offset": [1, 2]}` making `int(...)` raise) must
        turn into an error response, not an exception that escapes and kills
        the host's request/response pump. `Exception` is caught deliberately
        broadly here — narrower than that reopens exactly this hole for
        whatever stdlib `TypeError`/`AttributeError`/... a new handler
        happens to trigger on bad input the caps and the known error types
        below don't anticipate.
        """
        req_id = req.get("id")
        op = req.get("op")
        try:
            if isinstance(op, dict):
                result = self._op_record_op(op)
            elif isinstance(op, str):
                handler = self._read_ops.get(op)
                if handler is None:
                    raise ValueError(f"unknown op {op!r}")
                result = handler(req)
            else:
                raise ValueError(f"'op' must be a str or dict, got {op!r}")
        except Exception as exc:  # noqa: BLE001 - see docstring: must never escape
            return {"id": req_id, "error": f"{type(exc).__name__}: {exc}"}
        response = dict(result)
        response["id"] = req_id
        return response

    # -- read ops ---------------------------------------------------------

    def _op_element(self, req: dict[str, Any]) -> dict[str, Any]:
        element = self.model.get_element(req["element_id"])
        return {"element": _project_element(element)}

    def _op_elements_page(self, req: dict[str, Any]) -> dict[str, Any]:
        type_name = req.get("type")
        offset = max(0, int(req.get("offset") or 0))
        raw_limit = req.get("limit")
        limit = self.page_limit if raw_limit is None else int(raw_limit)
        limit = max(0, min(limit, self.page_limit))

        allowed_types = (
            None if type_name is None else self.metamodel.element_descendants(type_name)
        )
        candidates = (
            self.model.elements.values()
            if allowed_types is None
            else (
                e for e in self.model.elements.values() if e.type_name in allowed_types
            )
        )

        page: list[Element] = []
        skipped = 0
        has_more = False
        for element in candidates:
            if skipped < offset:
                skipped += 1
                continue
            if len(page) >= limit:
                has_more = True
                break
            page.append(element)

        return {
            "elements": [_project_element(e) for e in page],
            "next_offset": offset + limit if has_more else None,
        }

    def _op_outgoing(self, req: dict[str, Any]) -> dict[str, Any]:
        element_id = req["element_id"]
        self.model.get_element(element_id)  # raises KeyError if missing
        rel_ids = sorted(self.model.indexes.outgoing_ids(element_id))
        rels = [self.model.get_relationship(rid) for rid in rel_ids]
        return {"relationships": [_project_relationship(r) for r in rels]}

    def _op_incoming(self, req: dict[str, Any]) -> dict[str, Any]:
        element_id = req["element_id"]
        self.model.get_element(element_id)  # raises KeyError if missing
        rel_ids = sorted(self.model.indexes.incoming_ids(element_id))
        rels = [self.model.get_relationship(rid) for rid in rel_ids]
        return {"relationships": [_project_relationship(r) for r in rels]}

    def _op_parent(self, req: dict[str, Any]) -> dict[str, Any]:
        element_id = req["element_id"]
        self.model.get_element(element_id)  # raises KeyError if missing
        return {"parent_id": self.model.container_of(element_id)}

    def _op_children(self, req: dict[str, Any]) -> dict[str, Any]:
        element_id = req["element_id"]
        self.model.get_element(element_id)  # raises KeyError if missing
        # `Model` has no dedicated "children" index (`container_of`/
        # `containment_parents` only track parent-of, not the inverse), so
        # children are derived from the element's own outgoing relationships
        # filtered to containment types — the same filter Model._containment_
        # children uses internally, reimplemented here via the PUBLIC
        # `relationships_from` + `metamodel.is_containment` rather than
        # reaching into that underscore-prefixed helper.
        child_ids = sorted(
            rel.target_id
            for rel in self.model.relationships_from(element_id)
            if self.metamodel.is_containment(rel.type_name)
        )
        children = [_project_element(self.model.get_element(cid)) for cid in child_ids]
        return {"children": children}

    def _op_types(self, req: dict[str, Any]) -> dict[str, Any]:
        return {"types": [et.name for et in self.metamodel.elements]}

    def _op_type_info(self, req: dict[str, Any]) -> dict[str, Any]:
        type_name = req["type"]
        if self.metamodel.element_type(type_name) is None:
            raise KeyError(f"Unknown element type {type_name!r}")
        props = self.metamodel.effective_element_properties(type_name)
        return {
            "type": type_name,
            "properties": [
                {"name": p.name, "datatype": p.datatype, "multiplicity": p.multiplicity}
                for p in props
            ],
        }

    # -- write op: dry-run recording ---------------------------------------

    def _op_record_op(self, op: RecordedOp) -> dict[str, Any]:
        if not self.record_ops:
            raise ReadOnlyError("record_op is disabled on a read-only dispatcher")
        if len(self.ops) >= self.max_ops:
            raise BridgeLimitError(
                f"record_op: op cap exceeded (max_ops={self.max_ops})"
            )
        op_bytes = len(json.dumps(op))
        if self._op_bytes + op_bytes > self.max_op_bytes:
            raise BridgeLimitError(
                f"record_op: op byte cap exceeded (max_op_bytes={self.max_op_bytes})"
            )
        self.ops.append(op)
        self._op_bytes += op_bytes
        result: dict[str, Any] = {}
        temp_id = op.get("temp_id")
        if temp_id is not None:
            result["temp_id"] = temp_id
        return result
