# Code Execution — M1 Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the server side of standalone Python snippets end-to-end: a `code_snippet` artifact kind, server-side linting, a sandboxed WASM runner (built on the M0 spike's proven mechanics), the `dr` facade (reads + dry-run op recording), and the `run`/`lint`/`cancel` routes — so a client can create a snippet, lint it, run it, and get back captured stdout + a proposed op batch.

**Architecture:** Per spec `docs/superpowers/specs/2026-07-17-code-execution-design.md` and the M0 GO verdict (`spikes/code_exec/FINDINGS.md`). A `ScriptRunner` protocol in `core/` keeps the wasmtime dependency out of core; `WasmScriptRunner` (api layer) reuses the FIFO-in-process bridge, epoch-kill, memory-cap, and determinism recipe proven by the spike; `TrustedRunner` (under `tests/`) backs hermetic tests. Snippets are ordinary artifact rows (no leases, no commit journal); runs are read-only server-side and emit ops into the response for the client's existing staged-edits buffer.

**Tech Stack:** Python 3.14 (pyright floor 3.10 — import `Self`/`assert_never` from `typing_extensions`), pixi, FastAPI, Pydantic 2, SQLAlchemy 2, wasmtime-py 46.0.1 (already in `core-dev` pypi-deps from M0), CPython-WASI 3.14.6 (pinned fetch in `spikes/code_exec/fetch_python_wasi.sh`).

## Global Constraints

- **pixi only** — no global `python`/`node`. Run core tests: `pixi run test-core`; a single test: `pixi run -e core-dev pytest tests/path::name -v`; lint/type all three: `pixi run tidy` (ruff + mypy + pyright must all pass). API tests need no DB service (in-memory SQLite via `tests/api/conftest.py`).
- **Python floor 3.10 for typing** — `pyrightconfig.json` pins 3.10 though runtime is 3.14. Use `typing_extensions` for `Self`, `assert_never`, etc.
- **No Alembic migration for the enum** — verified: `ArtifactRow.kind` compiles to `VARCHAR(12)` with NO CHECK constraint (SQLAlchemy 2.0 `native_enum=False` defaults `create_constraint=False`); `"code_snippet"` is 12 chars, fits the existing width. Adding the enum member is a pure-Python change. (If a future migration adds a CHECK, revisit.)
- **The wasmtime dependency stays out of `core/`** — `core/script/` imports no wasmtime; only `src/data_rover/api/script_runner.py` and code under `tests/` may import it.
- **`TrustedRunner` must never ship** — it lives under `tests/`, and if runner selection is ever exposed as a setting, a boot guard refuses `trusted` unless `dev_seed` is on (spec §4 RCE tripwire).
- **Ops the runner emits use the exact `schemas.OPS_ADAPTER` wire format** (`frontend/src/lib/state/ops.ts` is the contract): `create_element{temp_id,type_name,properties}`, `update_element{id,properties_patch}` (JSON-merge-patch, null deletes a key), `delete_element{id}`, and the three relationship equivalents. Temp ids for created entities follow the staged-buffer temp-id convention.
- **The guest binary is never committed** — `spikes/code_exec/vendor/` is gitignored; M1 fetches it via `bash spikes/code_exec/fetch_python_wasi.sh` and the runner locates it by a settings path (defaulting to that vendor dir). CI wiring for the fetch is deferred to M4.
- **Determinism recipe (from spike, copy exactly):** `linker.allow_shadowing = True` before `define_wasi()`; shim `wasi_snapshot_preview1.clock_time_get`/`random_get` via `linker.define_func(..., access_caller=True)` after `define_wasi()`; `PYTHONHASHSEED=0` in guest env. Fixed wall clock = `1750000000` s; monotonic stays real.
- **Error mapping (from spike):** epoch/timeout kill = `wasmtime.Trap` with `.trap_code == wasmtime.TrapCode.INTERRUPT`; memory-cap breach = nonzero WASI exit code + `MemoryError` traceback on guest stderr (NOT a host Trap on this build) — key the "out of memory" branch off exit-code+stderr, keep a Trap-on-alloc branch for portability.
- Branch: all M1 backend work on `feature/code-execution-m1-backend`, off `main` (which now contains the merged M0 spike).

---

## File Structure

New files (created by this plan):

- `src/data_rover/core/script/__init__.py` — package marker.
- `src/data_rover/core/script/schema.py` — `SnippetDefinition`, `SNIPPET_ADAPTER`, `SCHEMA_VERSION`.
- `src/data_rover/core/script/lint.py` — `lint_code`, `derive_entry_points`, `Diagnostic`, allowlists.
- `src/data_rover/core/script/bridge.py` — pure protocol types: `BridgeRequest`/`BridgeResponse` shapes, `RunRequest`, `RunResult`, `RecordedOp` (re-exports the op wire dicts), `BridgeDispatcher` (read-only, dispatches facade calls against a `Model`).
- `src/data_rover/core/script/runner.py` — `ScriptRunner` Protocol, `RunLimits`, `ScriptError` hierarchy.
- `src/data_rover/core/script/facade_src.py` — the guest-side `dr` module source as a string constant (injected into the sandbox; never imported host-side).
- `src/data_rover/api/script_runner.py` — `WasmScriptRunner` (wasmtime, pool, FIFO bridge, limits, determinism).
- `src/data_rover/api/routes/snippets.py` — `POST /snippets/run|lint|cancel`.
- `tests/script/` — core-side tests (`test_schema.py`, `test_lint.py`, `test_bridge.py`, `test_trusted_runner.py`, `conftest.py` with `TrustedRunner`).
- `tests/api/test_snippets_routes.py` — route tests with `TrustedRunner` injected.
- `tests/api/test_snippets_wasm.py` — `integration`-marked real-WASM tests.

Modified files:

- `src/data_rover/api/db_models.py:264-267` — add `code_snippet` enum member.
- `src/data_rover/api/routes/artifacts.py:51-54` — add `SNIPPET_ADAPTER` to `_PAYLOAD_ADAPTERS`; recompute `entry_points` on create/update.
- `src/data_rover/api/schemas.py:665-668` — add `"code_snippet"` to `ArtifactCreateIn.kind`; add snippet run/lint schemas.
- `src/data_rover/api/authz.py:45-56` — add `/snippets/run` and `/snippets/lint` to `_READ_ONLY_POST_SUFFIXES` (NOT `/snippets/cancel` — it mutates run state, but takes no model lock; see Task 11).
- `src/data_rover/api/settings.py` — snippet limit settings.
- `src/data_rover/api/main.py:218-234` — register `snippets.router`; inject the runner; (cancel registry lifecycle if needed).

