# Multi-Element `value` Snippets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `value` snippet entry point receives a **list of 1+ elements** (`def value(elements):`) instead of a single element; `step` stays single-element. Spec: `docs/superpowers/specs/2026-07-19-multi-element-value-snippets-design.md`.

**Architecture:** Rename the run-context field `element_id: str | None` → `element_ids: list[str]` end-to-end (API schema → `RunRequest` → guest start message), with counts validated at the route (`value` ≥ 1, `step` == 1, `script` ignores). Both runners resolve the ids to `Element` handles and call `value(els)` / `step(els[0])`. The frontend swaps its single bound element for an ordered chip list.

**Tech Stack:** Python 3.14 (pixi envs `core-dev`), FastAPI + Pydantic v2, wasmtime guest bootstrap, SvelteKit 5 (runes) + vitest.

## Global Constraints

- Everything runs through pixi; there is no global `python`/`node`. Frontend npm scripts MUST run from inside `frontend/` (`pixi run -e frontend bash -c 'cd frontend && npm test'`).
- No compatibility shim: `element_id` is removed, `element_ids` replaces it everywhere (self-contained app, no external API consumers).
- `value`/`step` runs stay `record_ops=False` (read-only). The arity rule for both entry functions stays "exactly one positional argument" — `derive_entry_points` logic is untouched.
- The bridge wire protocol's read-op parameter `"element_id"` (e.g. `{"op": "element", "element_id": ...}`) is a DIFFERENT field and does NOT change. Only the run-request / start-message field changes.
- `element_ids` order is preserved: `value(elements)` receives handles in bound order.
- Preserve the repo's dense-docstring style; update docstrings that state the old single-element contract.
- All work on a feature branch, e.g. `git checkout -b feat/multi-element-value` from `main` before Task 1 (or a worktree via superpowers:using-git-worktrees).

---

### Task 1: Per-entry lint warning message

**Files:**
- Modify: `src/data_rover/core/script/lint.py:96-108`
- Test: `tests/script/test_lint.py:43-45`

**Interfaces:**
- Produces: lint warning text `"value() must take exactly one argument (the list of elements), got N"` and `"step() must take exactly one argument (the element), got N"`. No signature changes.

- [ ] **Step 1: Extend the failing test**

Replace `test_bad_entry_signature_is_warning` in `tests/script/test_lint.py` (currently lines 43-45) with:

```python
def test_bad_entry_signature_is_warning():
    diags = lint_code("def value(a, b):\n    return 1\n")
    assert any(
        d.severity == "warning" and "value" in d.message and "the list of elements" in d.message
        for d in diags
    )
    diags = lint_code("def step(a, b):\n    return 1\n")
    assert any(
        d.severity == "warning" and "step" in d.message and "the element" in d.message
        for d in diags
    )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/script/test_lint.py::test_bad_entry_signature_is_warning -v`
Expected: FAIL — current message says `(the element)` for `value`, so the `"the list of elements"` assertion fails.

- [ ] **Step 3: Implement the per-entry message**

In `src/data_rover/core/script/lint.py`, below `_ENTRY_NAMES = ("value", "step")` (line 30), add:

```python
#: What the single argument means, per entry — `value` receives the full list
#: of bound elements; `step` receives its one simulated element.
_ENTRY_ARG_DESC = {"value": "the list of elements", "step": "the element"}
```

In `lint_code`'s entry-point signature check, change the message line (currently line 106):

```python
                        f"{node.name}() must take exactly one argument "
                        f"({_ENTRY_ARG_DESC[node.name]}), got {argc}",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/script/test_lint.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/script/lint.py tests/script/test_lint.py
git commit -m "feat(snippets): per-entry lint message for value/step signature warnings"
```

---

### Task 2: Backend `element_ids` end-to-end

