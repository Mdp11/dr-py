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
"""

from __future__ import annotations

FACADE_SOURCE = '''
# dr facade -- exec'd ahead of snippet code. Requires a module-level
# _transport(req: dict) -> dict callable to already be bound in this
# namespace (see facade_src.py's host-side docstring for the contract).


class BridgeError(Exception):
    # Generic/unclassified error surfaced from a bridge response's "error".
    pass


class ReadOnlyError(BridgeError):
    # A write was attempted against a dispatcher constructed with
    # record_ops=False (bridge response "error" starts with "ReadOnlyError").
    pass


class NotFoundError(BridgeError):
    # Requested element/relationship id does not exist (bridge response
    # "error" starts with "KeyError").
    pass


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


class Element:
    __slots__ = ("_data",)

    def __init__(self, data):
        self._data = data

    @property
    def id(self):
        return self._data["id"]

    @property
    def type(self):
        return self._data["type"]

    @property
    def name(self):
        return self._data["name"]

    def __getitem__(self, key):
        return self._data["properties"][key]

    def get(self, key, default=None):
        return self._data["properties"].get(key, default)

    def props(self):
        return dict(self._data["properties"])

    def out(self):
        return _read("outgoing", element_id=self.id)["relationships"]

    def in_(self):
        return _read("incoming", element_id=self.id)["relationships"]

    def parent(self):
        parent_id = _read("parent", element_id=self.id)["parent_id"]
        if parent_id is None:
            return None
        return _fetch_element(parent_id)

    def children(self):
        return [Element(d) for d in _read("children", element_id=self.id)["children"]]

    def set(self, key, value):
        _write({"kind": "update_element", "id": self.id, "properties_patch": {key: value}})

    def delete(self):
        _write({"kind": "delete_element", "id": self.id})

    def __repr__(self):
        return "Element(id=" + repr(self.id) + ", type=" + repr(self.type) + ")"


def _fetch_element(element_id):
    return Element(_read("element", element_id=element_id)["element"])


def _iter_elements(type=None):
    offset = 0
    while True:
        resp = _read("elements_page", type=type, offset=offset, limit=500)
        for item in resp["elements"]:
            yield Element(item)
        next_offset = resp.get("next_offset")
        if next_offset is None:
            return
        offset = next_offset


def _list_types():
    return _read("types")["types"]


def _type_info(name):
    return _read("type_info", type=name)


def _create(type_name, properties=None):
    temp_id = _next_temp_id()
    resp = _write({
        "kind": "create_element",
        "temp_id": temp_id,
        "type_name": type_name,
        "properties": dict(properties) if properties else {},
    })
    return resp.get("temp_id", temp_id)


def _connect(type_name, source_id, target_id, properties=None):
    temp_id = _next_temp_id()
    resp = _write({
        "kind": "create_relationship",
        "temp_id": temp_id,
        "type_name": type_name,
        "source_id": source_id,
        "target_id": target_id,
        "properties": dict(properties) if properties else {},
    })
    return resp.get("temp_id", temp_id)


def _disconnect(rel_id):
    _write({"kind": "delete_relationship", "id": rel_id})


class _Dr:
    ReadOnlyError = ReadOnlyError
    NotFoundError = NotFoundError
    BridgeError = BridgeError

    element = staticmethod(_fetch_element)
    elements = staticmethod(_iter_elements)
    types = staticmethod(_list_types)
    type = staticmethod(_type_info)
    create = staticmethod(_create)
    connect = staticmethod(_connect)
    disconnect = staticmethod(_disconnect)


dr = _Dr()
'''