---

## Task 1: Branch + `code_snippet` artifact kind

**Files:**
- Modify: `src/data_rover/api/db_models.py:264-267`
- Modify: `src/data_rover/api/schemas.py:665-668`
- Test: `tests/api/test_artifacts_routes.py` (add a case)

**Interfaces:**
- Produces: `ArtifactKind.code_snippet` (value `"code_snippet"`); `ArtifactCreateIn.kind` accepts `"code_snippet"`.

- [ ] **Step 1: Branch**

```bash
git checkout -b feature/code-execution-m1-backend main
```

- [ ] **Step 2: Write the failing test**

Add to `tests/api/test_artifacts_routes.py`:

```python
def test_create_code_snippet_rejected_until_adapter(client: TestClient) -> None:
    # Kind is accepted by the request schema, but no payload adapter yet -> 422.
    r = client.post(
        papi("/artifacts"),
        json={"kind": "code_snippet", "name": "s1", "payload": {"schema_version": 1, "language": "python", "code": "x = 1"}},
    )
    assert r.status_code == 422, r.text
```

- [ ] **Step 3: Run it — expect failure at the request-schema layer**

Run: `pixi run -e core-dev pytest tests/api/test_artifacts_routes.py::test_create_code_snippet_rejected_until_adapter -v`
Expected: FAIL — currently `422` from `ArtifactCreateIn` (kind not in its Literal), but the assertion message we want is "no adapter". Confirm it fails or errors before the two edits below.

- [ ] **Step 4: Add the enum member**

In `src/data_rover/api/db_models.py`, extend `ArtifactKind`:

```python
class ArtifactKind(str, enum.Enum):
    navigation = "navigation"
    table = "table"
    diagram = "diagram"
    diagram_kind = "diagram_kind"
    code_snippet = "code_snippet"
```

- [ ] **Step 5: Widen the request schema**

In `src/data_rover/api/schemas.py`, `ArtifactCreateIn.kind`:

```python
    kind: Literal["navigation", "table", "diagram", "diagram_kind", "code_snippet"]
```

- [ ] **Step 6: Run the test — now 422 from the missing adapter**

Run: `pixi run -e core-dev pytest tests/api/test_artifacts_routes.py::test_create_code_snippet_rejected_until_adapter -v`
Expected: PASS (422 now comes from `_validate_payload` — "artifact kind 'code_snippet' is not supported yet").

- [ ] **Step 7: Confirm the enum width assumption**

Run:

```bash
PYTHONPATH=src pixi run -e core-dev python -c "
from sqlalchemy.schema import CreateTable
from sqlalchemy.dialects import postgresql
from data_rover.api.db_models import ArtifactRow
ddl=str(CreateTable(ArtifactRow.__table__).compile(dialect=postgresql.dialect()))
assert 'CHECK' not in ddl, ddl
print('OK: no CHECK; kind column line:'); [print(l) for l in ddl.splitlines() if 'kind ' in l.lower()]
"
```
Expected: `OK: no CHECK`, `kind VARCHAR(12)`. Confirms `"code_snippet"` (12 chars) fits, no migration needed.

- [ ] **Step 8: Commit**

```bash
git add src/data_rover/api/db_models.py src/data_rover/api/schemas.py tests/api/test_artifacts_routes.py
git commit -m "feat(snippets): add code_snippet artifact kind"
```

---

## Task 2: `SnippetDefinition` schema + adapter

**Files:**
- Create: `src/data_rover/core/script/__init__.py`
- Create: `src/data_rover/core/script/schema.py`
- Test: `tests/script/__init__.py`, `tests/script/test_schema.py`

**Interfaces:**
- Produces:
  - `SnippetDefinition` (pydantic `BaseModel`): fields `schema_version: int = 1`, `language: Literal["python"] = "python"`, `code: str`, `entry_points: list[str] = []`.
  - `SNIPPET_ADAPTER: TypeAdapter[SnippetDefinition]`.
  - `SNIPPET_SCHEMA_VERSION: int = 1`, `SNIPPET_MAX_CODE_BYTES: int = 64 * 1024`.

- [ ] **Step 1: Write the failing test**

Create `tests/script/__init__.py` (empty) and `tests/script/test_schema.py`:

```python
import pytest
from pydantic import ValidationError

from data_rover.core.script.schema import SNIPPET_ADAPTER, SnippetDefinition


def test_minimal_snippet_validates():
    d = SNIPPET_ADAPTER.validate_python({"code": "x = 1"})
    assert isinstance(d, SnippetDefinition)
    assert d.schema_version == 1 and d.language == "python"
    assert d.entry_points == []  # default; derived separately, not trusted here


def test_non_python_language_rejected():
    with pytest.raises(ValidationError):
        SNIPPET_ADAPTER.validate_python({"code": "x=1", "language": "ruby"})


def test_oversize_code_rejected():
    from data_rover.core.script.schema import SNIPPET_MAX_CODE_BYTES
    with pytest.raises(ValidationError):
        SNIPPET_ADAPTER.validate_python({"code": "x" * (SNIPPET_MAX_CODE_BYTES + 1)})
```

- [ ] **Step 2: Run it to verify failure**

Run: `pixi run -e core-dev pytest tests/script/test_schema.py -v`
Expected: FAIL — `ModuleNotFoundError: data_rover.core.script.schema`.

- [ ] **Step 3: Implement the schema**

Create `src/data_rover/core/script/__init__.py` (empty). Create `src/data_rover/core/script/schema.py`:

```python
"""Payload schema for `code_snippet` artifacts.

A snippet is just Python source. Its *roles* (standalone / table column /
navigation step) are decided by which entry-point functions it defines, which
is derived from the AST at save time (see `lint.derive_entry_points`) — the
`entry_points` field here is advisory metadata only and is NEVER trusted at
evaluation time (inline snippets carry client-supplied values).
"""
from __future__ import annotations

from pydantic import BaseModel, Field, TypeAdapter
from typing import Literal

SNIPPET_SCHEMA_VERSION = 1
SNIPPET_MAX_CODE_BYTES = 64 * 1024


class SnippetDefinition(BaseModel):
    schema_version: int = SNIPPET_SCHEMA_VERSION
    language: Literal["python"] = "python"
    code: str = Field(max_length=SNIPPET_MAX_CODE_BYTES)
    entry_points: list[str] = Field(default_factory=list)


SNIPPET_ADAPTER: TypeAdapter[SnippetDefinition] = TypeAdapter(SnippetDefinition)
```

