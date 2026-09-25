# Navigation script steps: value terminals + chain badge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a navigation `ScriptStep` whose `step()` returns a non-element show that value as a terminal chain node (blocking further navigation), exactly like a scalar `PropertyStep` does, and give the script step row the numbered chain badge every other step row already has.

**Architecture:** The `step` entry point's guest→host wire payload changes from `{"ids": [str, …]}` to `{"nodes": [str | int | float | bool, …]}` — untagged, because JSON's own types carry the distinction. `core/navigation/evaluate.py::_hop_script` then resolves each node: a string naming an element in the model hops as today, anything else becomes a `PropertyValue` terminal. `PropertyValue` is the node type scalar property steps already produce, so every downstream layer (chain serialization, results dock, table row keys and cells, the `_walk` guard that blocks steps past a terminal) already handles it unchanged. The frontend change is a single missing `<ChainBadge>`.

**Tech Stack:** Python 3.14 (pydantic v2, pytest), SvelteKit 5 frontend (vitest + happy-dom), all driven through `pixi run`.

## Global Constraints

- Everything runs through **pixi**. There is no global `python` or `node`. Core/API tests: `pixi run core-test`; a single test: `pixi run -e core-dev pytest tests/path/test.py::test_name -v`. Frontend tests: `pixi run frontend-test` (the task sets `cwd = "frontend"`; running `npm test` from the repo root fails). Lint/format/typecheck: `pixi run dr-tidy` (ruff + mypy + pyright must ALL pass).
- `pythonpath=src` is set in `pytest.ini` — import as `from data_rover.core...`.
- `core/script/facade_src.py`'s `_dr_serialize_entry_result` (guest-side encoder) and `core/script/runner.py`'s `decode_call_payload` (host-side untrusted-payload validator) are documented as agreeing **by construction**. Never change one without the other in the same commit, and update the wire-shape table in `core/script/README.md` with them.
- `facade_src.py` is a Python **string** (`FACADE_SOURCE`) exec'd inside the WASM guest. It may not import anything; use only what is already defined in that module (`Element`, `_WIRE_SCALARS = (str, int, float, bool)` at line 676).
- Code in this repo carries dense docstrings explaining **why** invariants exist. Preserve and extend that style — the invariants are load-bearing.
- The vendored guest binary (`spikes/code_exec/vendor/python.wasm`) may not be present. `tests/api/test_snippets_wasm.py` is `integration`-marked and is normally deselected; update it anyway, but do not treat its absence from a run as a failure.

---

### Task 1: `step()` wire shape carries values

**Files:**
- Modify: `src/data_rover/core/script/facade_src.py:741-766` (the `entry == "step"` branch of `_dr_serialize_entry_result`)
- Modify: `src/data_rover/core/script/runner.py:319-323` (the `entry == "step"` branch of `decode_call_payload`)
- Modify: `src/data_rover/core/script/README.md` (the `step` row of the "Tagged return-value wire shapes" table, ~line 355)
- Test: `tests/script/test_session.py:64-115` and `:160-220` (decode + serializer + session tests)
- Test: `tests/script/test_trip_counts.py:253-255`
- Test: `tests/api/test_snippets_wasm.py:484`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `decode_call_payload("step", …)` returns `{"nodes": list[str | int | float | bool]}` on success. Task 2 reads `res.value["nodes"]`.

- [ ] **Step 1: Write the failing tests**

In `tests/script/test_session.py`, replace `test_decode_step_payloads` (currently at line 64) with:

```python
def test_decode_step_payloads() -> None:
    decoded, msg = decode_call_payload("step", {"nodes": ["a", "b"]})
    assert (decoded, msg) == ({"nodes": ["a", "b"]}, None)
    # Values ride the same list as ids — the host, not the guest, decides
    # which strings name elements (see navigation/evaluate.py::_hop_script).
    decoded, msg = decode_call_payload("step", {"nodes": ["a", 1, 2.5, True]})
    assert (decoded, msg) == ({"nodes": ["a", 1, 2.5, True]}, None)
    for bad in (
        None,
        {"nodes": "a"},
        {"nodes": [{"a": 1}]},
        {"nodes": [None]},
        {"ids": ["a"]},  # the pre-`nodes` shape is no longer accepted
        {"kind": "scalar", "value": 1},
    ):
        decoded, msg = decode_call_payload("step", bad)
        assert decoded is None and msg is not None
```

