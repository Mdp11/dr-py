# Snippet Correctness & Error Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make navigation script steps work inside tables, fix the hostile `step()` return contract, add a per-table script-error recap with jump-to-cell, and close two read-only regression-test gaps.

**Architecture:** Four independent fixes over the existing embedded-script machinery (`ScriptEvalContext`), spec: `docs/superpowers/specs/2026-07-23-snippet-correctness-design.md`. (1) Thread the script context the table route already owns through the table evaluator's navigation helpers. (2) Widen the guest serializer's `step()` contract. (3) Warn when the chain walker's cycle guard drops script-step results. (4) A new cache-only `POST /tables/script-errors` route mirroring `/tables/export`'s whole-table pass, consumed by a badge + panel + jump in the table UI.

**Tech Stack:** Python 3.14 / FastAPI / pytest (backend), SvelteKit 5 / vitest + MSW (frontend). Everything runs through pixi.

## Global Constraints

- All Python commands via pixi: `pixi run -e core-dev pytest ...`; lint with `pixi run core-lint` (core) / `pixi run backend-lint` (api). ruff + mypy + pyright must all pass.
- Frontend commands MUST run from inside `frontend/`: `pixi run -e frontend bash -c 'cd frontend && npm test'`, `... npm run check`.
- Core script tests use `TrustedRunner` from `tests/script/trusted_runner.py` — it executes the real `facade_src.py`, so guest-side changes are covered without WASM. `TrustedRunner` must never move to `src/`.
- Embedded evaluation is degraded-never-failing: no change in this plan may turn a script/table/navigation problem into a 5xx.
- The wire shape of `step()` results stays `{"ids": [str, ...]}` — host-side `decode_call_payload` is untouched.
- Preserve the dense docstring style of `core/` — docstrings explain *why* invariants exist.
- Commit after every task; commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `step()` return contract — accept single Element / single id, teaching error message

**Files:**
- Modify: `src/data_rover/core/script/facade_src.py` (`_dr_serialize_entry_result`, the `entry == "step"` branch, ~line 741)
- Test: `tests/script/test_session.py`

**Interfaces:**
- Produces: `step()` may return `None` | `Element` | `str` (one element id) | iterable of `Element`/`str`. Wire payload unchanged: `{"ids": [str, ...]}`. Error message text (asserted by tests and referenced in Task 8 docs): `step() must return an Element, an element id, an iterable of those, or None (None ends the chain); got <TypeName>`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/script/test_session.py` (it already has `open_session`-based tests around line 154 — reuse its existing fixture/helpers for model + runner; the tests below assume a helper that opens a session against a model containing at least one element whose id is known, mirroring `test_session_is_read_only`'s setup):

```python
def test_step_returns_single_element(session_model) -> None:
    model, eid = session_model  # a model and one existing element id
    runner = TrustedRunner()
    sess = runner.open_session(model, "def step(el): return el", RunLimits())
    res = sess.call("step", [eid])
    assert res.error is None
    assert res.value == {"ids": [eid]}


def test_step_returns_single_id_string(session_model) -> None:
    model, eid = session_model
    runner = TrustedRunner()
    sess = runner.open_session(model, "def step(el): return el.id", RunLimits())
    res = sess.call("step", [eid])
    assert res.error is None
    assert res.value == {"ids": [eid]}


def test_step_indexed_child_style_return(session_model) -> None:
    # regression for the reported `el.children()[0]` case: an Element pulled
    # out of a list is still a single-Element return
    model, eid = session_model
    runner = TrustedRunner()
    sess = runner.open_session(model, "def step(el): return [el][0]", RunLimits())
    res = sess.call("step", [eid])
    assert res.error is None
    assert res.value == {"ids": [eid]}


def test_step_bad_return_message_teaches_none(session_model) -> None:
    model, eid = session_model
    runner = TrustedRunner()
    sess = runner.open_session(model, "def step(el): return 42", RunLimits())
    res = sess.call("step", [eid])
    assert res.error is not None
    assert "None ends the chain" in res.error.message
    assert "int" in res.error.message
```

If `test_session.py` has no reusable model fixture, add one at module scope following the file's existing construction pattern (a `Metamodel` with one `ElementType("Thing")`, a `Model` with one created element; return `(model, element_id)`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/script/test_session.py -k "single_element or single_id or indexed_child or teaches_none" -v`
Expected: 4 FAIL — single-Element returns error with `KeyError: 0`; single-str returns the old "must return an iterable" error; bad-type message lacks "None ends the chain".

- [ ] **Step 3: Implement the serializer change**

In `src/data_rover/core/script/facade_src.py`, replace the `entry == "step"` branch of `_dr_serialize_entry_result` with:

```python
    if entry == "step":
        if value is None:
            return {"ids": []}
        # Single-return conveniences BEFORE generic iteration: a bare Element
        # would otherwise be "iterated" via its __getitem__ (KeyError: 0), and
        # a bare id string would be iterated per-character.
        if isinstance(value, Element):
            return {"ids": [value.id]}
        if isinstance(value, str):
            return {"ids": [value]}
        _bad = (
            "step() must return an Element, an element id, an iterable of "
            "those, or None (None ends the chain); got "
        )
        try:
            items = list(value)
        except TypeError:
            raise ValueError(_bad + type(value).__name__)
        ids = []
        for item in items:
            if isinstance(item, Element):
                ids.append(item.id)
            elif isinstance(item, str):
                ids.append(item)
            else:
                raise ValueError(_bad + type(item).__name__)
        return {"ids": ids}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/script/test_session.py tests/script/test_trusted_runner.py tests/navigation/test_script_step.py -v`
Expected: all PASS (the pre-existing step tests still pass — iterables unchanged).

- [ ] **Step 5: Extend the wasm integration test (single-Element return)**

