# Exporter v2 Phase 4 — Transform Snippet Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-entry `transform(doc)` snippet post-processor on both export surfaces (exporter entries and `TableDefinition.transform` for standalone `POST /tables/export`), plus the `entries` cap, entry-point derivation, limits, and frontend pickers.

**Architecture:** The snippet-session bridge gains one new call shape — entry `"transform"` carrying an arbitrary JSON `doc` instead of element ids, returning a `{"kind": "json", "value": ...}` payload. The shared export engine (`table_export_engine.py`) splits its serialize step into shape → transform → serialize and hosts the guest call through a new `TransformHost` (one warm session per distinct transform code per export run). Routes resolve the transform ref up front (exists / same project / `code_snippet` kind / derives a `transform` entry point) and 422 by entry name. Everything else — bundle deps walk, manifest slot — already exists and just gets wired.

**Tech Stack:** Python 3.14 / FastAPI / Pydantic v2 / wasmtime guest; SvelteKit 5 + zod on the frontend. Everything runs through pixi.

**Spec:** `docs/superpowers/specs/2026-08-19-custom-export-v2-design.md` §8 (binding), §11 (frontend), §15 (tests), **§17 Amendments 2026-08-21** (entries cap = 50; 503/429 for runner-missing/busy; jsonl must-return-list; `on_error` checked pre-transform). Read §8 and §17 before starting any task.

## Global Constraints

- **Everything through pixi.** `pixi run core-test`, `pixi run frontend-test`, `pixi run core-lint`, `pixi run dr-tidy`. Frontend pixi tasks set `cwd=frontend` internally — run them from the repo root.
- **`pixi run dr-tidy` MUTATES by default** (no `--check`). Exit 0 is NOT proof of format-clean. The gate that fails on drift is `pixi run dr-tidy check_only=true` — use that in verification, then check `git status --short`.
- **Run `pixi run core-lint` before every Python commit** — pytest cannot catch an annotation-only break under `from __future__ import annotations`. It runs ruff + mypy + pyright; all three must pass.
- **Comments/docstrings are contract** — dense "why the invariant exists" style; comment accuracy is merge-blocking. Preserve and extend the style of the files you touch.
- **Never block Save** — strictness is enforced at run time (422/503/429 naming the offender), never at artifact Save. The ONE exception, by §17.1, is the `entries` max-length cap (a schema bound in the tradition of `SNIPPET_MAX_CODE_BYTES`).
- **RENDER ONLY boundary** — the transform runs after rendering; cell values, row order and script cache keys are computed off the ORIGINAL table definition and must stay byte-identical whether or not a transform is configured.
- **No-bleed rule (§8)** — a table's own `transform` applies only to its standalone export; an exporter entry applies only its entry-level `transform`; entry `transform: None` means "no transform", never "inherit the table's".
- **`tests/` is linted/formatted by nothing** — do not reformat existing test files.
- Work on branch `feat/exporter-v2-phase4`. Merge to `main` with `--no-ff` at the end (finishing skill handles this). Commit trailers name the actual authoring model.
- Python tests import as `from data_rover.core...` (`pythonpath=src`). Run a single test with `pixi run -e core-dev pytest tests/path/test_x.py::test_name -v`.

---

### Task 1: Core schema — `transform` on both surfaces + entries cap

**Files:**
- Modify: `src/data_rover/core/table/exporter.py`
- Modify: `src/data_rover/core/table/schema.py` (TableDefinition, ~line 275)
- Test: `tests/table/test_exporter.py`, `tests/table/test_schema.py`, `tests/api/test_artifact_kinds.py`

**Interfaces:**
- Consumes: existing `TableRef` (exporter.py:61), `ExporterEntry`, `ExporterDefinition`, `overridden_table`, `TableDefinition`.
- Produces: `ExporterEntry.transform: TableRef | None`, `TableDefinition.transform: TableRef | None`, `MAX_EXPORTER_ENTRIES = 50`, `ExporterDefinition.entries` capped at 50, `overridden_table` restating `transform` onto the render copy. Later tasks (6, 7) read `defn.transform` / `entry.transform`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/table/test_exporter.py`:

```python
from pydantic import ValidationError

from data_rover.core.table.exporter import (
    EXPORTER_ADAPTER,
    ExporterEntry,
    MAX_EXPORTER_ENTRIES,
    TableRef,
    overridden_table,
)


def test_entry_transform_defaults_none_and_roundtrips():
    e = ExporterEntry(source=TableRef(ref="t1"))
    assert e.transform is None
    e2 = ExporterEntry(source=TableRef(ref="t1"), transform=TableRef(ref="s1"))
    assert e2.transform is not None and e2.transform.ref == "s1"


def test_entries_capped_at_50():
    entries = [{"source": {"ref": f"t{i}"}} for i in range(MAX_EXPORTER_ENTRIES + 1)]
    with pytest.raises(ValidationError):
        EXPORTER_ADAPTER.validate_python({"entries": entries})
    ok = EXPORTER_ADAPTER.validate_python(
        {"entries": entries[:MAX_EXPORTER_ENTRIES]}
    )
    assert len(ok.entries) == MAX_EXPORTER_ENTRIES


def test_overridden_table_restates_entry_transform(sample_defn):
    # sample_defn: reuse whichever TableDefinition fixture/builder this module
    # already uses for overridden_table tests; the assertion below is the point.
    entry = ExporterEntry(source=TableRef(ref="t1"), transform=TableRef(ref="s1"))
    out = overridden_table(sample_defn, entry)
    assert out.transform is not None and out.transform.ref == "s1"
    # no-bleed: an entry WITHOUT a transform must not inherit the table's
    tainted = sample_defn.model_copy(update={"transform": TableRef(ref="tbl-own")})
    out2 = overridden_table(tainted, ExporterEntry(source=TableRef(ref="t1")))
    assert out2.transform is None
```

(If the module has no reusable `TableDefinition` fixture, build a minimal one inline exactly like the module's existing `overridden_table` tests do — copy their construction.)

Append to `tests/table/test_schema.py`:

```python
def test_table_definition_transform_field_optional():
    # Reuse the module's existing minimal-definition builder; only the new
    # field is under test.
    d = _minimal_defn()  # or however this module builds one
    assert d.transform is None
    d2 = d.model_copy(update={"transform": TableRef(ref="s1")})
    assert d2.transform.ref == "s1"
```

Append to `tests/api/test_artifact_kinds.py` (follow its existing extract/rewrite test shapes):

```python
def test_transform_ref_is_walked_for_deps_and_rewrite():
    payload = {
        "entries": [
            {"source": {"ref": "tbl-1"}, "transform": {"ref": "snip-1"}},
        ]
    }
    assert "snip-1" in extract_refs(payload)
    rewritten = rewrite_refs(payload, {"snip-1": "snip-2"})
    assert rewritten["entries"][0]["transform"]["ref"] == "snip-2"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/table/test_exporter.py tests/table/test_schema.py tests/api/test_artifact_kinds.py -v`
Expected: FAIL — `transform` unknown field / `MAX_EXPORTER_ENTRIES` import error. (The `extract_refs` test may already pass — the walk is generic; keep it as a pin.)

- [ ] **Step 3: Implement**

In `src/data_rover/core/table/exporter.py`:

```python
#: Hard cap on entries per exporter (spec §17.1). A schema bound in the
#: tradition of SNIPPET_MAX_CODE_BYTES — enforced at validation (so it does
#: reject at artifact save), NOT an export-time strictness rule. It closes
#: the Phase-3 finding: POST /exports/run accepts viewer-supplied draft
#: definitions, and an unbounded list let one request chain N whole-table
#: exports (each O(model)) synchronously.
MAX_EXPORTER_ENTRIES = 50
```

On `ExporterEntry`, after `json_doc`:

```python
    #: Per-entry snippet post-processor (spec §8): a `code_snippet` artifact
    #: ref whose `transform(doc)` runs render -> shape -> TRANSFORM ->
    #: serialize, JSON-family formats only. Ref-only by design (no inline
    #: code, unlike SnippetSource). None means "no transform", never
    #: "inherit the table's own" — the no-bleed rule, both directions.
    transform: TableRef | None = None