- [ ] **Step 4: Run the test — expect pass**

Run: `pixi run -e core-dev pytest tests/script/test_schema.py -v`
Expected: PASS (3 tests). Note: `max_length` on a `str` counts characters, not bytes; for ASCII-ish Python source this is close enough, and the route also guards. Leave the field name as documented.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/script/__init__.py src/data_rover/core/script/schema.py tests/script/
git commit -m "feat(snippets): SnippetDefinition schema + adapter"
```

---

## Task 3: Linter + entry-point derivation

**Files:**
- Create: `src/data_rover/core/script/lint.py`
- Test: `tests/script/test_lint.py`

**Interfaces:**
- Consumes: nothing (pure `ast`).
- Produces:
  - `Diagnostic` (dataclass): `line: int`, `col: int`, `severity: Literal["error","warning"]`, `message: str`.
  - `IMPORT_ALLOWLIST: frozenset[str]` = `{re, math, itertools, collections, functools, json, statistics, datetime, string}`.
  - `DR_NAMES: frozenset[str]` = the facade's public top-level names (`dr`).
  - `lint_code(code: str) -> list[Diagnostic]` — syntax errors (severity `error`, blocking), unknown names + disallowed imports + bad entry-point signatures (severity `warning`, non-blocking).
  - `derive_entry_points(code: str) -> list[str]` — subset of `["script","value","step"]`; `"script"` always present when the code parses; `"value"`/`"step"` present iff a top-level `def value(<1 arg>)` / `def step(<1 arg>)` exists. Returns `["script"]`-only stance on syntax error is caller's choice; here return `[]` on unparseable code.

- [ ] **Step 1: Write the failing tests**

Create `tests/script/test_lint.py`:

```python
from data_rover.core.script.lint import derive_entry_points, lint_code


def test_syntax_error_is_blocking_error():
    diags = lint_code("def value(el)\n  return 1")  # missing colon
    assert any(d.severity == "error" for d in diags)
    assert diags[0].line >= 1


def test_clean_code_no_errors():
    assert lint_code("value = lambda el: len(el.name)\n") == [] or all(
        d.severity == "warning" for d in lint_code("x = 1")
    )


def test_disallowed_import_is_warning():
    diags = lint_code("import os\n")
    assert any(d.severity == "warning" and "os" in d.message for d in diags)
    assert all(d.severity != "error" for d in diags)  # not blocking


def test_allowed_import_ok():
    assert lint_code("import re\nvalue = lambda el: re.findall('a', el.name)") == []


def test_unknown_name_is_warning():
    diags = lint_code("y = undefined_name + 1\n")
    assert any(d.severity == "warning" and "undefined_name" in d.message for d in diags)


def test_dr_names_are_known():
    assert lint_code("rows = list(dr.elements())\n") == []


def test_entry_points_derived():
    assert set(derive_entry_points("def value(el):\n    return 1\n")) == {"script", "value"}
    assert set(derive_entry_points("def step(el):\n    return []\n")) == {"script", "step"}
    both = derive_entry_points("def value(el):\n    return 1\ndef step(el):\n    return []\n")
    assert set(both) == {"script", "value", "step"}
    assert derive_entry_points("x = (") == []  # unparseable


def test_bad_entry_signature_is_warning():
    diags = lint_code("def value(a, b):\n    return 1\n")
    assert any(d.severity == "warning" and "value" in d.message for d in diags)
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/script/test_lint.py -v`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the linter**

Create `src/data_rover/core/script/lint.py`:

```python
"""Server-side lint for snippet code. Single source of truth so editor
diagnostics match the executor exactly (spec section 8).

Syntax errors block; unknown names, disallowed imports and bad entry-point
signatures are non-blocking warnings (Python scope analysis has honest false
positives — conditionally-defined names, comprehension scoping).
"""
from __future__ import annotations

import ast
import builtins
from dataclasses import dataclass
from typing import Literal

IMPORT_ALLOWLIST: frozenset[str] = frozenset(
    {"re", "math", "itertools", "collections", "functools", "json",
     "statistics", "datetime", "string"}
)
DR_NAMES: frozenset[str] = frozenset({"dr"})
_ENTRY_NAMES = ("value", "step")


@dataclass(frozen=True)
class Diagnostic:
    line: int
    col: int
    severity: Literal["error", "warning"]
    message: str


def _parse(code: str) -> tuple[ast.Module | None, Diagnostic | None]:
    try:
        return ast.parse(code), None
    except SyntaxError as e:
        return None, Diagnostic(e.lineno or 1, (e.offset or 1) - 1, "error", f"syntax error: {e.msg}")


def derive_entry_points(code: str) -> list[str]:
    tree, err = _parse(code)
    if tree is None:
        return []
    eps = ["script"]
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in _ENTRY_NAMES:
            if len(node.args.posonlyargs) + len(node.args.args) == 1:
                eps.append(node.name)
    # stable, de-duped
    return list(dict.fromkeys(eps))


def lint_code(code: str) -> list[Diagnostic]:
    tree, err = _parse(code)
    if err is not None:
        return [err]
    assert tree is not None
    diags: list[Diagnostic] = []

    # disallowed imports
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root not in IMPORT_ALLOWLIST:
                    diags.append(Diagnostic(node.lineno, node.col_offset, "warning",
                                            f"module {root!r} is not available in the sandbox"))
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if root not in IMPORT_ALLOWLIST:
                diags.append(Diagnostic(node.lineno, node.col_offset, "warning",
                                        f"module {root!r} is not available in the sandbox"))

    # entry-point signature checks
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in _ENTRY_NAMES:
            argc = len(node.args.posonlyargs) + len(node.args.args)
            if argc != 1:
                diags.append(Diagnostic(node.lineno, node.col_offset, "warning",
                                        f"{node.name}() must take exactly one argument (the element), got {argc}"))

    # unknown-name resolution (module scope only; conservative)
    known = set(dir(builtins)) | set(DR_NAMES) | set(IMPORT_ALLOWLIST)
    _collect_bound_names(tree, known)
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            if node.id not in known:
                diags.append(Diagnostic(node.lineno, node.col_offset, "warning",
                                        f"unknown name {node.id!r}"))
    return diags


