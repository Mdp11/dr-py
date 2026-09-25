# Exporter v2 Phase 3 — Automation Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add draft runs (`RunExportIn.definition`) and `GET /exports/run-by-name` to the export run route, replace the exporter tab's bare add-table `<select>` with a searchable typeahead (P-15.1), ungate the Export button (a dirty/never-committed draft exports by sending its definition inline), and fix F-16 (the entry-layout dialog's Save gate on an invalid split template).

**Architecture:** `routes/exports.py`'s `run_export` body is refactored into a shared `_execute_export(cdef, ...)` helper that both the widened POST (artifact-or-definition) and the new GET (name lookup → 404/409/delegate) call, so the two entry points cannot drift on the 202/zip/bare/manifest contract. The frontend gains a small self-contained `AddTablePicker` combobox (client-side filtering, mirroring `Sidebar/Search.svelte`'s ARIA pattern) and a `runExporterDraft` API client; the Export button picks artifact-id vs inline-definition per the draft's state. A leading cleanup task lands the three no-behavior-change items deferred from Phase 2's final review (`JSON_FAMILY` constant, `ExportFormat` on the engine signature, client `isJsonFamily` helper) so the new code builds on the cleaned surface.

**Tech Stack:** Python 3.14 / FastAPI / pydantic v2 (backend), SvelteKit + Svelte 5 runes + zod (frontend), pixi for every command.

**Spec:** `docs/superpowers/specs/2026-08-19-custom-export-v2-design.md` §9 (run route: draft runs 9.1, run-by-name 9.2, response assembly 9.3), §11 (frontend: P-15.1 picker, ungated Export button), §13 (error rows: both/neither 422, run-by-name 404/409), §16 item 3 (phase scope). F-16 fix authorized by the owner 2026-08-20 (extends §12's never-block-Save uniformity to the entry dialog's Save). Out of this phase by §16: the `transform` hook (Phase 4), bundle-draft export (Phase 5).

## Global Constraints

- Everything runs through pixi: `pixi run core-test`, `pixi run -e core-dev pytest <path> -v`, `pixi run frontend-test` (vitest, cwd=frontend), `pixi run frontend-check`, `pixi run dr-tidy` (format+lint+mypy+pyright — all must pass), `pixi run dr-test`.
- **Run `pixi run core-lint` before every Python commit** — pytest cannot catch an annotation-only break under `from __future__ import annotations` (bit us in Phase 2 Task 1).
- Work on branch `feat/exporter-v2-phase3` off `main`.
- **Never block Save:** all new strictness (both/neither of `artifact_id`/`definition`, unknown name, ambiguous name) is a 422/404/409 at *run* time. Task 6 *removes* a Save gate; nothing in this phase adds one.
- **Draft runs are render-only client input** (spec §9.1): a `definition` run validates through the same `ExporterDefinition` schema and flows through the identical guards (missing-table 422 enforces project scoping, templates validate up front). Referenced tables always evaluate from their **committed** definitions — presentation drafts export live; evaluation drafts still require commit. `/exports/run` stays in `authz._READ_ONLY_POST_SUFFIXES` (viewer-callable); the GET is read-only by method detection.
- **RENDER ONLY boundary:** nothing here touches evaluation — cell values, row order and script cache keys stay computed off the original definition.
- **No-migration guarantee:** `RunExportIn` widening keeps `{"artifact_id": "..."}` bodies working unchanged; every existing artifact payload validates and exports byte-identically.
- Docstring style: this codebase carries dense docstrings explaining *why* invariants exist. Match it. Comment accuracy is merge-blocking (Phase 2 precedent).
- Python: modern 3.14 idioms (PEP 604 unions, no `typing.Optional`).
- Frontend testids referenced by existing tests must keep working or the tests must be updated in the same task (grep before renaming).

---

### Task 1: Deferred Phase 2 cleanups (`JSON_FAMILY`, `ExportFormat` typing, `isJsonFamily`)

Three no-behavior-change items from Phase 2's final review, landed first so later tasks build on the cleaned surface. Behavior must be byte-identical — the existing suites are the test.

**Files:**
- Modify: `src/data_rover/core/table/exporter.py` (add `JSON_FAMILY`)
- Modify: `src/data_rover/api/table_export_engine.py:171,233,453` (type `format`, use the constant)
- Modify: `src/data_rover/api/routes/exports.py:177` (use the constant)
- Modify: `frontend/src/lib/api/types.ts` (add `isJsonFamily`)
- Modify: `frontend/src/lib/components/Table/ExportDialog.svelte:89`, `frontend/src/lib/components/Export/EntryLayoutDialog.svelte:79-83`, `frontend/src/lib/components/Export/ExportSettingsPanel.svelte:77` (use the helper)
- Test: `frontend/src/lib/table/__tests__/exporter.test.ts` (append one helper test)