```

On `ExporterDefinition`: `entries: list[ExporterEntry] = Field(default_factory=list, max_length=MAX_EXPORTER_ENTRIES)`.

In `overridden_table`'s final `model_copy(update={...})`, add `"transform": entry.transform,` with a comment noting the export engine reads its resolved code via an explicit parameter (Task 5) and this restatement exists so the render copy carries the entry's presentation completely — the no-bleed rule made structural.

In `src/data_rover/core/table/schema.py`, `TableDefinition` after `json_split` (import `TableRef` — note the import direction: `exporter.py` imports from `schema.py`, so `TableRef` must MOVE to `schema.py` if a cycle appears; check first — `TableRef` currently lives in `exporter.py` which imports from `schema.py`, so `schema.py` cannot import it back. **Move `TableRef` to `schema.py`** and re-export it from `exporter.py` (`from .schema import TableRef` plus keep it in `exporter.py`'s namespace so existing importers are untouched):

```python
    #: Standalone-export snippet post-processor (spec §8): applies to
    #: POST /tables/export in JSON-family formats ONLY — an exporter entry
    #: never consults it (no-bleed). Presentation-family: never consulted
    #: during evaluation; cell values, row order and script cache keys are
    #: unaffected (the transform runs after rendering).
    transform: TableRef | None = None
```

- [ ] **Step 4: Run tests + lint**

Run: `pixi run -e core-dev pytest tests/table tests/api/test_artifact_kinds.py -v` then `pixi run core-lint`
Expected: PASS, lint clean.

- [ ] **Step 5: Commit** — `feat(exporter): transform ref on both export surfaces + entries cap (phase 4 task 1)`

---

### Task 2: Entry-point derivation — `transform` joins `_ENTRY_NAMES`

**Files:**
- Modify: `src/data_rover/core/script/lint.py:30-33`
- Test: `tests/script/test_lint.py`

**Interfaces:**
- Produces: `derive_entry_points("def transform(doc): ...")` includes `"transform"`; `lint_code` signature-warns a wrong-arity `transform`. `routes/artifacts.py::_apply_derived_metadata` picks this up with zero changes (it calls `derive_entry_points`).

- [ ] **Step 1: Write the failing tests** (append to `tests/script/test_lint.py`, following its existing derive/lint test style):

```python
def test_derive_transform_entry_point():
    eps = derive_entry_points("def transform(doc):\n    return doc\n")
    assert eps == ["script", "transform"]


def test_transform_wrong_arity_warns_not_derived():
    code = "def transform(a, b):\n    return a\n"
    assert "transform" not in derive_entry_points(code)
    diags = lint_code(code)
    assert any(
        d.severity == "warning" and "transform() must take exactly one argument" in d.message
        for d in diags
    )
```

- [ ] **Step 2: Run to verify failure** — `pixi run -e core-dev pytest tests/script/test_lint.py -v` → FAIL.

- [ ] **Step 3: Implement** in `lint.py`:

```python
_ENTRY_NAMES = ("value", "step", "transform")
#: What the single argument means, per entry — `value` receives the full list
#: of bound elements; `step` receives its one simulated element; `transform`
#: receives the rendered export document (spec §8).
_ENTRY_ARG_DESC = {
    "value": "the list of elements",
    "step": "the element",
    "transform": "the document",
}
```

- [ ] **Step 4: Run tests + lint** — PASS. Also run `pixi run -e core-dev pytest tests/api/test_artifacts_routes.py -k entry_points -v` to confirm no derived-metadata regression.

- [ ] **Step 5: Commit** — `feat(script): derive the transform(doc) entry point (phase 4 task 2)`

---

### Task 3: Bridge capability — protocol, facade, trusted runner

**Files:**
- Modify: `src/data_rover/core/script/runner.py` (`SnippetSession` ~189, `decode_call_payload` ~310)
- Modify: `src/data_rover/core/script/facade_src.py` (`_dr_call_entry` ~679, `_dr_serialize_entry_result` ~735)
- Modify: `tests/script/trusted_runner.py` (`_TrustedSession.call` ~233)
- Test: `tests/script/test_transform_call.py` (new)

**Interfaces:**
- Consumes: existing session machinery, `CallResult`.
- Produces: `SnippetSession.call(entry: Literal["value","step","transform"], element_ids, *, doc: object | None = None)`; wire tag `{"kind": "json", "value": <any JSON>}`; `decode_call_payload("transform", ...)` accepting exactly that tag. Task 4 (WASM) and Task 5 (`TransformHost`) call this.

- [ ] **Step 1: Write the failing tests** — `tests/script/test_transform_call.py`:

```python
"""The transform(doc) session call (spec §8): arbitrary JSON in, arbitrary
JSON out, through the same _dr_call_entry driver value/step use. Exercised
against TrustedRunner; the WASM frame has its own integration test."""

from data_rover.core.script.runner import RunLimits, ScriptBudget, decode_call_payload
from tests.script.trusted_runner import TrustedRunner

# Reuse this package's existing model-building helper from conftest/test_session
# for the session's model argument (the transform tests never read the model,
# so the smallest fixture the package offers is fine).


def _session(model, code):
    return TrustedRunner().open_session(
        model, code, RunLimits(), budget=ScriptBudget.start(30)
    )


def test_transform_receives_and_returns_json(model):
    s = _session(model, "def transform(doc):\n    return {'wrapped': doc, 'n': len(doc)}\n")
    assert s.boot_error is None
    r = s.call("transform", [], doc=[{"a": 1}, {"a": 2}])
    assert r.error is None
    assert r.value == {"kind": "json", "value": {"wrapped": [{"a": 1}, {"a": 2}], "n": 2}}


def test_transform_may_read_the_model(model):
    # The facade is unchanged: dr.* reads work inside transform().
    s = _session(model, "def transform(doc):\n    return len(list(dr.elements()))\n")
    r = s.call("transform", [], doc=None)
    assert r.error is None
    assert r.value["kind"] == "json"


def test_transform_raise_is_a_runtime_error(model):
    s = _session(model, "def transform(doc):\n    raise RuntimeError('boom')\n")
    r = s.call("transform", [], doc={})
    assert r.error is not None and r.error.kind == "runtime"
    assert "boom" in r.error.message


def test_transform_unserializable_return_is_an_error(model):
    s = _session(model, "def transform(doc):\n    return object()\n")
    r = s.call("transform", [], doc={})
    assert r.error is not None and "JSON" in r.error.message


def test_missing_transform_entry_is_an_error(model):
    s = _session(model, "def value(elements):\n    return 1\n")
    r = s.call("transform", [], doc={})
    assert r.error is not None and "not defined" in r.error.message


def test_decode_rejects_json_tag_for_value_entry():
    decoded, msg = decode_call_payload("value", {"kind": "json", "value": 1})
    assert decoded is None and msg is not None


def test_decode_transform_accepts_any_json_value():
    for v in (None, 0, "x", [1, {"a": None}], {"k": [True]}):
        decoded, msg = decode_call_payload("transform", {"kind": "json", "value": v})
        assert msg is None and decoded == {"kind": "json", "value": v}
    decoded, msg = decode_call_payload("transform", {"nodes": []})
    assert decoded is None
```

(Use the package's existing model fixture; if none is importable, build the two-element model the way `tests/script/test_session.py` does — copy its construction.)

- [ ] **Step 2: Run to verify failure** — `pixi run -e core-dev pytest tests/script/test_transform_call.py -v` → FAIL (unexpected keyword `doc`).

- [ ] **Step 3: Implement.**

`runner.py` — `SnippetSession` protocol:

```python
    def call(
        self,
        entry: Literal["value", "step", "transform"],
        element_ids: list[str],
        *,
        doc: object | None = None,
    ) -> CallResult: ...
```

Extend its docstring: `doc` is the transform entry's input document (any JSON value, already-decoded); ignored for `value`/`step`. `element_ids` is empty for `transform`.

`decode_call_payload` — add the transform branch FIRST (before the `step` branch), and document that `"json"` is transform-exclusive (value/step keep their closed tag sets; a hostile guest must not smuggle arbitrary structures into an element/scalar consumer):

```python
    if entry == "transform":
        # Arbitrary JSON by contract (spec §8): the payload came through
        # json.loads, so it is structurally JSON already — the only
        # validation is the envelope. Size is the HOST's concern
        # (snippet_transform_max_bytes, enforced in TransformHost), not a
        # wire-shape concern.
        if payload.get("kind") == "json" and "value" in payload:
            return {"kind": "json", "value": payload["value"]}, None
        return None, "malformed transform() result payload"
