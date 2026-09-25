# Snippet API rename: `stereotype` surface, `Relationship` class, filterable hops

**Date:** 2026-07-22
**Status:** Approved design, pre-implementation
**Areas:** `src/data_rover/core/script/` (facade_src, bridge, docs), frontend editor completions, tests

## Goal

Rework the snippet-visible `dr` facade API:

1. Everything snippet authors see as "type" becomes **"stereotype"**.
2. Remove `dr.types()` and `dr.type(name)` (verified: no production callers outside the facade itself).
3. `dr.elements(type=None)` becomes `dr.elements(stereotypes=None)` accepting a single name or a list.
4. Fix `Element.name` (broken for models whose name property is not exact-lowercase `name`).
5. `Element.in_()` / `Element.out()` become `incoming()` / `outgoing()` with stereotype filters.
6. Relationships become a real `Relationship` class (like `Element`), returned by the hop methods.

## Decisions made (with user)

| Decision | Choice |
| --- | --- |
| `in()` is a Python reserved keyword — `el.in()` is a SyntaxError, impossible | Rename the pair to `incoming()` / `outgoing()` |
| Backward compatibility for saved snippets | **Hard break.** No aliases. Old snippets fail at run time with ordinary `AttributeError`/`TypeError` and render as error cells (the degraded-not-failed stance holds; nothing 5xxs). |
| Hop filter signature | `outgoing(stereotype=None, other_stereotype=None)` — each kwarg accepts a str or list of str; filters respect metamodel inheritance |
| `Element.name` fallback | `name_of` semantics: **`None` when no usable `name`/`Name`/`NAME` property exists** (revised from an earlier id-fallback choice). Resolution order (already implemented in `core/model/naming.py`): exact-lowercase `name` first, then other casings (`Name`/`NAME`), list-valued names contribute their first non-empty string entry. |
| Hop cardinality assertion | `expected=` kwarg on `outgoing()`/`incoming()`: positive int; fails with an informative error when the (filtered) count differs; `expected=1` returns a single `Relationship` instead of a list |
| `dr.elements` kwarg name | `stereotypes=` (rule 1 consistency wins over the literal `types=` in the original request) |

## Scope boundary

The rename is **facade-surface only**. Unchanged:

- Core (`Element.type_name`, `Metamodel`, ops schema `type_name` keys, `OpIn` shapes).
- The guest↔host **wire protocol** keys (`"type"` in projections, `"type_name"` in recorded ops). Host and guest ship together, but renaming wire keys buys nothing and touches the trip-collapse memo priming.
- Read-set tag names (`"scan"`, `"el"`, `"out"`, `"in"`, `"children"`, `"parent"`) and the whole `api/invalidation.py` machinery.

## New public API

```python
dr.element(id) -> Element
dr.elements(stereotypes=None) -> iterator of Element   # str | list[str] | None
dr.create(stereotype, properties=None) -> str (temp id)
dr.connect(stereotype, source_id, target_id, properties=None) -> str (temp id)
dr.disconnect(rel_id)
# dr.types() and dr.type() REMOVED, along with the bridge "types"/"type_info" ops.

Element.id -> str
Element.stereotype -> str            # replaces Element.type; repr updated too
Element.name -> str | None           # name_of semantics, None when unnamed (fixed)
Element[key] / Element.get(key, default) / Element.props()
Element.outgoing(stereotype=None, other_stereotype=None, expected=None)
Element.incoming(stereotype=None, other_stereotype=None, expected=None)
    # -> list[Relationship]; with expected=1 -> a single Relationship
Element.parent() -> Element | None
Element.children() -> list[Element]
Element.set(key, value) / Element.delete()

Relationship.id -> str               # NEW class
Relationship.stereotype -> str
Relationship[key] / Relationship.get(key, default) / Relationship.props()
Relationship.source() -> Element
Relationship.destination() -> Element
Relationship.__repr__ -> "Relationship(id=..., stereotype=...)"
```

Deliberately **not** included (YAGNI, user-approved): `Relationship.name`, `Relationship.set()`, `Relationship.delete()` (deletes stay on `dr.disconnect(rel.id)`). `value()`/`step()` continue to reject `Relationship` returns with the existing `ValueError`.

## Design

### Element.name fix (`bridge.py`)