def _collect_bound_names(tree: ast.Module, known: set[str]) -> None:
    """Add every name the module binds (defs, assignments, imports, comprehension
    targets, function args) so we don't flag legitimate locals. Deliberately
    over-approximates 'known' to keep unknown-name a low-false-positive warning."""
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            known.add(node.name)
        elif isinstance(node, ast.arg):
            known.add(node.arg)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            known.add(node.id)
        elif isinstance(node, ast.alias):
            known.add((node.asname or node.name).split(".")[0])
        elif isinstance(node, ast.Global) or isinstance(node, ast.Nonlocal):
            known.update(node.names)
```

- [ ] **Step 4: Run the tests**

Run: `pixi run -e core-dev pytest tests/script/test_lint.py -v`
Expected: PASS. If `test_clean_code_no_errors` is flaky due to the over-approximation, tighten the test, not the linter — the linter deliberately errs toward silence.

- [ ] **Step 5: Typecheck + commit**

Run: `pixi run lint-core`
Expected: mypy + pyright + ruff clean.

```bash
git add src/data_rover/core/script/lint.py tests/script/test_lint.py
git commit -m "feat(snippets): server-side linter + entry-point derivation"
```

---

## Task 4: Recompute `entry_points` on artifact write

**Files:**
- Modify: `src/data_rover/api/routes/artifacts.py:51-54,124,156`
- Test: `tests/api/test_artifacts_routes.py`

**Interfaces:**
- Consumes: `SNIPPET_ADAPTER` (Task 2), `derive_entry_points` (Task 3).
- Produces: `_PAYLOAD_ADAPTERS[ArtifactKind.code_snippet] = SNIPPET_ADAPTER`; server-derived `entry_points` written into the stored payload for snippet artifacts on create + update (client value ignored).

- [ ] **Step 1: Write the failing test**

Add to `tests/api/test_artifacts_routes.py`:

```python
def test_snippet_entry_points_are_server_derived(client: TestClient) -> None:
    body = {
        "kind": "code_snippet",
        "name": "col1",
        "payload": {
            "schema_version": 1, "language": "python",
            "code": "def value(el):\n    return len(el.name)\n",
            "entry_points": ["lies"],  # client lie, must be overwritten
        },
    }
    r = client.post(papi("/artifacts"), json=body)
    assert r.status_code == 201, r.text
    got = r.json()["payload"]["entry_points"]
    assert set(got) == {"script", "value"}
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_artifacts_routes.py::test_snippet_entry_points_are_server_derived -v`
Expected: FAIL — 422 (adapter still absent) or wrong entry_points.

- [ ] **Step 3: Wire the adapter + a derive helper**

In `src/data_rover/api/routes/artifacts.py`, extend the imports and adapter map, and add a helper:

```python
from data_rover.core.script.schema import SNIPPET_ADAPTER
from data_rover.core.script.lint import derive_entry_points

_PAYLOAD_ADAPTERS: dict[ArtifactKind, TypeAdapter[Any]] = {
    ArtifactKind.navigation: NAVIGATION_ADAPTER,
    ArtifactKind.table: TABLE_ADAPTER,
    ArtifactKind.code_snippet: SNIPPET_ADAPTER,
}


def _apply_derived_metadata(kind: ArtifactKind, payload: dict[str, Any]) -> None:
    """Recompute server-owned derived fields in-place. For snippets, entry_points
    is derived from the code AST and overwrites any client-supplied value."""
    if kind is ArtifactKind.code_snippet:
        payload["entry_points"] = derive_entry_points(payload.get("code", ""))
```

- [ ] **Step 4: Call it in create + update, after validation**

In `create_artifact`, right after `_validate_payload(kind, payload.payload)`:

```python
    _apply_derived_metadata(kind, payload.payload)
```

In `update_artifact`, inside the `if payload.payload is not None:` block, after `_validate_payload(row.kind, payload.payload)`:

```python
        _apply_derived_metadata(row.kind, payload.payload)
```

- [ ] **Step 5: Run the test**

Run: `pixi run -e core-dev pytest tests/api/test_artifacts_routes.py::test_snippet_entry_points_are_server_derived -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/routes/artifacts.py tests/api/test_artifacts_routes.py
git commit -m "feat(snippets): register snippet adapter, derive entry_points on write"
```

---

## Task 5: Bridge protocol types + read-only dispatcher

**Files:**
- Create: `src/data_rover/core/script/bridge.py`
- Test: `tests/script/test_bridge.py`

**Interfaces:**
- Consumes: `data_rover.core.model.model.Model`, `.metamodel.schema.Metamodel`.
- Produces:
  - `RecordedOp = dict[str, Any]` (a validated `OpIn`-shaped dict).
  - `BridgeDispatcher(model: Model, *, record_ops: bool)`:
    - `.dispatch(req: dict) -> dict` — takes `{"id", "op", ...}`, returns `{"id", ...}`. Read ops: `element`, `elements_page` (params `type`, `offset`, `limit`), `outgoing`, `incoming`, `parent`, `children`, `types`, `type_info`. Write ops (only when `record_ops`): `record_op` (params `op`: an OpIn dict) → appended to `.ops`, returns `{"id", "temp_id"?}`. When `record_ops` is False, `record_op` returns `{"id","error":"ReadOnlyError: ..."}`.
    - `.ops: list[RecordedOp]` — accumulated recorded ops.
    - Enforces caps: `max_ops`, `max_op_bytes`, `page_limit` (raises `BridgeLimitError` → mapped to an error response).
  - `BridgeLimitError(Exception)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/script/test_bridge.py`:

```python
import pytest

from data_rover.core.script.bridge import BridgeDispatcher, BridgeLimitError


def _model():
    # Build a tiny in-memory model via the real Model API.
    from data_rover.core.model.model import Model
    from data_rover.core.metamodel.schema import Metamodel
    # Reuse the smart-city example loader if available; else a minimal metamodel.
    from tests.script.conftest import tiny_model
    return tiny_model()


def test_element_read():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 1, "op": "element", "element_id": "b1"})
    assert resp["id"] == 1 and resp["element"]["id"] == "b1"


def test_elements_page():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 2, "op": "elements_page", "type": None, "offset": 0, "limit": 500})
    assert isinstance(resp["elements"], list) and "next_offset" in resp


def test_record_op_blocked_when_read_only():
    disp = BridgeDispatcher(_model(), record_ops=False)
    resp = disp.dispatch({"id": 3, "op": "record_op",
                          "op": {"kind": "delete_element", "id": "b1"}})
    assert "error" in resp and "ReadOnly" in resp["error"]
    assert disp.ops == []