Append to `tests/api/test_snippets_wasm.py` next to `test_wasm_session_read_only` (~line 453), reusing that test's session-opening pattern verbatim (same fixtures/marks — the file is `integration`-marked and needs the guest binary from `bash spikes/code_exec/fetch_python_wasi.sh`):

```python
def test_wasm_step_single_element_return(...same fixture params as test_wasm_session_read_only...) -> None:
    # mirror test_wasm_session_read_only's setup; only the code + assert differ
    res = sess.call("step", [eid])
    assert res.error is None
    assert res.value == {"ids": [eid]}
```

with session code `"def step(el): return el"`. This step only compiles the test; running it is optional (requires the fetched binary): `pixi run -e core-dev pytest tests/api/test_snippets_wasm.py -k single_element -v -m integration`.

- [ ] **Step 6: Lint and commit**

```bash
pixi run core-lint
git add src/data_rover/core/script/facade_src.py tests/script/test_session.py tests/api/test_snippets_wasm.py
git commit -m "fix(script): accept single Element/id from step() with a teaching error message

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Warn when the cycle guard drops script-step results

**Files:**
- Modify: `src/data_rover/core/navigation/evaluate.py` (`_walk`, the `ScriptStep` branch, ~line 415)
- Test: `tests/navigation/test_script_step.py`

**Interfaces:**
- Consumes: `_hop_script` return (list of element ids), `script.add_warning` (dedup + cap already handled by `ScriptEvalContext`).
- Produces: warning text (asserted here and shown in nav/table warnings strips): `script step: N element(s) dropped (already visited in this chain)`.

- [ ] **Step 1: Write the failing test**

Append to `tests/navigation/test_script_step.py` (uses the file's existing `_fixture`/`_path`/`_snip`/`_ctx` helpers):

```python
def test_script_step_visited_drop_warns() -> None:
    # identity return: every id the step returns is already in the chain, so
    # the cycle guard drops them all -- previously with NO signal at all
    mm, model = _fixture()
    defn = _path([ScriptStep(snippet=_snip("def step(el): return [el]"))])
    res = evaluate(mm, model, defn, script=_ctx(model))
    assert res.chains == []
    assert any("already visited" in w for w in res.warnings)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/navigation/test_script_step.py::test_script_step_visited_drop_warns -v`
Expected: FAIL — `res.warnings` is `[]`.

- [ ] **Step 3: Implement the warning**

In `_walk` (`src/data_rover/core/navigation/evaluate.py`), the step-dispatch currently ends with:

```python
    else:  # ScriptStep
        nxt = _hop_script(model, current, step, script, budget)
```

Replace with:

```python
    else:  # ScriptStep
        nxt = _hop_script(model, current, step, script, budget)
        if script is not None and exclude_visited:
            # The generic cycle guard below drops silently -- correct for
            # relationship hops (revisits are expected navigation semantics)
            # but a silent mystery for script steps, where an identity return
            # ("keep this element") is the natural idiom. Warn with a count.
            dropped = sum(1 for o in nxt if o in chain)
            if dropped:
                script.add_warning(
                    f"script step: {dropped} element(s) dropped "
                    "(already visited in this chain)"
                )
```

Do not change the guard itself (`if exclude_visited and other in chain: continue`) — semantics are unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/navigation/ -v`
Expected: all PASS.

- [ ] **Step 5: Lint and commit**

```bash
pixi run core-lint
git add src/data_rover/core/navigation/evaluate.py tests/navigation/test_script_step.py
git commit -m "feat(navigation): warn when the cycle guard drops script-step results

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Thread the script context through the table evaluator

**Files:**
- Modify: `src/data_rover/core/table/evaluate.py` (`_navigation_row_keys` ~83, `_chain_row_keys` ~106, `_base_row_keys` ~119, `_navigation_reached_ex` ~250, `_navigation_reached` ~277, `_navigation_step_elements` ~287, `_collapse_has_value` call site ~469, `_expand_values` call site ~519, `build_rows_ex` call site ~376)
- Modify: `src/data_rover/core/table/cells.py` (`_navigation_reached` call site ~231)
- Modify: `tests/navigation/test_script_step.py` (retitle the silent-prune test)
- Test: `tests/table/test_script_column.py` (new tests appended)

**Interfaces:**
- Consumes: `evaluate(mm, model, defn, limits, *, row_elements=None, script=None)` from `core/navigation/evaluate.py` (already accepts `script`); `ScriptEvalContext` built per-request by callers.
- Produces: every navigation-evaluating helper in `core/table/evaluate.py` accepts a trailing keyword-or-positional `script: ScriptEvalContext | None = None` and forwards it to the navigation `evaluate()`. Signatures after this task:
  - `_navigation_row_keys(mm, model, rs, limits, script=None)`
  - `_chain_row_keys(mm, model, rs, limits, script=None)`
  - `_base_row_keys(mm, model, defn, limits, script=None)`
  - `_navigation_reached_ex(mm, model, col, roots, limits, script=None)`
  - `_navigation_reached(mm, model, col, roots, limits, script=None)`
  - `_navigation_step_elements(mm, model, col, roots, limits, *, step, match_projected, script=None)`

- [ ] **Step 1: Write the failing tests**

Append to `tests/table/test_script_column.py` (reuses its `_snip` helper, `TrustedRunner`, `ScriptEvalContext`, `RunLimits`, `ScriptBudget` imports; add `NavigationColumn`, `NavigationRows`, `PathNavigation`, `ScriptStep`, `SnippetSource` navigation-schema imports mirroring how `tests/navigation/test_script_step.py` builds a `PathNavigation`):

```python
def _nav_with_script_step(target_expr: str) -> PathNavigation:
    """One-step navigation whose only step is a script step."""
    return PathNavigation(
        start=Scope(types=[]),
        steps=[ScriptStep(snippet=_snip(f"def step(el):\n    return {target_expr}"))],
    )