```

`facade_src.py` — `_dr_call_entry` gains a fourth parameter `doc=None`; replace the dispatch line (keep everything else, including read bookkeeping, exactly as is):

```python
        if entry == "transform":
            value = fn(doc)
        else:
            els = [_fetch_element(i) for i in element_ids]
            value = fn(els if entry == "value" else (els[0] if els else None))
```

`_dr_serialize_entry_result` — add before the `step` branch:

```python
    if entry == "transform":
        _dr_check_json(value)
        return {"kind": "json", "value": value}
```

And define, next to it:

```python
def _dr_check_json(value, _depth=0):
    # transform() returns the REPLACEMENT DOCUMENT (spec §8): any JSON value.
    # Checked recursively here so a bad return produces a teaching error
    # instead of a json.dumps crash in the transport (which would kill the
    # whole session rather than fail the one call). Tuples are admitted —
    # json.dumps serializes them as arrays, matching author intuition.
    if _depth > 100:
        raise ValueError("transform() return value nests too deeply (max 100)")
    if value is None or isinstance(value, _WIRE_SCALARS):
        return
    if isinstance(value, (list, tuple)):
        for v in value:
            _dr_check_json(v, _depth + 1)
        return
    if isinstance(value, dict):
        for k, v in value.items():
            if not isinstance(k, str):
                raise ValueError(
                    "transform() dict keys must be strings; got " + type(k).__name__
                )
            _dr_check_json(v, _depth + 1)
        return
    raise ValueError(
        "transform() must return a JSON-serializable value "
        "(dict/list/str/int/float/bool/None); got " + type(value).__name__
    )
```

(Reminder: `facade_src.py` is exec'd guest source — no imports, no type annotations beyond what the module already uses; match its plain-Python style.)

`tests/script/trusted_runner.py` — `_TrustedSession.call` signature becomes `def call(self, entry: str, element_ids: list[str], *, doc: object | None = None) -> CallResult:` and the driver invocation becomes `self._namespace["_dr_call_entry"](entry, element_ids, elements, doc)`. Skip the `project_roots` projection when `entry == "transform"` (`element_ids` is empty; mirror with `elements = [] if entry == "transform" else (...)`).

- [ ] **Step 4: Run the whole script suite** — `pixi run -e core-dev pytest tests/script -v` → PASS (existing session tests must be untouched by the widening). Then `pixi run core-lint`.

- [ ] **Step 5: Commit** — `feat(script): transform(doc) session-call capability in the bridge protocol (phase 4 task 3)`

---

### Task 4: WASM frame — host + guest shim + integration test

**Files:**
- Modify: `src/data_rover/api/script_runner.py` (guest `_run_embedded` ~423-448; `_WasmSnippetSession.call` ~1223-1256)
- Test: `tests/api/test_snippets_wasm.py` (append one `integration`-marked test)

**Interfaces:**
- Consumes: Task 3's widened `_dr_call_entry(entry, element_ids, elements, doc)` and `decode_call_payload`.
- Produces: the WASM `SnippetSession` honoring `call("transform", [], doc=...)`; wire frame `{"call": {"entry", "element_ids", "elements", "doc"}}`.

- [ ] **Step 1: Write the failing integration test** (append to `tests/api/test_snippets_wasm.py`, using that module's existing fixtures for building the real `WasmScriptRunner` and model; copy the shape of its existing `open_session` test):

```python
@pytest.mark.integration
def test_wasm_transform_call_roundtrip(wasm_runner, model):
    s = wasm_runner.open_session(
        model,
        "def transform(doc):\n    return {'n': len(doc), 'doc': doc}\n",
        RunLimits(),
        budget=ScriptBudget.start(30),
    )
    assert s.boot_error is None
    r = s.call("transform", [], doc=[1, 2, 3])
    s.close()
    assert r.error is None
    assert r.value == {"kind": "json", "value": {"n": 3, "doc": [1, 2, 3]}}
```

- [ ] **Step 2: Run to verify failure** — `pixi run -e core-dev pytest tests/api/test_snippets_wasm.py -m integration -k transform -v` (needs the guest binary; `scripts/ensure_guest.sh` fetches it on any `-e core-dev` run). Expected: FAIL (unexpected keyword `doc`).

- [ ] **Step 3: Implement.** In the guest source string's `_run_embedded` loop: `doc = call.get("doc")` and `res = namespace["_dr_call_entry"](entry, element_ids, elements, doc)`. In `_WasmSnippetSession.call`: signature `def call(self, entry: Literal["value", "step", "transform"], element_ids: list[str], *, doc: object | None = None) -> CallResult:`; skip the projection for transform (`elements = [] if entry == "transform" else (project_roots(...) if self._limits.read_memo_max > 0 else [])`); add `"doc": doc` to the frame dict. Everything else (arming, `_serve_until`, death mapping, decode) is untouched — that is the point of widening rather than adding a sibling method.

- [ ] **Step 4: Run** — the integration test above → PASS; then the full non-integration suite `pixi run core-test` for regressions; `pixi run core-lint`.

- [ ] **Step 5: Commit** — `feat(script): transform doc frame in the WASM bridge (phase 4 task 4)`

---

### Task 5: Settings + `TransformHost` + engine pipeline

**Files:**
- Modify: `src/data_rover/api/settings.py` (after `snippet_result_repr_bytes`, ~line 166)
- Modify: `src/data_rover/api/table_export_engine.py`
- Test: `tests/api/test_transform_host.py` (new)

**Interfaces:**
- Consumes: Task 3/4's `SnippetSession.call(..., doc=)`; `run_limits_from_settings`; `snippet_concurrency` guard (`api/snippet_concurrency.py::concurrency_guard`).
- Produces (Tasks 6/7 depend on these exact names):
  - `Settings.snippet_transform_max_bytes: int` (default `8 * 1024 * 1024`).
  - `class TransformUnavailableError(Exception)` with attribute `busy: bool` — raised when a transform-bearing export cannot run at all; routes map `busy=False → 503`, `busy=True → 429`.
  - `open_transform_host(runner, model, settings) -> TransformHost` — acquires ONE global concurrency slot for the whole run; raises `TransformUnavailableError`.
  - `TransformHost.apply(code: str, doc: object, name: str) -> object` — raises `ValueError` (→ the routes' existing 422 mapping) on any snippet failure, size breach, or unserializable return; `TransformHost.close()` — idempotent, releases sessions + slot.
  - `run_table_export(..., transform_code: str | None = None, transform_host: TransformHost | None = None)`.

- [ ] **Step 1: Write the failing tests** — `tests/api/test_transform_host.py`:

```python
"""TransformHost (spec §8 + §17.2): session reuse per code, size caps, the
failure-is-failure ValueError mapping, and slot acquisition/release."""

import pytest

from data_rover.api.settings import Settings
from data_rover.api.snippet_concurrency import concurrency_guard
from data_rover.api.table_export_engine import (
    TransformUnavailableError,
    open_transform_host,
)
from tests.script.trusted_runner import TrustedRunner

# Build the smallest Model the api test-package already uses for direct
# (non-HTTP) engine tests — see tests/api/_script_fakes.py / the model
# builders in tests/script; the host never reads the model in these tests.


def _settings(**kw):
    return Settings(dev_seed=True, **kw)


def test_no_runner_raises_unavailable_not_busy(model):
    with pytest.raises(TransformUnavailableError) as e:
        open_transform_host(None, model, _settings())
    assert e.value.busy is False


def test_no_slot_raises_busy(model):
    settings = _settings(snippet_concurrency=1)
    assert concurrency_guard.try_acquire_global(global_limit=1)
    try:
        with pytest.raises(TransformUnavailableError) as e:
            open_transform_host(TrustedRunner(), model, settings)
        assert e.value.busy is True
    finally:
        concurrency_guard.release_global()


def test_apply_transforms_and_reuses_one_session_per_code(model):
    host = open_transform_host(TrustedRunner(), model, _settings())
    try:
        code = "def transform(doc):\n    return {'wrapped': doc}\n"
        out1 = host.apply(code, [1], "e1")
        out2 = host.apply(code, [2], "e2")
        assert out1 == {"wrapped": [1]} and out2 == {"wrapped": [2]}
        assert len(host._sessions) == 1  # one warm session per distinct code
    finally:
        host.close()