In the same file, replace `test_serialize_step_shapes` (currently at line 98) with:

```python
def test_serialize_step_shapes(small_model) -> None:
    ns = _facade_ns(small_model)
    ser = ns["_dr_serialize_entry_result"]
    el = ns["dr"].element(next(iter(small_model.elements)))
    assert ser("step", [el, "raw-id"]) == {"nodes": [el.id, "raw-id"]}
    assert ser("step", None) == {"nodes": []}
    # A bare `str` return (e.g. `return el.id`) is a single node, not
    # something to iterate char-by-char (see the `entry == "step"` branch in
    # facade_src.py).
    assert ser("step", el.id) == {"nodes": [el.id]}
    # A bare `Element` return (e.g. `return el.children()[0]`) is a single
    # element, not something to index via its property-access __getitem__.
    assert ser("step", el) == {"nodes": [el.id]}
    # Non-string scalars are legal now: the host renders them as terminal
    # values rather than failing the call.
    assert ser("step", 42) == {"nodes": [42]}
    assert ser("step", [1, 2.5, True, "text"]) == {"nodes": [1, 2.5, True, "text"]}
    # A None ITEM contributes no node (a None RETURN already ends the chain).
    assert ser("step", [el, None]) == {"nodes": [el.id]}
    with pytest.raises(ValueError):
        ser("step", {"a": 1})
    with pytest.raises(ValueError):
        ser("step", [[1]])
```

Also in the same file, update the three session-level `step` assertions:

- `test_session_step_entry` (line ~168): `assert res.value == {"nodes": [ids[0]]}`
- `test_session_step_accepts_bare_str_return` (line ~182): `assert res.value == {"nodes": [ids[0]]}`
- the remaining `{"ids": [eid]}` assertions at lines ~198, ~206, ~216: change each to `{"nodes": [eid]}`

Add one new session test right after `test_session_step_accepts_bare_str_return`:

```python
def test_session_step_returns_a_scalar(small_model) -> None:
    # A step() that computes a value rather than a hop is legal end-to-end:
    # the guest ships the scalar, the host turns it into a terminal chain
    # node (nav evaluator's job, tested in tests/navigation/test_script_step.py).
    ids = sorted(small_model.elements)
    sess = _open(small_model, "def step(el):\n    return len(el.id)")
    res = sess.call("step", [ids[0]])
    assert res.error is None
    assert res.value == {"nodes": [len(ids[0])]}
    sess.close()
```

In `tests/script/test_trip_counts.py:255`, change `assert res.value == {"ids": ["b1"]}` to `assert res.value == {"nodes": ["b1"]}`.

In `tests/api/test_snippets_wasm.py:484`, change `assert res.value == {"ids": [eid]}` to `assert res.value == {"nodes": [eid]}`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/script/test_session.py tests/script/test_trip_counts.py -v`
Expected: FAIL — the decode tests fail because `decode_call_payload` still reads `payload.get("ids")` and rejects `{"nodes": …}`; the serializer tests fail on `KeyError`/mismatch because the facade still emits `{"ids": …}`.

- [ ] **Step 3: Change the guest-side serializer**

In `src/data_rover/core/script/facade_src.py`, replace the whole `if entry == "step":` block (lines 741-766) with:

```python
    if entry == "step":
        # Nodes are UNTAGGED: JSON's own types carry the only distinction the
        # host needs. A string stays ambiguous ON PURPOSE — the host resolves
        # it against the model and falls back to a displayed terminal value
        # when it names no element (navigation/evaluate.py::_hop_script), so
        # `return el.properties["name"]` shows the name instead of vanishing
        # as an unknown id. The guest cannot make that call itself: resolving
        # would mean a model read, which would pollute the call's read-set
        # (and therefore cache invalidation) with a lookup the snippet never
        # asked for.
        if value is None:
            return {"nodes": []}
        # Single-value conveniences BEFORE generic iteration: a bare Element
        # would otherwise be "iterated" via its __getitem__ (KeyError: 0), and
        # a bare id string would be iterated per character.
        if isinstance(value, Element):
            return {"nodes": [value.id]}
        if isinstance(value, _WIRE_SCALARS):
            return {"nodes": [value]}
        _bad = (
            "step() must return an Element, an element id, a scalar value, "
            "an iterable of those, or None (None ends the chain); got "
        )
        try:
            items = list(value)
        except TypeError:
            raise ValueError(_bad + type(value).__name__)
        nodes = []
        for item in items:
            if isinstance(item, Element):
                nodes.append(item.id)
            elif item is None:
                continue  # a None ITEM contributes no node; a None RETURN ends the chain
            elif isinstance(item, _WIRE_SCALARS):
                nodes.append(item)
            else:
                raise ValueError(_bad + type(item).__name__)
        return {"nodes": nodes}
