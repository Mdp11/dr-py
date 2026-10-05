# `core/script/` — snippet facade reference

The `dr` facade source (`facade_src.py`), the payload schema (`schema.py`),
the generated authoring reference (`docs.py`, served by `GET /snippets/docs`)
and the server-side lint (`lint.py`). It imports only `data_rover.core.*` +
stdlib. Snippets run in the browser engine (`engine/src/script/`, which
embeds `FACADE_SOURCE` and implements the bridge in `bridge.ts`); the server
never runs one. See `src/data_rover/api/README.md`'s "Code execution, tables
and exports" section for the routes.

## The `dr` facade surface

Per-member reference is generated from the facade's own docstrings (see
core/script/docs.py and GET /snippets/docs) — those docstrings are
canonical; this section is the narrative overview.

`dr` is not a Python module on disk — it is the string constant
`FACADE_SOURCE` in `facade_src.py`, `exec`'d verbatim ahead of the snippet's
own source (in a fresh namespace with `_transport` and `_read_memo_max`
already bound by the engine's bridge). The guest `exec`s the same string the
docs are generated from, so the surface below is exactly what a snippet
author gets.

The facade and the snippet are **two separate compilation units** — the facade
under the filename `<facade>`, the snippet under `<snippet>`. Keeping them
separate means `line N` is the line the author sees in the editor, and
the guest's traceback filter strips facade frames as
well as harness frames. Concatenating them would offset every traceback frame
and every `SyntaxError` by the facade's ~300 lines and make facade internals
appear as snippet frames.

Module-level exceptions (all subclass `dr.BridgeError`, itself
`Exception`):

- `dr.BridgeError` — generic/unclassified error from a bridge response's
  `"error"` field that doesn't match a more specific case below.
- `dr.ReadOnlyError(dr.BridgeError)` — raised when `record_op` is attempted
  against a dispatcher built with `record_ops=False` (a `"value"`/`"step"`
  run — see "Read-only / dry-run stance").
- `dr.NotFoundError(dr.BridgeError)` — raised when a requested element/
  relationship id does not exist (bridge response `"error"` starts with
  `"KeyError"`), and when a hop's `stereotype=`/`other_stereotype=` filter
  names a stereotype the metamodel doesn't have (the `descendants` read op
  raises `KeyError` on an unknown name, so a typo'd filter surfaces instead
  of silently matching nothing).
- `dr.CardinalityError(dr.BridgeError)` — raised when a hop's `expected=`
  count assertion fails (`el.outgoing(..., expected=N)` found some other
  number of *filtered* relationships). Purely guest-side: no bridge response
  carries this. A malformed `expected` argument (not an int, a `bool`, or
  `< 1`) is a plain `ValueError` instead, raised before any bridge work.

Top-level functions/attributes on `dr`:

| call | semantics |
|---|---|
| `dr.element(element_id) -> Element` | Fetch one element by id. Raises `dr.NotFoundError` if it doesn't exist. |
| `dr.elements(stereotypes=None) -> Iterator[Element]` | Lazily iterate all elements, optionally filtered by stereotype. `stereotypes` is `None` (no filter), a single name, or a list of names; each name is expanded HOST-side through `Metamodel.element_descendants` (so a filter matches that stereotype **or any subtype**) and the expansions are unioned. An empty list is a real filter matching nothing — distinct from `None`. An unknown name expands to the empty set and therefore silently matches nothing here (unlike the hop filters below, which raise `dr.NotFoundError` on a typo — `_op_elements_page` expands names itself and never validates them). Pages transparently via the bridge's `elements_page` op (the facade requests 500 per page, clamped host-side to `page_limit`; see limits table) — a snippet never sees pagination. |
| `dr.create(stereotype, properties=None) -> str` | Records a `create_element` op (dry-run — see below) and returns a client-side temp id (`"tmp_1"`, `"tmp_2"`, ...) usable as a `source_id`/`target_id` in a later `dr.connect()` call within the same run. The recorded op's wire key is `"type_name"`; the snippet-visible parameter is spelled `stereotype`. |
| `dr.connect(stereotype, source_id, target_id, properties=None) -> str` | Records a `create_relationship` op (wire key `"type_name"` likewise); returns a temp id the same way. |
| `dr.disconnect(rel_id)` | Records a `delete_relationship` op. Returns `None`. |

`Element` (returned by `dr.element`, `dr.elements`, `Element.parent`,
`Element.children`, `Relationship.source`/`destination`; `__slots__ =
("_data",)`, wraps the bridge's plain
`{"id", "type", "name", "properties"}` projection):