def test_record_op_accumulates():
    disp = BridgeDispatcher(_model(), record_ops=True)
    disp.dispatch({"id": 4, "op": "record_op",
                   "op": {"kind": "delete_element", "id": "b1"}})
    assert disp.ops == [{"kind": "delete_element", "id": "b1"}]


def test_ops_cap_enforced():
    disp = BridgeDispatcher(_model(), record_ops=True, max_ops=2)
    disp.dispatch({"id": 1, "op": "record_op", "op": {"kind": "delete_element", "id": "b1"}})
    disp.dispatch({"id": 2, "op": "record_op", "op": {"kind": "delete_element", "id": "b2"}})
    resp = disp.dispatch({"id": 3, "op": "record_op", "op": {"kind": "delete_element", "id": "b3"}})
    assert "error" in resp and "cap" in resp["error"].lower()
```

Create `tests/script/conftest.py` with a `tiny_model()` builder (uses `Model`/`Metamodel` real API — build 2-3 `Building` elements `b1,b2,b3` with a `name` property and one `Owns` relationship; if the smart-city example fixtures are readily importable from `tests/`, reuse them instead).

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/script/test_bridge.py -v`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the dispatcher**

Create `src/data_rover/core/script/bridge.py` implementing `BridgeDispatcher` per the Interfaces block. Read ops project `Element`/`Relationship` dataclasses to plain dicts (`{"id","type","name","properties"}` where `name = properties.get("name")`); `elements_page` pages over `model.elements` (optionally filtered by `metamodel.element_descendants(type)`); `outgoing`/`incoming` use `model.indexes.outgoing_ids`/`incoming_ids` then `model.get_relationship`; `parent` uses `model.container_of`; `children` inverts containment via `indexes` (elements whose `first_parent` equals the id — or a dedicated index if one exists); `types` iterates `metamodel.elements` `.name`; `type_info` returns `effective_element_properties(name)` projected to `{name, datatype, multiplicity}`. `record_op` validates the op dict via `schemas.OPS_ADAPTER` **is not importable from core** — instead re-validate shape locally with a small `OpIn`-mirror or accept the dict verbatim and let the route re-validate (choose: accept verbatim in core, re-validate at the route boundary — keeps core free of the api schema import). Enforce `max_ops` (count) and `max_op_bytes` (cumulative `len(json.dumps(op))`).

Note for the implementer: keep `bridge.py` importing only from `core.*` and stdlib. Op-dict *shape* validation lives at the route (Task 11), not here.

- [ ] **Step 4: Run the tests**

Run: `pixi run -e core-dev pytest tests/script/test_bridge.py -v`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pixi run lint-core`

```bash
git add src/data_rover/core/script/bridge.py tests/script/test_bridge.py tests/script/conftest.py
git commit -m "feat(snippets): read-only bridge dispatcher + op recording"
```

---

## Task 6: `ScriptRunner` protocol + `RunLimits` + error types

**Files:**
- Create: `src/data_rover/core/script/runner.py`
- Test: `tests/script/test_runner_protocol.py`

**Interfaces:**
- Produces:
  - `RunLimits` (dataclass, frozen): `wall_timeout_s: float = 10`, `memory_bytes: int = 256*1024*1024`, `stdout_bytes: int = 256*1024`, `result_repr_bytes: int = 64*1024`, `max_ops: int = 1000`, `max_op_bytes: int = 1024*1024`, `page_limit: int = 500`.
  - `RunRequest` (dataclass): `code: str`, `entry: Literal["script","value","step"] = "script"`, `element_id: str | None = None`.
  - `RunResult` (dataclass): `stdout: str`, `result_repr: str | None`, `ops: list[dict]`, `error: ScriptError | None`, `duration_ms: int`, `truncated: bool`.
  - `ScriptError` (dataclass): `kind: Literal["syntax","runtime","timeout","cancelled","memory","limit"]`, `message: str`, `traceback: str | None`.
  - `ScriptRunner` Protocol: `run(model: Model, req: RunRequest, limits: RunLimits, *, record_ops: bool, rev: int) -> RunResult`.

- [ ] **Step 1: Write the failing test** (protocol shape + a `RunResult` round-trips)

Create `tests/script/test_runner_protocol.py`:

```python
from data_rover.core.script.runner import RunLimits, RunRequest, RunResult, ScriptError


def test_defaults():
    lim = RunLimits()
    assert lim.wall_timeout_s == 10 and lim.max_ops == 1000
    req = RunRequest(code="x=1")
    assert req.entry == "script"


def test_result_shape():
    res = RunResult(stdout="hi", result_repr=None, ops=[], error=None, duration_ms=3, truncated=False)
    assert res.ops == [] and res.error is None
    err = ScriptError(kind="timeout", message="deadline", traceback=None)
    assert err.kind == "timeout"
```

- [ ] **Step 2: Run to verify failure; Step 3: implement `runner.py`; Step 4: run pass.**

Run (fail then pass): `pixi run -e core-dev pytest tests/script/test_runner_protocol.py -v`. Implement the dataclasses + `Protocol` per Interfaces. `ScriptRunner` is a `typing.Protocol` (runtime-checkable not required).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/script/runner.py tests/script/test_runner_protocol.py
git commit -m "feat(snippets): ScriptRunner protocol, RunLimits, error types"
```

---

## Task 7: The `dr` facade source (guest module) + `TrustedRunner`

**Files:**
- Create: `src/data_rover/core/script/facade_src.py`
- Create: `tests/script/trusted_runner.py`
- Test: `tests/script/test_trusted_runner.py`

**Interfaces:**
- Consumes: `BridgeDispatcher` (Task 5), `runner` types (Task 6).
- Produces:
  - `FACADE_SOURCE: str` — the `dr` module source; exposes `dr.element(id)`, `dr.elements(type=None)` (paged generator calling `elements_page`), `Element` handle (`.id/.type/.name`, `el[k]`, `.get`, `.props()`, `.out()/.in_()`, `.parent()/.children()`), `dr.create/connect/disconnect`, `el.set/.delete`, `dr.ReadOnlyError`, `dr.types()/dr.type()`. In the guest this talks over stdio; but the SAME source must run in-process for `TrustedRunner` via an injected `_transport` callable.
  - `TrustedRunner` (implements `ScriptRunner`, lives under `tests/`): executes `FACADE_SOURCE` + user code in-process with `exec`, wiring `dr`'s `_transport` directly to a `BridgeDispatcher`, enforcing a soft wall-timeout via `signal`/thread-watchdog is NOT required for tests — instead it runs synchronously and maps exceptions to `ScriptError`. Captures stdout via `contextlib.redirect_stdout`. For `entry != "script"`, calls the entry function with the element handle for `element_id`.