```

- [ ] **Step 4: Change the host-side validator**

In `src/data_rover/core/script/runner.py`, replace lines 319-323 (the `entry == "step"` branch of `decode_call_payload`) with:

```python
    if entry == "step":
        nodes = payload.get("nodes")
        # `_WIRE_SCALARS` deliberately admits values as well as ids: the
        # element/value split is made in `_hop_script`, not here (a hostile
        # guest can only choose what to send, never what it means).
        if isinstance(nodes, list) and all(isinstance(n, _WIRE_SCALARS) for n in nodes):
            return {"nodes": nodes}, None
        return None, "malformed step() result payload"
```

- [ ] **Step 5: Update the wire-shape documentation**

In `src/data_rover/core/script/README.md`, replace the `step` row of the "Tagged return-value wire shapes" table (~line 355) with:

```markdown
| `step` | `{"nodes": [str \| int \| float \| bool, ...]}` — `step()` may return `None` (→ `[]`, ending the chain), a single `Element`, a single `str`, a single scalar, or an iterable of those (`None` ITEMS are skipped); anything else raises, guest-side, `ValueError("step() must return an Element, an element id, a scalar value, an iterable of those, or None (None ends the chain); got <TypeName>")`, which surfaces as a `"runtime"` `CallResult.error`. Nodes are UNTAGGED: a `str` is ambiguous on purpose and the HOST decides (`navigation/evaluate.py::_hop_script` hops when it names a model element, otherwise emits a terminal `PropertyValue`), so a snippet returning a text property displays it rather than being dropped as an unknown id. The single-value cases are checked before generic iteration: a bare `Element` would otherwise be "iterated" via its `__getitem__` (`KeyError: 0`), and a bare id string would be iterated per character. |
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/script/ -v`
Expected: PASS (all of `tests/script/`, not just the two files — the trusted runner routes through `decode_call_payload` too).

Then run the whole core suite to see what Task 2 still owes:
Run: `pixi run core-test`
Expected: `tests/navigation/test_script_step.py` and any table/API test exercising nav script steps FAIL with `KeyError: 'ids'` from `_hop_script`. That is expected here and fixed in Task 2. Every other test passes.

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/core/script/facade_src.py src/data_rover/core/script/runner.py src/data_rover/core/script/README.md tests/script/test_session.py tests/script/test_trip_counts.py tests/api/test_snippets_wasm.py
git commit -m "refactor(script): step() wire payload carries values, not just ids"
```

---

### Task 2: `_hop_script` resolves ids, shows values

**Files:**
- Modify: `src/data_rover/core/navigation/evaluate.py:57-76` (`PropertyValue` docstring), `:79-92` (`ChainResult` docstring), `:345-379` (`_hop_script`), `:404-410` (the `_walk` terminal comment)
- Modify: `src/data_rover/core/navigation/schema.py:109-121` (`ScriptStep` docstring)
- Modify: `src/data_rover/core/script/warnings.py:1-20` (module docstring), `:31-42` (`NAV_UNKNOWN_IDS` member)
- Modify: `src/data_rover/core/table/cells.py:248-249` (comment only — the code already handles `PropertyValue`)
- Modify: `src/data_rover/api/schemas.py:880-887` (`ChainPageOut` docstring)
- Modify: `frontend/src/lib/api/types.ts:485-492` (`ChainValueSchema` doc comment), `frontend/src/lib/script/warnings.ts:25-31` (the `nav_unknown_ids` case comment)
- Test: `tests/navigation/test_script_step.py`
- Test: `tests/table/test_script_column.py` (one new seam test)

