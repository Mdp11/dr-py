# Relationship keys in uniqueness validation

**Date:** 2026-06-15
**Status:** Approved, ready for planning

## Problem

Two requests against uniqueness validation:

1. **Ownership always included.** Two elements identical on their declared keys but
   with different owners must not be considered duplicates.
2. **Relationships in keys.** A metamodel author should be able to list relationships
   in an element type's `key`, so that identity also depends on which other elements
   this element is connected to. Two elements are duplicates only if, in addition to
   matching key properties and owner, they have the same number of key relationships
   each reaching/leaving the same elements.

### Item 1 is already implemented

The uniqueness key is `(type_name, owner, signature)` where `owner` is the element's
first containment parent (`indexes.py:_uniq_key`). Elements matching on key properties
but with different owners already fall into different groups (see
`test_duplicate_keyed_elements_different_owners_ok`). **Item 1 requires no change** and
this design preserves that behaviour exactly. The work below is entirely item 2.

## Decisions (agreed)

- **Syntax:** extend the existing `key: list[str]` with a string-prefix DSL. A bare
  string is a property (unchanged). `out:R` / `in:R` denote a relationship key.
  Example: `key: [name, age, out:Parent, in:School]`.
- **Match semantics:** multiset of endpoints — same connected element ids *and* the same
  number of edges to each. Parallel duplicate edges matter.
- **Direction:** explicit per entry via the `out:` / `in:` prefix.
- **Metamodel validation:** the relationship type must exist, and the element type must
  be endpoint-compatible (on the source end for `out:`, target end for `in:`).
- **Exact relationship-type match:** a `Parent` key counts edges whose `type_name` is
  exactly `Parent`, not edges of `Parent`'s subtypes. (Consistent with `out_count` /
  `in_count` and `end_constraints`, which key by exact type name.)

## Design

### 1. Key DSL & parsing — `core/metamodel/schema.py`

`ElementType.key` stays `list[str]`. Each entry is classified:

- starts with `out:` → outgoing relationship key
- starts with `in:` → incoming relationship key
- otherwise → property name (unchanged)

New frozen dataclasses and a pure parse helper:

```python
@dataclass(frozen=True)
class KeyRel:
    rel_type: str
    direction: Literal["out", "in"]

@dataclass(frozen=True)
class KeySpec:
    properties: tuple[str, ...]
    relationships: tuple[KeyRel, ...]

def parse_key_entry(entry: str) -> str | KeyRel: ...
def parse_key(entries: Sequence[str]) -> KeySpec: ...
```

`_Caches` gains `effective_element_key_specs: dict[str, KeySpec | None]`, built in
`_build_caches` from the same first-declared-key-up-the-chain walk that already
produces `effective_element_keys`. The raw `effective_element_keys` cache and the
`effective_element_key()` accessor are left untouched (keeps existing callers and
`tests/metamodel/test_resolution.py` working). New accessor:

```python
def effective_element_key_spec(self, name: str) -> KeySpec | None: ...
```

**DSL boundary (documented in the schema docstring):** property names must not contain
`:`. Any entry beginning with `out:` or `in:` is a relationship key.

### 2. Metamodel validation — `core/metamodel/check.py`

In the existing per-type key loop, parse each entry:

- **property** → existing "key references unknown property" check (unchanged).
- **`out:R` / `in:R`**:
  - `R` must be a declared relationship type, else
    `Element 'T': key references unknown relationship 'R'`.
  - endpoint compatibility: for `out:`, the element type must be a subtype-or-supertype
    of some mapping **source** of `R`; for `in:`, of some mapping **target**. This
    tolerates keys declared on an abstract supertype and inherited by concrete subtypes.
    On failure:
    `Element 'T': key relationship 'out:R' is invalid — 'T' is not on the source end of 'R'`.

The empty-key check (`key must be non-empty`) is unchanged.

### 3. Identity signature — `core/model/indexes.py`

`_uniq_key` keeps `(type_name, owner, signature)`. `owner` (first containment parent)
is unchanged.

For a **keyed** type, `signature` becomes a 2-tuple `(prop_values, rel_values)`:

- `prop_values` — today's frozen value tuple over `KeySpec.properties`
  (empty tuple if the key is relationship-only).
- `rel_values` — for each `KeyRel` in declared order, the endpoint multiset rendered
  as `tuple(sorted(endpoint_ids))`:
  - `out:R` → target ids of this element's outgoing edges whose `type_name == R`.
  - `in:R` → source ids of this element's incoming edges whose `type_name == R`.

  Endpoints are gathered by scanning the element's incident relationship ids
  (`out_rels` / `in_rels`) and looking each up in `model.relationships`, filtering on
  exact `type_name`. Only runs for types whose `KeySpec.relationships` is non-empty.

**No-key types are unchanged** — full-property frozen signature, no relationship
component (no key declared ⇒ no relationship keys possible). The `UniqKey` type alias
comment is updated to describe the new keyed shape.

### 4. Incremental maintenance — `core/model/indexes.py`

Two lazily-built cached sets derived from the metamodel:

- `_out_key_rel_types: set[str]` — rel-type names appearing with `out:` in any
  element type's effective key.
- `_in_key_rel_types: set[str]` — likewise for `in:`.

In `on_relationship_created` and `on_relationship_deleted`, after adjacency
(`out_rels`/`in_rels`/counts/containment) is updated:

- if `rel.type_name in _out_key_rel_types` → `_rekey_if_present(rel.source_id)`
- if `rel.type_name in _in_key_rel_types` → `_rekey_if_present(rel.target_id)`

Endpoint ids are stable, so a key-edge connect/disconnect only rekeys its own two
endpoints — no cascade through the graph. Types with no relationship keys skip the
rekey entirely (set membership miss).

`rebuild()` already inserts all relationships before iterating elements, so
`_uniq_key`'s adjacency scan sees a complete graph during bulk load — no change needed
there. `verify_consistent()` continues to assert the incremental indexes equal a fresh
rebuild, now covering relationship-key signatures.

### 5. Validator message — `core/validation/validators/uniqueness.py`

`_issue` reads the `KeySpec` (via `effective_element_key_spec`) to render both parts of
a keyed duplicate, e.g.:

```
Duplicate Person element e2: matches e1 (name='Foo', out:Parent→[p1], in:School→[s1, s1])
```

Property-only keys render as before; the no-key path
(`no key — all properties match`) is unchanged.

### 6. Tests

`tests/validation/test_uniqueness.py`:

- multiset match: identical endpoints + counts → duplicate; differing count or
  differing endpoint id → not duplicate.
- direction independence: an `out:R`-keyed type and an `in:R`-keyed type group correctly
  and independently.
- incremental: connecting/disconnecting a key edge flips duplicate status; assert
  `model.indexes.verify_consistent()` after each mutation.
- relationship-only key (no property part).
- existing property-only and no-key tests still pass unchanged.

`tests/metamodel/` (check + resolution):

- `out:R` / `in:R` parse into the expected `KeySpec`.
- unknown relationship and wrong-end errors are reported by `check_metamodel`.
- endpoint compatibility tolerates a key inherited from an abstract supertype.

## Out of scope

- **Item 1** — already implemented; preserved, not modified.
- **Frontend** — `key` remains `list[str]`; nothing breaks. No UI work in this change.
- **Legacy direct-mutation routes** (`routes/elements.py`, `relationships.py`) — they
  already `touch_model()` and rebuild indexes, so they pick up the new signatures for
  free.