- [ ] **Step 1: Write the failing tests**

Create `tests/script/test_trusted_runner.py`:

```python
from data_rover.core.script.runner import RunLimits, RunRequest
from tests.script.trusted_runner import TrustedRunner
from tests.script.conftest import tiny_model


def test_standalone_prints_and_reads():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="els = list(dr.elements())\nprint(len(els))\nresult = len(els)"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None
    assert res.stdout.strip() == "3"
    assert res.result_repr == "3"


def test_value_entry_against_element():
    r = TrustedRunner()
    res = r.run(tiny_model(),
                RunRequest(code="def value(el):\n    return len(el.name)", entry="value", element_id="b1"),
                RunLimits(), record_ops=False, rev=0)
    assert res.error is None and res.result_repr is not None


def test_write_recorded_as_op_not_applied():
    m = tiny_model()
    r = TrustedRunner()
    res = r.run(m, RunRequest(code="dr.element('b1').delete()"), RunLimits(), record_ops=True, rev=0)
    assert res.error is None
    assert res.ops == [{"kind": "delete_element", "id": "b1"}]
    assert "b1" in m.elements  # NOT applied


def test_write_blocked_in_readonly_context():
    r = TrustedRunner()
    res = r.run(tiny_model(), RunRequest(code="dr.element('b1').delete()"), RunLimits(), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "runtime"  # dr.ReadOnlyError surfaced


def test_stdout_truncation():
    r = TrustedRunner()
    res = r.run(tiny_model(), RunRequest(code="print('x' * 10)"), RunLimits(stdout_bytes=4), record_ops=False, rev=0)
    assert res.truncated and len(res.stdout) <= 8  # cap + ellipsis slack
```

- [ ] **Step 2–4: implement `FACADE_SOURCE` + `TrustedRunner`, iterate to green.**

Run: `pixi run -e core-dev pytest tests/script/test_trusted_runner.py -v` (fail → implement → pass). Key design points: `FACADE_SOURCE` references a module-global `_transport(req: dict) -> dict` that both runners provide; the facade never imports wasmtime or api code. `TrustedRunner.run` builds a `BridgeDispatcher(model, record_ops=record_ops, max_ops=limits.max_ops, ...)`, sets `_transport = dispatcher.dispatch`, `exec`s `FACADE_SOURCE + "\n" + code` in a fresh namespace under `redirect_stdout` with a size-capped buffer, then for non-script entries calls the resolved function. Map `dr.ReadOnlyError` and generic exceptions to `ScriptError(kind="runtime", traceback=...)`; strip host frames from the traceback.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/script/facade_src.py tests/script/trusted_runner.py tests/script/test_trusted_runner.py
git commit -m "feat(snippets): dr facade source + TrustedRunner (tests)"
```

---

## Task 8: `WasmScriptRunner` — engine, module cache, warm pool

**Files:**
- Create: `src/data_rover/api/script_runner.py` (part 1)
- Test: `tests/api/test_snippets_wasm.py` (`integration`-marked)

**Interfaces:**
- Consumes: `runner` types, `BridgeDispatcher`, `FACADE_SOURCE`; the spike's `spikes/code_exec/host.py` as the reference implementation for engine/WASI/FIFO wiring.
- Produces:
  - `WasmScriptRunner(guest_wasm_path: str, guest_lib_path: str, *, pool_size: int = 2)` implementing `ScriptRunner`.
  - Startup: compile the module once (`Module.from_file`), cache via `Module.serialize()`→disk (`.cwasm`) with `Module.deserialize` on reload; share one `Engine` (with `epoch_interruption=True`).
  - A warm pool of pre-booted interpreter instances refilled off a background thread.
  - `.close()` for lifespan shutdown.

Port the proven mechanics from `spikes/code_exec/host.py` and `s07_pool.py` verbatim where possible (FIFO O_RDWR open, worker-thread `_start`, newline-JSON loop, module cache).

- [ ] **Step 1: Write the failing integration test**

Create `tests/api/test_snippets_wasm.py`:

```python
import os
import pytest

pytestmark = pytest.mark.integration  # needs the fetched guest binary

GUEST = "spikes/code_exec/vendor/python.wasm"
LIB = "spikes/code_exec/vendor/lib/python3.14"


@pytest.fixture(scope="module")
def wasm_runner():
    if not os.path.exists(GUEST):
        pytest.skip("guest binary not fetched (bash spikes/code_exec/fetch_python_wasi.sh)")
    from data_rover.api.script_runner import WasmScriptRunner
    r = WasmScriptRunner(GUEST, LIB, pool_size=2)
    yield r
    r.close()


def test_wasm_standalone_read(wasm_runner):
    from data_rover.core.script.runner import RunLimits, RunRequest
    from tests.script.conftest import tiny_model
    res = wasm_runner.run(tiny_model(), RunRequest(code="print(len(list(dr.elements())))"),
                          RunLimits(), record_ops=False, rev=0)
    assert res.error is None and res.stdout.strip() == "3"
```

- [ ] **Step 2: Run — expect skip (binary maybe absent) or fail (runner absent)**

Run: `bash spikes/code_exec/fetch_python_wasi.sh` then
`pixi run -e core-dev pytest tests/api/test_snippets_wasm.py -m integration -v`
Expected: FAIL (`WasmScriptRunner` missing).

- [ ] **Step 3: Implement pool + engine/module cache (no per-run bridge yet — a run just boots, sends one `ping`, tears down).** Iterate to a passing `test_wasm_standalone_read` after Task 9 adds the bridge; for THIS task, assert the pool boots and a trivial no-facade `print` script returns stdout (temporarily), then Task 9 wires the real bridge + facade.

- [ ] **Step 4: Commit**

```bash
git add src/data_rover/api/script_runner.py tests/api/test_snippets_wasm.py
git commit -m "feat(snippets): WasmScriptRunner engine + warm pool"
```

---

## Task 9: `WasmScriptRunner` — bridge loop, limits, determinism, error mapping

**Files:**
- Modify: `src/data_rover/api/script_runner.py` (part 2)
- Modify: `tests/api/test_snippets_wasm.py` (add limit/determinism cases)

**Interfaces:**
- Produces: a complete `run(...)` that: injects `FACADE_SOURCE` + user code into the guest (via a small guest bootstrap that reads code over the bridge or via argv/preopened temp), serves the guest's facade calls with a per-run `BridgeDispatcher`, enforces the two-sided deadline (epoch ticker + channel close), applies the determinism shims, and maps outcomes to `RunResult`/`ScriptError` per the M0 findings (timeout→`Trap.trap_code==INTERRUPT`; memory→nonzero exit + stderr `MemoryError`).

- [ ] **Step 1: Add failing tests** (timeout kills; memory cap; determinism; recorded op round-trips through the bridge):

```python
def test_wasm_timeout(wasm_runner):
    from data_rover.core.script.runner import RunLimits, RunRequest
    from tests.script.conftest import tiny_model
    res = wasm_runner.run(tiny_model(), RunRequest(code="while True: pass"),
                          RunLimits(wall_timeout_s=1.0), record_ops=False, rev=0)
    assert res.error is not None and res.error.kind == "timeout"