**Files:**
- Modify: `src/data_rover/core/script/runner.py:16-19,62-76` (`RunRequest` + module docstring)
- Modify: `tests/script/trusted_runner.py:131-137`
- Modify: `src/data_rover/api/script_runner.py:42-43` (docstring), `:294-329` (guest bootstrap `_main`), `:820-828` (start message)
- Modify: `src/data_rover/api/schemas.py:689-704` (`SnippetRunIn`)
- Modify: `src/data_rover/api/routes/snippets.py:326`
- Modify: `src/data_rover/core/script/README.md` (entry-contract note)
- Test: `tests/script/test_trusted_runner.py`, `tests/api/test_snippets_routes.py`, `tests/api/test_snippets_wasm.py:87-104`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `RunRequest(code: str, entry: Literal["script","value","step"] = "script", element_ids: list[str] = [])` (dataclass, `field(default_factory=list)`); `SnippetRunIn.element_ids: list[str]` with route-level 422 validation (`value` ≥ 1, `step` == 1); guest start message key `"element_ids"`. Task 3's frontend client sends `element_ids: string[]`.

> This task is one atomic rename: `RunRequest` is constructed by `routes/snippets.py`, both runners, and the tests — changing the field in stages would leave the suite red between commits.

- [ ] **Step 1: Write the failing trusted-runner tests**

In `tests/script/test_trusted_runner.py`, replace `test_value_entry_against_element` (lines 16-21) with:

```python
def test_value_entry_receives_single_element_as_list():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="def value(elements):\n    return [e.id for e in elements]",
                           entry="value", element_ids=["b1"]),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "['b1']"


def test_value_entry_receives_elements_in_bound_order():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="def value(elements):\n    return [e.name for e in elements]",
                           entry="value", element_ids=["b2", "b1"]),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "['Building Two', 'Building One']"


def test_value_entry_unknown_id_is_runtime_error():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="def value(elements):\n    return 1",
                           entry="value", element_ids=["nope"]),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "runtime"  # dr.NotFoundError surfaced


def test_step_entry_receives_single_element():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="def step(el):\n    return el.id",
                           entry="step", element_ids=["b1"]),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None, res.error
    assert res.result_repr == "'b1'"
```

(`tiny_model()` — `tests/script/conftest.py` — has `Building` elements `b1`/`b2`/`b3` named "Building One/Two/Three".)

- [ ] **Step 2: Run to verify they fail**

Run: `pixi run -e core-dev pytest tests/script/test_trusted_runner.py -v`
Expected: the four new tests FAIL with `TypeError: RunRequest.__init__() got an unexpected keyword argument 'element_ids'`.

- [ ] **Step 3: Change `RunRequest` in `src/data_rover/core/script/runner.py`**

Change the dataclass import (line 24) to:

```python
from dataclasses import dataclass, field
```

Update the module docstring's mode list (lines 17-19) to:

```python
- ``"script"`` — run the code as a module (returns ``None`` unless explicit)
- ``"value"`` — call the snippet's top-level ``value(elements)`` with the
  bound elements (a list, bound order preserved) and return its result
- ``"step"`` — step-wise simulation; ``step(el)`` receives its single element
```

Replace `RunRequest` (lines 62-76) with:

```python
@dataclass
class RunRequest:
    """A request to execute code against a model.

    Attributes:
        code: Python source code as a string (literal or template-expanded).
        entry: Execution mode: ``"script"`` (module), ``"value"`` (function of
            the bound elements), or ``"step"`` (snippet-defined entry point).
        element_ids: Context element ids for the run, in bound order.
            ``"value"`` receives ALL of them as a list of Element handles;
            ``"step"`` receives the first (its single simulated node);
            ``"script"`` ignores them. Count constraints (``value`` >= 1,
            ``step`` == 1) are enforced at the API route, not here — the
            runner layer stays lenient so tests can exercise edge shapes.
    """

    code: str
    entry: Literal["script", "value", "step"] = "script"
    element_ids: list[str] = field(default_factory=list)
```

- [ ] **Step 4: Update `tests/script/trusted_runner.py`**

Replace lines 131-137 (the `else:` branch resolving the entry function):

```python
                    else:
                        fn = namespace.get(req.entry)
                        if fn is None or not callable(fn):
                            raise NameError(f"entry function {req.entry!r} is not defined")
                        els = [namespace["dr"].element(i) for i in req.element_ids]
                        value = fn(els if req.entry == "value" else (els[0] if els else None))
                        have_value = True
```