**Interfaces:**
- Consumes: `decode_call_payload("step", …) -> {"nodes": list[str | int | float | bool]}` (Task 1), surfaced as `res.value["nodes"]` from `ScriptEvalContext.call(code, "step", [element_id])`.
- Produces: `_hop_script(...) -> list[ChainNode]` where `ChainNode = str | PropertyValue`. No new public names.

- [ ] **Step 1: Write the failing tests**

In `tests/navigation/test_script_step.py`, add these imports to the existing import block if not already present:

```python
from data_rover.core.navigation.evaluate import PropertyValue, evaluate
```

Replace `test_script_step_unknown_ids_dropped_with_warning` (currently at line ~139) with:

```python
def test_script_step_unresolvable_string_becomes_a_value_terminal() -> None:
    # A string that names no element is DISPLAYED, not dropped: `step()` has
    # no declared return type, so the model decides per value — the same
    # stance a scalar PropertyStep takes, and what makes
    # `return el.properties["name"]` useful instead of silently empty.
    mm, model = _fixture()
    ids = sorted(model.elements)
    defn = _path([ScriptStep(
        snippet=_snip(f"def step(el): return ['{ids[0]}', 'no-such-id']")
    )])
    res = evaluate(mm, model, defn, script=_ctx(model))
    assert res.warnings == []                       # nothing was dropped
    seconds = sorted({chain[1] for chain in res.chains}, key=repr)
    # ids[0] hops (except from itself — the cycle guard); the unknown string
    # terminates every chain at its value.
    assert PropertyValue("no-such-id") in seconds
    assert ids[0] in seconds


def test_script_step_scalar_returns_become_value_terminals() -> None:
    mm, model = _fixture()
    defn = _path([ScriptStep(snippet=_snip("def step(el): return len(el.id)"))])
    res = evaluate(mm, model, defn, script=_ctx(model))
    assert res.warnings == []
    assert all(len(chain) == 2 for chain in res.chains)
    assert all(isinstance(chain[1], PropertyValue) for chain in res.chains)
    assert {chain[1] for chain in res.chains} == {
        PropertyValue(len(i)) for i in model.elements
    }


def test_script_step_mixed_return_keeps_order_and_both_node_kinds() -> None:
    mm, model = _fixture()
    ids = sorted(model.elements)
    defn = _path([ScriptStep(
        snippet=_snip(f"def step(el): return ['{ids[0]}', 7, 'note']")
    )])
    res = evaluate(mm, model, defn, script=_ctx(model))
    start = ids[1]                                   # not ids[0]: no cycle guard hit
    reached = [chain[1] for chain in res.chains if chain[0] == start]
    assert reached == [ids[0], PropertyValue(7), PropertyValue("note")]


def test_script_step_dedup_keeps_distinct_scalar_types() -> None:
    # dict.fromkeys would collapse True/1 (and 1/1.0) into one node — for
    # element ids that never mattered, but these render as "True" and "1".
    mm, model = _fixture()
    defn = _path([ScriptStep(snippet=_snip("def step(el): return [1, True, 1.0, 1]"))])
    res = evaluate(mm, model, defn, script=_ctx(model))
    start = sorted(model.elements)[0]
    reached = [chain[1] for chain in res.chains if chain[0] == start]
    assert reached == [PropertyValue(1), PropertyValue(True), PropertyValue(1.0)]


def test_step_after_a_value_terminal_prunes_the_chain() -> None:
    # "Block further navigation": identical to a scalar PropertyStep followed
    # by another step — the chain cannot continue from a value.
    mm, model = _fixture()
    ids = sorted(model.elements)
    defn = _path([
        ScriptStep(snippet=_snip("def step(el): return 'not-an-id'")),
        ScriptStep(snippet=_snip(f"def step(el): return ['{ids[0]}']")),
    ])
    res = evaluate(mm, model, defn, script=_ctx(model))
    assert res.chains == []
    assert res.warnings == []
```