def test_apply_failures_are_value_errors_naming_the_entry(model):
    host = open_transform_host(TrustedRunner(), model, _settings())
    try:
        with pytest.raises(ValueError, match="entryX"):
            host.apply("def transform(doc):\n    raise RuntimeError('boom')\n", {}, "entryX")
        with pytest.raises(ValueError, match="entryY"):
            host.apply("syntax error here(", {}, "entryY")  # boot error
    finally:
        host.close()


def test_doc_and_result_size_caps(model):
    host = open_transform_host(
        TrustedRunner(), model, _settings(snippet_transform_max_bytes=64)
    )
    try:
        with pytest.raises(ValueError, match="document exceeds"):
            host.apply("def transform(doc):\n    return doc\n", "x" * 100, "big-in")
        with pytest.raises(ValueError, match="result exceeds"):
            host.apply("def transform(doc):\n    return 'y' * 100\n", "x", "big-out")
    finally:
        host.close()


def test_close_releases_the_slot(model):
    settings = _settings(snippet_concurrency=1)
    host = open_transform_host(TrustedRunner(), model, settings)
    host.close()
    host.close()  # idempotent
    assert concurrency_guard.try_acquire_global(global_limit=1)
    concurrency_guard.release_global()
```

(For the `model` fixture, construct the smallest real `Model` the way neighboring direct-engine tests do; a one-element model is plenty.)

- [ ] **Step 2: Run to verify failure** — import error on `TransformUnavailableError`.

- [ ] **Step 3: Implement.**

`settings.py`, after `snippet_result_repr_bytes`:

```python
    #: Cap on the export-transform document, BOTH directions (spec §8): the
    #: serialized doc handed to transform() and the serialized replacement it
    #: returns. Host-side (TransformHost) — deliberately NOT a RunLimits
    #: field, since the guest never enforces it. Breach -> 422 naming the
    #: entry, never a truncation: a machine consumer must not receive a
    #: silently clipped document.
    snippet_transform_max_bytes: int = 8 * 1024 * 1024
```

`table_export_engine.py` — add near the top (imports: `from data_rover.core.script.runner import RunLimits, ScriptBudget, ScriptRunner, SnippetSession`; `from .snippet_concurrency import concurrency_guard`; `from .script_runner import run_limits_from_settings`):

```python
class TransformUnavailableError(Exception):
    """A transform-bearing export cannot run AT ALL: no runner constructed,
    or no interactive concurrency slot free. The ONE exception to this
    engine's degraded-not-failed stance (spec §17.2): silently skipping a
    transform ships untransformed data — a functional-contract breach, not a
    cosmetic degradation — and 422 would mislabel a transient condition as a
    definition error. Routes map busy=False -> 503, busy=True -> 429,
    matching the snippet-console precedent."""

    def __init__(self, message: str, *, busy: bool) -> None:
        super().__init__(message)
        self.busy = busy


class TransformHost:
    """One export run's transform executor: one warm SnippetSession per
    DISTINCT transform code, shared across every entry/file that uses the
    same snippet (spec §8), one global interactive slot for the whole run
    (spec §17.2), one ScriptBudget shared by every call. Construct through
    `open_transform_host`; always `close()` in a finally."""

    def __init__(
        self,
        runner: ScriptRunner,
        model: Model,
        limits: RunLimits,
        budget: ScriptBudget,
        max_bytes: int,
    ) -> None:
        self._runner = runner
        self._model = model
        self._limits = limits
        self._budget = budget
        self._max_bytes = max_bytes
        self._sessions: dict[str, SnippetSession] = {}
        self._released = False

    def apply(self, code: str, doc: object, name: str) -> object:
        """Run `transform(doc)` and return the replacement document.

        Failure = failure (spec §8): a boot error, a raise, a timeout, an
        unserializable return, or a size breach raises ValueError naming
        `name` — the routes' existing ValueError -> 422 mapping carries it,
        so a machine consumer never receives a half-transformed 200."""
        blob = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
        if len(blob.encode("utf-8")) > self._max_bytes:
            raise ValueError(
                f"{name}: transform document exceeds "
                f"snippet_transform_max_bytes ({self._max_bytes})"
            )
        session = self._sessions.get(code)
        if session is None:
            session = self._runner.open_session(
                self._model, code, self._limits, budget=self._budget
            )
            self._sessions[code] = session
        if session.boot_error is not None:
            raise ValueError(
                f"{name}: transform failed to load: {session.boot_error.message}"
            )
        res = session.call("transform", [], doc=doc)
        if res.error is not None:
            raise ValueError(
                f"{name}: transform failed ({res.error.kind}): {res.error.message}"
            )
        assert res.value is not None  # decode contract: value xor error
        out = res.value["value"]
        out_blob = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
        if len(out_blob.encode("utf-8")) > self._max_bytes:
            raise ValueError(
                f"{name}: transform result exceeds "
                f"snippet_transform_max_bytes ({self._max_bytes})"
            )
        return out

    def close(self) -> None:
        if self._released:
            return
        self._released = True
        for s in self._sessions.values():
            s.close()
        self._sessions.clear()
        concurrency_guard.release_global()


def open_transform_host(
    runner: ScriptRunner | None, model: Model, settings: Settings
) -> TransformHost:
    """Acquire ONE interactive slot and build the run's TransformHost.
    Raises TransformUnavailableError (busy=False no runner / busy=True no
    slot) — see that class's docstring for why this is not a degradation."""
    if runner is None:
        raise TransformUnavailableError("script runner unavailable", busy=False)
    if not concurrency_guard.try_acquire_global(
        global_limit=settings.snippet_concurrency
    ):
        raise TransformUnavailableError("snippet runner busy", busy=True)
    return TransformHost(
        runner,
        model,
        run_limits_from_settings(settings),
        ScriptBudget.start(settings.snippet_eval_budget_s),
        settings.snippet_transform_max_bytes,
    )
```

Then rework `run_table_export`: add the two kwargs after `json_doc`:

```python
    transform_code: str | None = None,  # resolved snippet code (never a ref)
    transform_host: TransformHost | None = None,  # run-owned; NOT closed here
```

Guard at the top of the function, right after the `split_on` block (this also covers the standalone surface, whose route deliberately has no per-entry up-front pass):

```python
    if transform_code is not None and format not in JSON_FAMILY:
        # A functional contract, not presentation (spec §8): silently
        # skipping ships untransformed data, so no tolerate-and-ignore.
        raise ValueError(
            f"{name}: transform is only supported for JSON-family formats, "
            f"not {format!r}"
        )
```

Inside the JSON branch, replace `_serialize` with a shape/serialize split plus the hook — the transform sees exactly what would ship (the shaped array/keyed object for `json`, the row-object array for `jsonl`), called once per FILE on the split path. `_check_on_error` deliberately stays on the RENDERED docs, before shaping/transforming (spec §17.4 — a transform cannot launder error markers past the check):

```python
            def _shape(
                docs: list[dict[str, object]], doc_keys: list[str] | None
            ) -> object:
                if format == "jsonl":
                    return docs
                return (
                    dict(zip(doc_keys, docs, strict=True))
                    if doc_keys is not None
                    else docs
                )

            def _transformed(payload: object) -> object:
                if transform_code is None:
                    return payload
                assert transform_host is not None  # routes pair them
                out = transform_host.apply(transform_code, payload, name)
                if format == "jsonl" and not isinstance(out, list):
                    # §17.3: jsonl is newline-delimited; a non-list return
                    # has no honest line serialization.
                    raise ValueError(
                        f"{name}: transform must return a list for jsonl; "
                        f"got {type(out).__name__}"
                    )
                return out

            def _to_bytes(payload: object) -> bytes:
                if format == "jsonl":
                    assert isinstance(payload, list)  # _transformed enforced it
                    return jsonl_bytes(payload)
                if json_doc is not None and not json_doc.pretty:
                    return json.dumps(
                        payload, ensure_ascii=False, separators=(",", ":")
                    ).encode("utf-8")
                return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
