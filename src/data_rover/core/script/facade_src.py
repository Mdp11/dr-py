"""Source of the `dr` facade module injected into snippet execution guests.

This module is **never imported** by anything, host- or guest-side — it only
ever exists as the string constant :data:`FACADE_SOURCE`, which a runner
`exec`s (verbatim, prepended to the user's snippet) in a fresh namespace.
That is deliberate, not an oversight:

- In production (Tasks 8/9) the snippet + facade run inside a WASM guest
  (wasmtime + CPython-WASI); there is no way to "import" a host-side `.py`
  file into that guest, so the facade has to travel as source text the guest
  interpreter compiles for itself.
- In tests (`tests/script/trusted_runner.py`'s `TrustedRunner`) the same
  string is `exec`'d in-process. Using the *same* source both ways is the
  point: it is the only way to guarantee the facade snippet authors see in
  tests is byte-identical to the one running inside the sandbox — no second
  implementation to drift out of sync.

Because it is only ever `exec`'d, this string must be plain, stdlib-only,
Python 3.10-compatible source. It must never `import data_rover` (or
anything else host-side) — the guest that runs it has no such package
available, and the facade's only channel to the host is the transport
contract below.

**The `_transport` contract.** `FACADE_SOURCE` refers to a module-level
name, `_transport`, that it does *not* define. The embedding runner MUST
bind `_transport` to a `Callable[[dict], dict]` in the `exec` namespace
*before* `FACADE_SOURCE` executes (e.g. `namespace = {"_transport": ...}`,
then `exec(FACADE_SOURCE, namespace)`). `_transport(req)` takes one bridge
request dict (see `bridge.py`'s module docstring for the wire shape: a
string `"op"` selects a read, a dict `"op"` records a write) and returns one
response dict, synchronously, never raising — errors come back as
`{"id", "error": "ExcName: message"}`. In production `_transport` writes a
newline-JSON request to a pipe/stdio channel and blocks for the matching
response line; in `TrustedRunner` it is `BridgeDispatcher.dispatch` called
directly, in-process. The facade code below is oblivious to which.

**The `_read_memo_max` contract.** The embedding runner MUST also bind
`_read_memo_max` (an `int`, the memo capacity — see `RunLimits.read_memo_max`)
in the same namespace before `FACADE_SOURCE` executes. It caps the facade's
session-lifetime read memo (`_memo`, defined below): memoized reads cost zero
round trips on repeat. For embedded/sweep work the results this memo backs
are rev-stamped and discarded if the model rev moves under them, so the memo
can never be *observed* stale there; a console run reads without holding
`session.write_mutex` at all and can already observe a torn read with or
without the memo (see `RunLimits.read_memo_max`'s docstring in `runner.py`
for the full scoping). Missing the binding (e.g. a caller that forgets it)
falls back to a hardcoded default via `except (NameError, TypeError,
ValueError)`, so the facade never hard-fails on it — but every real
embedding path threads it through explicitly (`RunLimits.read_memo_max` ->
`start_msg`/`namespace`).
"""

from __future__ import annotations