Delete `test_unknown_ids_across_many_chains_sum_instead_of_collapsing` (currently at line ~205). Its real subject — `ScriptWarningLog` summing `total` across occurrences instead of collapsing to 1 — is already covered directly by `tests/script/test_warnings.py::test_repeat_kind_sums_total` and friends; with the emit site gone there is no navigation path left that can produce it.

In `tests/table/test_script_column.py`, add `ValuesCell` to the existing `from data_rover.core.table.cells import …` line (line 16) and append this seam test at the end of the file — it reuses the module's own `_mm()`/`_fixture()` (3 "Block" elements named "Block A"/"B"/"C"), `_snip()` and `_script_ctx()` helpers:

```python
def test_nav_script_step_value_terminal_renders_as_a_values_cell() -> None:
    """Seam test: a navigation column whose script step returns a NON-element
    reaches the cell layer as a `PropertyValue` terminal, exactly like a
    scalar property step, and renders as a `ValuesCell`. The unwrapping code
    in table/cells.py is shared between the two producers, so one test pins
    the seam rather than re-covering that module."""
    mm = _mm()
    model = _fixture()
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            ElementColumn(),
            NavigationColumn(
                navigation=NavigationSource(
                    definition=PathNavigation(
                        kind="path",
                        start=RowStart(),
                        steps=[
                            ScriptStep(
                                snippet=_snip("def step(el):\n    return el.name")
                            )
                        ],
                    )
                ),
            ),
        ],
    )
    ctx = _script_ctx(model)
    build = build_rows_ex(mm, model, defn, TableLimits(), script=ctx)
    rows = evaluate_cells(mm, model, defn, build.keys, TableLimits(), script=ctx)
    cells = [r[1] for r in rows]
    assert all(isinstance(c, ValuesCell) for c in cells)
    assert sorted(v for c in cells for v in c.values) == [
        "Block A",
        "Block B",
        "Block C",
    ]
    assert not ctx.warnings
    ctx.close()
```

`RowStart` roots the navigation at each row's own element, so the assertion does not depend on generated-id ordering. `PathNavigation`, `RowStart`, `ScopeRows`, `NavigationColumn`, `NavigationSource`, `ElementColumn`, `TableDefinition`, `TableLimits`, `build_rows_ex` and `evaluate_cells` are all already imported by that module.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/navigation/test_script_step.py tests/table/test_script_column.py -v`
Expected: FAIL with `KeyError: 'ids'` raised from `_hop_script` (Task 1 renamed the payload key).

- [ ] **Step 3: Rewrite `_hop_script`**

In `src/data_rover/core/navigation/evaluate.py`, replace the whole `_hop_script` function (lines 345-379) with:

```python
def _hop_script(
    model: Model,
    element_id: str,
    step: ScriptStep,
    script: ScriptEvalContext | None,
    budget: _Budget,
) -> list[ChainNode]:
    """Continuations of a script hop: `step(el)` returns the next frontier.

    A returned node that is a string NAMING A MODEL ELEMENT hops; anything
    else — a non-string scalar, or a string that names no element — becomes a
    terminal `PropertyValue`, so the chain ENDS AT the value and displays it
    instead of vanishing. That mirrors a scalar `PropertyStep` exactly, and is
    the only sane rule available here: unlike a property, a snippet declares
    no return type, so the model — not the metamodel — decides per value.
    (This is why there is no unknown-id warning: with every string either
    hopping or displaying, "unknown id" is no longer a failure mode.)

    DEGRADED, NEVER RAISING: a dangling ref or a per-element error prunes with
    a warning on the shared context; an unconfigured snippet or absent context
    prunes silently (mirroring an unconfigured navigation source). Dedup
    preserves the snippet's own return order — deterministic because guest
    output is deterministic — and keys on `(type name, value)` rather than the
    value alone: plain `dict.fromkeys` collapses `True`/`1` and `1`/`1.0`,
    which was invisible when every node was an id but is a visible difference
    once nodes render as values.
    """
    if step.snippet.ref is not None:
        if script is not None:
            script.add_warning(
                ScriptWarningCode.NAV_SNIPPET_NOT_FOUND, detail=step.snippet.ref
            )
        return []
    if step.snippet.definition is None or script is None:
        return []
    res = script.call(step.snippet.definition.code, "step", [element_id])
    if res.error is not None:
        script.add_warning(ScriptWarningCode.NAV_STEP_FAILED, detail=res.error.message)
        return []
    assert res.value is not None
    raw = list({(type(n).__name__, n): n for n in res.value["nodes"]}.values())
    if not budget.spend(len(raw)):
        return []
    return [
        n if isinstance(n, str) and n in model.elements else PropertyValue(n)
        for n in raw
    ]
```