def _script_ctx(model: Model) -> ScriptEvalContext:
    return ScriptEvalContext(TrustedRunner(), model, RunLimits(), ScriptBudget.start(30))


def test_nav_script_step_as_row_source(script_model) -> None:
    # script_model: metamodel + model with >=2 Thing elements (reuse the
    # file's existing model-construction helper)
    mm, model = script_model
    ids = sorted(model.elements)
    defn = TableDefinition(
        row_source=NavigationRows(
            navigation=NavigationSource(definition=_nav_with_script_step(f"['{ids[1]}']")),
        ),
        columns=[RowSlot()],
    )
    ctx = _script_ctx(model)
    build = build_rows_ex(mm, model, defn, TableLimits(), script=ctx)
    # the step hops every start element (except ids[1] itself, cycle guard)
    # onto ids[1]; projected step -1 -> the row set is exactly {ids[1]}
    assert build.keys == [(ids[1],)]


def test_nav_script_step_as_navigation_column(script_model) -> None:
    mm, model = script_model
    ids = sorted(model.elements)
    defn = TableDefinition(
        row_source=ScopeRows(types=[]),
        columns=[
            RowSlot(),
            NavigationColumn(
                navigation=NavigationSource(definition=_nav_with_script_step(f"['{ids[0]}']")),
            ),
        ],
    )
    ctx = _script_ctx(model)
    build = build_rows_ex(mm, model, defn, TableLimits(), script=ctx)
    rows = evaluate_cells(mm, model, defn, build.keys, TableLimits(), script=ctx)
    # every row except ids[0]'s reaches ids[0] in the nav column
    reached = {
        key[0]: cell
        for key, cell in zip(build.keys, [r[1] for r in rows])
    }
    other = next(k for k in reached if k != ids[0])
    assert getattr(reached[other], "element_ids", None) == [ids[0]]


def test_nav_script_step_error_warns_through_table(script_model) -> None:
    mm, model = script_model
    defn = TableDefinition(
        row_source=NavigationRows(
            navigation=NavigationSource(definition=_nav_with_script_step("1/0")),
        ),
        columns=[RowSlot()],
    )
    ctx = _script_ctx(model)
    build = build_rows_ex(mm, model, defn, TableLimits(), script=ctx)
    assert build.keys == []
    assert any("script step failed" in w for w in ctx.warnings)
```

Adjust construction details (`NavigationSource` field name, `RowSlot`, the exact `build_rows_ex` result attribute for keys) to match the real schema names used elsewhere in `tests/table/` — `test_build_rows.py` is the reference for row-source construction, and this file's existing tests are the reference for `build_rows_ex`/`evaluate_cells` result shapes. The three behaviors under test must stay exactly as written: (a) script-step row source produces rows, (b) script-step navigation column reaches elements, (c) a step error surfaces on `ctx.warnings`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/table/test_script_column.py -k "nav_script_step" -v`
Expected: 3 FAIL — row keys/reached sets are empty and no warning is recorded, because the helpers never see the context.

- [ ] **Step 3: Add the `script` parameter to the six helpers and forward it**

In `src/data_rover/core/table/evaluate.py`:

1. `_navigation_row_keys(mm, model, rs, limits)` → add `script: ScriptEvalContext | None = None`; change `result = evaluate(mm, model, defn, limits.nav_limits)` to `result = evaluate(mm, model, defn, limits.nav_limits, script=script)`.
2. `_chain_row_keys` — same two changes.
3. `_base_row_keys(mm, model, defn, limits)` → add `script=None`; forward to both `_navigation_row_keys(..., script=script)` and `_chain_row_keys(..., script=script)` (the `ScopeRows` branch ignores it).
4. `_navigation_reached_ex(mm, model, col, roots, limits)` → add `script=None`; change `result = evaluate(mm, model, defn, limits.nav_limits, row_elements=roots)` to pass `script=script`.
5. `_navigation_reached` → add `script=None`, forward: `return _navigation_reached_ex(mm, model, col, roots, limits, script=script)[0]`.
6. `_navigation_step_elements(..., *, step, match_projected)` → add `script: ScriptEvalContext | None = None` keyword; forward into its `evaluate(...)` call.

Then update every call site to pass the context that is already in scope:
- `build_rows_ex` ~line 376: `keys, truncated = _base_row_keys(mm, model, defn, limits, script=script)`
- the `_navigation_reached(mm, model, ref_col, roots, limits)` call ~line 223 → append `script=script` (its enclosing function already has `script`).
- `_collapse_has_value` ~line 469 and `_expand_values` ~line 519: `_navigation_reached_ex(mm, model, col, roots, limits, script=script)` (both functions already take `script`).
- Any `_navigation_step_elements(...)` call sites (~line 203): append `script=script`.
- `src/data_rover/core/table/cells.py` ~line 231: `reached = _navigation_reached(mm, model, col, roots, limits, script=script)` (the enclosing function already takes `script`).

Also update the docstrings that say `script` is "required to resolve a COLLAPSE script column as a source" (evaluate.py ~line 173) and cells.py's "`None` for callers with no script columns in play" to mention navigation script steps now ride the same context.

- [ ] **Step 4: Run the full core test suite**

Run: `pixi run core-test`
Expected: all PASS, including the three new tests. If `test_script_step_without_context_prunes_silently` fails, something regressed — that behavior must NOT change.

- [ ] **Step 5: Retitle the silent-prune test so it stops reading as an endorsement**

In `tests/navigation/test_script_step.py`, rename `test_script_step_without_context_prunes_silently` to `test_script_step_no_runner_fallback_prunes_silently` and set its comment to:

```python
def test_script_step_no_runner_fallback_prunes_silently() -> None:
    # script=None is the DEGRADED fallback for callers with no runner at all.
    # Table/nav routes always open a context when the definition has script
    # work (table_has_script / navigation_has_script), so this path is never
    # the table story -- see 2026-07-23 spec, section 1.
    mm, model = _fixture()
    defn = _path([ScriptStep(snippet=_snip("def step(el): return []"))])
    res = evaluate(mm, model, defn)                      # script=None
    assert res.chains == [] and res.warnings == []
```

- [ ] **Step 6: Run, lint, commit**

Run: `pixi run core-test && pixi run core-lint`
Expected: PASS.

```bash
git add src/data_rover/core/table/evaluate.py src/data_rover/core/table/cells.py tests/table/test_script_column.py tests/navigation/test_script_step.py
git commit -m "fix(table): thread the script context into embedded navigation evaluation

Navigations containing script steps evaluated inside a table (row source or
navigation column) previously ran with script=None and pruned to empty
silently.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: End-to-end route tests — nav script step inside a table over HTTP

**Files:**
- Create: `tests/api/test_tables_nav_script.py`

**Interfaces:**
- Consumes: the Task 3 threading (no src changes in this task); `tests/api/conftest.py` helpers `AUTH_HEADERS`, `papi`, `seed_default_project`; `TrustedRunner` via `dependency_overrides[get_runner]` (the override pattern of `tests/api/test_tables_script_status.py`); its `THING_MM` metamodel style.

- [ ] **Step 1: Write the tests**

Create `tests/api/test_tables_nav_script.py`:

```python
"""End-to-end: a navigation with a ScriptStep used inside a table, over HTTP.
This is the exact scenario the 2026-07-23 spec's bug report covered — the
table evaluator used to drop the script context, so these rows came back
empty with no warning. Fixture idiom follows test_tables_script_status.py
(app/client pair so the runner is swappable via dependency_overrides)."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.script_runner import get_runner
from tests.script.trusted_runner import TrustedRunner

from .conftest import AUTH_HEADERS, papi, seed_default_project

THING_MM = """
elements:
  - name: Thing
    key: [name]
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
"""


@pytest.fixture
def app() -> Iterator[FastAPI]:
    seed_default_project()
    application = create_app()
    application.dependency_overrides[get_runner] = lambda: TrustedRunner()
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    c = TestClient(app)
    c.headers.update(AUTH_HEADERS)
    return c


@pytest.fixture
def seed_things(client: TestClient) -> list[str]:
    r = client.post(papi("/metamodel"), content=THING_MM)
    assert r.status_code in (200, 201), r.text
    ids = []
    for n in ("t1", "t2", "t3"):
        r = client.post(
            papi("/model/elements"),
            json={"type_name": "Thing", "properties": {"name": n}},
        )
        assert r.status_code in (200, 201), r.text
        ids.append(r.json()["id"])
    return ids


def _step_nav(code: str) -> dict:
    return {
        "kind": "path",
        "start": {"types": []},
        "steps": [{"kind": "script", "snippet": {"definition": {"code": code}}}],
    }


def test_nav_script_step_row_source_over_http(client: TestClient, seed_things) -> None:
    target = seed_things[0]
    defn = {
        "row_source": {
            "kind": "navigation",
            "navigation": {"definition": _step_nav(f"def step(el): return ['{target}']")},
        },
        "columns": [{"kind": "row_slot"}],
    }
    r = client.post(papi("/tables/evaluate"), json={"definition": defn})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_rows"] > 0  # used to be 0: context was dropped
    assert body["warnings"] == []


def test_nav_script_step_error_surfaces_in_page_warnings(client: TestClient, seed_things) -> None:
    defn = {
        "row_source": {
            "kind": "navigation",
            "navigation": {"definition": _step_nav("def step(el): return 1/0")},
        },
        "columns": [{"kind": "row_slot"}],
    }
    r = client.post(papi("/tables/evaluate"), json={"definition": defn})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_rows"] == 0
    assert any("script step failed" in w for w in body["warnings"])
```

Adjust wire-shape details (metamodel upload route/content-type, element-create payload, table-definition keys such as `"row_slot"`, and the evaluate response field for row count) to whatever `tests/api/test_tables_script_status.py` and the table schema actually use — mirror that file's seeding helpers rather than inventing new shapes. The two assertions that matter: rows non-empty on the happy path, and `warnings` carrying `"script step failed"` on the error path.

- [ ] **Step 2: Run the tests**

Run: `pixi run -e core-dev pytest tests/api/test_tables_nav_script.py -v`
Expected: PASS (Task 3 already landed the fix; these tests pin it at the HTTP layer). If they fail, the threading missed a call site — fix in `core/table/evaluate.py`, not here.

- [ ] **Step 3: Lint and commit**

```bash
pixi run backend-lint
git add tests/api/test_tables_nav_script.py
git commit -m "test(api): pin nav-script-step-in-table behavior at the HTTP layer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Recap backend — `POST /tables/script-errors`

**Files:**
- Modify: `src/data_rover/api/schemas.py` (new response models, next to `ScriptStatusOut` ~line 909)
- Modify: `src/data_rover/api/routes/tables.py` (new route after `export_table`)
- Modify: `src/data_rover/api/authz.py` (`_READ_ONLY_POST_SUFFIXES`, line 54)
- Test: `tests/api/test_tables_script_errors.py` (create)

**Interfaces:**
- Consumes: `_resolve_table`, `open_script_context`/`close_script_context`, `build_rows`, `order_rows`, `iter_export_rows`, `kick_or_join_sweep`, `_status_from_job`, `table_has_script`, `display_name`, `ErrorCell`/`PendingCell` — all already imported or importable in `routes/tables.py`.
- Produces (wire, consumed by Task 6):

```python
class ScriptErrorItemOut(BaseModel):
    """One failed script cell, addressable by grid position."""
    row_index: int          # index into the table's row order (build order)
    row_element_id: str | None  # first row-key slot when it is an element id
    row_label: str | None   # display_name of that element, for the panel
    column_index: int       # index into defn.columns
    column_label: str       # defn.columns[i].header or the column kind
    message: str

class ScriptErrorsOut(BaseModel):
    """Whole-table script-error recap (cache-only; never drives the guest)."""
    state: Literal["ready"] = "ready"
    errors: list[ScriptErrorItemOut]
    total_errors: int       # full count, >= len(errors) when truncated
    truncated: bool         # errors list capped at SCRIPT_ERRORS_CAP
```

- Route contract: `200 ScriptErrorsOut` when the cache is settled; `202` with a `ScriptStatusOut` JSON body + `Retry-After: 1` header while the sweep is computing (same discriminator as export: the status code is the retry signal). A table with no script work, or no runner, returns `200` with whatever the cache holds (possibly zero errors) — never a 5xx.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_tables_script_errors.py`, fixture idiom copied from `tests/api/test_tables_script_status.py` (separate `app`/`client`, `TrustedRunner` override is NOT used here — use the `_script_fakes.py` runners so sweep interplay is controllable; pin sync sweep mode exactly the way that file does with `DATA_ROVER_SNIPPET_SWEEP_SYNC`):

```python
"""POST /tables/script-errors — the per-table script-error recap
(2026-07-23 spec §4). Cache-only like export: 202 + Retry-After while the
sweep computes; 200 with the collected ErrorCells once settled; pending
cells after a terminal sweep count as errors ("not computed")."""
```

Tests (each following the seeding/sweep-pinning idiom of `test_tables_script_status.py` — same `THING_MM`, same element seeding, same table-definition construction with a script column):

```python
def test_script_errors_empty_when_all_ok(client, seed_thing_model) -> None:
    # runner: ok(1) for every cell; sync sweep fills the cache on the first
    # evaluate; then the recap reports zero errors
    _evaluate_until_ready(client)          # helper: poll /tables/evaluate
    r = client.post(papi("/tables/script-errors"), json={"definition": TABLE_DEFN})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {"state": "ready", "errors": [], "total_errors": 0, "truncated": False}


def test_script_errors_lists_failed_cells(client, seed_thing_model) -> None:
    # runner scripted to error on t2's cell and succeed elsewhere
    _evaluate_until_ready(client)
    r = client.post(papi("/tables/script-errors"), json={"definition": TABLE_DEFN})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_errors"] == 1 and not body["truncated"]
    (err,) = body["errors"]
    assert err["row_label"] == "t2"
    assert err["column_index"] == SCRIPT_COL_INDEX
    assert err["message"]            # the ScriptError message text


def test_script_errors_202_while_computing(client, seed_thing_model) -> None:
    # async sweep parked on an Event (the idiom of test_tables_script_status's
    # one async case): first evaluate kicks the sweep, recap must 202
    r = client.post(papi("/tables/script-errors"), json={"definition": TABLE_DEFN})
    assert r.status_code == 202
    assert r.headers["Retry-After"] == "1"
    assert r.json()["state"] == "computing"


def test_script_errors_pending_after_terminal_sweep_counts_as_error(client, seed_thing_model) -> None:
    # a cell the sweep could never cache shows up as an error item with a
    # "not computed" message, not as a 202 loop. Setup: the runner scripted
    # with `timeout()` results (never cached) + sync sweep, exactly the
    # combination test_tables_script_status.py uses to drive its
    # consecutive-timeout abort / failed-state case — copy that scripted
    # runner + settings pinning verbatim, then evaluate once so the sweep
    # runs to its terminal state.
    r = client.post(papi("/tables/evaluate"), json={"definition": TABLE_DEFN})
    assert r.json()["script_status"]["state"] == "failed"  # terminal sweep
    r = client.post(papi("/tables/script-errors"), json={"definition": TABLE_DEFN})
    assert r.status_code == 200, r.text  # NOT 202: retry would never help
    body = r.json()
    assert body["total_errors"] > 0
    assert any("not computed" in e["message"] for e in body["errors"])


def test_script_errors_cap_truncates(client, seed_thing_model, monkeypatch) -> None:
    monkeypatch.setattr("data_rover.api.routes.tables.SCRIPT_ERRORS_CAP", 2)
    # runner errors every cell (5 Things) -> 5 total, 2 listed
    _evaluate_until_ready(client)
    r = client.post(papi("/tables/script-errors"), json={"definition": TABLE_DEFN})
    body = r.json()
    assert body["total_errors"] == 5
    assert len(body["errors"]) == 2 and body["truncated"] is True


def test_script_errors_is_viewer_callable(client_as_viewer, seed_thing_model) -> None:
    # membership role=viewer must not 403: the suffix is in the read-only
    # POST allowlist (mirror how existing tests build a viewer client)
    r = client_as_viewer.post(papi("/tables/script-errors"), json={"definition": TABLE_DEFN})
    assert r.status_code in (200, 202)
```

Flesh out `_evaluate_until_ready`, `TABLE_DEFN`, `SCRIPT_COL_INDEX`, and the viewer-client fixture by copying the concrete helpers from `test_tables_script_status.py` (they already exist there in some form; import or duplicate per that file's local style). The assertions above are the contract — do not weaken them.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_tables_script_errors.py -v`
Expected: FAIL — 404 (route does not exist).

- [ ] **Step 3: Add the schemas**

In `src/data_rover/api/schemas.py`, immediately after `ScriptStatusOut`, add `ScriptErrorItemOut` and `ScriptErrorsOut` exactly as specified in **Interfaces** above (with docstrings in the file's house style).

- [ ] **Step 4: Add the allowlist suffix**

In `src/data_rover/api/authz.py` line 54ff, add `"/tables/script-errors",` after `"/tables/export",`.

- [ ] **Step 5: Implement the route**

In `src/data_rover/api/routes/tables.py`, after `export_table`, add (imports: `ScriptErrorItemOut`, `ScriptErrorsOut` from `..schemas`; `display_name` from `data_rover.core.model.naming`; `ErrorCell`, `PendingCell` are already imported by the module or import them from `data_rover.core.table.cells`):

```python
SCRIPT_ERRORS_CAP = 200


def _collect_script_errors(
    metamodel, model, defn, ordered, limits, script_ctx
) -> tuple[list[ScriptErrorItemOut], int, bool]:
    """(items, total, pending_seen) — one cache-only render pass over the
    whole table (dict lookups, no guest work), mirroring export's probe."""
    items: list[ScriptErrorItemOut] = []
    total = 0
    pending_seen = False
    for row_index, row in enumerate(
        iter_export_rows(metamodel, model, defn, ordered, limits, script=script_ctx)
    ):
        for column_index, cell in enumerate(row):
            if isinstance(cell, PendingCell):
                pending_seen = True
                message = "not computed"
            elif isinstance(cell, ErrorCell):
                message = cell.message
            else:
                continue
            total += 1
            if len(items) >= SCRIPT_ERRORS_CAP:
                continue
            key = ordered[row_index]
            eid = key[0] if key and isinstance(key[0], str) else None
            items.append(
                ScriptErrorItemOut(
                    row_index=row_index,
                    row_element_id=eid,
                    row_label=(
                        display_name(model.elements[eid])
                        if eid is not None and eid in model.elements
                        else None
                    ),
                    column_index=column_index,
                    column_label=defn.columns[column_index].header
                    or defn.columns[column_index].kind,
                    message=message,
                )
            )
    return items, total, pending_seen


