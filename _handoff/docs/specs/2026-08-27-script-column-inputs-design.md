# Script column inputs — design

Date: 2026-08-27 · Status: approved design, pre-plan

## 1. Summary

A `ScriptColumn` can declare **named inputs**: references to earlier columns
whose per-row values are handed to the snippet beside its source elements,
as `value(elements, inputs)` with `inputs: dict[str, list]`. It closes the
gap where a script column starting from the row slot cannot see what a
sibling column resolved to for the same row, and the reverse navigation is
multi-valued so the script cannot recover the row element from the sibling.

Design decisions taken during brainstorming:

- **Explicit inputs, not whole-row visibility.** The column names exactly the
  columns it reads. The cache key stays small, a column recomputes only when
  *its* inputs change, and the sweep's dedupe keeps working.
- **Named dict, not positional list or keyword arguments.** Each input has a
  required identifier `name`; the snippet reads `inputs["status"]`. Survives
  reordering the inputs list; lint's arity rule stays a simple count.
- **Failures propagate; they are never laundered into `[]`.** A pending input
  makes the column pending; an errored input makes it an error cell naming
  the input. Neither is cached, so the column self-heals when the input
  computes. Passing `[]` instead would cache a wrong answer under a key that
  cannot know the input was broken.

Cycles are impossible by construction: `ColumnRef`s are backward-only
(`TableDefinition._validate_sources`), so column order is a topological
order and an input can only name a column to its left. Nothing new is needed
at evaluation time.

## 2. Contract

### 2.1 Schema (`core/table/schema.py`)

```python
class ScriptInput(BaseModel):
    name: str          # Python identifier, not a keyword; unique within the column
    ref: ColumnRef     # backward-only; step_index allowed iff the ref'd column is navigation

class ScriptColumn(BaseModel):
    ...
    inputs: list[ScriptInput] = []
```

- Default `[]` — every saved table round-trips unchanged; no migration.
- No dedicated cap: inputs are bounded by `MAX_COLUMNS` (50), each naming a
  distinct earlier column. Two inputs may name the same column under
  different names (harmless; not worth a rule).
- **Any** column kind is a legal input — element, property, navigation,
  script — with no element-producing/arity check, unlike `source`.
- Validation joins `_validate_sources`: `ref.index < i` (same message shape
  as the source rule), the existing `step_index`-requires-navigation rule,
  `name.isidentifier()` and not a keyword, names unique within the column.
- `ColumnRef.step_index` on an input keeps its meaning: resolve the
  navigation column at that chain step instead of its projected step.

### 2.2 Snippet calling convention

```python
def value(elements, inputs):
    ...
```

- `inputs[name]` is **always a list**:
  - `list[Element]` for an element-producing input (element column,
    navigation column, script column that returned element(s));
  - `list[scalar]` for a property input or a scalar-returning script input;
  - exactly one item for an `expand` input — this row's promoted binding;
  - `[]` for an empty cell (nothing reached, property absent, `keep_empty`
    row).
- A column with **no** inputs keeps calling `value(elements)` with one
  argument. Existing snippets are byte-for-byte unaffected.
- Lint (`core/script/lint.py::derive_entry_points`) recognizes `value` with
  **1 or 2** positional parameters. `step` and `transform` keep their exact
  one-arg rule; navigation `ScriptStep` inputs are out of scope.

### 2.3 Arity mismatch

A column with inputs whose `value` takes one argument:

- **inline code** → **422 at table save**, an AST check in the `table` kind's
  adapter beside the schema validation (`value() takes 1 argument but column
  declares N inputs`);
- **ref** to a `code_snippet` artifact → cannot be pinned at save (the
  artifact is edited independently), so it renders an **error cell** with the
  same message, where a dangling ref renders its error today.

A snippet with a 2-arg `value` on a column with **no** inputs is the mirror
case: 422 inline, error cell for a ref (`value() takes 2 arguments but column
declares no inputs`). The guest never guesses an arity.