- [ ] **Step 5: Run trusted-runner tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/script/ -v`
Expected: all PASS.

- [ ] **Step 6: Write the failing route tests**

Append to `tests/api/test_snippets_routes.py` (uses the file's existing `client` fixture, `papi`, `_seed_model`):

```python
def test_run_value_multi_element(client: TestClient) -> None:
    """`value` receives ALL bound elements as a list, in request order."""
    _seed_model(client)
    r = client.post(
        papi("/snippets/run"),
        json={
            "run_id": "rv1",
            "code": "def value(elements):\n    return [e.id for e in elements]\n",
            "entry": "value",
            "element_ids": ["b2", "b1"],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["error"] is None
    assert body["result_repr"] == "['b2', 'b1']"


def test_run_value_requires_element_ids_422(client: TestClient) -> None:
    r = client.post(
        papi("/snippets/run"),
        json={"run_id": "rv2", "code": "def value(elements):\n    return 1\n", "entry": "value"},
    )
    assert r.status_code == 422, r.text


def test_run_step_requires_exactly_one_element_id_422(client: TestClient) -> None:
    for ids in ([], ["b1", "b2"]):
        r = client.post(
            papi("/snippets/run"),
            json={
                "run_id": "rs1",
                "code": "def step(el):\n    return el.id\n",
                "entry": "step",
                "element_ids": ids,
            },
        )
        assert r.status_code == 422, r.text


def test_run_step_single_element(client: TestClient) -> None:
    _seed_model(client)
    r = client.post(
        papi("/snippets/run"),
        json={
            "run_id": "rs2",
            "code": "def step(el):\n    return el.id\n",
            "entry": "step",
            "element_ids": ["b1"],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["result_repr"] == "'b1'"
```

- [ ] **Step 7: Run to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_snippets_routes.py -v`
Expected: the four new tests FAIL (`element_ids` is currently rejected/ignored by `SnippetRunIn` and the route still passes `element_id=` to `RunRequest`, which now raises `TypeError` → 500).

- [ ] **Step 8: Update `SnippetRunIn` in `src/data_rover/api/schemas.py`**

Replace the field `element_id: str | None = None` (line 698) with:

```python
    element_ids: list[str] = Field(default_factory=list)
```

Below the existing `_exactly_one` validator, add:

```python
    @model_validator(mode="after")
    def _entry_context(self) -> SnippetRunIn:
        """`value` runs against 1+ bound elements, `step` against exactly one;
        `script` ignores the field. Enforced here (not in the runner) so a bad
        request 422s before a sandbox instance is consumed."""
        if self.entry == "value" and len(self.element_ids) < 1:
            raise ValueError("entry 'value' requires at least one element id")
        if self.entry == "step" and len(self.element_ids) != 1:
            raise ValueError("entry 'step' requires exactly one element id")
        return self
```

- [ ] **Step 9: Update the route call in `src/data_rover/api/routes/snippets.py`**

Line 326:

```python
            RunRequest(code=code, entry=payload.entry, element_ids=payload.element_ids),
```

- [ ] **Step 10: Update the WASM runner (`src/data_rover/api/script_runner.py`)**

Three edits:

1. Module docstring, the start-message description (~line 42): change `{code, entry, element_id, facade_source, stdout_bytes, result_repr_bytes}` to `{code, entry, element_ids, facade_source, stdout_bytes, result_repr_bytes}`.

2. In `_GUEST_BOOTSTRAP_SOURCE`'s `_main()` — replace line 297:

```python
    element_ids = start["element_ids"]
```

and replace the entry-call block (lines 323-329):

```python
            else:
                fn = namespace.get(entry)
                if fn is None or not callable(fn):
                    raise NameError("entry function " + repr(entry) + " is not defined")
                els = [namespace["dr"].element(i) for i in element_ids]
                value = fn(els if entry == "value" else (els[0] if els else None))
                have_value = True
```

3. The start message in `run()` (~line 823): change `"element_id": req.element_id,` to:

```python
                "element_ids": req.element_ids,
```

- [ ] **Step 11: Update `tests/api/test_snippets_wasm.py`**

Replace `test_wasm_value_entry` (lines 87-104):

```python
def test_wasm_value_entry(wasm_runner: WasmScriptRunner) -> None:
    """`entry="value"` resolves the `value` function and calls it with the
    list of Element handles for `element_ids` in bound order (matching
    TrustedRunner semantics); the return value becomes `result_repr`."""
    from data_rover.core.script.runner import RunLimits, RunRequest

    from tests.script.conftest import tiny_model

    res = wasm_runner.run(
        tiny_model(),
        RunRequest(
            code="def value(elements):\n    return [e['name'] for e in elements]",
            entry="value",
            element_ids=["b2", "b1"],
        ),
        RunLimits(),
        record_ops=False,
        rev=0,
    )
    assert res.error is None, res.error
    assert res.result_repr == "['Building Two', 'Building One']"
```

- [ ] **Step 12: Run the backend suites**

Run: `pixi run -e core-dev pytest tests/script/ tests/api/test_snippets_routes.py tests/api/test_snippets_runner_selection.py -v`
Expected: all PASS.

If the guest binary is vendored (`test -f spikes/code_exec/vendor/python.wasm`), also run the integration test:
`pixi run -e core-dev pytest tests/api/test_snippets_wasm.py -m integration -v` — expected PASS. If the binary is absent, the file's tests skip; that is fine (opt-in integration suite), but the file must still be updated in Step 11.

- [ ] **Step 13: Document the entry contract in `src/data_rover/core/script/README.md`**

In the "read-only / dry-run stance" section, directly after the paragraph ending `raises \`dr.ReadOnlyError\` in the snippet.` (line 92), insert a new paragraph:

```markdown
Entry-point calling convention: a `"value"` run calls the snippet's
top-level `value(elements)` with a **list of `Element` handles** — one per
id in the request's `element_ids`, in that order (validated non-empty at the
route); a `"step"` run calls `step(el)` with its single bound element. The
arity rule for both is unchanged — exactly one argument; for `value` that
one argument is the list.
```

- [ ] **Step 14: Full backend test run, then commit**

Run: `pixi run core-test`
Expected: all PASS (integration-marked tests skip without the guest binary).

```bash
git add src/data_rover/core/script/runner.py src/data_rover/core/script/README.md \
        src/data_rover/api/schemas.py src/data_rover/api/routes/snippets.py \
        src/data_rover/api/script_runner.py tests/script/trusted_runner.py \
        tests/script/test_trusted_runner.py tests/api/test_snippets_routes.py \
        tests/api/test_snippets_wasm.py
git commit -m "feat(snippets): value entry receives a list of 1+ bound elements (element_ids end-to-end)"
```

---

### Task 3: Frontend state + API client

**Files:**
- Modify: `frontend/src/lib/state/snippet-editor.svelte.ts:47-102,138-156`
- Modify: `frontend/src/lib/api/snippets.ts:17-23`
- Modify: `frontend/src/lib/state/index.ts:260-274` (export block)
- Test: `frontend/src/lib/state/__tests__/snippet-editor.test.ts`

**Interfaces:**
- Consumes: backend `element_ids: string[]` request field (Task 2).
- Produces (used by Task 4's components): `SnippetRunState.elements: SnippetBoundElement[]` (`{ id: string; label: string }`, bound order); `addSnippetElement(tabId: string, id: string, label: string): void` (append, dedupe by id; in `step` mode REPLACES the list); `removeSnippetElement(tabId: string, id: string): void`; `clearSnippetElements(tabId: string): void`; `setSnippetEntry` truncates to the first element when switching to `step`. `setSnippetElementContext` is REMOVED.

- [ ] **Step 1: Update the run-payload test and add the failing state tests**

In `frontend/src/lib/state/__tests__/snippet-editor.test.ts`:

1. In the import block from `'../snippet-editor.svelte'`, replace `setSnippetElementContext,` with (keeping alphabetical order):

```ts
	addSnippetElement,
	clearSnippetElements,
	removeSnippetElement,
```

(`addSnippetElement` goes before `closeSnippetDraft`; `clearSnippetElements` right after it; `removeSnippetElement` after `markRunStaged`.)

2. Replace the test `'sends entry + element_id for a value run'` with:

```ts
	it('sends entry + element_ids (bound order, deduped) for a value run', async () => {
		// runSnippetTab refuses to send an entry lint hasn't unlocked (see the
		// entryAvailable guard), so 'value' must be in the lint response —
		// drive that via the debounced lint (fake timers), not the fire-and-
		// forget immediate lint ensureSnippetDraft kicks off.
		vi.useFakeTimers();
		vi.spyOn(snippetsApi, 'lintSnippet').mockResolvedValue({
			diagnostics: [],
			entry_points: ['script', 'value']
		});
		const run = vi.spyOn(snippetsApi, 'runSnippet').mockResolvedValue(RUN_OUT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		updateSnippetCode(tabId, 'def value(elements):\n    return len(elements)\n');
		await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 10);
		setSnippetEntry(tabId, 'value');
		addSnippetElement(tabId, 'e2', 'Building e2');
		addSnippetElement(tabId, 'e1', 'Building e1');
		addSnippetElement(tabId, 'e2', 'Building e2'); // duplicate — ignored
		await runSnippetTab(tabId);
		expect(run.mock.calls[0][0]).toMatchObject({ entry: 'value', element_ids: ['e2', 'e1'] });
		vi.useRealTimers();
	});
```

3. Add two new tests in the same `describe` block:

```ts
	it('element binding: remove, clear, step-mode replace and truncate-on-switch', () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		setSnippetEntry(tabId, 'value');
		addSnippetElement(tabId, 'e1', 'One');
		addSnippetElement(tabId, 'e2', 'Two');
		addSnippetElement(tabId, 'e3', 'Three');
		removeSnippetElement(tabId, 'e2');
		expect(getSnippetRun(tabId).elements.map((e) => e.id)).toEqual(['e1', 'e3']);
		// switching to step keeps only the first chip (single-element contract)
		setSnippetEntry(tabId, 'step');
		expect(getSnippetRun(tabId).elements.map((e) => e.id)).toEqual(['e1']);
		// step: picking replaces instead of appending
		addSnippetElement(tabId, 'e9', 'Nine');
		expect(getSnippetRun(tabId).elements.map((e) => e.id)).toEqual(['e9']);
		clearSnippetElements(tabId);
		expect(getSnippetRun(tabId).elements).toEqual([]);
	});

	it('refuses to run a value entry with no bound elements', async () => {
		const run = vi.spyOn(snippetsApi, 'runSnippet').mockResolvedValue(RUN_OUT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		setSnippetEntry(tabId, 'value');
		await runSnippetTab(tabId);
		expect(run).not.toHaveBeenCalled();
	});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- --run src/lib/state/__tests__/snippet-editor.test.ts'`
Expected: FAIL — `addSnippetElement` etc. are not exported.

- [ ] **Step 3: Implement the state changes in `frontend/src/lib/state/snippet-editor.svelte.ts`**

1. Replace the `elementId`/`elementLabel` fields of `SnippetRunState` (lines 55-56) and add the chip type above the interface:

```ts
export interface SnippetBoundElement {
	id: string;
	label: string;
}
```

```ts
	entry: 'script' | 'value' | 'step';
	/** Bound context elements, in bind order — `value` receives all of them,
	 * `step` only ever holds one (add replaces, entry-switch truncates). */
	elements: SnippetBoundElement[];
```

2. In `IDLE_RUN`, replace `elementId: null,` / `elementLabel: null` with:

```ts
	elements: []
```

3. Replace `setSnippetEntry` and `setSnippetElementContext` (lines 93-102) with:

```ts
export function setSnippetEntry(tabId: string, entry: 'script' | 'value' | 'step'): void {
	const rs = getSnippetRun(tabId);
	// `step` binds a single element: switching there with several chips bound
	// keeps only the first so the row never shows an unrunnable step state.
	const elements = entry === 'step' ? rs.elements.slice(0, 1) : rs.elements;
	setRun(tabId, { entry, elements });
}
export function addSnippetElement(tabId: string, id: string, label: string): void {
	const rs = getSnippetRun(tabId);
	if (rs.entry === 'step') {
		setRun(tabId, { elements: [{ id, label }] }); // step: picking replaces
		return;
	}
	if (rs.elements.some((e) => e.id === id)) return; // duplicate — ignored
	setRun(tabId, { elements: [...rs.elements, { id, label }] });
}
export function removeSnippetElement(tabId: string, id: string): void {
	const rs = getSnippetRun(tabId);
	setRun(tabId, { elements: rs.elements.filter((e) => e.id !== id) });
}
export function clearSnippetElements(tabId: string): void {
	setRun(tabId, { elements: [] });
}
```

4. In `runSnippetTab`, replace the guard (line 142):

```ts
	if (rs.entry !== 'script' && rs.elements.length === 0) return; // UI disables Run too
```

and the request field (line 155):

```ts
			element_ids: rs.entry === 'script' ? undefined : rs.elements.map((e) => e.id)
```

- [ ] **Step 4: Update the API client type in `frontend/src/lib/api/snippets.ts`**

In `SnippetRunBody`, replace `element_id?: string;` with:

```ts
	element_ids?: string[];
```

- [ ] **Step 5: Update the export block in `frontend/src/lib/state/index.ts`**

In the `'./snippet-editor.svelte'` export list: remove `setSnippetElementContext,`; add (alphabetical) `addSnippetElement,` and `clearSnippetElements,` before `closeSnippetDraft,`, `removeSnippetElement,` after `reloadSnippetDraft,`, and `type SnippetBoundElement,` with the other `type` exports.

- [ ] **Step 6: Run the state tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- --run src/lib/state/__tests__/snippet-editor.test.ts'`
Expected: all PASS. (Component files still reference the old API — svelte-check will fail until Task 4; that is why Tasks 3 and 4 commit together only after Task 4's check, see Task 4 Step 6.)

- [ ] **Step 7: Commit (state layer compiles standalone; UI catch-up is Task 4)**

```bash
git add frontend/src/lib/state/snippet-editor.svelte.ts frontend/src/lib/api/snippets.ts \
        frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/snippet-editor.test.ts
git commit -m "feat(snippet-ui): bound-element list state + element_ids run payload"
```

---

### Task 4: Frontend UI — chip row, run gating, stub/hint copy

**Files:**
- Modify: `frontend/src/lib/components/Snippet/ElementContextRow.svelte`
- Modify: `frontend/src/lib/components/Snippet/SnippetTab.svelte:49,90`
- Modify: `frontend/src/lib/snippet/entry-stubs.ts:11-27`
- Modify: `frontend/src/lib/snippet/__tests__/entry-stubs.test.ts:32,39`
- Test (create): `frontend/src/lib/components/__tests__/element-context-row.test.ts`

**Interfaces:**
- Consumes (from Task 3): `getSnippetRun(tabId).elements`, `addSnippetElement`, `removeSnippetElement`, `clearSnippetElements`.
- Produces: chip-row UI; keeps the `snippet-element-search` test id; remove buttons carry `aria-label="Remove <label>"`.

- [ ] **Step 1: Write the failing component test**

Create `frontend/src/lib/components/__tests__/element-context-row.test.ts` (mount/flushSync pattern mirrors `lock-control.test.ts`):

```ts
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import {
	addSnippetElement,
	getSnippetRun,
	resetSnippetEditors,
	setSnippetEntry
} from '../../state/snippet-editor.svelte';
import ElementContextRow from '../Snippet/ElementContextRow.svelte';

afterEach(() => {
	resetSnippetEditors();
	document.body.innerHTML = '';
});

it('renders chips for bound elements and removes one via its × button', () => {
	const tabId = 'snip:draft:test';
	setSnippetEntry(tabId, 'value');
	addSnippetElement(tabId, 'e1', 'Building One');
	addSnippetElement(tabId, 'e2', 'Building Two');
	const c = mount(ElementContextRow, { target: document.body, props: { tabId } });
	flushSync();
	expect(document.body.textContent).toContain('Building One');
	expect(document.body.textContent).toContain('Building Two');
	const remove = document.querySelector<HTMLButtonElement>('[aria-label="Remove Building One"]');
	expect(remove).not.toBeNull();
	remove!.click();
	flushSync();
	expect(getSnippetRun(tabId).elements.map((e) => e.id)).toEqual(['e2']);
	unmount(c);
});

it('shows clear-all only with 2+ chips and empties the binding', () => {
	const tabId = 'snip:draft:test2';
	setSnippetEntry(tabId, 'value');
	addSnippetElement(tabId, 'e1', 'One');
	const c = mount(ElementContextRow, { target: document.body, props: { tabId } });
	flushSync();
	const clearAll = () =>
		[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'clear all');
	expect(clearAll()).toBeUndefined();
	addSnippetElement(tabId, 'e2', 'Two');
	flushSync();
	expect(clearAll()).toBeDefined();
	clearAll()!.click();
	flushSync();
	expect(getSnippetRun(tabId).elements).toEqual([]);
	unmount(c);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- --run src/lib/components/__tests__/element-context-row.test.ts'`
Expected: FAIL — the current component renders `run.elementLabel` (now nonexistent) and has no chips/aria-labels.

- [ ] **Step 3: Rewrite `ElementContextRow.svelte`**

Replace the script's state wiring and the label/selection handlers; keep the debounced micro-search exactly as is. Full replacement for the component (search `$effect` body unchanged from current file):

```svelte
<script lang="ts">
	// Shown only for `value`/`step` entry points. `value` binds 1+ elements as
	// removable chips (add appends, deduped); `step` binds exactly one (add
	// replaces — see state/snippet-editor.svelte.ts). The micro-search is a
	// component-local debounce (see Navigation/ElementStartPicker.svelte for
	// the same shape), not a store: nothing here outlives the row.
	import {
		addSnippetElement,
		clearSnippetElements,
		getCachedElements,
		getSelection,
		getSnippetRun,
		removeSnippetElement
	} from '$lib/state';
	import { listElementsPage } from '$lib/api/model-read';
	import { elementDisplayName } from '$lib/util/element-name';
	import type { Element } from '$lib/api/types';

	const MAX_RESULTS = 8;
	const DEBOUNCE_MS = 250;

	let { tabId }: { tabId: string } = $props();

	const run = $derived(getSnippetRun(tabId));
	const selection = $derived(getSelection());
	const canUseSelection = $derived(selection?.kind === 'element');

	let query = $state('');
	let results: Element[] = $state([]);
	let searching = $state(false);
	let searchSeq = 0;

	$effect(() => {
		const q = query.trim();
		const seq = ++searchSeq;
		if (q === '') {
			results = [];
			searching = false;
			return;
		}
		searching = true;
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const page = await listElementsPage({ q, limit: MAX_RESULTS });
					if (seq !== searchSeq) return; // stale response
					results = page.items;
				} catch {
					if (seq !== searchSeq) return;
					results = [];
				} finally {
					if (seq === searchSeq) searching = false;
				}
			})();
		}, DEBOUNCE_MS);
		return () => clearTimeout(timer);
	});

	function useSelection(): void {
		if (!selection || selection.kind !== 'element') return;
		const el = getCachedElements().get(selection.id);
		if (!el) return;
		addSnippetElement(tabId, el.id, elementDisplayName(el));
	}

	function pick(el: Element): void {
		addSnippetElement(tabId, el.id, elementDisplayName(el));
		query = '';
		results = [];
	}
</script>

<div class="relative flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
	<span class="text-muted-foreground">{run.entry === 'step' ? 'Element:' : 'Elements:'}</span>
	{#if run.elements.length === 0}
		<span class="font-mono text-foreground/90">no element bound</span>
	{/if}
	{#each run.elements as bound (bound.id)}
		<span
			class="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-foreground/90"
		>
			{bound.label}
			<button
				type="button"
				class="text-muted-foreground transition-colors hover:text-foreground"
				aria-label={`Remove ${bound.label}`}
				onclick={() => removeSnippetElement(tabId, bound.id)}
			>
				×
			</button>
		</span>
	{/each}
	{#if run.elements.length >= 2}
		<button
			type="button"
			class="text-muted-foreground underline transition-colors hover:text-foreground"
			onclick={() => clearSnippetElements(tabId)}
		>
			clear all
		</button>
	{/if}
	<button
		type="button"
		class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted disabled:opacity-40"
		disabled={!canUseSelection}
		onclick={useSelection}
	>
		Use current selection
	</button>
	<div class="relative">
		<input
			data-testid="snippet-element-search"
			class="w-48 rounded border border-input bg-card px-2 py-1 text-xs"
			placeholder="Search elements…"
			value={query}
			oninput={(e) => (query = e.currentTarget.value)}
		/>
		{#if query.trim() !== ''}
			<ul
				class="absolute left-0 top-full z-20 mt-1 max-h-56 w-64 overflow-y-auto rounded border border-border bg-popover shadow-lg"
			>
				{#if results.length === 0}
					<li class="px-2 py-1 text-muted-foreground/50">
						{searching ? 'Searching…' : 'No matches.'}
					</li>
				{:else}
					{#each results as el (el.id)}
						<li>
							<button
								type="button"
								class="flex w-full items-center gap-2 px-2 py-1 text-left transition-colors hover:bg-muted"
								onclick={() => pick(el)}
							>
								<span class="truncate text-foreground/90">{elementDisplayName(el)}</span>
								<span
									class="ml-auto shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground"
								>
									{el.type_name}
								</span>
							</button>
						</li>
					{/each}
				{/if}
			</ul>
		{/if}
	</div>
</div>
```

- [ ] **Step 4: Update `SnippetTab.svelte`**

Line 49 (run-disabled derivation):

```ts
		run.phase !== 'idle' || !entryOk || (run.entry !== 'script' && run.elements.length === 0)
```

Line 90 (option title):

```svelte
				<option value="value" title="Call a top-level value(elements) with one or more chosen elements (read-only)">
```

- [ ] **Step 5: Update stub/hint copy in `frontend/src/lib/snippet/entry-stubs.ts` and its test**

Replace `ENTRY_HINTS.value` and `STUBS.value` (leave `step` untouched):

```ts
export const ENTRY_HINTS: Record<BoundEntry, string> = {
	value:
		'value runs a top-level function def value(elements): against the bound elements (a list, read-only) and shows its return value. Your snippet doesn’t define one yet.',
	step: 'step runs a top-level function def step(el): — one tick of a step-wise evaluation for the bound element (read-only). Your snippet doesn’t define one yet.'
};

const STUBS: Record<BoundEntry, string> = {
	value:
		'def value(elements):\n' +
		'    # Read-only: compute and return a value for the bound elements.\n' +
		'    return [el.name for el in elements]\n',
	step:
		'def step(el):\n' +
		'    # Read-only: one tick of a step-wise evaluation for the bound element.\n' +
		'    return el.name\n'
};
```

Also update the module's header comment sentence "the server calls the function with the bound element" → "the server calls `value` with the list of bound elements and `step` with its single element".

In `frontend/src/lib/snippet/__tests__/entry-stubs.test.ts`, update the two `value` assertions (lines 32 and 39) to expect `'def value(elements):'`.

- [ ] **Step 6: Run the frontend suite + svelte-check to verify**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test'`
Expected: all PASS.
Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: 0 errors (this also proves no other component still references `elementId`/`setSnippetElementContext`).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/components/Snippet/ElementContextRow.svelte \
        frontend/src/lib/components/Snippet/SnippetTab.svelte \
        frontend/src/lib/snippet/entry-stubs.ts \
        frontend/src/lib/snippet/__tests__/entry-stubs.test.ts \
        frontend/src/lib/components/__tests__/element-context-row.test.ts
git commit -m "feat(snippet-ui): multi-element chip row for value runs"
```

---

### Task 5: Full verification sweep

**Files:**
- Modify: whatever `dr-tidy` reformats (commit as fallout only).

**Interfaces:** none — this task only verifies.

- [ ] **Step 1: Lint/format/typecheck everything**

Run: `pixi run dr-tidy`
Expected: ruff/mypy/pyright and the frontend linters all pass. If it reformats files, re-run the affected tests before committing.

- [ ] **Step 2: Full backend tests**

Run: `pixi run core-test`
Expected: all PASS.

- [ ] **Step 3: Full frontend tests + check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test'` then `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: all PASS, 0 check errors.

- [ ] **Step 4: Residual-reference sweep**

Run: `grep -rn "element_id" src/data_rover/core/script/runner.py src/data_rover/api/schemas.py src/data_rover/api/routes/snippets.py frontend/src/lib/state/snippet-editor.svelte.ts frontend/src/lib/api/snippets.ts`
Expected: no hits except `SnippetRunIn`-unrelated schemas (e.g. `TableCellOut.element_id`, `deleted_element_ids`) — the run-request path must be clean. (Bridge read-op `"element_id"` params in `bridge.py`/`facade_src.py`/`tests/script/test_bridge.py` are a different, unchanged field.)

- [ ] **Step 5: Commit fallout (if any)**

```bash
git add -A
git commit -m "chore(snippets): dr-tidy fallout for multi-element value work"
```

(Skip if the working tree is clean.)