`_project_element` currently does a bare `element.properties.get("name")`; models whose
names live under `Name`/`NAME` (typical for migrated legacy models) project `None`.
Fix: project `"name"` via `core.model.naming.name_of(element)` — the same
resolution the tree/search/table code uses (exact-lowercase `name` first, then other
casings, list-valued names), but **without** the id fallback: `el.name` is `None`
for a genuinely unnamed element, so scripts can distinguish and fall back to
`el.id` themselves.
`_project_relationship` keeps its current bare lookup (the new `Relationship` class
does not expose `.name`).

### Hop filtering: guest-side, over the memoized unfiltered response

**Chosen approach:** `outgoing()`/`incoming()` keep fetching the full unfiltered hop
exactly as today — same bridge ops, same memo keys (`("outgoing", id)` /
`("incoming", id)`), same read-set tags (`("out", id)` / `("in", id)`). Filtering
happens guest-side after the memo read, on the copied projections.

**Rejected alternative:** bridge-side filtered ops. Would parameterize memo keys by
filter combination and force the read-set/invalidation layer to understand filtered
hops — strictly more risk on the load-bearing soundness surface for no gain.

Semantics:

- `stereotype=` matches the relationship's stereotype; `other_stereotype=` matches
  the far element's stereotype (target for outgoing, source for incoming).