### 2.4 Failure propagation

Resolved host-side before any guest call:

| input cell state | column A |
|---|---|
| value (possibly empty) | `inputs[name] = [...]` / `[]`, snippet called |
| `pending` | A is `pending`; not memoized, not cached |
| error (runtime, timeout, unavailable, dangling ref, …) | A is an error cell `input '<name>': <original message>`; not memoized, not cached |

Both failure outcomes are derived fresh on every render from the input's own
(cached) result, so they cost no guest work and disappear the moment the
input computes.

## 3. Evaluation and caching

### 3.1 One resolver, one call site

Today six places call `script.call(code, "value", roots)`: the page cell
(`cells._script_cell`), the expand build and `keep_empty` filter, the
collapse-as-source resolution, the sort atom (`evaluate.py`) and the sweep
drain (`api/script_sweep.py`). They collapse onto two functions in a new
`core/table/script_inputs.py`:

- `resolve_script_inputs(mm, model, defn, key, col, base_slots, limits,
  script, memo) -> ResolvedInputs | InputFailure`. For each `ScriptInput` it
  computes exactly what that column's cell holds for this row:
  - element-producing ref → the existing `resolve_source_elements` (already
    handles navigation, `step_index`, script-as-source and expand slots);
  - property ref → the value derivation factored out of `cells._property_cell`
    into a shared function, so the input and the rendered cell cannot drift;
  - scalar-returning script ref → the memoized call's `scalar`/`scalars`
    payload.

  `ResolvedInputs` is `{name: ("elements", ids) | ("scalars", values)}`;
  `InputFailure` carries `(name, kind: "pending" | "error", message)`.
- `call_script_column(script, col, roots, inputs)` — the single wrapper every
  site uses. With `inputs=None` it is today's call, bit-for-bit.

### 3.2 Cache key

`ScriptEvalContext.call(code, entry, element_ids, *, inputs=None, ...)` and
`CellKey` gain a fourth component:

- `""` when the column has no inputs — existing keys, and therefore existing
  memo/cell-cache/sweep behaviour, stay byte-identical;
- otherwise `sha256(canonical JSON of the resolved inputs)[:32]`. Hashed
  because a property input can be a long text and because the memo and the
  sweep's `seen` set hold these tuples by the thousand. Scalars are
  serialized with type tags so `1`, `1.0`, `"1"` and `True` never collide.

### 3.3 Invalidation

Nothing new. An input's **resolved value** is in the key: a commit that
changes what B holds changes A's key, so A misses and recomputes, and the
stale entry ages out of the LRU. Element inputs put only ids in the key, but
anything the snippet then reads off those `Element` handles goes through the
bridge and lands in the call's read-set, which `ScriptCellCache.evict_touched`
already honours. No host-side read escapes invalidation.

### 3.4 Sweep (`api/script_sweep.py`)

- `_Item` becomes `(code, roots, inputs_payload)`; dedupe widens naturally —
  same roots with different inputs are two items.
