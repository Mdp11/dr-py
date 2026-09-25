# Navigation script steps: value terminals + chain badge

Date: 2026-07-28
Branch: `worktree-fix+nav-script-step-nonelement`

## Problem

Two defects in navigation `ScriptStep` (M3 embedded evaluation), both visible
in standalone navigations and in table navigation columns.

1. **A `step()` that does not return elements is broken.** The guest facade's
   `step` serializer accepts only `None`, an `Element`, an element-id `str`, or
   an iterable of those. Anything else raises guest-side, surfacing as a
   `runtime` `CallResult.error`, which `_hop_script` turns into a
   `NAV_STEP_FAILED` warning and a pruned chain. A snippet returning a scalar
   (`return len(el.name)`) fails outright; a snippet returning a text property
   (`return el.properties["name"]`) is silently interpreted as an element id,
   fails to resolve, and is dropped with a `NAV_UNKNOWN_IDS` warning.

   `PropertyStep` already has the right behaviour for this situation: when the
   stepped-on property is scalar, the chain **terminates at the value**, carried
   as a `PropertyValue` node so the UI can display it, and no further step can
   extend that chain. Script steps must behave the same way.

2. **The script step row has no chain badge.** Every other step row renders a
   `ChainBadge` on the numbered rail — `RelationshipStepRow` and
   `PropertyStepRow` show their column number, `FilterStepRow` shows the ghost
   dot (`value={null}`). `ScriptStepRow` renders nothing, so a path containing a
   script step has a visual hole in its rail even though the step *does* advance
   the chain (`PathCard.columnFor` already counts it).

## Design

### 1. `step()` may return values

The `step` entry point's tagged wire payload changes shape:

```
before: {"ids":   [str, ...]}
after:  {"nodes": [str | int | float | bool, ...]}
```

No tag is needed on each node — JSON's own types carry the distinction the host
needs, and a string stays ambiguous *by design* (see the resolution rule below).

Guest side (`core/script/facade_src.py`, `_dr_serialize_entry_result`):

| `step()` returns | emitted nodes |
|---|---|
| `None` | `[]` (ends the chain, unchanged) |
| an `Element` | `[element.id]` |
| a `str` | `[the string]` |
| an `int` / `float` / `bool` | `[the value]` |
| an iterable of any of the above | one node per item; `None` items are skipped |
| anything else (or an iterable containing anything else) | `ValueError`, surfacing as a `runtime` `CallResult.error` |

The single-value cases stay checked **before** generic iteration, for the reason
already documented: a bare `Element` would otherwise be "iterated" through its
`__getitem__` (`KeyError: 0`) and a bare id string per character.

The error message is updated to name the new accepted shapes:

```
step() must return an Element, an element id, a scalar value, an iterable of
those, or None (None ends the chain); got <TypeName>
```

Host side (`core/script/runner.py`, `decode_call_payload`) validates the new
shape from the untrusted guest: `payload["nodes"]` must be a `list` whose items
are each `str | int | float | bool`. Anything else returns
`(None, "malformed step() result payload")` as today. The two functions are
documented as agreeing by construction; both change in the same commit, along
with the `step` row of the wire-shape table in `core/script/README.md`.

### 2. Resolution rule in `_hop_script`

`core/navigation/evaluate.py::_hop_script` returns `list[ChainNode]` (already
the declared return type) built per node, preserving the snippet's own return
order and the existing dedup:

- a `str` that names an element in `model.elements` → that element id (an
  element hop, exactly as today);
- a `str` that does not → `PropertyValue(the string)`, a terminal;
- any non-`str` scalar → `PropertyValue(the value)`, a terminal.

An `Element` return therefore always hops (its id is by construction in the
model), and `return el.properties["name"]` shows the name and ends the chain.

**Consequence — the `NAV_UNKNOWN_IDS` warning stops firing.** There is no
unknown-id path left: every string either resolves or is displayed. The emit
site in `_hop_script` is removed. The `ScriptWarningCode.NAV_UNKNOWN_IDS`
member and the frontend's `formatScriptWarning` case are **kept**: the wire
vocabulary is deliberately open (`ScriptWarningSchema.code` is `z.string()`, not
an enum, so a client formats codes from any server version), and the code is the
generic counted-warning fixture across several test files.

This mirrors the reasoning already recorded in `_walk` for the removed
`NAV_ALREADY_VISITED` warning: a warning that fires constantly for intended
behaviour trains users to ignore the badge.

### 3. Terminals block further navigation (already true)

No change is needed. `_walk` already returns early when the chain's current node
is not a `str`:

```python
current = chain[-1]
if not isinstance(current, str):
    return False
```

so a step following a value terminal prunes that chain — identical to a scalar
`PropertyStep` followed by another step. The comment there is extended to name
script steps as a second producer of terminals.

Everything downstream is already built for `PropertyValue` and needs no change:
`ChainResult.chains` typing, `api/schemas.py::ChainValueOut`, the frontend's
`ChainValueSchema` / `ChainNodeSchema` and its results-dock rendering, and
`core/table/{evaluate,cells}.py`, which already unwrap `PropertyValue` in row
keys, expand slots, sort atoms and cells.

### 4. The chain badge

`ScriptStepRow.svelte` gains a `column: number` prop and renders
`<ChainBadge value={column} />` as the row's first child, exactly as
`PropertyStepRow` and `RelationshipStepRow` do. `PathCard.svelte` passes
`column={columnFor(i)}`; `columnFor` needs no change — it counts every non-filter
step, script steps included.

## Explicitly out of scope

**Statically blocking authoring of steps after a script step.**
`PropertyStepRow`'s `deadEnd` affordance (and `PathCard`'s `blockedAt`) can close
the rail down because the metamodel *declares* the property's datatype. A
snippet's return type is unknowable before it runs, and a script step normally
does return elements, so a static block would break the common case. The block
stays runtime-only, which is what "block further navigation" means here.

## Testing

Python:

- `tests/navigation/test_script_step.py`
  - `step()` returning an `int` / `float` / `bool` yields a `PropertyValue`
    terminal chain, no warning;
  - `step()` returning a string that is not an element id yields a
    `PropertyValue` terminal, no warning;
  - `step()` returning a string that *is* an element id still hops (regression);
  - a mixed list yields elements and terminals in return order;
  - a step following a value-producing script step prunes those chains;
  - rewrite `test_script_step_unknown_ids_dropped_with_warning` to assert the new
    resolve-else-show behaviour, and delete
    `test_unknown_ids_across_many_chains_sum_instead_of_collapsing` (its real
    subject, `ScriptWarningLog` count aggregation, is covered directly by
    `tests/script/test_warnings.py`).
- `tests/script/` — `decode_call_payload` accepts the new `nodes` shape and
  rejects malformations (wrong container, non-scalar members); the facade's
  serializer maps each accepted return shape and raises on the rest.
- Table-side coverage that a navigation column whose path ends in a script value
  terminal renders the value (the plumbing is shared with property terminals, so
  one test pinning the seam is enough).

Frontend:

- `Navigation/__tests__/script-step-row.test.ts` — the badge renders with the
  supplied column number.
- `Navigation/__tests__/path-card.test.ts` — numbering is correct for a path
  mixing relationship, filter and script steps (filters do not consume a number).

Commands: `pixi run core-test`, `pixi run frontend-test`, `pixi run dr-tidy`.