- Each accepts a str or a list of str; a relationship passes a filter if its (or its
  far element's) stereotype is the named stereotype **or any descendant of it**
  (matching `dr.elements`' existing inheritance behavior). Multiple entries OR
  together; both kwargs together AND.
- `None` (default) means no filtering — byte-identical behavior to today apart from
  the return type.
- **Dangling far endpoint** (inspectable-engine case): with `other_stereotype` set,
  a relationship whose far element does not resolve is treated as **non-matching**
  (silently excluded), never raising. Unfiltered calls still return such
  relationships, exactly as today.

Inheritance expansion needs metamodel knowledge the guest lacks. One new **internal**
bridge read op, `descendants` (request `{"op": "descendants", "kind":
"element"|"relationship", "name": <stereotype>}` — `kind` disambiguates the two
type namespaces), returns the descendant name set for a stereotype (covering element and relationship stereotypes; unknown
names raise `KeyError` → `NotFoundError`, consistent with the removed `type_info`).
Memoized guest-side under `("descendants", name)`-style keys. **No read-set tag**: the
metamodel is immutable per session, and a metamodel swap goes through the
clear-all/session-replacement path, so cached cells can never observe a stale
descendant set.

`other_stereotype` filtering resolves far elements through `_fetch_element`, which:

- is almost always a zero-trip memo hit (trip-collapse inlines far endpoints), and
- correctly records `("el", far_id)` reads — required for soundness, since the
  filtered result genuinely depends on the far elements. (Element stereotypes are
  immutable — no op changes an element's type — so the dependency is only on
  existence, which `("el", id)` covers via create/delete touched-keys.)

On the high-degree-hub path (`_MAX_INLINE_FAR_ENDPOINTS` exceeded, no inlining),
`other_stereotype` filtering degrades to one memoized fetch per distinct far
endpoint — correct, just not free. Document in the facade docstring.

**Cardinality assertion (`expected=`):** both hop methods take `expected=None`.
When set, it must be an `int` ≥ 1 (anything else — `0`, negatives, non-ints —
raises `ValueError` immediately). The check applies to the **filtered** result:
if the count differs from `expected`, the call raises `CardinalityError` (a new
`BridgeError` subclass, exposed as `dr.CardinalityError` alongside the existing
exceptions) with an informative message carrying the element id, the direction,
the active filters, and expected vs. actual counts, e.g.
`CardinalityError: element 'b1' has 3 outgoing relationships (stereotype='Owns'),
expected 1`. When `expected == 1` and the check passes, the method returns the
single `Relationship` directly instead of a one-element list. With
`expected=None` (default) no check runs and the return is always a list. In an
embedded cell/step the raise surfaces through the normal snippet-error path — an
error cell / pruned chain, degraded not failed.

### `Relationship` class (facade)

Snapshot wrapper over a **copied** relationship projection, mirroring `Element`:
built via `_copy_projection` from the memoized hop response, honoring the
copy-on-return invariant (a snippet mutating `rel.props()` or `rel[key]` results
must never reach the memo). `source()`/`destination()` call `_fetch_element` on
`source_id`/`target_id` — memo-primed by trip collapse, records `("el", id)`.

`out()`/`in_()` currently return raw dicts; after this change the hop methods return
`list[Relationship]`. Dict access (`rel["target_id"]`) is gone — hard break.

### `dr.elements(stereotypes=...)` (facade + bridge)

- Facade signature: `_iter_elements(stereotypes=None)`; normalizes a str to a
  one-element list; records one `("scan", s)` read tag **per requested stereotype**
  (exact requested names), or `("scan", None)` when unfiltered — recorded once per
  call before paging, as today.
- Bridge `elements_page` keeps the wire key `"type"`, now accepting
  `None | str | list[str]` (guest and host change in lockstep). Host expands each
  name via
  `metamodel.element_descendants` and unions the sets.
- Invalidation is already sound for this: `api/invalidation.py`'s `scan_keys` emits a
  typed `("scan", t)` for every ancestor of a changed element's type plus
  `("scan", None)`, so a scan recorded under any requested ancestor stereotype is
  correctly evicted.

### Removal of `dr.types()` / `dr.type()`

Delete `_list_types`, `_type_info`, their `_Dr` bindings, the bridge `types` /
`type_info` ops, their `_RETURNS` entries, and the frontend completion behaviors
that reference `dr.type(`. Consequence (accepted): snippets lose in-snippet
metamodel introspection; the `descendants` op is internal and not exposed on `dr`.

## Ripple surface (checklist for the implementation plan)

- **`facade_src.py`** — all of the above; docstrings + examples updated (they feed
  the docs pipeline and the editor reference panel).
- **`bridge.py`** — projection name fix, multi-stereotype `elements_page`,
  new `descendants` op, remove `types`/`type_info` ops; module docstring's read-op
  list updated.
- **`docs.py`** — add a `Relationship` class walk (currently only `_Dr` + `Element`);
  update `_RETURNS`; the undocumented-member tripwire keeps everything honest.
- **`lint.py`** — check for facade-name references (entry-point derivation is
  AST-shape-based and should be unaffected; verify).
- **`core/script/README.md`** — facade reference section rewritten.
- **Frontend** — `frontend/src/lib/editor/completion-source.ts`: drop `dr.type` from
  `TYPE_STRING_RE`, handle `stereotypes=` (including the list form after `[`),
  complete `Relationship.` members from the docs feed alongside `Element.`;
  placeholder snippet in `components/Snippet/CodeEditor.svelte`; completion tests.
- **Tests** (~15–20 files under `tests/script/`, `tests/api/`, `tests/table/`,
  `tests/navigation/` use `el.type` / `in_()` / `dr.elements(type=)` / rel-dict
  access) — mechanical updates, plus **new** coverage:
  - filter semantics: single/list, inheritance match, both kwargs ANDed,
    `other_stereotype` on incoming vs outgoing, dangling far endpoint excluded;
  - `expected=`: mismatch raises `CardinalityError` with element id/direction/
    filters/counts in the message; `expected=1` returns a bare `Relationship`;
    check runs on the *filtered* count; invalid values (`0`, negative, non-int)
    raise `ValueError`; error surfaces as an error cell in embedded runs;
  - `Relationship` copy invariants (mutating `props()`/`get` results never poisons
    the memo — extend the existing memo-aliasing tests);
  - zero-trip `source()`/`destination()` via `tests/script/test_trip_counts.py`;
  - `Element.name` casing fix (`Name`, list-valued, `None` when unnamed);
  - multi-stereotype scan read-sets + the invalidation soundness property net
    (`tests/script/test_read_sets.py`, `tests/api/` soundness tests).

## Compatibility & risk register

| Risk | Disposition |
| --- | --- |
| `el.in()` impossible (`in` is a keyword) | Resolved: `incoming()`/`outgoing()` |
| Saved `code_snippet` artifacts break at run time | Accepted (hard break). Error cells at 200; no 5xx; no migration tooling. |
| Read-set/invalidation soundness | Protected by design: no tag or memo-key shape changes; new far-element reads are recorded; `descendants` needs no tag (immutable metamodel). |
| Doc/completion drift | `docs.py` tripwire + completion tests force same-commit updates. |
| Wire protocol drift | None: wire keys unchanged; guest+host ship together anyway. |