```

Call sites: split branch becomes `files.append((f"{stem}.{format}", _to_bytes(_transformed(_shape(part_docs, part_keys)))))` (after the existing `_check_on_error(part_docs)`); unsplit branch becomes `blob = _to_bytes(_transformed(_shape(docs, doc_keys)))` after `_check_on_error(docs)`. Loosen `jsonl_bytes`'s annotation in `core/table/json_export.py` to `docs: list[object]` (json.dumps already handles any JSON value; note in its docstring that post-transform lines may be any JSON value, not only objects). Extend `run_table_export`'s docstring with a short transform paragraph (both surfaces, pipeline position, once-per-file on split, the §17 amendments).

- [ ] **Step 4: Run** — `pixi run -e core-dev pytest tests/api/test_transform_host.py tests/api/test_exports_route.py tests/api/test_table_export_json.py -v` (existing export tests must be untouched by the restructure), then `pixi run core-lint`.

- [ ] **Step 5: Commit** — `feat(exporter): TransformHost + engine shape->transform->serialize pipeline (phase 4 task 5)`

---

### Task 6: Standalone surface — `POST /tables/export`

**Files:**
- Modify: `src/data_rover/api/routes/tables.py` (`_resolve_table` region ~90-128; `export_table` ~477-555)
- Test: `tests/api/test_table_export_transform.py` (new)

**Interfaces:**
- Consumes: Task 5's `open_transform_host`/`TransformUnavailableError`/`transform_code` kwargs; Task 1's `defn.transform`; Task 2's `derive_entry_points`.
- Produces: `_resolve_transform_code(db, project_id, ref, name) -> str` in `routes/tables.py` — raises `ValueError` (→ 422) naming `name` for missing/foreign/wrong-kind refs and for a snippet without a `transform` entry point. Task 7 imports it (`from .tables import _resolve_table, _resolve_transform_code`).

- [ ] **Step 1: Write the failing tests** — `tests/api/test_table_export_transform.py`:

```python
"""TableDefinition.transform on POST /tables/export (spec §8: the standalone
surface). Runner injected via dependency_overrides -> TrustedRunner."""

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.script_runner import get_runner

from tests.script.trusted_runner import TrustedRunner

from .conftest import AUTH_HEADERS, papi, seed_default_project
from .test_artifacts_routes import _bootstrap_model
from .test_exports_route import TABLE_PAYLOAD


@pytest.fixture
def app():
    seed_default_project()
    application = create_app()
    yield application
    application.dependency_overrides.clear()


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    app.dependency_overrides[get_runner] = lambda: TrustedRunner()
    c = TestClient(app)
    c.headers.update(AUTH_HEADERS)
    return c