- [ ] **Step 4: Update the invariant docstrings the change touches**

In `src/data_rover/core/navigation/evaluate.py`:

- `PropertyValue`'s docstring (line ~65): change the opening sentence from `"""Terminal chain node for a SCALAR property step: when the stepped-on` … to:

```python
    """Terminal chain node for a value a chain ends AT rather than hops from.

    Two steps produce one: a SCALAR property step (the stepped-on property is
    not element-typed) and a script step whose `step()` returned something
    that names no model element. Wrapped (rather than carried raw) so a string
    value can never be mistaken for an element id by downstream consumers —
    every consumer discriminates with ``isinstance(node, str)``. Frozen
    (hashable) because chain nodes are deduped through dict keys."""
```

- `ChainResult`'s docstring (line ~81): change `Every node is an element id except a possible trailing `PropertyValue` (a scalar property step is always terminal).` to `Every node is an element id except a possible trailing `PropertyValue` (a scalar property step, or a script step that returned a non-element, is always terminal).`

- the `_walk` comment at lines ~406-409: change it to

```python
        # A PropertyValue is TERMINAL — a scalar property step or a script
        # step that returned a non-element ends its chain there. The UI blocks
        # adding steps past a scalar property step (it can read the datatype
        # from the metamodel); it cannot for a script step, whose return type
        # is unknowable before it runs, so those chains prune HERE — silently,
        # the same stance as absent properties.
```

In `src/data_rover/core/navigation/schema.py`, replace `ScriptStep`'s docstring (lines 110-115) with:

```python
    """A hop computed by a snippet's `step(el)` entry point: consumes the
    frontier one element at a time, produces the next frontier from what the
    snippet returns. A returned string naming a model element hops; anything
    else (a scalar, or a string naming no element) TERMINATES that chain at
    the value, carried as a `PropertyValue` so the UI can display it — the
    same contract a scalar `PropertyStep` has, since a snippet declares no
    return type. `exclude_visited` applies to the hopping nodes. Adds ONE
    chain column, like RelationshipStep — its `step_types` entry is
    `comment or "script"`. Per-element failures PRUNE that chain with a
    warning (never abort), mirroring PropertyStep's graceful stance."""
```

In `src/data_rover/core/script/warnings.py`:

- module docstring, line 4-5: change `a snippet that raises prunes its chains, an unknown returned id is dropped` to `a snippet that raises prunes its chains, a snippet reference that no longer resolves is reported`.
- annotate the enum member (line 42) so nobody re-wires it by accident:

```python
    #: No longer emitted: a navigation script step now DISPLAYS a returned
    #: value that names no element (see navigation/evaluate.py::_hop_script)
    #: instead of dropping it, so "unknown id" stopped being a failure mode.
    #: Kept in the vocabulary because the wire is open by design — a client
    #: must still format a code an older/other server sends.
    NAV_UNKNOWN_IDS = "nav_unknown_ids"
```

In `src/data_rover/core/table/cells.py` (line ~249), change the comment `# The projected step is a scalar property step: the cell shows VALUES.` to `# The projected step ended at a value (a scalar property step, or a script step that returned a non-element): the cell shows VALUES.`

In `src/data_rover/api/schemas.py` (line ~881), change `except a possible trailing `ChainValueOut` when the path ends in a scalar property step` to `except a possible trailing `ChainValueOut` when the path ends in a scalar property step or in a script step that returned a non-element`.

In `frontend/src/lib/api/types.ts` (line ~485), change the `ChainValueSchema` doc comment's first sentence to:

```typescript
/** Terminal VALUE node in a chain: a scalar property step — or a script step
 * whose `step()` returned something that names no element — ends its chain at
 * that value instead of an element (discriminated from TreeItem by the `kind`
 * tag — TreeItem has no `kind`). */
```

In `frontend/src/lib/script/warnings.ts`, add above the `case 'nav_unknown_ids':` line (~line 26):

```typescript
		// Retained for older/other servers: the current backend no longer
		// emits this — a nav script step displays an unresolvable return
		// value rather than dropping it.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/navigation/ tests/table/ -v`
Expected: PASS.

Then the full core suite:
Run: `pixi run core-test`
Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/core/navigation/ src/data_rover/core/script/warnings.py src/data_rover/core/table/cells.py src/data_rover/api/schemas.py frontend/src/lib/api/types.ts frontend/src/lib/script/warnings.ts tests/navigation/test_script_step.py tests/table/test_script_column.py
git commit -m "fix(nav): a script step that returns a non-element shows the value and ends the chain"
```

---

### Task 3: The script step row gets its chain badge

**Files:**
- Modify: `frontend/src/lib/components/Navigation/ScriptStepRow.svelte` (header comment, props, template)
- Modify: `frontend/src/lib/components/Navigation/PathCard.svelte:491-498` (pass `column`)
- Test: `frontend/src/lib/components/Navigation/__tests__/script-step-row.test.ts`
- Test: `frontend/src/lib/components/Navigation/__tests__/path-card.test.ts`

**Interfaces:**
- Consumes: `ChainBadge.svelte`'s existing props — `{ value: number | null; tone?: 'default' | 'start' | 'combine'; size?: 'sm' | 'md' }`. `PathCard.columnFor(i: number): number` already counts script steps (it counts every non-`filter` step), so it needs no change.
- Produces: `ScriptStepRow` gains a required `column: number` prop.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/lib/components/Navigation/__tests__/script-step-row.test.ts`, add `column: 2` to the `render` helper's props:

```typescript
function render(step: NavScriptStep, onChange: (index: number, next: NavScriptStep) => void) {
	const component = mount(ScriptStepRow, {
		target: document.body,
		props: {
			step,
			index: 0,
			column: 2,
			collapseKey: 'nav:t::[]::step:0',
			onChange,
			onRemove: vi.fn()
		}
	});
	flushSync();
	return component;
}
```

and add this test inside the `describe('ScriptStepRow', …)` block:

```typescript
	it('renders the chain badge for its column', () => {
		const c = render(scriptStep(), vi.fn());
		try {
			// A script step advances the chain exactly like a relationship or
			// property step, so it carries the same numbered rail badge — its
			// absence was a visual hole in the rail.
			const badge = document.querySelector('[data-testid="chain-badge"]');
			expect(badge?.textContent?.trim()).toBe('2');
		} finally {
			unmount(c);
		}
	});
```