FACADE_SOURCE = '''
# dr facade -- exec'd ahead of snippet code. Requires a module-level
# _transport(req: dict) -> dict callable to already be bound in this
# namespace (see facade_src.py's host-side docstring for the contract).


class BridgeError(Exception):
    """Base class for errors surfaced from the model bridge."""


class ReadOnlyError(BridgeError):
    """A write was attempted in a read-only run (writes disabled)."""


class NotFoundError(BridgeError):
    """The requested element or relationship id does not exist."""


class CardinalityError(BridgeError):
    """A hop's `expected=` relationship-count assertion failed."""


_req_counter = [0]
_temp_counter = [0]


def _next_req_id():
    _req_counter[0] += 1
    return _req_counter[0]


def _next_temp_id():
    _temp_counter[0] += 1
    return "tmp_" + str(_temp_counter[0])


def _raise_for_error(resp):
    err = resp.get("error")
    if err is None:
        return resp
    if err.startswith("ReadOnlyError"):
        raise ReadOnlyError(err)
    if err.startswith("KeyError"):
        raise NotFoundError(err)
    raise BridgeError(err)


def _read(op_name, **fields):
    req = {"id": _next_req_id(), "op": op_name}
    req.update(fields)
    return _raise_for_error(_transport(req))


def _write(op):
    req = {"id": _next_req_id(), "op": op}
    return _raise_for_error(_transport(req))


try:
    _MEMO_CAP = int(_read_memo_max)
except (NameError, TypeError, ValueError):
    # NameError: caller forgot to bind _read_memo_max at all.
    # TypeError: caller bound it to None (or another non-int-coercible value).
    # ValueError: caller bound it to a non-numeric string.
    # Any of these falls back to the hardcoded default rather than letting
    # an opaque exception kill facade exec before the snippet even starts.
    _MEMO_CAP = 4096

# Session-lifetime read memo: (op_name, id_or_None) -> response fragment.
# Soundness is scoped in `RunLimits.read_memo_max`'s docstring (rev-stamped
# for embedded/sweep work; a console run can observe a torn read with or
# without the memo). Insertion-ordered
# dict gives FIFO eviction at _MEMO_CAP entries. Element entries hold the
# PROJECTION dict (not the whole response) so hop/root priming can insert
# projections directly under ("element", id).
#
# INVARIANT: memo entries are canonical session state, read by every future
# call to the op they were stored under. Every read path in this module
# hands out COPIES of the containers it returns (lists and dicts alike) —
# never the memo's own list/dict object. This is load-bearing, not just
# defensive: if a snippet's returned structure aliased the memo entry, a
# snippet that mutates what it gets back (e.g. appending to a list-valued
# property of an element or of a hop's Relationship)
# would silently change the RESULT of a later call to the same read. That
# would make snippet behavior depend on `_read_memo_max` (whether the memo
# was populated/evicted at the time), which must never be observable.
#
# Property values are NOT always immutable scalars: multi-valued properties
# are first-class (see `validation/validators/multiplicity.py` and
# `type_conformance.py`), so a projection's `properties` dict can map a key
# to a LIST. `_copy_projection` below is the one place that copies an
# element (or relationship) projection safely: it copies the outer dict AND
# replaces any list-valued property with a fresh list, so `el["tags"]` or
# `el.outgoing()[0]["tags"]` can be appended to without ever reaching back
# into `_memo`.
# Every read path in this module that hands out a projection (or a
# structure built from one) must go through this helper rather than a bare
# `dict(...)`.
_memo = {}


def _memo_put(key, value):
    if _MEMO_CAP <= 0:
        return
    if key not in _memo and len(_memo) >= _MEMO_CAP:
        _memo.pop(next(iter(_memo)))
    _memo[key] = value


def _copy_projection(d):
    # Shallow dict() is not enough: the projection's `properties` dict is
    # memo state, and property VALUES can be lists (multi-valued
    # properties), so `el["tags"].append(...)` would mutate the memo.
    c = dict(d)
    props = c.get("properties")
    if props is not None:
        c["properties"] = {
            k: (list(v) if isinstance(v, list) else dict(v) if isinstance(v, dict) else v)
            for k, v in props.items()
        }
    # No metamodel datatype admits a dict value, so dict copying is unreachable
    # for a conformant model — but the engine deliberately stays inspectable
    # and will hold non-conformant data, and over-copying is the safe direction.
    return c


def _descendant_set(kind, name):
    # Stereotype descendant closure fetched from the host, memoized for the
    # session under a 3-part key (the only memo key that is not the usual
    # (op_name, id_or_None) shape -- it is keyed by type NAMESPACE + name,
    # not by entity id). Deliberately NO _note_read: the metamodel is
    # immutable per session (a swap goes through session replacement /
    # clear-all), so a cached cell can never observe a stale descendant set,
    # and recording it would only add a dependency nothing can ever touch.
    #
    # The returned list is the memo's own object, which is safe ONLY because
    # it never escapes this module: `_stereotype_filter` copies it into a set
    # and no facade path ever hands it to snippet code. Do not return it from
    # a public member without going through a copy first.
    key = ("descendants", kind, name)
    hit = _memo.get(key)
    if hit is None:
        hit = _read("descendants", kind=kind, name=name)["descendants"]
        _memo_put(key, hit)
    return hit


def _stereotype_filter(kind, names):
    # None -> no filtering (distinct from an empty list, which is a real
    # filter matching nothing). A str or list of names -> the union of each
    # name's descendant closure, so a filter is inheritance-aware. An unknown
    # name raises NotFoundError from the host rather than silently matching
    # nothing, so a typo surfaces.
    if names is None:
        return None
    if isinstance(names, str):
        names = [names]
    allowed = set()
    for n in names:
        allowed.update(_descendant_set(kind, n))
    return allowed


# Cannot import runner.py's _MAX_READS here (this string is exec'd guest
# source -- no imports, see the module docstring), so this cap and that one
# can only be kept in sync by convention: this value MUST be <= host-side
# `runner.py`'s `_MAX_READS`. If it were ever greater, a read-set sized
# between the two caps (under _READS_CAP, so `_dr_call_entry` ships it
# un-overflowed) would arrive at `decode_reads` over `_MAX_READS` and get
# silently decoded to `None` there (its `len(obj) > _MAX_READS` guard) --
# indistinguishable from a deliberate overflow report, so nothing would ever
# surface the drift. Keep the two literals equal unless you have a specific
# reason the facade should overflow strictly before the host does.
_READS_CAP = 2000

# Read-set recording (Phase B): _boot_reads accumulates reads made during
# module exec (an import-time index feeds every later call, so its reads
# belong to every call's set); _call_reads[0] holds the active per-call set
# while _dr_call_entry is driving, else None (console 'script' runs record
# into _boot_reads and never ship it — harmless). Overflow past _READS_CAP
# flips the matching flag and the call reports reads=None ("depends on
# everything") — the conservative direction.
_boot_reads = set()
_boot_overflow = [False]
_call_reads = [None]
_call_overflow = [False]


def _note_read(tag, ident):
    # LIMITATION -- cannot be fixed by more instrumentation, only by author
    # discipline (see README.md's "Evaluation sessions (M2/M3)" section for
    # the author-facing version of this warning): a read made during module
    # exec (boot) is charged to EVERY call via _boot_reads, which covers an
    # index built at true module top level. It does NOT cover the equally
    # common LAZY variant -- a module global initialized on first use inside
    # value()/step() (`if _index is None: _index = {...}`) -- because only
    # the FIRST call that triggers the lazy build ever executes the reads
    # that build it; every later call hits the already-built global directly
    # and never calls back into this module, so its _call_reads set is
    # missing that dependency even though its RESULT still depends on it.
    # The same shape bites a generator merely CREATED at module level but
    # ADVANCED (next()'d) inside a call: the _note_read call living in the
    # generator body only fires on the first advance, not at creation. The
    # fix would require unioning each call's reads into a session-sticky set
    # that later calls inherit, which degrades back to clear-all invalidation
    # and defeats the whole point of per-call tracking — so author discipline
    # is required: build indexes at actual module top level, not lazily.
    target = _call_reads[0]
    if target is None:
        if len(_boot_reads) >= _READS_CAP:
            _boot_overflow[0] = True
        else:
            _boot_reads.add((tag, ident))
        return
    if len(target) >= _READS_CAP:
        _call_overflow[0] = True
    else:
        target.add((tag, ident))


class Element:
    """A read snapshot of a model element, plus dry-run write helpers."""

    __slots__ = ("_data",)

    def __init__(self, data):
        self._data = data

    @property
    def id(self):
        """The element's id."""
        return self._data["id"]

    @property
    def stereotype(self):
        """The element's stereotype (type) name."""
        return self._data["type"]

    @property
    def name(self):
        """The element's display name, or None when the element is unnamed."""
        return self._data["name"]

    def __getitem__(self, key):
        return self._data["properties"][key]

    def get(self, key, default=None):
        """Return property `key`, or `default` if absent. `el[key]` raises instead.

        Example:
            height = el.get("height", 0)
        """
        return self._data["properties"].get(key, default)

    def props(self):
        """Return a dict copy of all properties.

        Example:
            print(el.props())
        """
        return dict(self._data["properties"])

    def outgoing(self, stereotype=None, other_stereotype=None, expected=None):
        """List outgoing Relationships, optionally filtered.

        `stereotype` (str or list) keeps only relationships of the named
        stereotype(s) or their subtypes; `other_stereotype` (str or list)
        keeps only relationships whose TARGET element matches. `expected`
        (int >= 1) asserts the filtered count — a mismatch raises
        dr.CardinalityError — and with expected=1 the single Relationship is
        returned directly instead of a list.

        Example:
            for rel in el.outgoing(stereotype="Owns"):
                print(rel.destination().name)
        """
        return self._hop("outgoing", stereotype, other_stereotype, expected)

    def incoming(self, stereotype=None, other_stereotype=None, expected=None):
        """List incoming Relationships. Same filters as `outgoing`;
        `other_stereotype` matches the SOURCE element.

        Example:
            owner = el.incoming(stereotype="Owns", expected=1).source()
        """
        return self._hop("incoming", stereotype, other_stereotype, expected)

    def _hop(self, direction, stereotype, other_stereotype, expected):
        # Shared driver behind `outgoing`/`incoming` (underscored: internal,
        # and the docs walker skips it -- the two public wrappers carry the
        # docstrings). Validation of `expected` runs BEFORE any bridge work so
        # a bad argument costs no round trip and always reports the same way
        # regardless of what the model happens to contain.
        if expected is not None:
            # bool is an int subclass -- reject it explicitly, True would
            # otherwise pass as expected=1.
            if (
                isinstance(expected, bool)
                or not isinstance(expected, int)
                or expected < 1
            ):
                raise ValueError(
                    "expected must be a positive int, got " + repr(expected)
                )
        # Read-set tags stay "out"/"in" (the shapes `api/invalidation.py`'s
        # `touched_keys` emits) even though the ops/memo keys are the longer
        # "outgoing"/"incoming" -- renaming either would silently break
        # incremental invalidation.
        _note_read("out" if direction == "outgoing" else "in", self.id)
        key = (direction, self.id)
        hit = _memo.get(key)
        if hit is None:
            resp = _read(direction, element_id=self.id)
            # Hop responses ship the far endpoints' element projections
            # inline (trip-collapse, spec 2026-07-21 Phase A') -- prime the
            # element memo with them BEFORE storing the relationships, so
            # `rel.destination()` / `rel.source()` is a memo hit instead of
            # one round trip per neighbor. `or []` keeps this tolerant of the
            # host's high-degree guard (`bridge._MAX_INLINE_FAR_ENDPOINTS`),
            # which ships no inline elements at all past its threshold.
            for proj in resp.get("elements") or []:
                _memo_put(("element", proj["id"]), proj)
            hit = resp["relationships"]
            _memo_put(key, hit)
        rel_allowed = _stereotype_filter("relationship", stereotype)
        other_allowed = _stereotype_filter("element", other_stereotype)
        rels = []
        for r in hit:
            # Wire key stays "type" (the host's relationship projection
            # contract); only the snippet-visible spelling is `stereotype`.
            if rel_allowed is not None and r["type"] not in rel_allowed:
                continue
            if other_allowed is not None:
                far_id = r["target_id"] if direction == "outgoing" else r["source_id"]
                try:
                    far = _fetch_element(far_id)
                except NotFoundError:
                    # Dangling far endpoint (the engine stays inspectable):
                    # treated as non-matching, never raising. An unfiltered
                    # hop still returns such relationships.
                    continue
                if far.stereotype not in other_allowed:
                    continue
            # Copy each relationship dict (via _copy_projection, so
            # list-valued properties are copied too) -- the memo entry is
            # shared canonical state (see the invariant comment above
            # `_memo`); a snippet mutating a Relationship's data (e.g.
            # `rel["tags"].append(...)`) must not change what a later hop
            # returns. The enclosing `rels` list is freshly built per call,
            # so the memo's own list object never escapes either.
            rels.append(Relationship(_copy_projection(r)))
        if expected is not None and len(rels) != expected:
            parts = []
            if stereotype is not None:
                parts.append("stereotype=" + repr(stereotype))
            if other_stereotype is not None:
                parts.append("other_stereotype=" + repr(other_stereotype))
            detail = " (" + ", ".join(parts) + ")" if parts else ""
            raise CardinalityError(
                "element " + repr(self.id) + " has " + str(len(rels)) + " "
                + direction + " relationships" + detail
                + ", expected " + str(expected)
            )
        if expected == 1:
            return rels[0]
        return rels

    def parent(self):
        """Return the containment parent Element, or None at a root."""
        _note_read("parent", self.id)
        key = ("parent", self.id)
        if key in _memo:
            parent_id = _memo[key]
        else:
            parent_id = _read("parent", element_id=self.id)["parent_id"]
            _memo_put(key, parent_id)
        if parent_id is None:
            return None
        return _fetch_element(parent_id)

    def children(self):
        """List containment child Elements.

        Example:
            for child in el.children():
                print(child.name)
        """
        _note_read("children", self.id)
        key = ("children", self.id)
        hit = _memo.get(key)
        if hit is None:
            hit = _read("children", element_id=self.id)["children"]
            for proj in hit:
                _memo_put(("element", proj["id"]), proj)
            _memo_put(key, hit)
        # `hit`'s dicts are the SAME objects primed into the ("element", id)
        # memo entries above (or, on a repeat call, into the "children" memo
        # entry from a prior call) — build each Element over a copy (via
        # _copy_projection, which also copies list-valued properties) so a
        # snippet holding one of these children can't mutate the shared
        # projection out from under a later `dr.element(child_id)` call.
        return [Element(_copy_projection(d)) for d in hit]

    def set(self, key, value):
        """Record a dry-run property update. Nothing changes until staged and committed.

        Example:
            el.set("name", "Renamed")
        """
        _write({"kind": "update_element", "id": self.id, "properties_patch": {key: value}})

    def delete(self):
        """Record a dry-run delete of this element (containment children cascade at commit)."""
        _write({"kind": "delete_element", "id": self.id})

    def __repr__(self):
        return "Element(id=" + repr(self.id) + ", stereotype=" + repr(self.stereotype) + ")"


class Relationship:
    """A read snapshot of a model relationship, returned by
    `Element.outgoing`/`Element.incoming`.

    Read-only on purpose: there is no `.set()`/`.delete()` here (use
    `dr.disconnect(rel.id)` to record a dry-run delete), and `value()`/
    `step()` still reject a Relationship return — the wire payload shapes
    only carry elements and scalars.
    """

    __slots__ = ("_data",)

    def __init__(self, data):
        # `data` MUST already be a `_copy_projection` copy, never a live
        # `_memo` entry -- see the invariant comment above `_memo`.
        self._data = data

    @property
    def id(self):
        """The relationship's id."""
        return self._data["id"]

    @property
    def stereotype(self):
        """The relationship's stereotype (type) name."""
        # Wire key stays "type" (the host's projection contract).
        return self._data["type"]

    def __getitem__(self, key):
        return self._data["properties"][key]

    def get(self, key, default=None):
        """Return property `key`, or `default` if absent. `rel[key]` raises instead.

        Example:
            weight = rel.get("weight", 0)
        """
        return self._data["properties"].get(key, default)

    def props(self):
        """Return a dict copy of all properties.

        Example:
            print(rel.props())
        """
        return dict(self._data["properties"])

    def source(self):
        """Return the source Element of this relationship.

        Example:
            owner = rel.source()
        """
        return _fetch_element(self._data["source_id"])

    def destination(self):
        """Return the destination (target) Element of this relationship.

        Example:
            owned = rel.destination()
        """
        return _fetch_element(self._data["target_id"])

    def __repr__(self):
        return (
            "Relationship(id=" + repr(self.id)
            + ", stereotype=" + repr(self.stereotype) + ")"
        )


def _fetch_element(element_id):
    """Fetch a single element by id.

    Example:
        el = dr.element("some-id")
        print(el.name)
    """
    _note_read("el", element_id)
    key = ("element", element_id)
    proj = _memo.get(key)
    if proj is None:
        proj = _read("element", element_id=element_id)["element"]
        _memo_put(key, proj)
    # `proj` may be the memo's own dict (on a hit, or after _memo_put aliases
    # it in) — build the Element over a copy (via _copy_projection, which
    # also copies list-valued properties) so `Element._data` is never the
    # live memo entry. See the invariant comment above `_memo`.
    return Element(_copy_projection(proj))


# Deliberately NOT memoized: a whole-model scan does not fit the single
# `(op_name, id_or_None)` memo key shape, and re-running the same scan
# twice in one snippet is rare enough not to be worth a bespoke key scheme
# here. Its read-set key is recorded once per call regardless of how many
# pages it takes (`_note_read` before the loop, not per page).
def _iter_elements(stereotypes=None):
    """Iterate all elements, optionally filtered by stereotype name(s).

    `stereotypes` is a single name or a list of names; matches include
    subtypes of each named stereotype. Pages transparently.

    Example:
        for el in dr.elements(stereotypes="Building"):
            print(el.name)
    """
    # One ("scan", name) read tag per REQUESTED name -- not one per expanded
    # subtype, and never the list object itself (unhashable, and it would
    # match nothing `api/invalidation.py`'s `touched_keys` ever emits). The
    # unfiltered scan keeps its distinct ("scan", None) tag, which that
    # module treats as "depends on every stereotype".
    if stereotypes is None:
        names = None
        _note_read("scan", None)
    else:
        names = [stereotypes] if isinstance(stereotypes, str) else list(stereotypes)
        for s in names:
            _note_read("scan", s)
    offset = 0
    while True:
        # Wire key stays "type" (the host's `elements_page` contract); only
        # the snippet-visible parameter name is `stereotypes`.
        resp = _read("elements_page", type=names, offset=offset, limit=500)
        for item in resp["elements"]:
            # No _copy_projection here, and that is deliberate: scan pages are
            # never put in `_memo` (see the comment above this function), so
            # each projection is a fresh per-page object no other read path
            # can ever hand out again. Aliasing the HOST's model is handled at
            # the source instead — `bridge.py`'s `_copy_properties` already
            # copied list-valued property values out of the live `Element` —
            # so this stays copy-free on the whole-model scan hot path.
            yield Element(item)
        next_offset = resp.get("next_offset")
        if next_offset is None:
            return
        offset = next_offset


def _create(stereotype, properties=None):
    """Record a dry-run element create. Returns a temp id usable as a
    source_id/target_id in a later dr.connect() within this run. The temp id
    is NOT resolvable via dr.element() -- the create is only a recorded op,
    never applied to the model this run reads against.

    Example:
        tid = dr.create("Building", {"name": "HQ"})
    """
    temp_id = _next_temp_id()
    resp = _write({
        "kind": "create_element",
        "temp_id": temp_id,
        # Wire key stays "type_name" (the recorded-op contract); only the
        # snippet-visible parameter name is `stereotype`.
        "type_name": stereotype,
        "properties": dict(properties) if properties else {},
    })
    return resp.get("temp_id", temp_id)


def _connect(stereotype, source_id, target_id, properties=None):
    """Record a dry-run relationship create between two element ids (real or temp).
    Returns the relationship's temp id.

    Example:
        dr.connect("Owns", parent_id, child_id)
    """
    temp_id = _next_temp_id()
    resp = _write({
        "kind": "create_relationship",
        "temp_id": temp_id,
        # Wire key stays "type_name" — see `_create` above.
        "type_name": stereotype,
        "source_id": source_id,
        "target_id": target_id,
        "properties": dict(properties) if properties else {},
    })
    return resp.get("temp_id", temp_id)


def _disconnect(rel_id):
    """Record a dry-run relationship delete.

    Example:
        dr.disconnect(rel_id)
    """
    _write({"kind": "delete_relationship", "id": rel_id})


class _Dr:
    ReadOnlyError = ReadOnlyError
    NotFoundError = NotFoundError
    BridgeError = BridgeError
    CardinalityError = CardinalityError

    element = staticmethod(_fetch_element)
    elements = staticmethod(_iter_elements)
    create = staticmethod(_create)
    connect = staticmethod(_connect)
    disconnect = staticmethod(_disconnect)


dr = _Dr()

_WIRE_SCALARS = (str, int, float, bool)


def _dr_call_entry(entry, element_ids, elements=None):
    # Single per-call driver for embedded sessions (M2/M3): prime the read
    # memo with the host-projected roots, build handles, invoke the entry
    # point, serialize, and report the call's read-set (boot reads union
    # per-call reads; None on overflow). Both hosts call THIS — per-call
    # semantics live in one place, so the runners cannot drift. Roots the
    # host could not project are absent from `elements`; _fetch_element then
    # surfaces NotFoundError exactly as a direct fetch would. Raises on
    # snippet errors — the caller owns exception -> error-result mapping
    # (and an errored call ships no reads: reads=None, always-evict). NOT
    # part of the documented dr API (underscored on purpose). Saves/restores
    # the prior _call_reads/_call_overflow rather than resetting to a fixed
    # None/False in `finally`: today the driver is never reentrant (nothing
    # calls `_dr_call_entry` while another invocation is on the stack), so a
    # fixed reset and a restore are observably identical -- but a future
    # nested or write-enabled driver would otherwise silently attribute its
    # boot/inner-call reads to the WRONG frame the moment reentrancy showed
    # up, which is exactly the kind of silent-stale-value bug this module
    # exists to prevent. The restore costs nothing today and removes that
    # failure mode for free.
    prior_reads = _call_reads[0]
    prior_overflow = _call_overflow[0]
    _call_reads[0] = set()
    _call_overflow[0] = False
    try:
        for proj in elements or []:
            _memo_put(("element", proj["id"]), proj)
        fn = globals().get(entry)
        if fn is None or not callable(fn):
            raise NameError("entry function " + repr(entry) + " is not defined")
        els = [_fetch_element(i) for i in element_ids]
        value = fn(els if entry == "value" else (els[0] if els else None))
        payload = _dr_serialize_entry_result(entry, value)
        if _boot_overflow[0] or _call_overflow[0]:
            reads = None
        else:
            merged = _boot_reads | _call_reads[0]
            if len(merged) > _READS_CAP:
                reads = None
            else:
                # Sort key avoids comparing None to str directly: a
                # ("scan", None) (unfiltered scan) and a ("scan", "Building")
                # (stereotype-filtered scan) can coexist in one call's set,
                # and plain `sorted(list(k) for k in merged)` raises
                # TypeError trying to order their second elements against
                # each other.
                reads = sorted(
                    (list(k) for k in merged),
                    key=lambda k: (k[0], k[1] is not None, k[1] or ""),
                )
        return {"payload": payload, "reads": reads}
    finally:
        _call_reads[0] = prior_reads
        _call_overflow[0] = prior_overflow


def _dr_serialize_entry_result(entry, value):
    # Session wire serializer for embedded entry-point calls (M2/M3): maps a
    # value()/step() return value to the tagged payload the host validates
    # with runner.decode_call_payload. Unsupported shapes raise ValueError;
    # the session loop reports that as the call's error. NOT part of the
    # documented dr API (underscored on purpose).
    if entry == "step":
        if value is None:
            return {"ids": []}
        if isinstance(value, str):
            raise ValueError(
                "step() must return an iterable of Elements or element ids"
            )
        try:
            items = list(value)
        except TypeError:
            raise ValueError(
                "step() must return an iterable of Elements or element ids"
            )
        ids = []
        for item in items:
            if isinstance(item, Element):
                ids.append(item.id)
            elif isinstance(item, str):
                ids.append(item)
            else:
                raise ValueError(
                    "step() must return an iterable of Elements or element ids"
                )
        return {"ids": ids}
    if isinstance(value, Element):
        return {"kind": "element", "id": value.id}
    if value is None or isinstance(value, _WIRE_SCALARS):
        return {"kind": "scalar", "value": value}
    if isinstance(value, (list, tuple)):
        items = list(value)
        if items and all(isinstance(v, Element) for v in items):
            return {"kind": "elements", "ids": [v.id for v in items]}
        if all(v is None or isinstance(v, _WIRE_SCALARS) for v in items):
            return {"kind": "scalars", "values": items}
    raise ValueError(
        "value() must return a scalar, a list of scalars, an Element, "
        "or a list of Elements"
    )
'''
