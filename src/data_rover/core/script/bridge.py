"""Host-side dispatcher for the guest<->host bridge protocol.

A running snippet talks to the host over a newline-JSON pipe: one line in is
one request dict (``{"id": ..., "op": ..., ...}``), one line out is one
response dict echoing the same ``"id"``. :class:`BridgeDispatcher` is the
*host* side of that protocol — it never touches the sandbox/transport layer
(no wasmtime, no process/pipe handling), it just answers `dispatch()` calls
against an in-memory :class:`~data_rover.core.model.model.Model`.

Two invariants shape everything here:

- **Read-only against the live model.** Every read op (`element`,
  `elements_page`, `outgoing`, `incoming`, `parent`, `children`,
  `descendants`) only ever calls accessor methods on `Model`/`Metamodel` —
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
from collections.abc import Callable, Iterable, Mapping, Sequence

from ..metamodel.schema import Metamodel
from ..model.element import Element
from ..model.model import Model
from ..model.naming import name_of
from ..model.relationship import Relationship

#: A recorded write op: a (verbatim, unvalidated) `OpIn`-shaped dict, e.g.
#: `{"kind": "delete_element", "id": "..."}`. Shape validation happens at the
#: API route boundary (Task 11), not here — see the module docstring.
RecordedOp = dict[str, Any]

#: Above this many DISTINCT far endpoints, `_far_endpoints` skips inlining
#: entirely and returns `[]` instead of projecting anything. Without this, a
#: hop on a high-degree hub (e.g. 10k outgoing relationships) would ship 10k
#: full element projections even when the snippet only reads `rel["type"]`
#: and never dereferences a neighbor — roughly doubling the JSON shipped
#: across the bridge for zero benefit — and the guest's priming loop
#: (`facade_src.py`'s `out()`/`in_()`) would push all 10k entries through its
#: `_MEMO_CAP`-sized (default 4096, see `RunLimits.read_memo_max`) FIFO memo,
#: evicting every other entry the session had cached. Skipping is legal by
#: construction: the facade already tolerates a missing/empty "elements" key
#: (`resp.get("elements") or []`) and falls back to one `dr.element(id)` call
#: per neighbor actually dereferenced — exactly today's (pre-trip-collapse)
#: behavior, just without the inline fast path for this one hop. Half the
#: default memo cap: comfortably below the point where priming would evict
#: the memo's own prior contents, without being so small it defeats the
#: optimization on ordinarily-sized fan-out. `bridge.py` is host-side and
#: does not know the guest's actual configured `read_memo_max` (that value
#: never crosses the bridge), so this is a fixed constant rather than a
#: derived one — threading a new setting through the stack for this single
#: guard would be scope creep for what a hard-coded, documented number
#: already solves.
_MAX_INLINE_FAR_ENDPOINTS = 2048


class BridgeLimitError(Exception):
    """A bridge request would exceed a configured cap (`max_ops`,
    `max_op_bytes`, ...). Raised internally by op handlers and always caught
    by :meth:`BridgeDispatcher.dispatch`, which maps it to an error response
    — the guest's request loop needs a response for every request id, never
    an exception crossing the bridge boundary."""


class ReadOnlyError(Exception):
    """`record_op` was called on a dispatcher constructed with
    `record_ops=False`. Caught by `dispatch()` like `BridgeLimitError`."""


def _copy_properties(properties: Mapping[str, Any]) -> dict[str, Any]:
    """Copy a property bag deeply enough that nothing a snippet can reach
    still aliases the live `Model`.

    A bare `dict(properties)` is NOT enough: multi-valued properties are
    first-class (see `validation/validators/multiplicity.py`), so a value can
    be a LIST — and that list object would still be the core `Element`'s own.
    Under a transport with a real JSON boundary (`WasmScriptRunner`) the
    decode breaks the alias anyway, but the in-process `TrustedRunner` binds
    the guest straight to `dispatch()`, so a read-only snippet doing
    `el["tags"].append(...)` would mutate the session's model — breaking this
    module's headline invariant that "a snippet that only reads ... can never
    corrupt the session's model" (see `BridgeDispatcher`).

    Fixing it HERE rather than in `facade_src.py` puts the copy at the single
    point every projection flows through (`_op_element`, `_op_elements_page`,
    `_op_children`, `_far_endpoints`, the hop relationship projections and
    the `project_roots` piggyback), so no read path can be added that forgets
    it. `dict` values are copied too on the same "the engine stays
    inspectable and will hold non-conformant data" reasoning as
    `facade_src.py`'s guest-side `_copy_projection`.
    """
    return {
        k: (list(v) if isinstance(v, list) else dict(v) if isinstance(v, dict) else v)
        for k, v in properties.items()
    }


def _project_element(element: Element) -> dict[str, Any]:
    """Element -> plain dict: `{"id", "type", "name", "properties"}`.

    `name` is a display convenience resolved via `core.model.naming.name_of`
    — the same case-insensitive `name`/`Name`/`NAME` resolution the tree/
    search/table code uses (list-valued names contribute their first
    non-empty entry), `None` when no usable name property exists. The full
    property bag is still there under `"properties"` for a snippet that
    needs more than the display name.
    """
    return {
        "id": element.id,
        "type": element.type_name,
        "name": name_of(element),
        "properties": _copy_properties(element.properties),
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
        "properties": _copy_properties(rel.properties),
        "source_id": rel.source_id,
        "target_id": rel.target_id,
    }


#: Public alias: the embedded-session root piggyback (both hosts — the WASM
#: bootstrap loop and the trusted test session) projects elements host-side
#: with exactly the wire shape `_op_element` uses; exported here so a second
#: projection implementation never has to exist.
project_element = _project_element


def project_roots(model: Model, element_ids: Sequence[str]) -> list[dict[str, Any]]:
    """Project each of `element_ids` still present in `model`, in input
    order, silently OMITTING any id no longer present (never a `None`
    placeholder in its place).

    This is the HOST half of the embedded-session root piggyback: both hosts
    (`api/script_runner.py`'s `_WasmSnippetSession.call` and `tests/script/
    trusted_runner.py`'s `_TrustedSession.call`) call this to build the
    `"elements"` list they ship alongside a `{"call": ...}` request, so the
    guest's read memo (`facade_src.py`'s `_dr_call_entry`) can be primed with
    the bound root(s) before the entry point runs — a property-math cell
    (e.g. `def value(els): return els[0].name`) then costs zero bridge round
    trips instead of one `element` fetch per root.

    Omission, not a `None` placeholder, is the load-bearing contract: the
    guest keys priming off `proj["id"]` (a dict per surviving projection),
    never off list position, so a hole in this list is simply invisible to
    it — nothing shifts, nothing needs a sentinel. An id missing here (a
    benign race, e.g. the root was deleted between binding the call and
    running it) is never primed, so the guest's own `_fetch_element` for
    that id falls through to the bridge and raises the same `NotFoundError`
    a direct, unmemoized fetch has always produced. Encoding "missing" as a
    `None` placeholder instead would force the guest to special-case a dead
    entry it must never treat as a real (if empty) result.
    """
    out: list[dict[str, Any]] = []
    for eid in element_ids:
        element = model.elements.get(eid)
        if element is not None:
            out.append(_project_element(element))
    return out


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
            "descendants": self._op_descendants,
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
        # `type` is None (no filter), a single stereotype name, or a list of
        # names (facade sends a list since the stereotypes= rework); each
        # name expands to its descendant closure, lists union them. An empty
        # list is a real filter matching nothing — distinct from None.
        type_names = req.get("type")
        offset = max(0, int(req.get("offset") or 0))
        raw_limit = req.get("limit")
        limit = self.page_limit if raw_limit is None else int(raw_limit)
        limit = max(0, min(limit, self.page_limit))

        if type_names is None:
            allowed_types: set[str] | None = None
        else:
            if isinstance(type_names, str):
                type_names = [type_names]
            allowed_types = set()
            for name in type_names:
                allowed_types.update(self.metamodel.element_descendants(name))
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
        return {
            "relationships": [_project_relationship(r) for r in rels],
            "elements": self._far_endpoints(r.target_id for r in rels),
        }

    def _op_incoming(self, req: dict[str, Any]) -> dict[str, Any]:
        element_id = req["element_id"]
        self.model.get_element(element_id)  # raises KeyError if missing
        rel_ids = sorted(self.model.indexes.incoming_ids(element_id))
        rels = [self.model.get_relationship(rid) for rid in rel_ids]
        return {
            "relationships": [_project_relationship(r) for r in rels],
            "elements": self._far_endpoints(r.source_id for r in rels),
        }

    def _far_endpoints(self, ids: Iterable[str]) -> list[dict[str, Any]]:
        """Inline far-endpoint projections shipped with a hop response
        (trip-collapse, spec 2026-07-21 Phase A'): the facade primes its read
        memo with these, collapsing `out()` + N neighbor fetches into one
        trip. Deduped, in first-appearance (sorted-rel-id) order; an endpoint
        missing from the model (dangling reference — the engine stays
        inspectable) is silently skipped, so the guest's own fetch surfaces
        the same NotFoundError it always did.

        High-degree guard: dedup ids FIRST (a hub with many parallel edges to
        the same neighbor must not inflate the count), then bail out with
        `[]` before projecting anything if the distinct count exceeds
        `_MAX_INLINE_FAR_ENDPOINTS` — see that constant's docstring for why.
        Bailing here (rather than after projecting) is what actually saves
        the work, not just the wire bytes: this is a pathological-hub guard,
        not a truncation, so it is all-or-nothing rather than a partial/
        best-effort inline of the first N — a partial list would make the
        facade's memo-priming depend on which endpoints happened to fit,
        i.e. make results depend on iteration order instead of just falling
        back to the same per-neighbor fetch every hub hop already used
        before trip-collapse existed."""
        seen: set[str] = set()
        unique_ids: list[str] = []
        for fid in ids:
            if fid in seen:
                continue
            seen.add(fid)
            unique_ids.append(fid)
        if len(unique_ids) > _MAX_INLINE_FAR_ENDPOINTS:
            return []
        out: list[dict[str, Any]] = []
        for fid in unique_ids:
            el = self.model.elements.get(fid)
            if el is not None:
                out.append(_project_element(el))
        return out

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

    def _op_descendants(self, req: dict[str, Any]) -> dict[str, Any]:
        """Descendant closure for a stereotype — internal support for the
        facade's inheritance-aware filters (`dr.elements(stereotypes=...)`
        expands host-side in `_op_elements_page`; hop filters expand
        guest-side from this op). `kind` disambiguates the two type
        namespaces. Unknown names raise KeyError (guest `NotFoundError`) so
        a typo'd filter surfaces instead of silently matching nothing."""
        kind = req.get("kind")
        name = req["name"]
        if kind == "element":
            if self.metamodel.element_type(name) is None:
                raise KeyError(f"Unknown element stereotype {name!r}")
            return {"descendants": sorted(self.metamodel.element_descendants(name))}
        if kind == "relationship":
            if self.metamodel.relationship_type(name) is None:
                raise KeyError(f"Unknown relationship stereotype {name!r}")
            return {
                "descendants": sorted(self.metamodel.relationship_descendants(name))
            }
        raise ValueError(f"descendants: unknown kind {kind!r}")

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