In `frontend/src/lib/components/Navigation/__tests__/path-card.test.ts`, add a test modelled on the existing badge test at line ~144 (copy that test's `seed`/`render`/`unmount` scaffolding verbatim from its neighbour, and use the same `pathWith([...])` helper the file already defines):

```typescript
it('numbers a script step on the rail like any other hop', async () => {
	const tabId = 'nav:draft:pc-script-badge';
	await seed(
		tabId,
		pathWith([
			{
				kind: 'relationship',
				relationship_type: 'Owns',
				direction: 'out',
				target_types: [],
				children: []
			},
			{ kind: 'filter', criteria: [] },
			{ kind: 'script', snippet: {}, comment: null }
		])
	);
	const c = render(tabId);
	try {
		const badges = [...document.querySelectorAll('[data-testid="chain-badge"]')].map(
			(b) => b.textContent?.trim() ?? ''
		);
		// 0 = start, 1 = the relationship hop, · = the filter (adds no column),
		// 2 = the script hop.
		expect(badges.slice(0, 4)).toEqual(['0', '1', '·', '2']);
	} finally {
		unmount(c);
	}
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run frontend-test`
Expected: FAIL — `script-step-row.test.ts` finds no `[data-testid="chain-badge"]` (`badge?.textContent` is `undefined`), and `path-card.test.ts` gets `['0', '1', '·']` plus whatever follows instead of the script step's `'2'`.

- [ ] **Step 3: Render the badge**

In `frontend/src/lib/components/Navigation/ScriptStepRow.svelte`, replace the header comment (lines 2-8) with:

```svelte
	// A `script`-kind step: runs a snippet's step(el) per frontier element.
	// Carries the rail's numbered ChainBadge like the other chain-advancing
	// rows — a script step adds a chain column exactly as a relationship or
	// property step does. It has no FRONTIER machinery of its own, though
	// (see the note in PathCard.svelte on the known frontier-tracking gap for
	// script steps: a snippet's return type is unknowable before it runs), so
	// the body is just the shared SnippetSourceEditor (bound to the "step"
	// entry point) plus the same per-step comment note the other rows have.
```

add the prop to the `Props` type and the destructuring:

```typescript
	type Props = {
		step: NavScriptStep;
		index: number;
		/** The rail's column number for this hop (a script step advances the
		 * chain exactly like a relationship step) — see PathCard's `columnFor`. */
		column: number;
		collapseKey: string;
		onChange: (index: number, next: NavScriptStep) => void;
		onRemove: (index: number) => void;
	};
	let { step, index, column, collapseKey, onChange, onRemove }: Props = $props();
```

add the import alongside the existing ones:

```typescript
	import ChainBadge from './ChainBadge.svelte';
```

and insert the badge as the row's first child, matching `PropertyStepRow.svelte:50-51`:

```svelte
<div class="group relative flex items-baseline gap-2.5 py-0.5" data-testid="script-step">
	<ChainBadge value={column} />
	<div class="flex min-h-[22px] flex-1 flex-col gap-1">
```

- [ ] **Step 4: Pass the column from PathCard**

In `frontend/src/lib/components/Navigation/PathCard.svelte`, change the `ScriptStepRow` invocation (lines 491-498) to:

```svelte
					{:else if step.kind === 'script'}
						<ScriptStepRow
							step={step as NavScriptStep}
							index={i}
							column={columnFor(i)}
							collapseKey={`${tabId}::${pathKey(path)}::step:${i}`}
							onChange={setStep}
							onRemove={removeStep}
						/>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pixi run frontend-test`
Expected: PASS, 0 failures.

Run: `pixi run frontend-check`
Expected: no new svelte-check errors (a missing required prop on `ScriptStepRow` would surface here).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/Navigation/ScriptStepRow.svelte frontend/src/lib/components/Navigation/PathCard.svelte frontend/src/lib/components/Navigation/__tests__/script-step-row.test.ts frontend/src/lib/components/Navigation/__tests__/path-card.test.ts
git commit -m "fix(nav): give the script step row its chain badge"
```

---

### Task 4: Full verification

**Files:** none (verification only; `dr-tidy` may reformat files touched above).

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: a green tree.

- [ ] **Step 1: Lint, format and typecheck**

Run: `pixi run dr-tidy`
Expected: clean. All three of ruff, mypy and pyright must pass. If ruff reformats anything, keep the reformatting.

- [ ] **Step 2: Run the full suite**

Run: `pixi run dr-test`
Expected: PASS — core pytest and frontend vitest, 0 failures.

- [ ] **Step 3: Confirm no stale references to the old wire key**

Run: `grep -rn '"ids"' src/data_rover/core/script/ src/data_rover/core/navigation/ tests/script/ tests/navigation/`
Expected: only `value`-entry hits (`{"kind": "elements", "ids": [...]}`). Any `step`-entry `"ids"` left is a miss — fix it.

- [ ] **Step 4: Commit anything `dr-tidy` changed**

```bash
git status --short
# if dr-tidy reformatted files:
git add -A && git commit -m "chore: dr-tidy"
```

## Manual smoke check (optional, needs the guest binary)

If `spikes/code_exec/vendor/python.wasm` is vendored (`bash spikes/code_exec/fetch_python_wasi.sh`), start the stack (`pixi run backend-start` + `pixi run frontend-start`), open a navigation, add a script step with `def step(el): return el.properties.get("name")`, and confirm: the rail shows a numbered badge on the script step, and the results dock shows the name values as terminal nodes rather than an empty result with a warning badge.