| member | semantics |
|---|---|
| `.id` / `.stereotype` / `.name` | The element's id, stereotype (type) name, and display name. `.name` is resolved HOST-side by `_project_element` via `core.model.naming.name_of` — the same case-insensitive `name`/`Name`/`NAME` resolution the tree/search/table code uses, with a list-valued (multiplicity-many) name contributing its first non-empty string entry — and is `None` when no usable name property exists. There is **no id fallback** (that is `display_name`, which the facade does not use). The raw bag is still reachable via `el.props()`/`el.get("name")` — not `el["name"]`, which raises a plain `KeyError` whenever the property is absent or spelled `Name`/`NAME`, precisely the cases where `.name`'s resolution differs. `repr(el)` is `Element(id=..., stereotype=...)`. Handles compare **by id** (`__eq__`/`__hash__`), never by identity — every accessor mints a fresh handle, so `dr.element(x) == dr.element(x)` is `True` and handles work as set members / dict keys; `Relationship` has the same contract. |
| `el[key]` | `properties[key]` — raises a plain (not `dr.`) `KeyError` if the property is absent, since this reads the already-fetched local dict, not a fresh bridge call. |
| `el.get(key, default=None)` | `properties.get(key, default)`. |
| `el.props() -> dict` | A shallow copy of the full property bag. |
| `el.outgoing(stereotype=None, other_stereotype=None, expected=None)` | Outgoing `Relationship` objects, sorted by relationship id host-side. `stereotype`/`other_stereotype` accept a str or a list of names and match that stereotype **or any subtype** (the filter is applied GUEST-side over the memoized unfiltered hop; descendant closures come from the internal `descendants` bridge op, memoized per `(kind, name)` for the session). As with `dr.elements`, an empty list for either filter is a real filter matching nothing — distinct from `None`. `other_stereotype` checks the far — for `outgoing`, the TARGET — element's stereotype; a dangling far endpoint (the engine stays inspectable) is treated as non-matching, never raising, while an *unfiltered* hop still returns that relationship. `expected` (an int ≥ 1; `bool` is rejected explicitly since it is an `int` subclass) asserts the **filtered** count, raising `dr.CardinalityError` naming the element id, the direction, the active filters, and expected vs. actual; with `expected=1` the single `Relationship` is returned directly instead of a one-item list. A bad `expected` is a `ValueError` raised before any bridge work. At most one bridge round trip for the hop itself regardless of filters — the hop is memoized under `(direction, self.id)`, so repeating it on the same element within the same run costs zero round trips — plus, on first use, one `descendants` trip per distinct filter name, and per-neighbor `element` fetches under `other_stereotype` whenever trip-collapse inlining didn't prime the memo: past the bridge's high-degree guard (`_MAX_INLINE_FAR_ENDPOINTS`), or for a dangling far endpoint below that threshold, which the bridge silently omits from the inline list. |
| `el.incoming(stereotype=None, other_stereotype=None, expected=None)` | Same, with the far element being the relationship's SOURCE. |
| `el.parent() -> Element | None` | The containing element, or `None` at a containment root. |
| `el.children() -> list[Element]` | Elements reached via this element's own outgoing containment relationships (derived host-side from `metamodel.is_containment`, not a dedicated model index). |
| `el.set(key, value)` | Records an `update_element` op with `properties_patch={key: value}`. Dry-run — see below. |
| `el.delete()` | Records a `delete_element` op. Dry-run — see below. |

`Relationship` (returned by `Element.outgoing`/`Element.incoming` — the only
two members that produce one; `__slots__ = ("_data",)`, wrapping a
`_copy_projection` copy of the bridge's plain `{"id", "type", "name",
"properties", "source_id", "target_id"}` relationship projection, never a
live `_memo` entry):

| member | semantics |
|---|---|
| `.id` / `.stereotype` | The relationship's id and stereotype (type) name. The wire key is `"type"`; the snippet-visible spelling is `.stereotype`. `repr(rel)` is `Relationship(id=..., stereotype=...)`. |
| `rel[key]` | `properties[key]` — a plain (not `dr.`) `KeyError` if absent, same reasoning as `el[key]`. |
| `rel.get(key, default=None)` | `properties.get(key, default)`. |
| `rel.props() -> dict` | A shallow copy of the full property bag. |
| `rel.source() -> Element` | The relationship's source element (`_fetch_element(source_id)`). |
| `rel.destination() -> Element` | The relationship's target element (`_fetch_element(target_id)`). |

Both `.source()`/`.destination()` are ordinary `_fetch_element` calls, so
they are memo-primed by trip collapse (a hop response inlines its far
endpoints' projections) and therefore typically cost **zero** round trips —
but they always record an `("el", id)` read in the call's read-set, memo hit
or not. There is deliberately **no** `.name` (the wire projection does carry
a `name` key — a raw `properties.get("name")`, *not* the `name_of`
resolution `Element.name` gets — but the facade exposes no accessor for it;
`rel.get("name")` is the same value) and no `.set()`/`.delete()`: recording
a relationship delete goes through
`dr.disconnect(rel.id)`, and `value()`/`step()` reject a `Relationship`
return value outright since the tagged wire payloads only carry elements and
scalars.

## The read-only / dry-run stance

Every `dr` **read** (`element`, `elements`, `Element.outgoing`/`incoming`/
`parent`/`children`, `Relationship.source`/`destination`, plus the internal
`descendants` closure lookup behind the hop filters) is answered by the
engine's bridge from its own replica through read accessors only, so a run can
never corrupt the model.

Every `dr` **write** (`create`, `connect`, `disconnect`, `Element.set`,
`Element.delete`) is *recorded, not applied*: the bridge appends the op dict
to the run's op list and returns. The list is a *proposal*; nothing changes
until the client stages it and commits it through `POST /commits`, exactly as
a human-driven edit would. Only size/count caps (`max_ops`, `max_op_bytes`)
are enforced at the bridge; op shape is validated at the commit boundary.

Whether writes are allowed is controlled by the *caller*, not the snippet:
only `entry="script"` runs may record ops; `"value"`/`"step"` runs get a
read-only bridge, so any `dr` write call there raises `dr.ReadOnlyError`.

Entry-point calling convention: a `"value"` run calls the snippet's
top-level `value(elements)` with a **list of `Element` handles** — one per
bound id, in that order; a `"step"` run calls `step(el)` with its single bound
element. `step` and `transform` are exactly one argument. A table script
column that declares `inputs` calls `value(elements, inputs)` instead —
`inputs` is a `dict[str, list]`, one key per declared input, each value the
`Element` handles or scalars the named column holds for the row (`[]` for an
empty cell). Lint accepts a `value` of arity 1 or 2; `step`/`transform` stay
one-arg.