@router.post("/tables/script-errors")
def table_script_errors(
    payload: EvaluateTableIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    runner: ScriptRunner | None = Depends(get_runner),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Read-only (viewer-callable; listed in authz._READ_ONLY_POST_SUFFIXES).
    Whole-table script-error recap: the same CACHE-ONLY pass as export (never
    drives the guest inline), returning every ErrorCell's grid position so
    the client can list failures and jump to them. While the sweep is still
    computing this answers 202 + Retry-After: 1 — the STATUS CODE is the
    retry signal, exactly like export. After a TERMINAL sweep, remaining
    PendingCells count as errors ("not computed"): failed-job memory means a
    retry would never fill them, so hiding them behind another 202 would loop
    forever. Degraded stance: no runner / no script work -> 200 with whatever
    the cache holds, never a 5xx."""
    metamodel, model = require_model(session)
    script_ctx = None
    acquired = False
    try:
        defn = _resolve_table(payload, project_id, db)
        limits = TableLimits(max_cell_elements=10**9, ignore_cell_caps=True)
        rev = session.model_rev
        script_ctx, acquired = open_script_context(
            runner,
            model,
            settings,
            needs_script=table_has_script(defn),
            cell_cache=session.script_cell_cache,
            rev=rev,
        )
        if script_ctx is None:
            return JSONResponse(
                ScriptErrorsOut(errors=[], total_errors=0, truncated=False).model_dump()
            )
        script_ctx.cache_only = True
        keys, _ = build_rows(metamodel, model, defn, limits, script=script_ctx)
        ordered = order_rows(metamodel, model, defn, keys, None, limits, script=script_ctx)
        items, total, pending_seen = _collect_script_errors(
            metamodel, model, defn, ordered, limits, script_ctx
        )
        if pending_seen and runner is not None:
            job = kick_or_join_sweep(
                session, metamodel, model, defn, runner, settings, rev
            )
            status = _status_from_job(job)
            terminal = status.state == "failed" or job.state == "done"
            if not terminal:
                return JSONResponse(
                    status.model_dump(),
                    status_code=202,
                    headers={"Retry-After": "1"},
                )
            # terminal but holes remain: re-collect once (the sweep may have
            # filled cells between our first pass and its termination), then
            # report what is left — pending items are "not computed" errors.
            items, total, _ = _collect_script_errors(
                metamodel, model, defn, ordered, limits, script_ctx
            )
        return JSONResponse(
            ScriptErrorsOut(
                errors=items,
                total_errors=total,
                truncated=total > len(items),
            ).model_dump()
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    finally:
        close_script_context(script_ctx, acquired)
```

Match the module's existing import list and error-mapping idiom (`export_table` maps `ValueError` → 422 somewhere in its body — mirror exactly how it does it rather than inventing a new pattern; if the module has a shared handler, use it). Sort: the recap deliberately uses **build order** (`sort=None`) — it must agree with the order the grid shows while degraded, and `row_index` must be stable across the recap fetch and the grid's row window; if the grid applies a user sort only after `ready`, matching that is Task 6's job via the same ordering rules as `evaluate_table` — check what `evaluate_table` passes to `order_rows` when `script_status` is `ready` and mirror it by forwarding `payload.sort` the same way. If `evaluate_table` honors `payload.sort` whenever the cache is complete, forward `payload.sort` here identically (build a `SortSpec` exactly like `export_table` does) so `row_index` always matches what the client displays.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_tables_script_errors.py tests/api/test_tables_script_status.py -v`
Expected: all PASS.

- [ ] **Step 7: Lint and commit**

```bash
pixi run backend-lint
git add src/data_rover/api/schemas.py src/data_rover/api/routes/tables.py src/data_rover/api/authz.py tests/api/test_tables_script_errors.py
git commit -m "feat(api): per-table script-error recap route (cache-only, 202 while computing)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Recap frontend — badge, panel, jump-to-cell

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (mirror `ScriptErrorItemOut`/`ScriptErrorsOut`)
- Modify: `frontend/src/lib/api/tables.ts` (`fetchScriptErrors`)
- Modify: `frontend/src/lib/state/table-editor.svelte.ts` (recap state + fetch-on-settle + jump request)
- Create: `frontend/src/lib/components/Table/ScriptErrorsPanel.svelte`
- Modify: `frontend/src/lib/components/Table/TableView.svelte` (badge + panel mount)
- Modify: `frontend/src/lib/components/Table/TableGrid.svelte` (scroll-to-row + cell highlight)
- Test: `frontend/src/lib/components/Table/__tests__/` or the file layout the existing table vitest suites use — put the new test beside the existing `TableView`/table-editor tests, matching their MSW setup.

**Interfaces:**
- Consumes: `POST /tables/script-errors` (Task 5 wire shapes); existing `_scriptStatus` per-tab map and `evaluateTable` client plumbing.
- Produces (used within these files only):
  - `types.ts`: `interface ScriptErrorItem { row_index: number; row_element_id: string | null; row_label: string | null; column_index: number; column_label: string; message: string }` and `interface ScriptErrorsRecap { state: 'ready'; errors: ScriptErrorItem[]; total_errors: number; truncated: boolean }`.
  - `tables.ts`: `fetchScriptErrors(args: EvaluateArgs, cfg?: ClientConfig): Promise<ScriptErrorsRecap | { retry: true }>` — a 202 resolves to `{ retry: true }` (mirror how `exportTable` detects 202, same request-body construction as `evaluateTable`).
  - `table-editor.svelte.ts`: `getScriptErrors(tabId): ScriptErrorsRecap | null`, `requestScrollToCell(tabId, rowIndex: number, columnIndex: number): void`, `consumeScrollRequest(tabId): { rowIndex: number; columnIndex: number } | null`.

- [ ] **Step 1: Write the failing state/API tests**

Beside the existing table-editor vitest suite (matching its MSW server setup), add coverage for: (a) when a page's `script_status` settles (`ready` or `failed`, transitioning from `computing` — or a first page that has a script status and is already settled), the store fetches `/tables/script-errors` and `getScriptErrors(tabId)` exposes the recap; (b) a 202 response schedules one retry after ~1s (reuse the store's existing single-timer discipline — never two concurrent timers per tab); (c) `requestScrollToCell`/`consumeScrollRequest` round-trip and clear. Use the MSW handler idiom of the neighboring tests; assert with the store's public getters only.

- [ ] **Step 2: Run to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- --run table-editor'`
Expected: FAIL (missing functions).

- [ ] **Step 3: Implement types, API client, and store state**

- `types.ts`: add the two interfaces from **Interfaces**.
- `tables.ts`:

```ts
export async function fetchScriptErrors(
  args: EvaluateArgs,
  cfg?: ClientConfig
): Promise<ScriptErrorsRecap | { retry: true }> {
  // same body construction as evaluateTable; same 202 handling as exportTable
  const res = await post(cfg, papiPath('/tables/script-errors'), evaluateBody(args));
  if (res.status === 202) return { retry: true };
  return (await res.json()) as ScriptErrorsRecap;
}
```

(Adapt `post`/`papiPath`/`evaluateBody` to the file's actual helpers — `evaluateTable` at `tables.ts:12` shows the real names; keep the 202 discrimination by status code.)

- `table-editor.svelte.ts`: add
  - `const _scriptErrors = new SvelteMap<string, ScriptErrorsRecap>();`
  - `const _scrollRequests = new Map<string, { rowIndex: number; columnIndex: number }>();`
  - in the function that records a landed page's `script_status` (~line 354): when the recorded status transitions to `ready`/`failed` (including the case where the very first page reports a settled status), fire `void _fetchScriptErrors(tabId)` — a helper that calls `fetchScriptErrors`, retries once per `retry: true` response on the same single-timer/generation discipline the sweep poll uses, and writes the result into `_scriptErrors`. When there is no script status, `_scriptErrors.delete(tabId)`.
  - clear `_scriptErrors` and `_scrollRequests` for a tab wherever the module already forgets per-tab script state (~line 300, `_forgetScriptState`-style function) and on rev change/reload paths that reset `_scriptStatus`.
  - export `getScriptErrors`, `requestScrollToCell`, `consumeScrollRequest` as specified in **Interfaces**.

- [ ] **Step 4: Implement the panel and badge**

- `ScriptErrorsPanel.svelte` (new): props `{ recap: ScriptErrorsRecap; onJump: (rowIndex: number, columnIndex: number) => void }`. Render a bordered dropdown/panel styled like the existing warnings strip family: header `“N script errors”` plus `“(showing first M)”` when `truncated`; a scrollable list where each entry is a button showing `row_label ?? row_element_id ?? `row ${row_index + 1}``, `column_label`, and the truncated `message` (full message in `title=`). Clicking calls `onJump(row_index, column_index)`. `data-testid="script-errors-panel"`.
- `TableView.svelte`: beside the script-status readout block (~line 327): when `getScriptErrors(tabId)?.total_errors > 0`, render a badge button (`data-testid="script-errors-badge"`, destructive styling consistent with the `failed` line) showing the count; clicking toggles the panel. Wire `onJump` to `requestScrollToCell(tabId, rowIndex, columnIndex)` and close the panel.

- [ ] **Step 5: Implement the grid jump**

`TableGrid.svelte` already tracks `scrollEl`, per-row `offsets`, and the window (`computeWindowVariable`, ~line 103). Add an `$effect` that calls `consumeScrollRequest(tabId)`; when non-null, set `scrollEl.scrollTop = offsets[rowIndex]` (clamped to the scrollable range) and record `{ rowIndex, columnIndex }` in a local `$state` used to apply a temporary highlight class (e.g. ring/outline for ~2s via `setTimeout`) on the matching cell in the rendered window. The highlight is best-effort: with estimated row heights the scroll may land slightly off — acceptable, matches the file's documented virtualization tradeoff (~line 77).

- [ ] **Step 6: Component test for badge → panel → jump**

In the suite beside the existing `TableView` tests (same MSW + render harness): seed a page whose `script_status` is `ready` and an MSW handler for `/tables/script-errors` returning one error; assert the badge appears with count 1, the panel opens on click and lists the entry, and clicking the entry records a scroll request (assert via `consumeScrollRequest`).

- [ ] **Step 7: Run frontend tests + svelte-check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- --run && npm run check'`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/api/tables.ts frontend/src/lib/state/table-editor.svelte.ts frontend/src/lib/components/Table/ScriptErrorsPanel.svelte frontend/src/lib/components/Table/TableView.svelte frontend/src/lib/components/Table/TableGrid.svelte <new test files>
git commit -m "feat(frontend): script-error recap badge, panel, and jump-to-cell

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Read-only regression tests (route entry mapping + table-column write)

**Files:**
- Modify: `tests/api/test_snippets_routes.py`
- Modify: `tests/api/test_tables_nav_script.py` (add the table-column write test — it already has the TrustedRunner-override app fixture)

**Interfaces:**
- Consumes: `routes/snippets.py:282` (`record_ops=(payload.entry == "script")`) and `script_runner.open_session`'s `record_ops=False` — no src changes; tests only.

- [ ] **Step 1: Write the route-level entry-mapping tests**

Append to `tests/api/test_snippets_routes.py`, next to `test_run_records_ops_without_mutating` (line 159 — mirror its `_seed_model`/`_model_summary` helpers and request shape):

```python
@pytest.mark.parametrize("entry", ["value", "step"])
def test_run_value_and_step_entries_are_read_only(client: TestClient, entry: str) -> None:
    """Pins routes/snippets.py's record_ops=(entry == "script") mapping: a
    value/step console run carrying a write must be blocked with zero ops."""
    _seed_model(client)
    before = _model_summary(client)
    code = f"def {entry}(x):\n    return dr.create('Building', {{}})"
    r = client.post(
        papi("/snippets/run"),
        json={"run_id": f"ro-{entry}", "code": code, "entry": entry},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["error"] is not None
    assert "ReadOnly" in body["error"]["message"]
    assert body["ops"] == []
    assert _model_summary(client) == before
```

Adjust the element type name (`'Building'`) and the `entry` request-field name to what `_seed_model` and the value/step tests around line 496 actually use — copy from them. The four assertions are the contract.

- [ ] **Step 2: Write the table-column write test**

Append to `tests/api/test_tables_nav_script.py`:

```python
def test_table_script_column_write_attempt_is_error_cell(client: TestClient, seed_things) -> None:
    """End-to-end pin of the embedded read-only guarantee: a script COLUMN
    whose snippet writes renders an error cell and mutates nothing."""
    defn = {
        "row_source": {"kind": "scope", "types": []},
        "columns": [
            {"kind": "row_slot"},
            {"kind": "script", "snippet": {"definition": {"code": "def value(els): return dr.create('Thing', {})"}}},
        ],
    }
    r = client.post(papi("/tables/evaluate"), json={"definition": defn})
    assert r.status_code == 200, r.text
    body = r.json()
    cells = [c for row in body["rows"] for c in row["cells"] if c["kind"] == "error"]
    assert cells and all("ReadOnly" in (c["message"] or "") for c in cells)
    # element count unchanged
    r = client.get(papi("/model/elements"), params={"limit": 100})
    assert len(r.json()["items"]) == len(seed_things)
```

Adjust the page/rows wire shape (`body["rows"]`, `row["cells"]`, elements listing) to the real `TablePageOut` field names — `_cell_out` in `routes/tables.py:129` and existing evaluate tests show them. The contract: at least one error cell mentioning ReadOnly, and the element count unchanged.

- [ ] **Step 3: Run the tests**

Run: `pixi run -e core-dev pytest tests/api/test_snippets_routes.py -k read_only -v && pixi run -e core-dev pytest tests/api/test_tables_nav_script.py -v`
Expected: PASS (behavior already correct — these pin it). If the value/step route test FAILS, that is a live security bug: stop and report before continuing.

- [ ] **Step 4: Commit**

```bash
pixi run backend-lint
git add tests/api/test_snippets_routes.py tests/api/test_tables_nav_script.py
git commit -m "test(api): pin the embedded read-only guarantee at route and table level

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Docs

**Files:**
- Modify: `src/data_rover/core/script/README.md` (the `step()` row of the entry-point contract table, ~line 346, and any prose stating "step() must return an iterable")
- Modify: `frontend/README.md` (table section)

- [ ] **Step 1: Update the script README**

In the entry-point contract table and related prose: `step()` may return `None` (ends the chain), a single `Element`, a single element-id `str`, or an iterable of `Element`s/ids; anything else raises the teaching `ValueError` (quote the exact message from Task 1). Add one sentence to the navigation-step section: ids already visited in the chain are dropped by the cycle guard with a `script step: N element(s) dropped (already visited in this chain)` warning.

- [ ] **Step 2: Update the frontend README**

In the table section, add a short paragraph: the script-error recap — badge next to the script-status line once the sweep settles, panel listing failed cells (fed by cache-only `POST /tables/script-errors`; 202 + Retry-After: 1 while computing), click-to-jump via the grid's scroll offsets.

- [ ] **Step 3: Full verification sweep and commit**

Run: `pixi run dr-tidy && pixi run core-test && pixi run -e frontend bash -c 'cd frontend && npm test -- --run && npm run check'`
Expected: everything green.

```bash
git add src/data_rover/core/script/README.md frontend/README.md
git commit -m "docs: step() contract widening, visited-drop warning, script-error recap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