**Interfaces:**
- Produces: `data_rover.core.table.exporter.JSON_FAMILY: frozenset[str]` (`{"json", "jsonl"}`) — used by Task 2's refactored route; `run_table_export(..., format: ExportFormat, ...)`; `$lib/api/types`'s `isJsonFamily(format: ExportFormat): boolean` — used by Task 6's dialog edit.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/exporter-v2-phase3
```

- [ ] **Step 2: Write the failing frontend test** (append to `frontend/src/lib/table/__tests__/exporter.test.ts`; add `isJsonFamily` to its `$lib/api/types` import)

```ts
describe('isJsonFamily', () => {
	it('is true exactly for json and jsonl', () => {
		expect(isJsonFamily('json')).toBe(true);
		expect(isJsonFamily('jsonl')).toBe(true);
		expect(isJsonFamily('xlsx')).toBe(false);
		expect(isJsonFamily('csv')).toBe(false);
	});
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pixi run frontend-test -- src/lib/table/__tests__/exporter.test.ts`
Expected: FAIL (`isJsonFamily` not exported).

- [ ] **Step 4: Implement all three cleanups**

In `src/data_rover/core/table/exporter.py`, next to `ExportFormat`:

```python
#: The two formats that render through the JSON document list — ONE spelling
#: for every "json family" gate (the engine's split/render branches, the run
#: route's split-template validation). csv/xlsx take the layout path. The
#: frontend mirror is `isJsonFamily` in `frontend/src/lib/api/types.ts`.
JSON_FAMILY: frozenset[str] = frozenset({"json", "jsonl"})
```

In `src/data_rover/api/table_export_engine.py`:
- Import `ExportFormat` and `JSON_FAMILY` from `data_rover.core.table.exporter` (extend the existing import).
- `run_table_export` signature: `format: str,  # "xlsx" | "json" | "csv" | "jsonl"` becomes `format: ExportFormat,` (drop the now-redundant trailing comment; the docstring already names all four).
- Line ~233: `format in ("json", "jsonl")` → `format in JSON_FAMILY`.
- Line ~453: same replacement. (Line ~471's `format == "json"` stays — it is json-only by design, not a family gate.)

In `src/data_rover/api/routes/exports.py` line ~177: `entry.format in ("json", "jsonl")` → `entry.format in JSON_FAMILY` (import the constant from `data_rover.core.table.exporter`, extending the existing import block).

In `frontend/src/lib/api/types.ts`, next to `EXPORT_FORMATS`:

```ts
/** ONE spelling for the "json family" gate — json + jsonl render through the
 *  same document list; csv/xlsx take the layout path. Mirror of
 *  core/table/exporter.py::JSON_FAMILY. */
export function isJsonFamily(format: ExportFormat): boolean {
	return format === 'json' || format === 'jsonl';
}
```

Then replace the three inline spellings:
- `ExportDialog.svelte:89`: `(format === 'json' || format === 'jsonl') &&` → `isJsonFamily(format) &&` (import the helper).
- `EntryLayoutDialog.svelte:79-83`: same replacement inside `splitTemplateInvalid`.
- `ExportSettingsPanel.svelte:77`: `const jsonFamily = $derived(format === 'json' || format === 'jsonl');` → `const jsonFamily = $derived(isJsonFamily(format));` (the derived stays — ~10 call sites read it).

- [ ] **Step 5: Run the full verification for a pure refactor**

Run: `pixi run core-lint`, then `pixi run core-test`, then `pixi run frontend-test`, then `pixi run frontend-check`
Expected: all green, zero behavior change.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/core/table/exporter.py src/data_rover/api/table_export_engine.py src/data_rover/api/routes/exports.py frontend/src/lib/api/types.ts frontend/src/lib/components/Table/ExportDialog.svelte frontend/src/lib/components/Export/EntryLayoutDialog.svelte frontend/src/lib/components/Export/ExportSettingsPanel.svelte frontend/src/lib/table/__tests__/exporter.test.ts
git commit -m "refactor: JSON_FAMILY constant, ExportFormat engine typing, isJsonFamily client helper"
```

---

### Task 2: Draft runs — `RunExportIn.definition` + route refactor

Spec §9.1. The POST accepts exactly one of `artifact_id`/`definition`; a definition run flows through the identical guards and reports `artifact_id: null` in the manifest. The route body is refactored into `_execute_export` so Task 3's GET can share it verbatim.

**Files:**
- Modify: `src/data_rover/api/schemas.py:1338-1344` (`RunExportIn`)
- Modify: `src/data_rover/api/routes/exports.py` (dispatch + `_execute_export` extraction)
- Test: `tests/api/test_exports_route.py` (append)

**Interfaces:**
- Consumes: Task 1's `JSON_FAMILY` (already wired into the validation pass).
- Produces: `RunExportIn(artifact_id: str | None = None, definition: ExporterDefinition | None = None, name: str = "")`; `_execute_export(cdef: ExporterDefinition, *, run_name: str, artifact_id: str | None, project_id: str, session: Session, db: DbSession, runner: ScriptRunner | None, settings: Settings) -> Response` — Task 3's GET calls it; Task 4's client sends the new body shape.

- [ ] **Step 1: Write the failing tests** (append to `tests/api/test_exports_route.py`; reuse its `_mk_table`, `_names`, `TABLE_PAYLOAD` helpers and `_bootstrap_model`)

```python
# ---- Phase 3: draft runs (spec §9.1) --------------------------------------


def _run_draft(client, definition, name="draft"):
    return client.post(
        papi("/exports/run"),
        json={"definition": definition, "name": name},
        headers=AUTH_HEADERS,
    )


def test_draft_run_exports_without_a_committed_artifact(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    r = _run_draft(
        client,
        {"entries": [{"source": {"ref": t}, "name": "as-json", "format": "json"}]},
        name="my-draft",
    )
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    # The request's `name` feeds the zip-stem fallback (no output.filename).
    assert r.headers["content-disposition"].endswith('my-draft.zip"')
    assert _names(r) == ["as-json.json"]


def test_draft_run_manifest_reports_null_artifact_id_and_request_name(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    r = _run_draft(
        client,
        {"entries": [{"source": {"ref": t}, "name": "e1", "format": "json"}]},
        name="my-draft",
    )
    assert r.status_code == 200
    manifest = json.loads(
        zipfile.ZipFile(io.BytesIO(r.content)).read("manifest.json")
    )
    assert manifest["artifact_id"] is None
    assert manifest["artifact_name"] == "my-draft"


def test_draft_run_default_name_is_export(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    r = client.post(
        papi("/exports/run"),
        json={"definition": {"entries": [{"source": {"ref": t}, "format": "json"}]}},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200
    assert r.headers["content-disposition"].endswith('export.zip"')


def test_exactly_one_of_artifact_id_and_definition_is_required(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(client, [{"source": {"ref": t}, "format": "json"}])
    neither = client.post(papi("/exports/run"), json={}, headers=AUTH_HEADERS)
    assert neither.status_code == 422
    both = client.post(
        papi("/exports/run"),
        json={
            "artifact_id": x,
            "definition": {"entries": [{"source": {"ref": t}, "format": "json"}]},
        },
        headers=AUTH_HEADERS,
    )
    assert both.status_code == 422
    assert "exactly one" in both.json()["detail"]


def test_draft_run_flows_through_the_same_guards(client):
    _bootstrap_model(client)
    # Missing table: project scoping via the existing missing-table 422.
    r = _run_draft(
        client,
        {"entries": [{"source": {"ref": "no-such-table"}, "name": "ghost"}]},
    )
    assert r.status_code == 422
    assert "missing table" in r.json()["detail"]
    assert "ghost" in r.json()["detail"]
    # Templates validate up front, naming the entry.
    t = _mk_table(client, "parts")
    r = _run_draft(
        client,
        {"entries": [{"source": {"ref": t}, "name": "bad", "folder": "${bogus}"}]},
    )
    assert r.status_code == 422
    assert "invalid template" in r.json()["detail"]
    assert "bad" in r.json()["detail"]


def test_draft_run_with_no_entries_422s(client):
    _bootstrap_model(client)
    r = _run_draft(client, {"entries": []})
    assert r.status_code == 422
    assert "no entries" in r.json()["detail"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_exports_route.py -k "draft or exactly_one" -v`
Expected: FAIL — pydantic rejects `definition`/missing `artifact_id` (`RunExportIn.artifact_id` is still required).

- [ ] **Step 3: Widen `RunExportIn`**

In `src/data_rover/api/schemas.py`: extend the line-21 import to `from data_rover.core.table.exporter import ExporterDefinition, ExportFormat`, then:

```python
class RunExportIn(BaseModel):
    """`POST /exports/run` body. The id travels in the BODY, not the path:
    `authz._READ_ONLY_POST_SUFFIXES` matches fixed path suffixes, and this
    route must be viewer-callable like `/tables/export`.

    Exactly one of `artifact_id`/`definition` is required (the route 422s
    otherwise). A `definition` is a staged DRAFT (spec §9.1): it is validated
    by this field's own `ExporterDefinition` typing — the same shape
    `EXPORTER_ADAPTER` enforces on a committed payload — and flows through
    the identical run guards, so a draft is render-only client input, no more
    trusted than a committed row. Referenced tables always evaluate from
    their COMMITTED definitions: presentation drafts export live; evaluation
    drafts still require commit."""

    artifact_id: str | None = None
    definition: ExporterDefinition | None = None
    #: Stands in for the artifact name on a draft run: feeds the zip-stem
    #: fallback and the manifest's `artifact_name`; "" -> "export".
    name: str = ""
```

- [ ] **Step 4: Refactor the route into dispatch + `_execute_export`**

In `src/data_rover/api/routes/exports.py`, replace `run_export` with a thin dispatcher and move everything from the current `if not cdef.entries:` check (line ~128) to the end of the function into the helper. The helper takes `run_name`/`artifact_id` instead of `row`; the three `row` uses map to: manifest `artifact_id=artifact_id, artifact_name=run_name`; zip stem `substitute(cdef.output.filename, {"name": run_name, **ctx})` with fallback `sanitize_stem(run_name)`.

```python
@router.post("/exports/run")
def run_export(
    payload: RunExportIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    runner: ScriptRunner | None = Depends(get_runner),
    settings: Settings = Depends(get_settings),
) -> Response:
    # Spec §9.1: exactly one source for the definition. Checked here, not on
    # the model, so the 422 detail is one plain sentence rather than a
    # pydantic error tree — this is a contract line for CI scripts.
    if (payload.artifact_id is None) == (payload.definition is None):
        raise HTTPException(
            status_code=422,
            detail="exactly one of artifact_id and definition is required",
        )
    if payload.artifact_id is not None:
        row = content.get_artifact(db, payload.artifact_id)
        if (
            row is None
            or row.project_id != project_id
            or row.kind is not ArtifactKind.exporter
        ):
            raise HTTPException(
                status_code=404, detail=f"unknown exporter {payload.artifact_id}"
            )
        cdef: ExporterDefinition = EXPORTER_ADAPTER.validate_python(row.payload)
        run_name, artifact_id = row.name, row.id
    else:
        assert payload.definition is not None  # the XOR check above
        cdef = payload.definition
        # `name` stands in for the artifact name (spec §9.1): ${name} in the
        # zip filename template, the stem fallback, and the manifest's
        # `artifact_name` all read it. `artifact_id: None` is the manifest's
        # draft marker.
        run_name, artifact_id = payload.name or "export", None
    return _execute_export(
        cdef,
        run_name=run_name,
        artifact_id=artifact_id,
        project_id=project_id,
        session=session,
        db=db,
        runner=runner,
        settings=settings,
    )


def _execute_export(
    cdef: ExporterDefinition,
    *,
    run_name: str,
    artifact_id: str | None,
    project_id: str,
    session: Session,
    db: DbSession,
    runner: ScriptRunner | None,
    settings: Settings,
) -> Response:
    """The whole run pipeline behind BOTH entry points (`POST /exports/run`
    with an id or a draft definition, `GET /exports/run-by-name`), so the
    202/zip/bare/manifest contract cannot drift between them. `run_name` is
    the artifact's name for a committed run and the request's `name` for a
    draft (`artifact_id` None marks the draft in the manifest, spec §9.1);
    everything downstream is source-agnostic."""
    metamodel, model = require_model(session)
    if not cdef.entries:
        raise HTTPException(status_code=422, detail="exporter has no entries")
    # ... the ENTIRE existing body from the `ctx = export_context_vars(...)`
    # line to the final `return Response(...)`, verbatim, with exactly three
    # substitutions:
    #   1. manifest: build_manifest(..., artifact_id=artifact_id,
    #      artifact_name=run_name, ...)
    #   2. zip stem: substitute(cdef.output.filename, {"name": run_name, **ctx})
    #      and the fallback sanitize_stem(run_name)
    #   3. `require_model` moved above (it stays first in the pipeline).
```

Move the existing long comments (`# Run-level ${rev}/... context`, `# Resolve every table up front: ...`, all the assembly-loop commentary) with the code verbatim — they are load-bearing.

- [ ] **Step 5: Run the whole exports suite**

Run: `pixi run -e core-dev pytest tests/api/test_exports_route.py -v`
Expected: PASS — every pre-existing test (id-based runs, dedupe, folders, manifest, bare) plus the new draft tests.

- [ ] **Step 6: Lint and commit**

Run: `pixi run core-lint` — must pass.

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/routes/exports.py tests/api/test_exports_route.py
git commit -m "feat(api): draft exporter runs via RunExportIn.definition"
```

---

### Task 3: `GET /exports/run-by-name`

Spec §9.2: CI ergonomics — run a committed exporter by name with one `curl`. Query parameter (names are free-form text); unknown → 404; ambiguous → 409 listing candidate ids; response contract identical to the POST (shared `_execute_export`).

**Files:**
- Modify: `src/data_rover/api/content.py` (add `find_artifacts_by_name`)
- Modify: `src/data_rover/api/routes/exports.py` (add the GET route)
- Test: `tests/api/test_exports_route.py` (append)

**Interfaces:**
- Consumes: Task 2's `_execute_export`.
- Produces: `content.find_artifacts_by_name(db: Session, project_id: str, kind: ArtifactKind, name: str) -> list[ArtifactRow]` (ordered by id); `GET /api/v1/projects/{project_id}/exports/run-by-name?name=...`.

- [ ] **Step 1: Write the failing tests** (append to `tests/api/test_exports_route.py`)

```python
# ---- Phase 3: run-by-name (spec §9.2) -------------------------------------


def _run_by_name(client, name):
    return client.get(
        papi("/exports/run-by-name"), params={"name": name}, headers=AUTH_HEADERS
    )


def test_run_by_name_matches_the_post_contract(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(
        client, [{"source": {"ref": t}, "name": "e1", "format": "json"}], name="nightly"
    )
    by_name = _run_by_name(client, "nightly")
    by_id = _run(client, x)
    assert by_name.status_code == by_id.status_code == 200
    assert by_name.headers["content-type"] == "application/zip"
    assert _names(by_name) == _names(by_id) == ["e1.json"]
    assert by_name.headers["content-disposition"].endswith('nightly.zip"')


def test_run_by_name_unknown_404s(client):
    _bootstrap_model(client)
    r = _run_by_name(client, "no-such-exporter")
    assert r.status_code == 404


def test_run_by_name_ignores_other_kinds(client):
    _bootstrap_model(client)
    _mk_table(client, "shadow")  # a TABLE named like the query
    r = _run_by_name(client, "shadow")
    assert r.status_code == 404


def test_run_by_name_ambiguous_409s_listing_candidates(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x1 = _mk_export(client, [{"source": {"ref": t}, "format": "json"}], name="dup")
    # The create/rename routes 409 a (kind, name) clash, so a duplicate can
    # only exist if something bypassed them — insert one at the content layer
    # to prove the route still answers deterministically (spec §9.2).
    from data_rover.api.db import db_session
    from data_rover.api.db_models import ArtifactKind
    from data_rover.api import content

    with db_session() as db:
        row = content.create_artifact(
            db,
            "default",
            kind=ArtifactKind.exporter,
            name="dup",
            payload={"entries": [{"source": {"ref": t}, "format": "json"}]},
            updated_by=None,
        )
        x2 = row.id
    r = _run_by_name(client, "dup")
    assert r.status_code == 409
    assert x1 in r.json()["detail"]
    assert x2 in r.json()["detail"]
```

(If `db_session` is not the conftest-blessed way to open a raw session, mirror how `tests/api/test_issues_route.py` uses `from data_rover.api.db import db_session` — that import is the established pattern. `"default"` is the project id `papi` targets.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_exports_route.py -k "run_by_name" -v`
Expected: FAIL with 404s from FastAPI (route does not exist → 404 on every case, so the 200/409 tests fail).

- [ ] **Step 3: Implement the content query and the route**

In `src/data_rover/api/content.py`, below `find_artifact`:

```python
def find_artifacts_by_name(
    db: Session, project_id: str, kind: ArtifactKind, name: str
) -> list[ArtifactRow]:
    """Every row sharing `(kind, name)` — unlike `find_artifact`, which
    `scalar_one_or_none`s and would RAISE on a duplicate. The create/rename
    routes 409 a clash, so >1 should not arise through the API; but nothing
    at the DB level enforces it, and `GET /exports/run-by-name`'s ambiguity
    contract (spec §9.2: 409 listing candidates) must answer
    deterministically if it ever does. Ordered by id for a stable detail."""
    return list(
        db.execute(
            select(ArtifactRow)
            .where(
                ArtifactRow.project_id == project_id,
                ArtifactRow.kind == kind,
                ArtifactRow.name == name,
            )
            .order_by(ArtifactRow.id)
        ).scalars()
    )
```

In `src/data_rover/api/routes/exports.py`, after `run_export`:

```python
@router.get("/exports/run-by-name")
def run_export_by_name(
    name: str,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    runner: ScriptRunner | None = Depends(get_runner),
    settings: Settings = Depends(get_settings),
) -> Response:
    """CI ergonomics (spec §9.2): run a committed exporter by NAME with one
    `curl`. A QUERY parameter, not a path segment — artifact names are
    free-form text. GET is read-only by `authz`'s method-based write
    detection, so membership auth (header or cookie) works unchanged and the
    route is viewer-callable like the POST. Response contract identical to
    `POST /exports/run` — both delegate to `_execute_export`, including the
    aggregate `202 + Retry-After: 1` while sweeps fill."""
    rows = content.find_artifacts_by_name(db, project_id, ArtifactKind.exporter, name)
    if not rows:
        raise HTTPException(status_code=404, detail=f"unknown exporter {name!r}")
    if len(rows) > 1:
        raise HTTPException(
            status_code=409,
            detail=(
                f"ambiguous exporter name {name!r}; candidates: "
                + ", ".join(r.id for r in rows)
            ),
        )
    row = rows[0]
    cdef: ExporterDefinition = EXPORTER_ADAPTER.validate_python(row.payload)
    return _execute_export(
        cdef,
        run_name=row.name,
        artifact_id=row.id,
        project_id=project_id,
        session=session,
        db=db,
        runner=runner,
        settings=settings,
    )
```

- [ ] **Step 4: Run the exports suite, then the whole backend**

Run: `pixi run -e core-dev pytest tests/api/test_exports_route.py -v`, then `pixi run core-test`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `pixi run core-lint` — must pass.

```bash
git add src/data_rover/api/content.py src/data_rover/api/routes/exports.py tests/api/test_exports_route.py
git commit -m "feat(api): GET /exports/run-by-name with 404/409-ambiguous contract"
```

---

### Task 4: Draft-run client + ungated Export button

Spec §11: the Export button "loses its `dirty`/temp-id gating — a dirty or never-committed draft exports by sending `definition` inline (§9.1). Tooltip updated accordingly." A clean committed draft still runs by `artifact_id` (the committed payload — identical content, and the manifest then carries the real artifact id).

**Files:**
- Modify: `frontend/src/lib/api/exports.ts` (add `runExporterDraft`, share the response handling)
- Modify: `frontend/src/lib/components/Export/ExporterTab.svelte:169-201,216-235` (gating + dispatch + tooltip)
- Test: `frontend/src/lib/components/Export/__tests__/ExporterTab.test.ts` (append)

**Interfaces:**
- Consumes: Task 2's wire contract (`{definition, name}` body).
- Produces: `runExporterDraft(definition: ExporterDefinition, name: string, cfg?: ClientConfig): Promise<ExportResult>` in `$lib/api/exports`.

- [ ] **Step 1: Write the failing tests**

Append to `ExporterTab.test.ts` — read the file's existing mount/MSW pattern first and reuse its store seeding and request-capture helpers verbatim. Three cases:

```ts
it('exports a dirty draft by sending the definition inline', async () => {
	// mount a tab whose draft has one entry and dirty=true (edit a field via
	// the UI or the state helpers, following the file's existing dirty-draft
	// test setup). Capture the POST /exports/run body via the MSW handler.
	// Click the Export button (testid exporter-run) — it must NOT be disabled.
	// Assert the captured body has `definition.entries.length === 1`,
	// `name` === the draft's name, and NO `artifact_id`.
});

it('exports a clean committed draft by artifact id', async () => {
	// mount with a committed (non-temp id) clean draft; click Export;
	// assert the captured body is { artifact_id: <id> } with no definition.
});

it('disables Export only while the draft has no entries', async () => {
	// mount with zero entries: exporter-run has the disabled attribute and
	// the "Add at least one table" title. Add an entry (state helper):
	// disabled goes away even though the draft is dirty/uncommitted.
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run frontend-test -- src/lib/components/Export/__tests__/ExporterTab.test.ts`
Expected: FAIL — the dirty-draft case finds the button disabled; `runExporterDraft` does not exist.

- [ ] **Step 3: Implement the client**

In `frontend/src/lib/api/exports.ts`: extract the response handling into a private helper and add the draft variant (import `type ExporterDefinition` from `./types`):

```ts
async function handleRunResponse(res: Response): Promise<ExportResult> {
	if (res.status === 202) {
		const body = (await res.json()) as { done?: number; total?: number | null };
		return { kind: 'preparing', done: body.done ?? 0, total: body.total ?? null };
	}
	return {
		kind: 'ready',
		blob: await res.blob(),
		filename: parseAttachmentFilename(res) ?? 'export.zip'
	};
}

export async function runExporter(artifactId: string, cfg?: ClientConfig): Promise<ExportResult> {
	const res = await apiFetchRaw(
		'/exports/run',
		{ method: 'POST', body: { artifact_id: artifactId } },
		cfg
	);
	return handleRunResponse(res);
}

/**
 * Run a STAGED exporter draft (`POST /exports/run` with an inline
 * `definition`, spec §9.1) — how the Export button works for a dirty or
 * never-committed draft. `name` stands in for the artifact name (zip-stem
 * fallback, manifest `artifact_name`). Same 202 protocol as `runExporter`;
 * the server validates the draft exactly like a committed payload, so the
 * 422s (missing table, bad template) surface identically.
 */
export async function runExporterDraft(
	definition: ExporterDefinition,
	name: string,
	cfg?: ClientConfig
): Promise<ExportResult> {
	const res = await apiFetchRaw(
		'/exports/run',
		{ method: 'POST', body: { definition, name } },
		cfg
	);
	return handleRunResponse(res);
}
```

Keep `runExporter`'s existing doc comment on it (id-in-body rationale, 202-status-is-the-signal) — trim only what moved to `handleRunResponse`.

- [ ] **Step 4: Implement the button**

In `ExporterTab.svelte`:

Replace the `exportDisabled` block (lines ~176-181) and `runExport` (lines ~183-201):

```ts
// Spec §9.1/§11: the Export button is UNGATED on dirty/uncommitted state — a
// clean committed draft runs by artifact id (the committed payload), anything
// else ships its definition inline as a draft run. Referenced tables still
// evaluate from their COMMITTED definitions either way; only this exporter's
// own presentation travels as a draft. The one remaining gate is emptiness:
// the server 422s "exporter has no entries", so disable with a hint instead.
const exportDisabled = $derived(!draft || draft.entries.length === 0);

async function runExport(): Promise<void> {
	const d = draft;
	if (!d || d.entries.length === 0 || exporting) return;
	// `id` is a const so the ternary's true branch narrows it to string and
	// the closure keeps the narrowing — no non-null assertion needed.
	const id = d.artifactId;
	const start =
		!d.dirty && id !== null && !isTempId(id)
			? () => runExporter(id)
			: () =>
					runExporterDraft(
						{ schema_version: 1, output: d.output, entries: d.entries },
						d.name || 'export'
					);
	exportError = null;
	exporting = true;
	exportAbort = new AbortController();
	try {
		await retryAndDownload(start, {
			onProgress: (p) => (exportProgress = p),
			signal: exportAbort.signal
		});
	} catch (e) {
		exportError = e instanceof Error ? e.message : 'Export failed';
	} finally {
		exporting = false;
		exportProgress = null;
		exportAbort = null;
	}
}
```

Imports: add `runExporterDraft` beside `runExporter`. Update the button's `title` (lines ~221-223):

```svelte
title={exportDisabled ? 'Add at least one table first' : undefined}
```

Also update the component's line-3 doc comment: "Export (run the COMMITTED artifact)" → "Export (run the committed artifact, or the draft inline when dirty/uncommitted — spec §9.1)". The `schema_version: 1` literal matches `saveExporterDraft`'s payload construction in `exporter-editor.svelte.ts` — the draft body IS the payload Save would stage.

- [ ] **Step 5: Run the frontend suite + typecheck**

Run: `pixi run frontend-test` and `pixi run frontend-check`
Expected: PASS / 0 errors. Grep for tests asserting the OLD disabled behavior (`exporter-run` + `disabled`/`Save and commit first`) and update them to the new contract in the same commit.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api/exports.ts frontend/src/lib/components/Export/ExporterTab.svelte frontend/src/lib/components/Export/__tests__/ExporterTab.test.ts
git commit -m "feat(frontend): ungated Export button — dirty/uncommitted drafts run inline"
```

---

### Task 5: P-15.1 — searchable add-table picker

Spec §11: "Replace the exporter tab's bare `<select>` with a searchable typeahead (mirror `Sidebar/Search.svelte`'s pattern, `ExportArtifactsDialog`'s visual treatment)." Client-side filtering (the headers are already in memory — no server call, no debounce), full combobox ARIA per the pattern note in `Search.svelte`/`Metamodel/MetamodelSearch.svelte`.

**Files:**
- Create: `frontend/src/lib/components/Export/AddTablePicker.svelte`
- Modify: `frontend/src/lib/components/Export/ExporterTab.svelte:85-102,402-428` (replace the select)
- Test: `frontend/src/lib/components/Export/__tests__/ExporterTab.test.ts` (append; update any test using `add-table-select`)

**Interfaces:**
- Consumes: `ExporterTab`'s existing `availableTables` derived and `addExporterEntry` flow.
- Produces: `AddTablePicker` with props `{ tables: { id: string; name: string }[]; disabled: boolean; onPick: (id: string) => void }`; testids `add-table-input`, `add-table-option-{id}`.

- [ ] **Step 1: Write the failing tests** (append to `ExporterTab.test.ts`, reusing its mount pattern)

```ts
it('filters the add-table picker as the user types', async () => {
	// mount with >=2 committed tables in the header store, e.g. "parts" and
	// "buildings" (follow the file's existing seeding for availableTables).
	// Focus add-table-input, type "par":
	// - add-table-option-<partsId> is present
	// - add-table-option-<buildingsId> is absent
});

it('adds the active option on Enter and allows a duplicate add', async () => {
	// type "par", press Enter -> one entry for parts appears (export-entry-0).
	// Repeat -> export-entry-1 for the SAME table (F-11: duplicates are
	// legal and useful).
});

it('closes the picker on Escape without adding', async () => {
	// type "par", press Escape -> no option visible, no entry added.
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run frontend-test -- src/lib/components/Export/__tests__/ExporterTab.test.ts`
Expected: FAIL (`add-table-input` not found).

- [ ] **Step 3: Create the component**

Create `frontend/src/lib/components/Export/AddTablePicker.svelte`:

```svelte
<script lang="ts">
	/**
	 * The exporter tab's searchable add-table typeahead (P-15.1) — the
	 * CLIENT-SIDE sibling of `Sidebar/Search.svelte`: same ARIA combobox
	 * pattern (focus stays on the input, the active row is announced via
	 * `aria-activedescendant`, options are non-interactive `<li role="option">`
	 * — `Metamodel/MetamodelSearch.svelte` carries the fuller note), but the
	 * candidates are the in-memory committed-table headers, so there is no
	 * debounce, no request sequencing, and the list shows ALL tables on focus
	 * (a picker is for browsing too, not only for narrowing).
	 *
	 * Deliberately NOT filtered against already-added entries: duplicates are
	 * legal and useful (F-11 — "table A as a wide xlsx AND as a split JSON");
	 * the server dedupes colliding output names at export time.
	 */
	let {
		tables,
		disabled,
		onPick
	}: {
		tables: { id: string; name: string }[];
		disabled: boolean;
		onPick: (id: string) => void;
	} = $props();

	let query = $state('');
	let isOpen = $state(false);
	let active = $state(0);
	let inputEl = $state<HTMLElement | null>(null);
	let dropdownEl = $state<HTMLElement | null>(null);

	/** Per-instance id root — `aria-*` wiring must resolve THIS instance's
	 * nodes, never a second mounted picker's. */
	const uid = $props.id();
	const listboxId = `${uid}-listbox`;
	const optionId = (i: number): string => `${uid}-option-${i}`;

	const results = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return q === '' ? tables : tables.filter((t) => t.name.toLowerCase().includes(q));
	});
	/** Clamped for the window between the list shrinking under a new query
	 * and the active row being reset. */
	const activeIndex = $derived(results.length === 0 ? 0 : Math.min(active, results.length - 1));

	// A new query starts back at the top hit.
	$effect(() => {
		void query;
		active = 0;
	});

	function pick(id: string): void {
		onPick(id);
		query = '';
		isOpen = false;
	}

	function onKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			isOpen = false;
			(e.currentTarget as HTMLInputElement).blur();
			return;
		}
		// Not prevented: the focus move is what the user asked for.
		if (e.key === 'Tab') {
			isOpen = false;
			return;
		}
		if (!isOpen || results.length === 0) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = (activeIndex + 1) % results.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = (activeIndex - 1 + results.length) % results.length;
		} else if (e.key === 'Enter') {
			e.preventDefault();
			pick(results[activeIndex].id);
		}
	}

	function onDocPointerDown(e: PointerEvent): void {
		if (!isOpen) return;
		const target = e.target as Node | null;
		if (!target) return;
		if (inputEl && inputEl.contains(target)) return;
		// The bound reference, not an id lookup — an id is a global name and
		// would cross-match the moment a second picker mounted.
		if (dropdownEl && dropdownEl.contains(target)) return;
		isOpen = false;
	}

	$effect(() => {
		document.addEventListener('pointerdown', onDocPointerDown);
		return () => document.removeEventListener('pointerdown', onDocPointerDown);
	});
</script>

<div class="relative">
	<input
		bind:this={inputEl}
		data-testid="add-table-input"
		type="text"
		placeholder="Add table…"
		role="combobox"
		aria-expanded={isOpen}
		aria-controls={listboxId}
		aria-autocomplete="list"
		aria-activedescendant={isOpen && results.length > 0 ? optionId(activeIndex) : undefined}
		class="w-56 rounded border border-input bg-card px-2 py-1 text-xs placeholder:text-muted-foreground/50"
		{disabled}
		value={query}
		oninput={(e) => {
			query = e.currentTarget.value;
			isOpen = true;
		}}
		onfocus={() => (isOpen = true)}
		onclick={() => (isOpen = true)}
		onkeydown={onKeydown}
	/>
	{#if isOpen}
		<div
			bind:this={dropdownEl}
			class="absolute left-0 top-full z-20 mt-1 max-h-56 w-64 overflow-y-auto rounded border border-border bg-popover shadow-lg"
		>
			{#if results.length === 0}
				<!-- Outside the listbox: a status line is not an option, and an
				     option is the only thing a listbox may contain. -->
				<p class="px-2 py-1 text-xs text-muted-foreground/50">No matching tables.</p>
			{/if}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<ul id={listboxId} role="listbox" aria-label="Committed tables" class="flex flex-col gap-0.5 p-1 text-xs">
				{#each results as t, i (t.id)}
					<!-- Pointer handlers live on the OPTION itself: the listbox
					     pattern forbids interactive descendants inside an option;
					     the keyboard equivalent is the input's own ↑/↓/Enter. -->
					<li
						id={optionId(i)}
						role="option"
						aria-selected={i === activeIndex}
						data-testid="add-table-option-{t.id}"
						class="cursor-pointer truncate rounded px-1.5 py-0.5 text-left transition-colors hover:bg-muted {i === activeIndex ? 'bg-muted' : ''}"
						onpointerenter={() => (active = i)}
						onclick={() => pick(t.id)}
						title={t.id}
					>
						{t.name}
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
```

- [ ] **Step 4: Wire it into `ExporterTab.svelte`**

Replace the add-table handler (lines ~85-102) — the select juggling goes, the load-and-stage logic stays:

```ts
// --- Add-table picker (P-15.1) ----------------------------------------
let addTableError = $state<string | null>(null);
async function addTable(id: string): Promise<void> {
	const header = availableTables.find((h) => h.id === id);
	if (!header) return;
	addTableError = null;
	try {
		const art = await artifactsApi.getArtifact(id);
		const defn = TableDefinitionSchema.parse(art.payload);
		addExporterEntry(tabId, id, header.name, defn);
	} catch (err) {
		addTableError = err instanceof Error ? err.message : 'Failed to load table';
	}
}
```

Replace the `<select>` block (lines ~404-417) with:

```svelte
<AddTablePicker
	tables={availableTables}
	disabled={locked || availableTables.length === 0}
	onPick={(id) => void addTable(id)}
/>
```

Import `AddTablePicker` beside `EntryLayoutDialog`. Keep the empty-hint block (`add-table-empty-hint` and the `stagedOnlyTables` distinction) exactly as it is — a disabled input swallows clicks the same way a disabled select did, so the hint still carries that explanation; reword the comment above `stagedOnlyTables` from "select" to "picker input".

- [ ] **Step 5: Run the suite, fix stale testid references**

Run: `pixi run frontend-test` and `pixi run frontend-check`
Expected: PASS / 0 errors. First `grep -rn "add-table-select" frontend/` and update every hit (component tests, e2e specs) to drive `add-table-input` + `add-table-option-{id}` instead.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/Export/AddTablePicker.svelte frontend/src/lib/components/Export/ExporterTab.svelte frontend/src/lib/components/Export/__tests__/ExporterTab.test.ts
git commit -m "feat(frontend): searchable add-table picker for the exporter tab (P-15.1)"
```

If the grep in Step 5 touched e2e specs, add those files to the commit too.

---

### Task 6: F-16 — never block the entry dialog's Save

Owner decision 2026-08-20: the `EntryLayoutDialog` Save gate on an invalid split filename template contradicts never-block-Save (a presentation setting must never block persisting; the export-time 422 is the contract — the same reasoning as §12's F-10 resolution). Save becomes always-enabled; the invalid template renders an inline warning instead.

**Files:**
- Modify: `frontend/src/lib/components/Export/EntryLayoutDialog.svelte:75-90,215-221`
- Test: `frontend/src/lib/components/Export/__tests__/EntryLayoutDialog.test.ts` (append; update any test asserting the disabled Save)

**Interfaces:**
- Consumes: Task 1's `isJsonFamily` (already in the `splitTemplateInvalid` derived).
- Produces: nothing new — `onSave` fires regardless of template validity; testid `entry-split-template-warning`.

- [ ] **Step 1: Write the failing tests** (append to `EntryLayoutDialog.test.ts`, reusing its mount helper and `onSave` capture)

```ts
it('saves even while the split filename template is invalid (F-16)', async () => {
	// mount an entry with format 'json', json_split enabled and a template
	// WITHOUT ${name} (follow the file's existing split-template setup).
	// The warning is visible and Save is clickable:
	expect(screen.getByTestId('entry-split-template-warning')).toBeInTheDocument();
	const save = screen.getByTestId('entry-layout-save');
	expect(save).not.toBeDisabled();
	await fireEvent.click(save);
	// The invalid template is PERSISTED (never-block-Save): the patch
	// carries json_split with the tokenless template.
	const patch = onSave.mock.calls[0][0];
	expect(patch.json_split?.filename_template).not.toContain('${name}');
});

it('shows no split-template warning when the template is valid', async () => {
	// mount with a valid '${name}' template
	expect(screen.queryByTestId('entry-split-template-warning')).toBeNull();
});
```

(If `entry-layout-save` is not the Save button's existing testid, check the file — the button at line ~217 may be selected by role/text in existing tests; add the testid to the button if it has none, matching the file's conventions.)

- [ ] **Step 2: Run to verify failure**

Run: `pixi run frontend-test -- src/lib/components/Export/__tests__/EntryLayoutDialog.test.ts`
Expected: FAIL — Save carries `disabled` and no warning testid exists.

- [ ] **Step 3: Implement**

In `EntryLayoutDialog.svelte`:

1. Remove `disabled={splitTemplateInvalid}` from the Save button (line ~218). Keep the `disabled:opacity-40` class (harmless) or drop it with the attribute — either is fine.
2. Rewrite the comment above `splitTemplateInvalid` (lines ~76-78): it no longer gates anything — it only drives the warning:

```ts
// F-16 (resolved 2026-08-20): this used to DISABLE Save, contradicting
// never-block-Save — a presentation setting persists freely and the run is
// where the contract is enforced (the export-time 422 names the entry, same
// stance as every other template rule; see spec §12's F-10 resolution for
// the governing principle). Now it only drives the inline warning below.
// The belt-and-braces framing still holds: the server 422s a tokenless
// template regardless — the warning just saves a round trip.
const splitTemplateInvalid = $derived(
	isJsonFamily(format) &&
		(effective.json_split?.enabled ?? false) &&
		!templateIsValid(effective.json_split?.filename_template ?? '')
);
```

3. Extend the neighbouring "Deliberately no Save gating on a missing key column" comment (line ~85-87) so its "never add a check here that disables Save" rule now explicitly covers the split template too.
4. Render the warning near the dialog's footer (beside the existing key-column hint pattern):

```svelte
{#if splitTemplateInvalid}
	<span data-testid="entry-split-template-warning" class="text-xs text-muted-foreground/70">
		split filename template needs {'${name}'} (checked at export)
	</span>
{/if}
```

- [ ] **Step 4: Run the suite, fix stale assertions**

Run: `pixi run frontend-test` and `pixi run frontend-check`
Expected: PASS / 0 errors. First `grep -n "splitTemplateInvalid\|toBeDisabled" frontend/src/lib/components/Export/__tests__/EntryLayoutDialog.test.ts` and update any test that pinned the old disabled-Save behavior. (`ExportDialog`'s gate on **Export** is untouched — that gates a run, not a save, consistent with §12.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Export/EntryLayoutDialog.svelte frontend/src/lib/components/Export/__tests__/EntryLayoutDialog.test.ts
git commit -m "fix(frontend): entry-layout Save never blocks on an invalid split template (F-16)"
```

---

### Task 7: Docs, backlog, full verification

**Files:**
- Modify: `CLAUDE.md` (the "**Table export formats**" bullet)
- Modify: `frontend/README.md` (the exporter tab section)
- Modify: `BACKLOG.md` (P-15.1, P-16 exporter half, F-16, K-11, changelog)

**Interfaces:** none — documentation only, but part of the phase's definition of done (the repo's docs are load-bearing).

- [ ] **Step 1: Update the three documents.** Keep each edit surgical — extend existing sentences, do not restructure sections.

- `CLAUDE.md`, in the "**Table export formats**" bullet where `POST /exports/run` is described: add that `RunExportIn` takes exactly one of `artifact_id`/`definition` (422 otherwise) — a `definition` is a staged draft validated by the same `ExporterDefinition` schema and run through the identical guards, with `name` feeding the zip-stem fallback and the manifest's `artifact_name` (`artifact_id: null` marks a draft run); that `GET /exports/run-by-name?name=` runs a committed exporter by name for CI (404 unknown, 409 with candidate ids on ambiguity, response contract shared via `_execute_export`); and that the frontend's Export button now ships dirty/uncommitted drafts inline while the add-table control is a searchable typeahead (P-15.1).
- `frontend/README.md`, exporter/export section: the add-table picker is `AddTablePicker.svelte` (client-side combobox, duplicates allowed per F-11); the Export button is ungated (clean committed → `artifact_id`, otherwise inline `definition` via `runExporterDraft`); the entry dialog's Save never blocks (F-16 resolved — the split-template warning is inline, enforcement is the export-time 422).
- `BACKLOG.md`: mark **P-15.1** and the exporter half of **P-16** shipped (Phase 3); mark **F-16** fixed (Save ungated, warning inline); on **K-11** append that the owner confirmed the documented keep-unsanitized posture on 2026-08-20 (decision closed, not just recorded). Changelog note: Exporter v2 Phase 3 shipped — draft runs, run-by-name, P-15.1 picker, ungated Export, F-16; Phases 4–5 remain (Phase 5 needs re-confirmation before starting).

- [ ] **Step 2: Full verification sweep**

Run, in order:
- `pixi run dr-tidy` — format + lint + mypy + pyright, all gates must pass
- `pixi run dr-test` — core pytest + frontend vitest
- `pixi run frontend-check` — svelte-check

Expected: everything green. Fix anything that isn't before committing.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md frontend/README.md BACKLOG.md
git commit -m "docs: exporter v2 phase 3 (draft runs, run-by-name, picker, ungated export)"
```

- [ ] **Step 4: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill (verify tests → present merge options for `feat/exporter-v2-phase3` → base `main`, `--no-ff` per repo convention).

---

## Self-review notes (already applied)

- **Spec coverage:** §9.1 draft runs → Task 2 (XOR 422, guard parity, manifest `artifact_id: null`/`artifact_name`=request name, viewer-callable unchanged); §9.2 run-by-name → Task 3 (query param, 404, 409-with-candidates, shared contract incl. 202); §9.3 needed no work (bare/zip/folders shipped in Phase 1 — `_execute_export` carries them unchanged for both entry points); §11 P-15.1 picker → Task 5; §11 ungated Export button + tooltip → Task 4; §11 F-11 duplicate adds → picker deliberately unfiltered (Task 5) — the `usedRefs` filter itself was already dropped in Phase 1; §13's two new rows (both/neither → 422, run-by-name → 404/409) → Tasks 2–3. Owner additions: F-16 fix → Task 6; deferred cleanups → Task 1; K-11 closure → Task 7 docs. Out of scope by §16: `transform` (Phase 4), bundle drafts (Phase 5), object-shape JSON preview (deliberately deferred in Phase 2).
- **Deliberate interpretations** (flag to the reviewer): (1) the Export button *disables on zero entries* with a hint — the spec only says the dirty/temp gating goes; shipping a guaranteed server 422 as the empty-state UX would be worse than a disabled button, and Save is unaffected. (2) A **clean committed** draft still runs by `artifact_id` rather than always sending the definition — the manifest then reports the real artifact id, matching §9.1's framing of `definition` as the *draft* path. (3) `run_by_name` reuses the POST's per-run 422s (`no entries` etc.) by construction since it delegates to `_execute_export`.
- **Type consistency:** `_execute_export(cdef, *, run_name, artifact_id, project_id, session, db, runner, settings)` defined in Task 2, called in Task 3 with the same keywords; `find_artifacts_by_name(db, project_id, kind, name)` (Task 3) matches `content.py`'s existing argument order (`find_artifact`); `runExporterDraft(definition, name, cfg?)` (Task 4) sends the Task 2 body shape `{definition, name}`; `AddTablePicker`'s `tables` prop is structural (`{id, name}[]`) so `availableTables` (artifact headers) satisfies it without a type import; `isJsonFamily` (Task 1) is consumed in Task 6's rewritten derived.