def test_wasm_records_op(wasm_runner):
    from data_rover.core.script.runner import RunLimits, RunRequest
    from tests.script.conftest import tiny_model
    m = tiny_model()
    res = wasm_runner.run(m, RunRequest(code="dr.element('b1').delete()"),
                          RunLimits(), record_ops=True, rev=0)
    assert res.ops == [{"kind": "delete_element", "id": "b1"}] and "b1" in m.elements
```

- [ ] **Step 2–4:** implement the bridge loop + limits + determinism shims + error mapping, iterate to green. Reuse `s04_epoch.py`, `s05_memory.py`, `s06_determinism.py`, `s08_bench50k.py` mechanics. Two-sided deadline: an engine epoch ticker plus a host watchdog that closes the FIFO on timeout/cancel so a guest blocked on a bridge read also dies. Determinism shims copied from the spike recipe.

Run: `pixi run -e core-dev pytest tests/api/test_snippets_wasm.py -m integration -v`
Expected: PASS (all cases). Also re-run the TrustedRunner suite to confirm no core regressions: `pixi run -e core-dev pytest tests/script -v`.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/script_runner.py tests/api/test_snippets_wasm.py
git commit -m "feat(snippets): WasmScriptRunner bridge loop, limits, determinism"
```

---

## Task 10: Runner selection, settings, tripwire, lifespan wiring

**Files:**
- Modify: `src/data_rover/api/settings.py`
- Modify: `src/data_rover/api/main.py:165-235`
- Create: `src/data_rover/api/script_runner.py` (add `build_runner_from_settings`, `get_runner`)
- Test: `tests/api/test_snippets_runner_selection.py`

**Interfaces:**
- Produces: settings `snippet_runner: Literal["wasm","trusted"] = "wasm"`, `snippet_guest_wasm_path`, `snippet_guest_lib_path`, `snippet_pool_size`, `snippet_concurrency`, `snippet_per_user_concurrency`, plus the `RunLimits` fields as settings; `build_runner_from_settings(settings) -> ScriptRunner`; a module-level singleton accessor `get_runner()`; a boot guard: selecting `trusted` while `dev_seed is False` raises at startup (RCE tripwire). `TrustedRunner` import for `"trusted"` comes from a shipped shim ONLY if `dev_seed` — otherwise the guard fires before import.

- [ ] **Step 1: failing test** — `build_runner_from_settings` returns a `WasmScriptRunner` by default, and raises when `snippet_runner="trusted"` and `dev_seed=False`.

- [ ] **Step 2–4:** implement settings fields, the builder, the guard, and wire runner construction into `create_app` (store on `app.state` or a module singleton) + `.close()` in lifespan shutdown. Iterate to green.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/settings.py src/data_rover/api/main.py src/data_rover/api/script_runner.py tests/api/test_snippets_runner_selection.py
git commit -m "feat(snippets): runner selection, settings, RCE tripwire, lifespan wiring"
```

---

## Task 11: `/snippets/run|lint|cancel` routes

**Files:**
- Create: `src/data_rover/api/routes/snippets.py`
- Modify: `src/data_rover/api/schemas.py` (run/lint/cancel request+response)
- Modify: `src/data_rover/api/authz.py:45-56` (allowlist run+lint)
- Modify: `src/data_rover/api/main.py:218-234` (register router)
- Test: `tests/api/test_snippets_routes.py` (with `TrustedRunner` injected via settings `snippet_runner="trusted"`, allowed because conftest sets `dev_seed=false`… see note)

**Interfaces:**
- Produces:
  - `POST /snippets/run` → `SnippetRunOut{run_id, stdout, result_repr, ops, error, duration_ms, model_rev, stale, truncated}`. Body `SnippetRunIn{run_id, code?, artifact_id?, entry?, element_id?}` (exactly one of code/artifact_id). Read-only: added to `_READ_ONLY_POST_SUFFIXES`. Records `rev` at start and end; sets `stale = start_rev != end_rev`. Ops validated against `OPS_ADAPTER` before returning. Audit log line per run.
  - `POST /snippets/lint` → `SnippetLintOut{diagnostics, entry_points}` from `lint_code` + `derive_entry_points`. Read-only.
  - `POST /snippets/cancel` → 204; body `{run_id}`; owner-bound (404 if the run_id isn't an active run owned by the caller). NOT in the read-only allowlist reasoning: it takes no model lock and is safe for viewers, but it's a state change on run registry — add it to the allowlist too so viewers can cancel their own runs (a viewer may run, so a viewer must be able to cancel).

**Note on the tripwire vs. tests:** conftest pins `DATA_ROVER_DEV_SEED=false`, which would make `snippet_runner="trusted"` fail the boot guard. Resolve by having route tests inject the runner directly (dependency override on `get_runner`) rather than via settings — override `app.dependency_overrides[get_runner] = lambda: TrustedRunner()`. This keeps the tripwire intact while tests stay hermetic (no WASM). Document this in the test file.

- [ ] **Step 1: Write failing route tests**

Create `tests/api/test_snippets_routes.py`:

```python
import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.script_runner import get_runner
from tests.api.conftest import AUTH_HEADERS, papi, seed_default_project
from tests.script.trusted_runner import TrustedRunner


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    app = create_app()
    app.dependency_overrides[get_runner] = lambda: TrustedRunner()
    c = TestClient(app)
    c.headers.update(AUTH_HEADERS)
    return c


def _seed_model(client):
    # upload the tiny/smart-city model so the session has a Model; reuse existing helpers.
    ...  # follow the pattern other route tests use to install a model