- Enumeration resolves inputs **live with the serial context**, exactly as it
  already resolves a script-column *source* live (the "sweep-covered
  boundary" rule in `core/script/README.md`). An input that is itself a
  script column is therefore computed and cached serially before A's item is
  queued; A's item carries concrete inputs and the workers resolve nothing.
- An input that is pending or errored at enumeration counts like an
  empty-source cell (`dup_or_empty`): there is nothing to compute for A, and
  the failing cell is accounted for by its own column. If the hole persists
  the terminal sweep reports `failed`, as it already does for any hole.
- Parallelizing script-column inputs across workers (wave scheduling) is a
  possible later optimization, not part of this design.

### 3.5 Row-order cache

`TableOrderCache` is untouched. Sort atoms treat "A failed on an input" as
they treat "A errored" (sorts with empties), and a pending anywhere already
declines to cache the order.

## 4. Wire and guest

- The per-call bridge message (`api/script_runner.py`, the `"call"` branch)
  gains an optional `"inputs"` field beside `"doc"`:
  `{name: {"kind": "elements", "ids": [...]} | {"kind": "scalars", "values": [...]}}`.
  The tag set is closed; the host decodes it with the same strictness as
  `decode_call_payload`, so a guest never sees an untyped structure.
- `SnippetSession.call(entry, element_ids, *, doc=None, inputs=None)`
  (`core/script/runner.py`); `tests/script/trusted_runner.py` mirrors it.
- Guest side, `_dr_call_entry` (`core/script/facade_src.py`) builds the dict:
  element inputs become `Element` handles through the same memoized
  `_fetch_element` the roots use (so the read-set contract holds), scalars
  pass through. It calls `fn(els, inputs)` when `inputs is not None`, else
  `fn(els)`.
- Element-input projections ride the existing trip-collapse inlining
  (`project_roots`), so a handle's first `.get()` costs no round trip — the
  same treatment roots get.

## 5. Frontend

- `ScriptColumnEditor.svelte` gains an **Inputs** block under the source: one
  row per input with a `name` text field (validated as identifier + unique,
  inline error) and an earlier-column picker reusing `ColumnSourceEditor`
  (which already renders the earlier-column select and the `step_index`
  picker for navigation refs), plus add/remove controls.
- `frontend/src/lib/table/columns.ts`: `moveColumn`, `removeColumn` and the
  insert helper remap every `inputs[].ref.index` exactly as they remap
  `source`; a move that would push an input forward throws like the existing
  forward-source guard.
- `api/types.ts` mirrors `ScriptInput`/`ScriptColumn.inputs`.
- The snippet editor's placeholder/doc snippet shows `value(elements, inputs)`
  when the column has inputs.

## 6. Documentation

- `core/script/README.md`: calling convention (1 or 2 args), wire-contract
  table (`inputs` field), evaluation-sessions section (fourth key component,
  sweep enumeration rule, failure propagation).
- `CLAUDE.md`: one sentence in the embedded-evaluation bullet on the `inputs`
  key component and the "resolved value is in the key" invalidation rule.
- `frontend/README.md`: the editor block.

## 7. Testing

TDD, per the test file that already owns each area:

- `tests/table/test_schema.py` — backward-only inputs; `step_index` rule;
  identifier/keyword/uniqueness on names; default `[]` round-trips unchanged.
- `tests/table/test_script_column.py` (via `TrustedRunner`) — property input
  (scalars); navigation input (elements); expand input (single binding);
  scalar-script input; empty input → `[]`; pending input → pending cell;
  errored input → error cell naming the input; 1-arg `value` with inputs →
  error cell (ref form); 2-arg `value` without inputs → error cell; a column
  without inputs still calls with one argument.
- `tests/api` — inline arity mismatch is a 422 at table save, both directions.
- `tests/script/test_embed_cache.py`, `test_cell_cache.py` — key differs by
  input value; identical without inputs; type-tag collisions (`1` vs `"1"` vs
  `True`); failure-derived results never stored.
- `tests/script/test_lint.py` — 2-arg `value` derives `"value"`; 3-arg does
  not.
- `tests/api/test_script_sweep*.py` — dedupe widens by inputs; a
  script-column input is computed at enumeration; pending input counted as
  done; the table reports `failed` if the hole persists.
- `tests/api/test_snippets_wasm.py` (integration-marked) — one end-to-end
  `value(elements, inputs)` through the real guest.
- Frontend — `columns.test.ts` remaps; a vitest for `ScriptColumnEditor`
  name validation.

## 8. Out of scope

- Inputs on navigation `ScriptStep`.
- Inputs naming the row slot (that is `source`).
- Cross-table inputs.
- Wave-scheduling the sweep to parallelize script-column inputs.
- Whole-row visibility (rejected in §1).