def _mk_snippet(client, name, code):
    r = client.post(
        papi("/artifacts"),
        json={"kind": "code_snippet", "name": name, "payload": {"code": code}},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201
    return r.json()["id"]


WRAP = "def transform(doc):\n    return {'rows': doc, 'count': len(doc)}\n"


def _export(client, definition, format="json"):
    return client.post(
        papi("/tables/export"),
        json={"definition": definition, "format": format},
        headers=AUTH_HEADERS,
    )


def test_transform_applies_to_standalone_json_export(client):
    _bootstrap_model(client)
    snip = _mk_snippet(client, "wrap", WRAP)
    r = _export(client, {**TABLE_PAYLOAD, "transform": {"ref": snip}})
    assert r.status_code == 200
    doc = json.loads(r.content)
    assert doc["count"] == 3 and len(doc["rows"]) == 3


def test_transform_on_xlsx_is_422(client):
    _bootstrap_model(client)
    snip = _mk_snippet(client, "wrap2", WRAP)
    r = _export(client, {**TABLE_PAYLOAD, "transform": {"ref": snip}}, format="xlsx")
    assert r.status_code == 422
    assert "JSON-family" in r.json()["detail"]


def test_unknown_or_wrong_kind_ref_is_422(client):
    _bootstrap_model(client)
    r = _export(client, {**TABLE_PAYLOAD, "transform": {"ref": "nope"}})
    assert r.status_code == 422
    assert "transform" in r.json()["detail"]


def test_snippet_without_transform_entry_is_422(client):
    _bootstrap_model(client)
    snip = _mk_snippet(client, "noentry", "def value(elements):\n    return 1\n")
    r = _export(client, {**TABLE_PAYLOAD, "transform": {"ref": snip}})
    assert r.status_code == 422
    assert "transform" in r.json()["detail"]


def test_no_runner_is_503(app):
    # NO get_runner override on this app: the default runner is None in tests.
    c = TestClient(app)
    c.headers.update(AUTH_HEADERS)
    _bootstrap_model(c)
    snip = _mk_snippet(c, "wrap3", WRAP)
    r = _export(c, {**TABLE_PAYLOAD, "transform": {"ref": snip}})
    assert r.status_code == 503


def test_transform_raise_is_422_not_200(client):
    _bootstrap_model(client)
    snip = _mk_snippet(client, "boom", "def transform(doc):\n    raise RuntimeError('nope')\n")
    r = _export(client, {**TABLE_PAYLOAD, "transform": {"ref": snip}})
    assert r.status_code == 422
    assert "nope" in r.json()["detail"]


def test_no_bleed_table_transform_never_leaks_into_exporter_entry(client):
    # §15: the table's own transform must NOT apply when an exporter entry
    # (with transform: None) exports that same table.
    _bootstrap_model(client)
    snip = _mk_snippet(client, "wrap4", WRAP)
    t = client.post(
        papi("/artifacts"),
        json={"kind": "table", "name": "tt",
              "payload": {**TABLE_PAYLOAD, "transform": {"ref": snip}}},
        headers=AUTH_HEADERS,
    ).json()["id"]
    r = client.post(
        papi("/exports/run"),
        json={"definition": {"entries": [
            {"source": {"ref": t}, "name": "plain", "format": "json"}]},
            "name": "d"},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200  # zip; the entry rendered UNtransformed
    import io, zipfile
    z = zipfile.ZipFile(io.BytesIO(r.content))
    doc = json.loads(z.read("plain.json"))
    assert isinstance(doc, list)  # a plain row array, not {'rows':..., 'count':...}
```

- [ ] **Step 2: Run to verify failure** — transform silently ignored today: the first test gets a plain array → FAIL.

- [ ] **Step 3: Implement.** In `routes/tables.py`, add beside `_resolve_table` (module level, taking `db`/`project_id` as args so `exports.py` can import it):

```python
def _resolve_transform_code(
    db: DbSession, project_id: str, ref: str, name: str
) -> str:
    """Resolve a transform ref (spec §8) to its snippet CODE, strictly.

    Deliberately NOT the tolerant `_fetch_snippet`/resolve path script
    columns use: a dangling script-column ref degrades to error cells, but a
    dangling transform is a functional-contract hole — silently skipping it
    ships untransformed data — so every failure is a ValueError naming
    `name` (the routes' 422 mapping). The entry point is RE-DERIVED from the
    code, never read off the stored `entry_points` (advisory metadata only —
    core/script/schema.py — and stale for any snippet last written before
    "transform" joined _ENTRY_NAMES)."""
    r = content.get_artifact(db, ref)
    if r is None or r.project_id != project_id or r.kind is not ArtifactKind.code_snippet:
        raise ValueError(f"{name}: unknown transform snippet {ref}")
    snippet = SNIPPET_ADAPTER.validate_python(r.payload)
    if "transform" not in derive_entry_points(snippet.code):
        raise ValueError(
            f"{name}: snippet {ref} does not define a one-argument "
            "top-level transform(doc)"
        )
    return snippet.code
```

(Import `derive_entry_points` from `data_rover.core.script.lint`; `SNIPPET_ADAPTER`/`ArtifactKind`/`content` are already imported in this module.)

In `export_table`, before `run_table_export` (inside the existing `try` so `ValueError → 422` holds), resolve + open the host; thread through and close:

```python
        transform_code: str | None = None
        transform_host = None
        if defn.transform is not None:
            transform_code = _resolve_transform_code(
                db, project_id, defn.transform.ref, name
            )
            transform_host = open_transform_host(runner, model, settings)
        try:
            result = run_table_export(
                ...existing kwargs...,
                transform_code=transform_code,
                transform_host=transform_host,
            )
            ...existing response assembly (202 / zip / single file), unchanged...
        finally:
            if transform_host is not None:
                transform_host.close()
```

And extend the route's outer `except` chain with, placed BEFORE the generic handlers:

```python
    except TransformUnavailableError as exc:
        raise HTTPException(
            status_code=429 if exc.busy else 503, detail=str(exc)
        ) from exc
```

(Import `TransformUnavailableError`, `open_transform_host` from `..table_export_engine`.) Mention in `export_table`'s docstring: the transform is the table's OWN (`defn.transform`), applied only here — never by an exporter entry (no-bleed, spec §8).

- [ ] **Step 4: Run** — `pixi run -e core-dev pytest tests/api/test_table_export_transform.py tests/api/test_tables_routes.py -v`; `pixi run core-lint`.

- [ ] **Step 5: Commit** — `feat(exporter): TableDefinition.transform on POST /tables/export (phase 4 task 6)`

---

### Task 7: Exporter surface — `POST /exports/run` + manifest

**Files:**
- Modify: `src/data_rover/api/routes/exports.py`
- Test: `tests/api/test_exports_transform.py` (new)

**Interfaces:**
- Consumes: Task 6's `_resolve_transform_code`; Task 5's host/engine kwargs; Task 1's `entry.transform`; existing `ManifestEntry.transform` slot (`export_manifest.py:48` — the "Always None in Phase 1" wire slot, now fed).
- Produces: the complete exporter-entry transform behavior; `ManifestEntry.transform` carries the snippet ref id.

- [ ] **Step 1: Write the failing tests** — `tests/api/test_exports_transform.py` (reuse the app/client/`_mk_snippet` fixtures from Task 6's module by importing them, or copy the ~20 fixture lines — either is fine, but note `tests/` is unformatted-by-design so match neighboring style):

```python
"""ExporterEntry.transform through POST /exports/run (spec §8/§15): per-entry
application, no-bleed (entry -> table direction), session sharing, split
per-file calls, jsonl list contract, manifest recording, 503/429."""

import io
import json
import zipfile

# fixtures/helpers: same app/client-with-TrustedRunner shape as
# test_table_export_transform.py; _mk_table/_mk_export/_bootstrap_model from
# test_exports_route.py / test_artifacts_routes.py.

WRAP = "def transform(doc):\n    return {'rows': doc, 'count': len(doc)}\n"


def test_entry_transform_applies_and_manifest_records_it(client):
    _bootstrap_model(client)
    t = _mk_table(client, "alpha")
    snip = _mk_snippet(client, "wrap", WRAP)
    art = _mk_export(client, [
        {"source": {"ref": t}, "name": "doc", "format": "json",
         "transform": {"ref": snip}},
    ])
    r = _run(client, art)
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    doc = json.loads(z.read("doc.json"))
    assert doc["count"] == 3
    manifest = json.loads(z.read("manifest.json"))
    assert manifest["entries"][0]["transform"] == snip


def test_no_bleed_entry_transform_never_touches_standalone_export(client):
    # §15, the other direction of test_table_export_transform's no-bleed
    # test: an exporter entry's transform must not affect the table's own
    # standalone export.
    _bootstrap_model(client)
    t = _mk_table(client, "beta")
    snip = _mk_snippet(client, "wrap2", WRAP)
    _mk_export(client, [{"source": {"ref": t}, "name": "doc", "format": "json",
                         "transform": {"ref": snip}}])
    r = client.post(
        papi("/tables/export"),
        json={"artifact_id": t, "format": "json"},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200
    assert isinstance(json.loads(r.content), list)  # untransformed row array


def test_transform_on_csv_entry_is_422_naming_it(client):
    _bootstrap_model(client)
    t = _mk_table(client, "gamma")
    snip = _mk_snippet(client, "wrap3", WRAP)
    art = _mk_export(client, [
        {"source": {"ref": t}, "name": "bad", "format": "csv",
         "transform": {"ref": snip}},
    ])
    r = _run(client, art)
    assert r.status_code == 422
    assert "bad" in r.json()["detail"]


def test_missing_transform_snippet_is_422_up_front(client):
    _bootstrap_model(client)
    t = _mk_table(client, "delta")
    art = _mk_export(client, [
        {"source": {"ref": t}, "name": "doc", "format": "json",
         "transform": {"ref": "nope"}},
    ])
    r = _run(client, art)
    assert r.status_code == 422
    assert "doc" in r.json()["detail"]


def test_split_entry_transform_called_once_per_file(client):
    _bootstrap_model(client)  # 3 Block elements -> 3 split files
    t = _mk_table(client, "eps")
    snip = _mk_snippet(client, "wrap4", WRAP)
    art = _mk_export(client, [{
        "source": {"ref": t}, "name": "per-el", "format": "json",
        "json_split": {"enabled": True, "filename_template": "${name}"},
        "transform": {"ref": snip},
    }])
    r = _run(client, art)
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    members = [n for n in z.namelist() if n != "manifest.json"]
    assert len(members) == 3
    for m in members:
        assert json.loads(z.read(m))["count"] == 1  # each file's own doc


def test_jsonl_transform_must_return_list(client):
    _bootstrap_model(client)
    t = _mk_table(client, "zeta")
    bad = _mk_snippet(client, "notalist", "def transform(doc):\n    return {'a': 1}\n")
    art = _mk_export(client, [
        {"source": {"ref": t}, "name": "lines", "format": "jsonl",
         "transform": {"ref": bad}},
    ])
    r = _run(client, art)
    assert r.status_code == 422
    assert "must return a list" in r.json()["detail"]


def test_jsonl_list_transform_ships_lines(client):
    _bootstrap_model(client)
    t = _mk_table(client, "eta")
    keep = _mk_snippet(client, "first2", "def transform(doc):\n    return doc[:2]\n")
    art = _mk_export(client, [
        {"source": {"ref": t}, "name": "lines", "format": "jsonl",
         "transform": {"ref": keep}},
    ])
    r = _run(client, art)
    z = zipfile.ZipFile(io.BytesIO(r.content))
    lines = z.read("lines.jsonl").decode().strip().split("\n")
    assert len(lines) == 2


def test_two_entries_same_snippet_share_a_session(client, app):
    # Observable via a module-level counter in the snippet: sessions exec
    # the module ONCE, so a shared session increments across calls.
    _bootstrap_model(client)
    t1, t2 = _mk_table(client, "s1"), _mk_table(client, "s2")
    code = ("_n = [0]\n"
            "def transform(doc):\n"
            "    _n[0] += 1\n"
            "    return {'call': _n[0]}\n")
    snip = _mk_snippet(client, "counter", code)
    art = _mk_export(client, [
        {"source": {"ref": t1}, "name": "a", "format": "json", "transform": {"ref": snip}},
        {"source": {"ref": t2}, "name": "b", "format": "json", "transform": {"ref": snip}},
    ])
    r = _run(client, art)
    z = zipfile.ZipFile(io.BytesIO(r.content))
    calls = {json.loads(z.read("a.json"))["call"], json.loads(z.read("b.json"))["call"]}
    assert calls == {1, 2}  # one module exec, two calls — a shared warm session


def test_no_runner_is_503(app):
    c = TestClient(app)  # no get_runner override: default runner is None
    c.headers.update(AUTH_HEADERS)
    _bootstrap_model(c)
    t = _mk_table(c, "theta")
    snip = _mk_snippet(c, "wrap5", WRAP)
    art = _mk_export(c, [
        {"source": {"ref": t}, "name": "doc", "format": "json",
         "transform": {"ref": snip}},
    ])
    assert _run(c, art).status_code == 503


def test_busy_is_429(monkeypatch, app):
    # Settings are constructed per-request (get_settings), so the env var
    # takes effect immediately; hold the ONLY interactive slot ourselves so
    # open_transform_host's try_acquire_global fails.
    monkeypatch.setenv("DATA_ROVER_SNIPPET_CONCURRENCY", "1")
    app.dependency_overrides[get_runner] = lambda: TrustedRunner()
    c = TestClient(app)
    c.headers.update(AUTH_HEADERS)
    _bootstrap_model(c)
    t = _mk_table(c, "iota")
    snip = _mk_snippet(c, "wrap6", WRAP)
    art = _mk_export(c, [
        {"source": {"ref": t}, "name": "doc", "format": "json",
         "transform": {"ref": snip}},
    ])
    from data_rover.api.snippet_concurrency import concurrency_guard

    assert concurrency_guard.try_acquire_global(global_limit=1)
    try:
        assert _run(c, art).status_code == 429
    finally:
        concurrency_guard.release_global()
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** in `routes/exports.py`:

In the up-front pass (the single loop, ~line 240), add index-aligned transform resolution — one more accumulator, same by-construction alignment stance as `folders` (extend the loop's alignment comment accordingly):

```python
    transform_codes: list[str | None] = []
```

Inside the loop, alongside the template `try` (its own `try`, feeding the SAME `bad_templates`-style aggregation — reuse a new `bad_transforms` list to keep messages grouped):

```python
        code_: str | None = None
        if entry.transform is not None:
            label = entry.name or entry.source.ref
            try:
                if entry.format not in JSON_FAMILY:
                    raise ValueError(
                        f"{label}: transform is only supported for JSON-family "
                        f"formats, not {entry.format!r}"
                    )
                code_ = _resolve_transform_code(
                    db, project_id, entry.transform.ref, label
                )
            except ValueError as exc:
                bad_transforms.append(str(exc))
        transform_codes.append(code_)
```

After the `bad_templates` 422, add:

```python
    if bad_transforms:
        raise HTTPException(
            status_code=422,
            detail="invalid transform for entries: " + "; ".join(bad_transforms),
        )
```

Open the run-level host only when needed, and close it around the WHOLE run loop + assembly (the host's sessions are shared across entries):

```python
    transform_host = None
    if any(c is not None for c in transform_codes):
        transform_host = open_transform_host(runner, model, settings)
    try:
        ... existing run loop (zip now also over transform_codes, strict=True),
            passing transform_code=code_, transform_host=transform_host to
            run_table_export ...
        ... existing pending/assembly/manifest/response code ...
    finally:
        if transform_host is not None:
            transform_host.close()
```

Route-level mapping in `run_export`/`run_export_by_name` is unnecessary — raise happens inside `_execute_export`; add the exception handler THERE, around `open_transform_host` (or let it propagate: add near the top of `_execute_export`'s docstring that `TransformUnavailableError` maps below). Concretely: wrap the `open_transform_host` call:

```python
        try:
            transform_host = open_transform_host(runner, model, settings)
        except TransformUnavailableError as exc:
            raise HTTPException(
                status_code=429 if exc.busy else 503, detail=str(exc)
            ) from exc
```

Manifest: in the `ManifestEntry(...)` construction (~line 417), add `transform=entry.transform.ref if entry.transform is not None else None,`. Update `export_manifest.py:48`'s field comment from "Always None in Phase 1 … a later phase's per-entry snippet post-processor" to say it now carries the entry's transform snippet artifact id (Phase 4), `None` when the entry has no transform.

Also check `tests/api/test_export_manifest.py` for a pin on the always-None comment and update if needed.

- [ ] **Step 4: Run** — `pixi run -e core-dev pytest tests/api/test_exports_transform.py tests/api/test_exports_route.py tests/api/test_export_manifest.py -v`; `pixi run core-lint`; then the full `pixi run core-test`.

- [ ] **Step 5: Commit** — `feat(exporter): per-entry transform through POST /exports/run + manifest recording (phase 4 task 7)`

---

### Task 8: Frontend — types, entry stubs, TransformPicker component

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (`TableDefinitionSchema` ~964, `ExporterEntrySchema` ~1008)
- Modify: `frontend/src/lib/snippet/entry-stubs.ts`
- Create: `frontend/src/lib/components/Export/TransformPicker.svelte`
- Modify: `frontend/src/lib/table/exporter.ts` (`entryForTable` — explicit `transform: null`)
- Test: `frontend/src/lib/snippet/entry-stubs.test.ts` (or the module's existing test file), `frontend/src/lib/components/Export/TransformPicker.test.ts`

**Interfaces:**
- Consumes: `referenceableArtifactHeaders('code_snippet')` (`$lib/state`), `entryAvailable`.
- Produces: `TableRefSchema` (`{ ref: string }`), `transform` on both zod schemas; `BoundEntry` widened with `'transform'` + hint + stub; `<TransformPicker value={ref|null} disabled onChange={(ref|null)=>void} />`. Tasks 9/10 mount the picker.

- [ ] **Step 1: Write the failing tests.**

Entry stubs (append to the module's existing vitest file, or create one following `docs-view.test.ts`-style siblings):

```ts
import { describe, expect, it } from 'vitest';
import { ENTRY_HINTS, entryAvailable, withStub } from './entry-stubs';

describe('transform entry', () => {
	it('is gated on entry_points like value/step', () => {
		expect(entryAvailable('transform', ['script', 'transform'])).toBe(true);
		expect(entryAvailable('transform', ['script', 'value'])).toBe(false);
		expect(entryAvailable('transform', undefined)).toBe(false);
	});
	it('has a hint and a one-arg stub', () => {
		expect(ENTRY_HINTS.transform).toContain('transform');
		expect(withStub('', 'transform')).toContain('def transform(doc):');
	});
});
```

`TransformPicker.test.ts` (follow the mount/mocking pattern of the existing `AddTablePicker` tests — mock `$lib/state`'s `referenceableArtifactHeaders`):

```ts
// Cases:
// 1. lists only code_snippet artifacts whose entry_points include 'transform'
// 2. renders a "None" option; picking it calls onChange(null)
// 3. picking a snippet calls onChange(its id)
// 4. a selected ref that fell out of the option list renders the
//    "(missing)" option rather than being silently cleared
```

Write these four cases fully, modeled on `AddTablePicker`'s existing test file (same testing-library helpers, same state-mock shape).

- [ ] **Step 2: Run to verify failure** — `pixi run frontend-test` → FAIL.

- [ ] **Step 3: Implement.**

`types.ts` — add above `TableDefinitionSchema`:

```ts
/** A `{ref}` artifact reference — mirror of core/table/schema.py::TableRef.
 *  For `transform` this is ref-ONLY by design (no inline code, unlike
 *  SnippetSourceSchema): the snippet must be a committed code_snippet
 *  artifact defining a one-arg top-level transform(doc). */
export const TableRefSchema = z.object({ ref: z.string() });
export type TableRef = z.infer<typeof TableRefSchema>;
```

Add `transform: TableRefSchema.nullish()` to BOTH `TableDefinitionSchema` (beside `json_split`) and `ExporterEntrySchema` (after `json_doc`), each with a one-line comment: JSON-family only, strict at export time (422/503/429 from the run route), never validated client-side, never blocks Save; entry `null` = no transform, never "inherit the table's" (no-bleed).

`entry-stubs.ts`:

```ts
export type BoundEntry = 'value' | 'step' | 'transform';
```

Add to `ENTRY_HINTS`: `transform: 'transform runs a top-level function def transform(doc): against the rendered export document (read-only reads allowed) and ships its return value instead. Your snippet doesn’t define one yet.'`
Add to `STUBS`:

```ts
	transform:
		'def transform(doc):\n' +
		'    # Post-process the rendered export document (any JSON value) and\n' +
		'    # return the replacement to ship. jsonl entries must return a list.\n' +
		'    return doc\n'
```

Then run `pixi run frontend-check`: any `Record<BoundEntry, ...>` consumer outside this file now fails exhaustiveness — add the `transform` key where the compiler points (expected: none beyond this module, but the check is the authority).

`TransformPicker.svelte`:

```svelte
<script lang="ts">
	// Ref-only snippet picker for the export transform hook (spec §8/§11):
	// the reusable core of SnippetSourceEditor's ref mode (refOptions +
	// refMissing) without its inline-code half — transform is TableRef-only
	// by schema. Options are committed code_snippet artifacts whose
	// server-derived entry_points include 'transform'
	// (referenceableArtifactHeaders excludes staged temp ids — a temp id
	// must never reach a payload). A selected ref that fell out of the list
	// (deleted, or its entry_points no longer cover transform) is surfaced
	// as "(missing)" and never silently cleared — the user might be mid-edit
	// of the snippet elsewhere. All strictness is server-side at export time
	// (422/503/429); this control never blocks Save.
	import { referenceableArtifactHeaders } from '$lib/state';
	import { entryAvailable } from '$lib/snippet/entry-stubs';

	let {
		value,
		disabled = false,
		onChange
	}: {
		value: string | null;
		disabled?: boolean;
		onChange: (ref: string | null) => void;
	} = $props();

	const options = $derived(
		referenceableArtifactHeaders('code_snippet').filter((a) =>
			entryAvailable('transform', a.entry_points ?? undefined)
		)
	);
	const missing = $derived(!!value && !options.some((h) => h.id === value));
</script>

<select
	data-testid="transform-picker"
	aria-label="Transform snippet"
	class="rounded border border-input bg-card px-1.5 py-0.5 text-xs"
	{disabled}
	value={value ?? ''}
	onchange={(e) => onChange(e.currentTarget.value || null)}
>
	<option value="">No transform</option>
	{#if missing}
		<option value={value}>saved snippet (missing)</option>
	{/if}
	{#each options as h (h.id)}
		<option value={h.id}>{h.name}</option>
	{/each}
</select>
```

`table/exporter.ts` — in `entryForTable`'s returned object add `transform: null` with a comment: deliberately NOT copied from the table at add time — a transform is a functional contract, not cosmetic presentation, and entry `null` means "no transform" (no-bleed; §8). Leave `applyEntryOverrides`/`overridesFromDefinition` untouched — the entry-row picker owns `transform`, and the layout dialog's save patch must not clobber it (its `Pick<>` excludes the field by design; note that in a comment beside the `Pick`).

- [ ] **Step 4: Run** — `pixi run frontend-test` and `pixi run frontend-check` → PASS.

- [ ] **Step 5: Commit** — `feat(frontend): transform types, entry stub, and ref-only TransformPicker (phase 4 task 8)`

---

### Task 9: Frontend — exporter entry row picker

**Files:**
- Modify: `frontend/src/lib/components/Export/ExporterTab.svelte` (entry row, after the format buttons ~line 387)
- Test: the ExporterTab vitest file (extend)

**Interfaces:**
- Consumes: Task 8's `TransformPicker`, `updateExporterEntry` (patch-merge, already generic over `Partial<ExporterEntry>` — no state-module change needed).

- [ ] **Step 1: Write the failing tests** (extend the existing ExporterTab test module, using its established mount + state seeding helpers):

```ts
// Cases:
// 1. a JSON-family entry row renders the transform picker; picking a
//    snippet patches the entry ({ transform: { ref } }) and marks dirty
// 2. an xlsx/csv entry row hides the picker
// 3. an xlsx entry that STILL carries a transform (format flipped after
//    picking) shows the warning text instead of silently hiding the state
```

Write all three fully in the module's existing style (its tests already exercise `updateExporterEntry` through row inputs — mirror one).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** In the entry row, after the format-buttons `div`:

```svelte
{#if isJsonFamily(entry.format)}
	<TransformPicker
		value={entry.transform?.ref ?? null}
		disabled={disabledEntry}
		onChange={(ref) =>
			updateExporterEntry(tabId, i, { transform: ref ? { ref } : null })}
	/>
{:else if entry.transform}
	<!-- A transform left behind by a format flip: the server 422s it at run
	     time (a functional contract is never tolerate-and-ignored, spec §8),
	     so surface it rather than hiding the state. Never blocks Save. -->
	<span class="shrink-0 text-warning" data-testid="export-entry-{i}-transform-warning">
		transform needs a JSON format
	</span>
{/if}
```

Imports: `TransformPicker from './TransformPicker.svelte'`, `isJsonFamily` from `$lib/api/types`.

- [ ] **Step 4: Run** — `pixi run frontend-test` + `pixi run frontend-check` → PASS.

- [ ] **Step 5: Commit** — `feat(frontend): transform picker in exporter entry rows (phase 4 task 9)`

---

### Task 10: Frontend — table Export dialog picker

**Files:**
- Modify: `frontend/src/lib/components/Table/ExportDialog.svelte` (the format-toggle strip, ~line 162)
- Test: the ExportDialog vitest file (extend)

**Interfaces:**
- Consumes: Task 8's `TransformPicker`; `updateTableExportSettings(tabId, defn)` (writes the whole definition into the draft — the dialog's existing snapshot/cancel machinery then covers `transform` for free, since it snapshots and restores the full definition).

- [ ] **Step 1: Write the failing tests** (extend the existing ExportDialog test module):

```ts
// Cases:
// 1. with a JSON-family format selected, the picker renders; picking writes
//    { ...defn, transform: { ref } } through updateTableExportSettings
// 2. with xlsx selected, the picker is hidden
// 3. Cancel restores the pre-dialog transform (covered by the existing
//    snapshot restore — assert it explicitly for the new field)
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** In the format-strip row (same flex container as the format buttons, right-aligned):

```svelte
{#if isJsonFamily(format) && defn}
	<span class="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
		Transform
		<TransformPicker
			value={defn.transform?.ref ?? null}
			onChange={(ref) =>
				updateTableExportSettings(tabId, {
					...defn,
					transform: ref ? { ref } : null
				})}
		/>
	</span>
{/if}
```

One comment above it: this edits the table's OWN `transform` (standalone `POST /tables/export` only — an exporter entry never inherits it, no-bleed §8); strictness is server-side at export time.

- [ ] **Step 4: Run** — `pixi run frontend-test` + `pixi run frontend-check` → PASS.

- [ ] **Step 5: Commit** — `feat(frontend): transform picker in the table export dialog (phase 4 task 10)`

---

### Task 11: Docs + backlog

**Files:**
- Modify: `CLAUDE.md` (the "Table export formats" bullet and, briefly, the snippet bullet's entry-point list)
- Modify: `frontend/README.md` (exporter tab / export dialog sections)
- Modify: `src/data_rover/core/script/README.md` (bridge protocol: the transform call frame + `{"kind": "json"}` tag; entry-point table)
- Modify: `BACKLOG.md` (record Phase 4 shipped; close the unbounded-entries item per §17.1)

**Interfaces:** none — prose only, but held to the comments-are-contract bar.

- [ ] **Step 1: Update each document.** Cover, at minimum: both surfaces + no-bleed; pipeline position (render → shape → `on_error` check → transform → serialize); once-per-file on split; jsonl list contract; `snippet_transform_max_bytes`; 422/503/429 stances; entry-point derivation (`transform` in `_ENTRY_NAMES`, stored `entry_points` advisory — the run route re-derives); the entries cap (§17.1); manifest `transform` field now live; `TransformHost` session sharing and the one-slot-per-run rule.
- [ ] **Step 2: Cross-check** every claim against the merged code (grep the symbol names — do not describe from memory).
- [ ] **Step 3: Commit** — `docs: exporter v2 phase 4 (transform hook)`

---

### Task 12: Whole-branch verification

- [ ] **Step 1:** `pixi run dr-tidy check_only=true` — must exit 0 (this, not plain `dr-tidy`, is the format gate).
- [ ] **Step 2:** `git status --short` — must be clean.
- [ ] **Step 3:** `pixi run dr-test` — core pytest + frontend vitest, all green.
- [ ] **Step 4:** `pixi run -e core-dev pytest tests/api/test_snippets_wasm.py -m integration -v` — the WASM transform frame test, green (fetches the guest binary if absent).
- [ ] **Step 5:** Final whole-branch review (most capable reviewer, per the established process), fix wave if needed, then superpowers:finishing-a-development-branch → merge `--no-ff` into `main`.

---

## Self-Review Notes (spec coverage)

- §8 both surfaces: Tasks 6 (standalone) + 7 (entries). No-bleed both directions: Task 6's last test + Task 7's second test (§15 requirement).
- §8 pipeline position / split per-file / jsonl array-in: Task 5 engine + Task 7 tests. §17.3 list-out: Task 5 `_transformed` + Task 7 test.
- §8 entry-point derivation + up-front 422: Tasks 2, 6, 7. Stored `entry_points` advisory → re-derived (`_resolve_transform_code`).
- §8 limits (`snippet_transform_max_bytes`, both directions): Task 5. Wall/memory caps ride the existing `RunLimits`/`ScriptBudget` per call.
- §8 failure-is-failure: `TransformHost.apply` ValueError → 422; §17.2 503/429: Tasks 5-7.
- §8 xlsx/csv 422: engine guard (Task 5) + exporter up-front check (Task 7) + UI warning (Task 9).
- §8 read-only/sandbox/viewer-callable: sessions are `record_ops=False` by construction; both routes already viewer-callable; no authz change needed.
- §8 session sharing (one warm guest per distinct code per run): `TransformHost._sessions`, pinned by Task 7's counter test.
- §8 bundle deps ("under the standard `ref` key"): automatic via `extract_refs`; pinned in Task 1.
- §11 pickers (entry row + table export dialog, JSON-family gated): Tasks 8-10.
- §15 TrustedRunner end-to-end both surfaces + one integration WASM test: Tasks 3, 4, 6, 7.
- §17.1 entries cap: Task 1. Manifest slot: Task 7.