def test_lint_endpoint(client):
    r = client.post(papi("/snippets/lint"), json={"code": "def value(el):\n    return 1\n"})
    assert r.status_code == 200
    body = r.json()
    assert set(body["entry_points"]) == {"script", "value"}
    assert body["diagnostics"] == []


def test_run_reads_model(client):
    _seed_model(client)
    r = client.post(papi("/snippets/run"),
                    json={"run_id": "r1", "code": "print(len(list(dr.elements())))"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["error"] is None and body["stdout"].strip().isdigit()
    assert body["stale"] is False


def test_run_records_ops_without_mutating(client):
    _seed_model(client)
    before = client.get(papi("/model/summary")).json()
    r = client.post(papi("/snippets/run"),
                    json={"run_id": "r2", "code": "dr.element('b1').delete()"})
    assert r.json()["ops"] == [{"kind": "delete_element", "id": "b1"}]
    after = client.get(papi("/model/summary")).json()
    assert before == after  # model untouched
```

- [ ] **Step 2–4:** implement `snippets.py`, the schemas, the allowlist entries, the router registration, and a cancel registry (a per-process dict of active `run_id → (user_id, cancel_callable)`; `run` registers/deregisters, `cancel` looks up + authorizes). The route resolves `session = get_request_session`, reads `session.model` (404 if none via `require_model`), records `rev = session.model_rev` before/after, calls `get_runner().run(model, req, limits, record_ops=(entry=="script"), rev=rev)`, validates `res.ops` through `OPS_ADAPTER`, emits an audit log line (`logging.getLogger(__name__).info(...)` with user, project, code hash, duration, op count, outcome). Iterate to green.

Run: `pixi run -e core-dev pytest tests/api/test_snippets_routes.py -v`

- [ ] **Step 5: Full suite + tidy + commit**

Run: `pixi run test-core` and `pixi run tidy`
Expected: green.

```bash
git add src/data_rover/api/routes/snippets.py src/data_rover/api/schemas.py src/data_rover/api/authz.py src/data_rover/api/main.py tests/api/test_snippets_routes.py
git commit -m "feat(snippets): run/lint/cancel routes with op recording + audit"
```

---

## Task 12: Docs + backend wrap-up

**Files:**
- Modify: `CLAUDE.md` (add a "Code execution (snippets)" subsection under the api architecture map)
- Create: `src/data_rover/core/script/README.md` (facade surface reference + limits + determinism guarantees + WASI absences)

- [ ] **Step 1:** Document the `dr` facade surface, the read-only/dry-run stance, the limits table (from settings), the determinism guarantee (fixed wall clock / seeded random / `PYTHONHASHSEED`), and what's absent under WASI (`threading`, `socket`, `subprocess`, file I/O). Add a CLAUDE.md subsection pointing at `core/script/` + `api/script_runner.py` + `routes/snippets.py`, mirroring the existing architecture-map style.

- [ ] **Step 2: Full verification**

Run: `pixi run test-core && pixi run tidy && bash spikes/code_exec/fetch_python_wasi.sh && pixi run -e core-dev pytest tests/api/test_snippets_wasm.py -m integration -v`
Expected: all green (the integration test proves the real sandbox path end-to-end).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md src/data_rover/core/script/README.md
git commit -m "docs(snippets): facade reference + architecture-map entry"
```

---

## Self-review notes (resolved inline)

- **Spec coverage (M1 slice):** artifact kind (§3)→T1; `SnippetDefinition`+entry-points (§3)→T2/T4; lint (§8)→T3; `dr` facade reads+dry-run writes (§5)→T5/T7; `ScriptRunner` seam + `TrustedRunner` + tripwire (§4,§9)→T6/T7/T10; WASM runner, limits, determinism, error mapping (§4,§7,§9,§10)→T8/T9; run/lint/cancel routes + read-only allowlist + audit + torn-read stale flag (§4,§7,§9)→T11; docs/WASI-absences (§9,§11)→T12. Deferred to M2/M3 by design: `ScriptColumn`/`ScriptStep`, cache fingerprint, export budget. Deferred to M1-frontend plan: CodeMirror editor, console, Stage-ops UI.
- **No-migration correction:** verified `ArtifactRow.kind` = `VARCHAR(12)` no CHECK; `"code_snippet"` fits. The spec's "Alembic CHECK-widening" step (§3) is moot — recorded here so no one writes a needless migration.
- **Type consistency:** `RunResult`/`RunRequest`/`RunLimits`/`ScriptError`/`ScriptRunner` defined once (T6), consumed unchanged by T7–T11; `BridgeDispatcher(record_ops=...)` signature stable T5→T7→T9; op wire dicts always the `OPS_ADAPTER` shape.
- **Tripwire-vs-tests tension** (T11) resolved via `dependency_overrides[get_runner]`, not a settings flip, so the `dev_seed`-gated guard stays honest.
- **Placeholder scan:** the `...` in `_seed_model` (T11 test) and the `tiny_model()` builder (T5) are the two spots that say "follow the existing pattern" — acceptable because the exact model-seeding helper is a codebase lookup the implementer does once; every production code step shows real code.

---

# M1 Frontend — to plan next (milestone-level; expand after this backend lands)

Deliberately not task-level yet: the UI plan is far more reliable written against the *real, tested* run/lint/cancel response shapes from Task 11 than against projected ones. Scope when expanded (spec §5, §7):

- CodeMirror 6 dependency (new) — Python mode + diagnostics gutter fed by debounced `/snippets/lint`.
- Snippet workspace tab: editor + console panel (Run/Stop via `run_id`, stdout/result/error panes, ops-preview list + "Stage ops" into the existing staged-edits buffer).
- `createCodeSnippetArtifact` in `artifacts.svelte.ts`; sidebar listing with entry-point badges; view placement (free).
- Element-context picker for `value`/`step` test runs.
- Tests: vitest+MSW (editor diagnostics, run/stop, ops staging); Playwright e2e (create→lint→run→stage→commit).

# M2–M4 — unchanged milestone outline

See `docs/superpowers/plans/2026-07-17-code-execution-m0-spike.md` tail and spec §14. M2 = table `ScriptColumn` (+ cache-poisoning guard, error cells, export budget); M3 = navigation `ScriptStep` (prune-with-warning, shared budget); M4 = polish (facade docs panel, examples, CI guest-binary fetch, per-user fairness tuning). Each expands to its own task-level plan when reached.
