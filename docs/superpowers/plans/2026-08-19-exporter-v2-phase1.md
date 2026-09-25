# Exporter v2 — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the `custom_export` artifact kind to `exporter` end-to-end, restructure its payload (`output` options + per-entry `folder`), and land the naming/template engine, folder paths, zip-filename template, bare output mode, and manifest — plus F-11 (allow duplicate table entries) and F-10 (spec amendment).

**Architecture:** The exporter payload becomes `ExporterDefinition{schema_version, output: OutputOptions, entries: [ExporterEntry]}`. A new pure module `core/table/naming.py` owns `${token}` substitution/validation; `split.py` delegates to it. `routes/exports.py` renders entry names, folder paths and the zip filename through it, dedupes members per-folder, injects a deterministic `manifest.json`, and gains a bare (unzipped) mode. Clean-slate: the owner wipes the DB, so the rename ships with only a trivial data-UPDATE Alembic revision and no compat shims.

**Tech Stack:** Python 3.14 / FastAPI / pydantic v2 / SQLAlchemy 2 / Alembic; SvelteKit 5 (runes) / zod / vitest + MSW; everything through pixi.

**Spec:** `docs/superpowers/specs/2026-08-19-custom-export-v2-design.md` (read it first; this plan implements its §16 Phase 1). One correction discovered during planning: the spec's §2.11 assumed a CHECK constraint on `project_artifacts.kind`; there is none (`native_enum=False`, bare VARCHAR(32)), so Alembic `0012` is a data-only UPDATE.

## Global Constraints

- **Toolchain:** no global python/node. Backend tests: `pixi run core-test` (all) or `pixi run -e core-dev pytest tests/path/test_x.py::test_name -v` (one). Frontend tests: `pixi run frontend-test` (all) or `pixi run frontend-test -- src/lib/path/x.test.ts` (one file; the task sets cwd=frontend). Typecheck/lint everything: `pixi run dr-tidy` (ruff --fix + mypy + pyright + frontend). Svelte types: `pixi run frontend-check`.
- **Branch:** work on `feat/exporter-v2-phase1` off `main`. Never push to origin. Never commit anything under `docs/superpowers/` or `.superpowers/` (gitignored by convention).
- **Commit message footer** (every commit): `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- **Naming decisions (locked):** kind value `"exporter"`; UI label `Exporter`; the persisted workspace tab-id prefix stays **`exp:`** (opaque, already fits "exporter" — renaming it would churn `unsaved.ts`, `artifact-lock-denied.ts` and localStorage for nothing).
- **Copy rule:** user-visible copy says "exporter"/"Exporter", never "custom export".
- **Docstring style:** this repo carries dense *why*-docstrings on invariants. When you move code (rename, extract), the docstrings move verbatim; when you add invariants (zip-slip, determinism), document why, matching the style of `routes/exports.py` / `split.py`.
- **Template vocabulary (spec §4):** name/folder/zip contexts allow `${name}`, `${rev}`, `${date}`, `${project}`; split filenames additionally allow `${id}` and REQUIRE `${name}`. Unknown token → 422 at export, never blocks Save. `${date}` = UTC `YYYYMMDD`. `${project}` = project **id**. `${rev}` = `session.model_rev`.

## File Structure (Phase 1 end state)

Backend:
- `src/data_rover/core/table/exporter.py` — renamed from `custom_export.py`; payload models (`TableRef`, `ColumnOverride`, `ExporterEntry`, `OutputOptions`, `ExporterDefinition`, `EXPORTER_ADAPTER`, `overridden_table`).
- `src/data_rover/core/table/naming.py` — **new, pure**: `${token}` regex, `substitute`, `validate_tokens`, `folder_segments`, token-set constants.
- `src/data_rover/core/table/split.py` — delegates substitution to `naming.py`; `render_filenames` gains `extra` vars.
- `src/data_rover/api/export_manifest.py` — **new**: `ManifestEntry` dataclass + `build_manifest`.
- `src/data_rover/api/routes/exports.py` — rename + template rendering, folder paths, per-folder dedupe, bare mode, manifest injection, zip filename.
- `src/data_rover/api/{db_models,artifact_kinds,schemas}.py`, `alembic/versions/0012_rename_custom_export_kind.py` — rename.

Frontend:
- `frontend/src/lib/api/types.ts` — `ExporterEntrySchema`/`ExporterDefinitionSchema`/`OutputOptionsSchema` (resolves C-10: the wire `ExportEntry` name stops clashing with `table/export-layout.ts`'s layout row).
- `frontend/src/lib/state/exporter-editor.svelte.ts` — renamed from `custom-export-editor.svelte.ts`; draft gains `output`.
- `frontend/src/lib/components/Export/ExporterTab.svelte` — renamed from `CustomExportTab.svelte`; output controls + folder field + F-11.
- `frontend/src/lib/table/exporter.ts` — renamed from `custom-export.ts` (helpers keep their names).
- `frontend/src/lib/{artifacts/kinds.ts, state/{workspace.svelte.ts,index.ts,unsaved.ts,artifact-lock-denied.ts,artifacts.svelte.ts}, api/exports.ts, components/{Workspace.svelte,DiffDrawer.svelte,ExportArtifactsDialog.svelte,Sidebar/{ArtifactsSection,TreeRow}.svelte}}` — rename touches.

---

### Task 1: Backend rename sweep (`custom_export` → `exporter`)

Pure refactor — the existing backend suite is the harness. No new behavior.

**Files:**
- Rename: `src/data_rover/core/table/custom_export.py` → `src/data_rover/core/table/exporter.py`
- Rename: `tests/table/test_custom_export.py` → `tests/table/test_exporter.py`
- Create: `alembic/versions/0012_rename_custom_export_kind.py`
- Modify: `src/data_rover/api/db_models.py`, `src/data_rover/api/artifact_kinds.py`, `src/data_rover/api/schemas.py:320-327,1075-1083`, `src/data_rover/api/routes/exports.py`, `src/data_rover/api/table_export_engine.py` (comment), `src/data_rover/api/routes/tables.py:495` (comment), `src/data_rover/core/table/{schema,split}.py` (docstring spec-path refs), `tests/api/{test_artifact_kinds,test_artifacts_routes,test_exports_route,test_artifact_bundle,test_alembic}.py`, `CLAUDE.md` (5 mentions, L137/L163 area)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `ArtifactKind.exporter` (value `"exporter"`); module `data_rover.core.table.exporter` exporting `TableRef`, `ColumnOverride`, `ExporterEntry` (ex-`ExportEntry`), `ExporterDefinition` (ex-`CustomExportDefinition`), `EXPORTER_ADAPTER` (ex-`CUSTOM_EXPORT_ADAPTER`), `overridden_table(defn: TableDefinition, entry: ExporterEntry) -> TableDefinition` (unchanged signature). Wire kind literal `"exporter"` in `CreateArtifactOp.artifact_kind` and `ArtifactCreateIn.kind`. Route error copy: `f"unknown exporter {payload.artifact_id}"`, `"exporter has no entries"`.

- [ ] **Step 1: Branch**

```bash
git checkout -b feat/exporter-v2-phase1
```

- [ ] **Step 2: Rename the core module and its test file**

```bash
git mv src/data_rover/core/table/custom_export.py src/data_rover/core/table/exporter.py
git mv tests/table/test_custom_export.py tests/table/test_exporter.py
```

In `exporter.py`: rename `ExportEntry` → `ExporterEntry`, `CustomExportDefinition` → `ExporterDefinition`, `CUSTOM_EXPORT_ADAPTER` → `EXPORTER_ADAPTER` (and its type annotation), update the module docstring's first line to `"""The `kind='exporter'` artifact payload: ..."""`. Keep every docstring's *why* content. In `test_exporter.py`, update imports and any `custom export` prose in test names/comments (keep the five test functions' semantics identical).

- [ ] **Step 3: Rename the enum member + registry + wire literals**

`db_models.py`: in `ArtifactKind`, replace `custom_export = "custom_export"` with `exporter = "exporter"`. Update the L285-306 docstring: note the VARCHAR(32) width was originally motivated by the 13-char `custom_export` (now renamed `exporter`, Alembic 0012) — keep the width rationale, mark the trigger historical.

`artifact_kinds.py`: import becomes `from data_rover.core.table.exporter import EXPORTER_ADAPTER`; registry entry becomes:

```python
    ArtifactKind.exporter: ArtifactKindSpec(
        kind=ArtifactKind.exporter, adapter=EXPORTER_ADAPTER
    ),
```

`schemas.py`: in BOTH `CreateArtifactOp.artifact_kind` (L320-327) and `ArtifactCreateIn.kind` (L1075-1083) replace `"custom_export"` with `"exporter"` in the `Literal[...]`.

- [ ] **Step 4: Update `routes/exports.py`**

Imports: `from data_rover.core.table.exporter import EXPORTER_ADAPTER, ExporterDefinition, overridden_table`. Kind guard: `row.kind is not ArtifactKind.exporter`; 404 detail `f"unknown exporter {payload.artifact_id}"`; empty-entries 422 detail `"exporter has no entries"`; local variable/annotation `cdef: ExporterDefinition`. Module docstring: "Run an exporter artifact: ...". Update the comment-only mentions in `table_export_engine.py` and `routes/tables.py:495`, and the spec-path docstring refs in `core/table/schema.py` / `core/table/split.py` (point them at both specs: the 2026-08-13 one and `2026-08-19-custom-export-v2-design.md`).

- [ ] **Step 5: Alembic 0012 (data-only)**

Create `alembic/versions/0012_rename_custom_export_kind.py`:

```python
"""Rename artifact kind 'custom_export' -> 'exporter' (data only).

The `project_artifacts.kind` column is a bare VARCHAR (native_enum=False and
therefore no CHECK constraint -- see db_models.ArtifactKind's docstring), so
the rename needs no schema change: only stored rows carry the old literal,
and a row holding it would fail the StrEnum lookup at read time.
"""

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None

_UP = "UPDATE project_artifacts SET kind = 'exporter' WHERE kind = 'custom_export'"
_DOWN = "UPDATE project_artifacts SET kind = 'custom_export' WHERE kind = 'exporter'"


def upgrade() -> None:
    op.execute(_UP)


def downgrade() -> None:
    op.execute(_DOWN)
```

Do NOT edit `0011`'s body (already applied); its docstring prose may gain a one-line "(kind since renamed to `exporter`, see 0012)" note only.

- [ ] **Step 6: Sweep backend tests**

- `tests/api/test_artifact_kinds.py`: rename `test_custom_export_is_registered_and_roundtrips` → `test_exporter_is_registered_and_roundtrips`, `test_custom_export_refs_extract_and_rewrite` → `test_exporter_refs_extract_and_rewrite`; update `ArtifactKind.custom_export` / import references.
- `tests/api/test_artifacts_routes.py`: `test_create_custom_export_artifact` → `test_create_exporter_artifact`, `test_custom_export_payload_is_validated_on_create` → `test_exporter_payload_is_validated_on_create`; JSON bodies post `"kind": "exporter"`.
- `tests/api/test_exports_route.py`: `_mk_export` posts `"kind": "exporter"`; assertions on the 404/422 detail strings updated to `"unknown exporter"` / `"exporter has no entries"`.
- `tests/api/test_artifact_bundle.py`: `ArtifactKind.custom_export` → `ArtifactKind.exporter`; rename `test_custom_export_root_pulls_its_tables_into_the_closure` → `test_exporter_root_pulls_its_tables_into_the_closure`.
- `tests/api/test_alembic.py`: the round-trip row uses `ArtifactKind.exporter`; update the "13 chars fits VARCHAR(32)" comment to reference the historical rename; verify the migration chain test picks up 0012 (if the test enumerates the head, bump it to `"0012"`).

- [ ] **Step 7: Update CLAUDE.md**

Replace the five `custom_export` mentions (the artifact-kinds list and the two long export bullets around L137/L163) with `exporter`, and note the rename parenthetically once: `exporter (né custom_export, renamed 2026-08-19)`.

- [ ] **Step 8: Run the backend suite + lint**

Run: `pixi run core-test` — expected: all pass (same count as baseline, 1835+/30 deselected).
Run: `pixi run -e core-dev ruff check src/ && pixi run core-lint` — expected: clean.
Also grep for stragglers: `grep -rn "custom_export\|CustomExport\|CUSTOM_EXPORT\|custom export" src/ tests/ alembic/ CLAUDE.md` — expected: only historical mentions you deliberately kept (0011/0012 docstrings, CLAUDE.md "né" note, db_models width rationale).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(backend): rename artifact kind custom_export -> exporter

Data-only Alembic 0012 (bare VARCHAR, no CHECK constraint to move).
Spec: 2026-08-19 exporter-v2 §2.11.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Frontend rename sweep

Pure refactor; the frontend suite + `frontend-check`'s exhaustive `Record<ArtifactKind, …>` maps are the harness.

**Files:**
- Rename: `frontend/src/lib/state/custom-export-editor.svelte.ts` → `exporter-editor.svelte.ts`; `frontend/src/lib/components/Export/CustomExportTab.svelte` → `ExporterTab.svelte`; `frontend/src/lib/table/custom-export.ts` → `exporter.ts`; test files `state/__tests__/custom-export-editor.test.ts` → `exporter-editor.test.ts`, `components/Export/__tests__/CustomExportTab.test.ts` → `ExporterTab.test.ts`, `table/__tests__/custom-export.test.ts` → `exporter.test.ts`
- Modify: `frontend/src/lib/api/types.ts:971-999`, `frontend/src/lib/api/exports.ts`, `frontend/src/lib/api/tables.ts` (comment), `frontend/src/lib/artifacts/kinds.ts`, `frontend/src/lib/state/{workspace.svelte.ts,index.ts:404-420,unsaved.ts,artifact-lock-denied.ts,artifacts.svelte.ts,table-editor.svelte.ts}`, `frontend/src/lib/components/{Workspace.svelte,DiffDrawer.svelte:150,ExportArtifactsDialog.svelte:27,Sidebar/ArtifactsSection.svelte,Sidebar/TreeRow.svelte:241}`, `frontend/src/lib/components/Export/{EntryLayoutDialog.svelte,ExportSettingsPanel.svelte}` (imports/comments), `frontend/src/lib/util/export-download.ts` (comment), tests `state/__tests__/{workspace,artifact-lock-denied}.test.ts`, `api/__tests__/exports.test.ts`, `frontend/README.md` (10 mentions)

**Interfaces:**
- Consumes: wire kind `"exporter"` from Task 1.
- Produces (exact new names — later tasks and the whole app use these):
  - types.ts: `ExporterEntrySchema`/`ExporterEntry`, `ExporterDefinitionSchema`/`ExporterDefinition` (`ColumnOverrideSchema` unchanged).
  - exports.ts: `runExporter(artifactId: string, cfg?: ClientConfig): Promise<ExportResult>`.
  - kinds.ts: `REGISTERED_KINDS = ['navigation', 'table', 'code_snippet', 'exporter'] as const`; `KIND_LABEL.exporter = 'Exporter'`; `KIND_ICONS.exporter = FolderOutput`.
  - workspace: tab kind `'exporter'` in `DynamicTab['kind']` and `openArtifactTab`; `PREFIX.exporter = 'exp'` (prefix string unchanged).
  - exporter-editor.svelte.ts (old → new): `getCustomExportDraft→getExporterDraft`, `getCustomExportLockHolder→getExporterLockHolder`, `retryCustomExportLock→retryExporterLock`, `setCustomExportLockDenied→setExporterLockDenied`, `hasDirtyCustomExportDrafts→hasDirtyExporterDrafts`, `ensureCustomExportDraft→ensureExporterDraft`, `setCustomExportName→setExporterName`, `addExportEntry→addExporterEntry`, `removeExportEntry→removeExporterEntry`, `moveExportEntryInList→moveExporterEntryInList`, `updateExportEntry→updateExporterEntry`, `saveCustomExportDraft→saveExporterDraft`, `closeCustomExportDraft→closeExporterDraft`, `resetCustomExportEditors→resetExporterEditors`, `interface CustomExportDraft→ExporterDraft`. All signatures otherwise unchanged. `state/index.ts` barrel re-exports the new names.
  - Testids: `custom-export-run → exporter-run`, `custom-export-save → exporter-save` (`add-table-select`, `export-entry-*`, `entry-layout-*` unchanged).
  - UI copy: `ExportArtifactsDialog` section `{ kind: 'exporter', title: 'Exporters' }`; `DiffDrawer.ARTIFACT_KIND_LABEL.exporter = 'exporter'`; `artifacts.svelte.ts` `NAME_CLASH_LABEL.exporter = 'exporter'`.

- [ ] **Step 1: git mv the six files**

```bash
cd frontend/src/lib
git mv state/custom-export-editor.svelte.ts state/exporter-editor.svelte.ts
git mv components/Export/CustomExportTab.svelte components/Export/ExporterTab.svelte
git mv table/custom-export.ts table/exporter.ts
git mv state/__tests__/custom-export-editor.test.ts state/__tests__/exporter-editor.test.ts
git mv components/Export/__tests__/CustomExportTab.test.ts components/Export/__tests__/ExporterTab.test.ts
git mv table/__tests__/custom-export.test.ts table/__tests__/exporter.test.ts
```

- [ ] **Step 2: types.ts + exports.ts**

In `types.ts` apply the renames from the Interfaces block (schema consts, inferred types, and the section comment header → "Exporter (kind='exporter' artifact payload)… wire mirror of core/table/exporter.py… see $lib/table/exporter.ts"). In `exports.ts`: `runCustomExport` → `runExporter`, docstring updated. In `tables.ts` fix the comment cross-ref.

- [ ] **Step 3: kinds.ts + tab plumbing + exhaustive maps**

Apply the Interfaces block to `kinds.ts`, `workspace.svelte.ts` (union member, `PREFIX`, `openArtifactTab` param type — the `'exp'` prefix string stays), `unsaved.ts` (union member `'exporter'`, `exp:` prefix logic untouched), `artifact-lock-denied.ts` (imports the renamed module; `exp:` dispatch untouched), `artifacts.svelte.ts` `NAME_CLASH_LABEL`, `DiffDrawer.svelte` `ARTIFACT_KIND_LABEL`, `ExportArtifactsDialog.svelte` section descriptor (`title: 'Exporters'`), `ArtifactsSection.svelte` (kind literal, `openArtifactTab('exporter', …)`, collapse-record key), `TreeRow.svelte:241` dispatch, `Workspace.svelte` (both `tab.kind === 'exporter'` branches, `<ExporterTab>` import/render, `closeExporterDraft`).

- [ ] **Step 4: exporter-editor.svelte.ts + ExporterTab.svelte + table/exporter.ts + index.ts**

Rename all 15 exports + the draft interface per the Interfaces table (bodies unchanged); update the module docstring. `ExporterTab.svelte`: update every import, the two testids, and user-visible copy (tooltips already say "Save and commit first…" — keep; any "custom export" prose becomes "exporter"). `table/exporter.ts`: only the module docstring and its `custom-export` self-references change (exported helper names stay). `state/index.ts` L404-420: re-export block updated to the new names (keep alphabetized).

- [ ] **Step 5: sweep the frontend tests + README**

Update imports/testids/fixture kind strings in the six moved-or-affected test files (`exporter-editor.test.ts` fixture `CUSTOM_EXPORT_ARTIFACT` → `EXPORTER_ARTIFACT` with `kind: 'exporter'`; `ExporterTab.test.ts` queries `exporter-run`/`exporter-save`; `workspace.test.ts` asserts `kind === 'exporter'` under the `exp` prefix; `artifact-lock-denied.test.ts` imports `setExporterLockDenied`; `exports.test.ts` describes `runExporter`). `frontend/README.md`: update its 10 mentions.

- [ ] **Step 6: Run the frontend suite + check**

Run: `pixi run frontend-test` — expected: all pass (2078+ baseline).
Run: `pixi run frontend-check` — expected: clean (this is the tripwire for any missed exhaustive-map member).
Grep stragglers: `grep -rn "custom_export\|custom-export\|customExport\|CustomExport" frontend/src/` — expected: zero (frontend keeps no historical mentions).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(frontend): rename custom export -> exporter across wire types, state, components

Resolves C-10 (ExporterEntry no longer clashes with export-layout's ExportEntry).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `core/table/naming.py` — the template engine

**Files:**
- Create: `src/data_rover/core/table/naming.py`
- Modify: `src/data_rover/core/table/split.py` (delegate substitution; `render_filenames` gains `extra`)
- Test: create `tests/table/test_naming.py`; modify `tests/table/test_split.py`

**Interfaces:**
- Consumes: `split.sanitize_stem` (unchanged), `split.SPLIT_TOKEN` (unchanged).
- Produces:
  - `naming.TOKEN_RE: re.Pattern[str]` matching `${...}`.
  - `naming.CONTEXT_TOKENS: frozenset[str] = frozenset({"rev", "date", "project"})`
  - `naming.NAME_TOKENS: frozenset[str] = CONTEXT_TOKENS | {"name"}` (entry names, folder paths, zip filename)
  - `naming.SPLIT_TOKENS: frozenset[str] = NAME_TOKENS | {"id"}` (split filenames)
  - `naming.substitute(template: str, vars: Mapping[str, str]) -> str` — replaces known tokens, leaves unknown ones verbatim (validation is a separate, earlier step).
  - `naming.validate_tokens(template: str, allowed: Iterable[str]) -> None` — raises `ValueError("unknown template token(s): ${x}, ${y}")` listing them sorted.
  - `naming.folder_segments(rendered: str) -> list[str]` — raises `ValueError` on absolute paths / empty segments / segments that sanitize to nothing; returns `sanitize_stem`-cleaned segments. `""` → `[]`.
  - `split.render_filenames(template: str, items: list[tuple[str, str]], *, extra: Mapping[str, str] | None = None) -> list[str]` — per-item vars are `{"name": name, "id": fallback, **(extra or {})}`.

- [ ] **Step 1: Write the failing tests**

Create `tests/table/test_naming.py`:

```python
"""Unit tests for the export template engine (spec 2026-08-19 §4)."""

import pytest

from data_rover.core.table.naming import (
    NAME_TOKENS,
    SPLIT_TOKENS,
    folder_segments,
    substitute,
    validate_tokens,
)


def test_substitute_replaces_known_tokens_and_leaves_unknown_verbatim():
    out = substitute("${name}-${rev}-${nope}", {"name": "svc", "rev": "7"})
    assert out == "svc-7-${nope}"


def test_substitute_handles_repeated_and_adjacent_tokens():
    assert substitute("${name}${name}", {"name": "a"}) == "aa"


def test_validate_tokens_accepts_the_allowed_vocabulary():
    validate_tokens("x${name}_${rev}_${date}_${project}", NAME_TOKENS)
    validate_tokens("${id}-${name}", SPLIT_TOKENS)


def test_validate_tokens_rejects_unknown_tokens_sorted_and_named():
    with pytest.raises(ValueError, match=r"unknown template token\(s\): \$\{beta\}, \$\{zeta\}"):
        validate_tokens("${zeta}${name}${beta}", NAME_TOKENS)


def test_validate_tokens_rejects_id_outside_split_context():
    with pytest.raises(ValueError, match=r"\$\{id\}"):
        validate_tokens("${id}", NAME_TOKENS)


def test_folder_segments_splits_and_sanitizes():
    assert folder_segments("a/b c/d:e") == ["a", "b c", "d_e"]


def test_folder_segments_empty_template_is_root():
    assert folder_segments("") == []


def test_folder_segments_rejects_absolute_paths():
    with pytest.raises(ValueError, match="relative"):
        folder_segments("/abs")
    with pytest.raises(ValueError, match="relative"):
        folder_segments("\\\\abs")


def test_folder_segments_rejects_empty_segments():
    for bad in ("a//b", "a/", "/",):
        with pytest.raises(ValueError):
            folder_segments(bad)


def test_folder_segments_neutralizes_dot_segments():
    # sanitize_stem turns all-dots into underscores; never a traversal token.
    assert folder_segments("../evil") == ["__", "evil"]


def test_folder_segments_rejects_segments_that_sanitize_to_nothing():
    with pytest.raises(ValueError):
        folder_segments("a/   /b")
```

Add to `tests/table/test_split.py`:

```python
def test_render_filenames_extra_vars_reach_every_item():
    out = render_filenames(
        "${name}-${rev}",
        [("id1", "a"), ("id2", "b")],
        extra={"rev": "9"},
    )
    assert out == ["a-9", "b-9"]


def test_render_filenames_id_token_uses_the_fallback_id():
    out = render_filenames("${name}_${id}", [("abc", "el")])
    assert out == ["el_abc"]
```

- [ ] **Step 2: Run them to verify failure**

Run: `pixi run -e core-dev pytest tests/table/test_naming.py tests/table/test_split.py -v`
Expected: FAIL — `ModuleNotFoundError: data_rover.core.table.naming`, and `TypeError: render_filenames() got an unexpected keyword argument 'extra'`.

- [ ] **Step 3: Implement `naming.py`**

```python
"""The `${token}` template engine behind export naming (spec 2026-08-19 §4).

One vocabulary, four contexts (zip filename, entry name, folder path, split
filename). Two-phase by design: `validate_tokens` runs UP FRONT at the route
(unknown tokens are a 422 naming the entry — a typo silently shipped verbatim
into a filename contract is worse than a loud failure), while `substitute`
never raises and leaves unknown tokens verbatim, so it stays safe to call on
already-validated input without re-deriving the context's vocabulary.

Sanitization is deliberately NOT here: templates render first, then pass
through `split.sanitize_stem` at the archive boundary — the same zip-slip
seam `routes/exports.py` documents. `folder_segments` is the one exception:
it must reason about path SEGMENTS (absolute/empty/traversal), which a
per-stem sanitizer cannot, so it owns the segment rules and delegates the
per-segment character cleaning to `sanitize_stem`.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping

from .split import sanitize_stem

TOKEN_RE = re.compile(r"\$\{([^}]*)\}")

CONTEXT_TOKENS: frozenset[str] = frozenset({"rev", "date", "project"})
#: entry names, folder paths, the zip filename
NAME_TOKENS: frozenset[str] = CONTEXT_TOKENS | {"name"}
#: split filenames additionally know the element id
SPLIT_TOKENS: frozenset[str] = NAME_TOKENS | {"id"}


def validate_tokens(template: str, allowed: Iterable[str]) -> None:
    allowed_set = set(allowed)
    unknown = sorted(
        {m.group(1) for m in TOKEN_RE.finditer(template)} - allowed_set
    )
    if unknown:
        listed = ", ".join("${" + t + "}" for t in unknown)
        raise ValueError(f"unknown template token(s): {listed}")


def substitute(template: str, vars: Mapping[str, str]) -> str:
    return TOKEN_RE.sub(lambda m: vars.get(m.group(1), m.group(0)), template)


def folder_segments(rendered: str) -> list[str]:
    """Path segments for a RENDERED folder template. `""` -> [] (root)."""
    if not rendered:
        return []
    if rendered.startswith(("/", "\\")):
        raise ValueError("folder path must be relative")
    segments: list[str] = []
    for raw in rendered.split("/"):
        cleaned = sanitize_stem(raw)
        if not cleaned:
            raise ValueError("folder path has an empty segment")
        segments.append(cleaned)
    return segments
```

In `split.py`, rewrite `render_filenames`'s substitution (keep `validate_template` and the docstrings; the `${name}`-required rule is unchanged):

```python
def render_filenames(
    template: str,
    items: list[tuple[str, str]],
    *,
    extra: Mapping[str, str] | None = None,
) -> list[str]:
    """One filename STEM per `(fallback_id, name)` item, deduplicated `_2`,
    `_3`, ... in row order. Per-item vars are `name` (display name) and `id`
    (the fallback id); `extra` carries the run-level context tokens
    (rev/date/project). The extension is appended by the CALLER after dedup,
    so `a` and a literal `a_2` can never merge. Loop (not a single suffix)
    for the same reason `resolve_json_keys` loops: a produced `_2` can
    collide with a literal name."""
    validate_template(template)
    base_vars = dict(extra or {})
    taken: set[str] = set()
    out: list[str] = []
    for fallback, name in items:
        rendered = substitute(
            template, {**base_vars, "name": name, "id": fallback}
        )
        base = _sanitize(rendered) or _sanitize(fallback) or "element"
        candidate, n = base, 2
        while candidate in taken:
            candidate = f"{base}_{n}"
            n += 1
        taken.add(candidate)
        out.append(candidate)
    return out
```

Import at the top of `split.py`: `from collections.abc import Iterable, Mapping` (extend the existing `Iterable` import) and — to avoid a circular import (`naming` imports `sanitize_stem` from `split`) — import lazily is NOT needed if `split` imports only the function: add `from .naming import substitute` **below** the module's own definitions is ugly; instead have `split.py` import at top: `from . import naming` and call `naming.substitute(...)`. Python resolves this fine as long as `naming` imports `sanitize_stem` at module top and `split` uses `naming.substitute` only inside the function body — but top-level `from . import naming` in `split.py` + `from .split import sanitize_stem` in `naming.py` IS a cycle. Resolution: `naming.py` must NOT import from `split.py`. Move nothing — instead `folder_segments` takes the sanitizer as data? No: simplest correct fix — `sanitize_stem` MOVES to `naming.py` (with its full docstring, verbatim) and `split.py` re-imports it: `from .naming import sanitize_stem` plus keeps the `_sanitize = sanitize_stem` alias and its re-export (external callers `routes/exports.py` and `table_export_engine.py` keep importing `sanitize_stem` from `split` unchanged; tests too). Then `split.py` also imports `substitute` from `.naming`. One direction, no cycle.

- [ ] **Step 4: Run tests to verify pass**

Run: `pixi run -e core-dev pytest tests/table/test_naming.py tests/table/test_split.py -v`
Expected: PASS, including the pre-existing split/sanitize tests (they exercise the moved `sanitize_stem` through `split`'s re-import).

- [ ] **Step 5: Full backend suite + commit**

Run: `pixi run core-test` — expected: all pass.

```bash
git add src/data_rover/core/table/naming.py src/data_rover/core/table/split.py tests/table/test_naming.py tests/table/test_split.py
git commit -m "feat(core): export template engine (naming.py) with per-context token vocabularies

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Payload restructure — `OutputOptions` + `ExporterEntry.folder`

**Files:**
- Modify: `src/data_rover/core/table/exporter.py`
- Test: `tests/table/test_exporter.py`

**Interfaces:**
- Consumes: Task 1's renamed module.
- Produces:

```python
class OutputOptions(BaseModel):
    mode: Literal["zip", "bare"] = "zip"
    #: Zip filename template; "" = the artifact's name. NAME_TOKENS vocabulary.
    filename: str = ""
    manifest: bool = True

class ExporterEntry(BaseModel):   # two NEW fields beside the existing ones
    ...
    #: Output base-name template; "" = the table's name. NAME_TOKENS vocabulary.
    name: str = ""                # (existing field, semantics now "template")
    #: Folder path template inside the zip; "" = archive root. Multi-segment.
    folder: str = ""

class ExporterDefinition(BaseModel):
    schema_version: int = 1
    output: OutputOptions = Field(default_factory=OutputOptions)
    entries: list[ExporterEntry] = Field(default_factory=list)
```

`overridden_table` unchanged (folder/name are route-level naming, not table presentation).

- [ ] **Step 1: Write the failing test** (append to `tests/table/test_exporter.py`)

```python
def test_output_options_default_and_roundtrip():
    d = EXPORTER_ADAPTER.validate_python({"entries": []})
    assert d.output.mode == "zip"
    assert d.output.filename == ""
    assert d.output.manifest is True

    d2 = EXPORTER_ADAPTER.validate_python(
        {
            "output": {"mode": "bare", "filename": "x_${rev}", "manifest": False},
            "entries": [{"source": {"ref": "t1"}, "folder": "a/b"}],
        }
    )
    assert d2.output.mode == "bare"
    assert d2.entries[0].folder == "a/b"
    dumped = d2.model_dump()
    assert EXPORTER_ADAPTER.validate_python(dumped) == d2
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/table/test_exporter.py::test_output_options_default_and_roundtrip -v`
Expected: FAIL — `AttributeError: 'ExporterDefinition' object has no attribute 'output'` (or validation error on `folder`).

- [ ] **Step 3: Implement** — add `OutputOptions` (above `ExporterEntry`), the `folder` field with the docstring comments from the Interfaces block, and the `output` field on `ExporterDefinition`. Update `ExporterEntry.name`'s comment to say "template" and reference the NAME_TOKENS vocabulary.

- [ ] **Step 4: Run to verify pass**, then full suite: `pixi run core-test` — expected: PASS (existing payload tests keep passing: all new fields default).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/table/exporter.py tests/table/test_exporter.py
git commit -m "feat(core): exporter payload gains OutputOptions and per-entry folder

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Route — template rendering, folder paths, per-folder dedupe

**Files:**
- Modify: `src/data_rover/api/routes/exports.py`, `src/data_rover/api/table_export_engine.py` (thread `template_vars` to `render_filenames`), `src/data_rover/api/routes/tables.py` (pass `template_vars` from the standalone export too)
- Test: `tests/api/test_exports_route.py`

**Interfaces:**
- Consumes: `naming.{NAME_TOKENS, SPLIT_TOKENS, substitute, validate_tokens, folder_segments}`, `split.render_filenames(..., extra=)`, Task 4's schema.
- Produces:
  - `run_table_export(..., template_vars: Mapping[str, str] | None = None)` — new keyword-only param, passed as `extra=` to `render_filenames`; `None` behaves as `{}`.
  - In `table_export_engine.py`: `export_context_vars(session: Session, project_id: str) -> dict[str, str]` returning `{"rev": str(session.model_rev), "date": datetime.now(UTC).strftime("%Y%m%d"), "project": project_id}` — ONE definition, imported by both `routes/exports.py` and `routes/tables.py`.
  - In `routes/exports.py`: helper `_dedupe_path(prefix: str, stem: str, taken: set[str]) -> str` (replaces `_dedupe`; `taken` holds full `prefix+stem` paths).
  - Rendered entry name: `substitute(entry.name, {"name": t.name, **ctx})` when `entry.name` else `t.name`.
  - Member path: `{folder_prefix}{name}.{ext}` for single files; `{folder_prefix}{entry_folder}/{split_file}` for split entries.

- [ ] **Step 1: Write the failing tests** (append to `tests/api/test_exports_route.py`; reuse its `client` fixture, `_mk_table`, `_mk_export`, `_run` helpers — `_mk_export` must accept and forward an optional `output` dict and per-entry extras, so extend it first):

```python
def _entries(*tables: str, **extra: object) -> list[dict[str, object]]:
    return [{"source": {"ref": t}, **extra} for t in tables]


def test_folder_template_nests_entry_files(client) -> None:
    t = _mk_table(client, "T")
    art = _mk_export(client, [{"source": {"ref": t}, "name": "f", "folder": "grp/sub"}])
    resp = _run(client, art)
    assert resp.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(resp.content)).namelist()
    assert "grp/sub/f.xlsx" in names


def test_shared_folder_prefix_and_per_folder_dedupe(client) -> None:
    t = _mk_table(client, "T")
    art = _mk_export(
        client,
        [
            {"source": {"ref": t}, "name": "same", "folder": "a"},
            {"source": {"ref": t}, "name": "same", "folder": "a"},
            {"source": {"ref": t}, "name": "same", "folder": "b"},
        ],
    )
    names = zipfile.ZipFile(io.BytesIO(_run(client, art).content)).namelist()
    # dedupe scoped to the folder: b/same needs no suffix
    assert {"a/same.xlsx", "a/same_2.xlsx", "b/same.xlsx"} <= set(names)


def test_folder_traversal_and_absolute_are_422(client) -> None:
    t = _mk_table(client, "T")
    for bad in ("/abs", "a//b", "a/   /b"):
        art = _mk_export(client, [{"source": {"ref": t}, "folder": bad}], name=f"e-{bad!r}")
        resp = _run(client, art)
        assert resp.status_code == 422, bad
        assert "folder" in resp.json()["detail"]


def test_dotdot_folder_segment_is_neutralized_not_traversal(client) -> None:
    t = _mk_table(client, "T")
    art = _mk_export(client, [{"source": {"ref": t}, "name": "f", "folder": "../up"}])
    names = zipfile.ZipFile(io.BytesIO(_run(client, art).content)).namelist()
    assert "__/up/f.xlsx" in names  # sanitize_stem turns ".." into "__"


def test_unknown_template_token_is_422_naming_the_entry(client) -> None:
    t = _mk_table(client, "T")
    art = _mk_export(client, [{"source": {"ref": t}, "name": "x${typo}"}])
    resp = _run(client, art)
    assert resp.status_code == 422
    assert "${typo}" in resp.json()["detail"]


def test_context_tokens_render_in_entry_names(client) -> None:
    t = _mk_table(client, "T")
    art = _mk_export(client, [{"source": {"ref": t}, "name": "${name}_r${rev}"}])
    names = zipfile.ZipFile(io.BytesIO(_run(client, art).content)).namelist()
    # rev is 0-or-more commits in the seeded project; just assert the shape
    assert any(n.startswith("T_r") and n.endswith(".xlsx") for n in names)
```

(Imports `io`, `zipfile` exist in that test module already; verify.)

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_exports_route.py -k "folder or token" -v`
Expected: FAIL — folder key rejected by the adapter until Task 4 landed (it did), so failures are missing 422s / missing zip members.

- [ ] **Step 3: Implement in `routes/exports.py`**

Up-front validation loop additions (beside the existing missing/bad_templates passes — merge into ONE loop with per-entry `bad_templates` reasons):

```python
    ctx = export_context_vars(session, project_id)
    try:
        validate_tokens(cdef.output.filename, NAME_TOKENS)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"output filename: {exc}") from exc
    folders: list[list[str]] = []
    for entry in cdef.entries:
        ...existing table resolution...
        try:
            validate_tokens(entry.name, NAME_TOKENS)
            validate_tokens(entry.folder, NAME_TOKENS)
            rendered_folder = substitute(entry.folder, {"name": table_name, **ctx})
            folders.append(folder_segments(rendered_folder))
            split = entry.json_split
            if entry.format == "json" and split is not None and split.enabled:
                validate_template(split.filename_template)
                validate_tokens(split.filename_template, SPLIT_TOKENS)
        except ValueError as exc:
            bad_templates.append(f"{entry.name or entry.source.ref}: {exc}")
            folders.append([])
```

`table_name` is `t.name` when the table resolved, else the ref (mirror the existing `missing` naming). Entry run: `out_name = substitute(entry.name, {"name": t.name, **ctx}) if entry.name else t.name`; pass `template_vars={**ctx}` into `run_table_export`. Assembly: build `prefix = "/".join(segments) + "/" if segments else ""` per entry; replace `_dedupe` with:

```python
def _dedupe_path(prefix: str, stem: str, taken: set[str]) -> str:
    candidate, n = stem, 2
    while f"{prefix}{candidate}" in taken:
        candidate = f"{stem}_{n}"
        n += 1
    taken.add(f"{prefix}{candidate}")
    return candidate
```

and prepend `prefix` to every member path in both the archive and single-file branches (the zip-slip commentary moves/extends accordingly — folder segments are already sanitized by `folder_segments`, entry stems still by `sanitize_stem` at this boundary).

In `table_export_engine.py`: define `export_context_vars` per the Interfaces block; `run_table_export` gains keyword-only `template_vars: Mapping[str, str] | None = None`, passed as `extra=template_vars` to `render_filenames`. Both `routes/exports.py` and `routes/tables.py`'s export call sites import `export_context_vars` from the engine and pass the dict.

- [ ] **Step 4: Run to verify pass**

Run: `pixi run -e core-dev pytest tests/api/test_exports_route.py tests/api/test_tables*.py -v`
Expected: PASS, including the pre-existing traversal/dedupe tests (their expectations are unchanged: no folder → empty prefix, dedupe degenerates to the old global behavior for root files).

- [ ] **Step 5: Full suite + commit**

Run: `pixi run core-test` — expected: PASS.

```bash
git add src/data_rover/api/routes/exports.py src/data_rover/api/table_export_engine.py src/data_rover/api/routes/tables.py tests/api/test_exports_route.py
git commit -m "feat(api): exporter entry-name/folder templating with per-folder dedupe

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Zip filename template + bare mode

**Files:**
- Modify: `src/data_rover/api/routes/exports.py`
- Test: `tests/api/test_exports_route.py`

**Interfaces:**
- Consumes: Task 5's `ctx`, `substitute`, `sanitize_stem`.
- Produces: `Content-Disposition` from `output.filename`; bare-mode single-file `Response`. Media types: `_MEDIA_TYPES = {"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "json": "application/json"}` keyed by member extension.

- [ ] **Step 1: Write the failing tests**

```python
def test_zip_filename_template(client) -> None:
    t = _mk_table(client, "T")
    art = _mk_export(
        client, _entries(t), name="MyExport",
        output={"filename": "bundle_${name}_${project}"},
    )
    resp = _run(client, art)
    cd = resp.headers["content-disposition"]
    assert 'filename="bundle_MyExport_default.zip"' in cd


def test_bare_mode_ships_the_single_file_directly(client) -> None:
    t = _mk_table(client, "T")
    art = _mk_export(
        client, [{"source": {"ref": t}, "name": "solo", "format": "json"}],
        output={"mode": "bare"},
    )
    resp = _run(client, art)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/json")
    assert 'filename="solo.json"' in resp.headers["content-disposition"]
    json.loads(resp.content)  # it's the document, not a zip


def test_bare_mode_with_multiple_files_is_422(client) -> None:
    t = _mk_table(client, "T")
    art = _mk_export(client, _entries(t, t), output={"mode": "bare"})
    resp = _run(client, art)
    assert resp.status_code == 422
    assert "bare" in resp.json()["detail"]
```

(`test_bare_mode_with_multiple_files_is_422` relies on F-11's server-side tolerance of duplicate refs — already supported.)

- [ ] **Step 2: Run to verify failure** — `pixi run -e core-dev pytest tests/api/test_exports_route.py -k "zip_filename or bare" -v` — expected: FAIL (filename is still `{row.name}.zip`; bare unimplemented).

- [ ] **Step 3: Implement** — after file assembly (before manifest injection, Task 7):

```python
    if cdef.output.mode == "bare":
        # Spec §9.3: bare is a CONTRACT (exactly one file), not best-effort —
        # a silent fallback to zip would change the content type under a
        # consuming script. Never blocks Save; enforced only here.
        if len(files) != 1:
            raise HTTPException(
                status_code=422,
                detail=f"bare output requires a single file (this run produced {len(files)})",
            )
        member, blob = files[0]
        ext = member.rpartition(".")[2]
        return Response(
            content=blob,
            media_type=_MEDIA_TYPES.get(ext, "application/octet-stream"),
            headers={
                "Content-Disposition": f'attachment; filename="{member.rpartition("/")[2]}"',
                **{k: v for k, v in resp_headers.items() if k != "Content-Disposition"},
            },
        )
```

Zip name: `zip_stem = sanitize_stem(substitute(cdef.output.filename, {"name": row.name, **ctx})) or sanitize_stem(row.name) or "export"`; `resp_headers["Content-Disposition"] = f'attachment; filename="{zip_stem}.zip"'`. Order the code so `resp_headers` (with truncated/degraded) is built before the bare branch, and the bare branch carries those X- headers too.

- [ ] **Step 4: Run to verify pass**, then `pixi run core-test` — expected: PASS (`test_..._land_in_one_zip` still passes: default filename template = artifact name = old behavior).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/routes/exports.py tests/api/test_exports_route.py
git commit -m "feat(api): exporter zip filename template and bare single-file output mode

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Manifest

**Files:**
- Create: `src/data_rover/api/export_manifest.py`
- Modify: `src/data_rover/api/routes/exports.py`
- Test: create `tests/api/test_export_manifest.py` (pure-fn tests) + append route tests to `tests/api/test_exports_route.py`

**Interfaces:**
- Consumes: per-entry `ExportFiles.{truncated,degraded}`, final member paths from Task 5/6.
- Produces:

```python
@dataclass(frozen=True)
class ManifestEntry:
    name: str            # rendered entry name
    table_ref: str
    table_name: str
    format: str
    truncated: bool
    degraded: bool
    files: list[str]     # final member paths
    transform: str | None = None   # always None in Phase 1; wire slot per spec §5

def build_manifest(
    *, project_id: str, artifact_id: str | None, artifact_name: str,
    model_rev: int, entries: list[ManifestEntry],
) -> bytes
```

Top-level `truncated`/`degraded` = `any(...)` over entries. `MANIFEST_NAME = "manifest.json"`. Output: `json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8")` — **no wall-clock field** (spec §5: `model_rev` is the reproducible identity; a timestamp would break `build_zip`'s byte-determinism).

- [ ] **Step 1: Write the failing tests**

`tests/api/test_export_manifest.py`:

```python
import json

from data_rover.api.export_manifest import ManifestEntry, build_manifest


def _entry(**kw: object) -> ManifestEntry:
    base: dict = dict(
        name="e", table_ref="t1", table_name="T", format="xlsx",
        truncated=False, degraded=False, files=["e.xlsx"],
    )
    base.update(kw)
    return ManifestEntry(**base)


def test_manifest_shape_and_aggregates():
    blob = build_manifest(
        project_id="p", artifact_id="a", artifact_name="Exp", model_rev=7,
        entries=[_entry(), _entry(name="f", degraded=True, files=["g/f.json"], format="json")],
    )
    doc = json.loads(blob)
    assert doc["manifest_version"] == 1
    assert doc["model_rev"] == 7
    assert doc["truncated"] is False and doc["degraded"] is True
    assert doc["entries"][1]["files"] == ["g/f.json"]
    assert doc["entries"][0]["transform"] is None
    assert "generated_at" not in doc  # determinism: no wall clock, by spec


def test_manifest_is_deterministic():
    kw = dict(project_id="p", artifact_id=None, artifact_name="E", model_rev=1, entries=[_entry()])
    assert build_manifest(**kw) == build_manifest(**kw)
```

Route tests (append to `tests/api/test_exports_route.py`):

```python
def test_manifest_lands_at_the_zip_root_by_default(client) -> None:
    t = _mk_table(client, "T")
    art = _mk_export(client, _entries(t), name="M")
    zf = zipfile.ZipFile(io.BytesIO(_run(client, art).content))
    doc = json.loads(zf.read("manifest.json"))
    assert doc["artifact_name"] == "M"
    assert doc["entries"][0]["files"] == ["T.xlsx"]


def test_manifest_off_omits_the_member(client) -> None:
    t = _mk_table(client, "T")
    art = _mk_export(client, _entries(t), output={"manifest": False})
    names = zipfile.ZipFile(io.BytesIO(_run(client, art).content)).namelist()
    assert "manifest.json" not in names


def test_user_file_named_manifest_dedupes_against_the_reserved_root_name(client) -> None:
    t = _mk_table(client, "T")
    art = _mk_export(client, [{"source": {"ref": t}, "name": "manifest", "format": "json"}])
    names = set(zipfile.ZipFile(io.BytesIO(_run(client, art).content)).namelist())
    assert "manifest.json" in names          # the real manifest
    assert "manifest_2.json" in names        # the user's file, deduped


def test_two_runs_at_one_rev_are_byte_identical(client) -> None:
    t = _mk_table(client, "T")
    art = _mk_export(client, _entries(t))
    assert _run(client, art).content == _run(client, art).content
```

- [ ] **Step 2: Run to verify failure** — `pixi run -e core-dev pytest tests/api/test_export_manifest.py tests/api/test_exports_route.py -k manifest -v` — expected: FAIL (module missing; no manifest member).

- [ ] **Step 3: Implement** — `export_manifest.py` per the Interfaces block (module docstring: why no timestamp — quote spec §5's determinism argument). In `routes/exports.py`: when `output.manifest and output.mode == "zip"`, seed `taken` with `"manifest"`-stem BEFORE assembly (seed the full path: `taken.add("manifest")` so `_dedupe_path("", "manifest", taken)` suffixes the user's root-level `manifest` stem — note the taken-set stores stem paths without extension, matching Task 5's semantics), collect a `ManifestEntry` per entry as its files are appended (final paths), and `files.insert(0, (MANIFEST_NAME, build_manifest(...)))` after assembly. `artifact_id=row.id`, `artifact_name=row.name`, `model_rev=session.model_rev`.

- [ ] **Step 4: Run to verify pass**, then `pixi run core-test` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/export_manifest.py src/data_rover/api/routes/exports.py tests/api/test_export_manifest.py tests/api/test_exports_route.py
git commit -m "feat(api): deterministic manifest.json in exporter zips

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Frontend — output/folder controls + F-11

**Files:**
- Modify: `frontend/src/lib/api/types.ts`, `frontend/src/lib/state/exporter-editor.svelte.ts`, `frontend/src/lib/state/index.ts`, `frontend/src/lib/components/Export/ExporterTab.svelte`
- Test: `frontend/src/lib/state/__tests__/exporter-editor.test.ts`, `frontend/src/lib/components/Export/__tests__/ExporterTab.test.ts`

**Interfaces:**
- Consumes: Task 2's renamed modules; Task 4's wire shape.
- Produces:
  - types.ts: `export const OutputOptionsSchema = z.object({ mode: z.enum(['zip', 'bare']).default('zip'), filename: z.string().default(''), manifest: z.boolean().default(true) }); export type OutputOptions = z.infer<typeof OutputOptionsSchema>;` — `ExporterEntrySchema` gains `folder: z.string().default('')`; `ExporterDefinitionSchema` gains `output: OutputOptionsSchema.default({ mode: 'zip', filename: '', manifest: true })`.
  - `ExporterDraft` gains `output: OutputOptions`; new export `updateExporterOutput(tabId: string, patch: Partial<OutputOptions>): void` (marks dirty, like `updateExporterEntry`); `saveExporterDraft` payload becomes `{ schema_version: 1, output: d.output, entries: d.entries }`; `ensureExporterDraft` seeds `output` from the parsed payload (schema default covers pre-wipe blobs, which won't exist anyway).
  - ExporterTab controls (testids): `exporter-filename` (text input, placeholder = artifact name), `exporter-mode-zip`/`exporter-mode-bare` (toggle pair, `aria-pressed`, same style as the entry format toggles), `exporter-manifest` (checkbox), per-entry `export-entry-{i}-folder` (text input, placeholder "folder/in/zip").

- [ ] **Step 1: Write the failing tests**

`exporter-editor.test.ts` additions:

```ts
it('seeds output from the payload and defaults it when absent', async () => { /* mock getArtifact with and without output; assert draft.output */ });
it('updateExporterOutput patches and dirties', () => { /* updateExporterOutput(tab, { mode: 'bare' }); expect(draft.output.mode).toBe('bare'); expect(draft.dirty).toBe(true); */ });
it('saveExporterDraft stages output alongside entries', () => { /* assert staged payload contains output */ });
```

`ExporterTab.test.ts` additions:

```ts
it('renders output controls and stages edits through them', async () => { /* type into exporter-filename, click exporter-mode-bare, uncheck exporter-manifest; assert updateExporterOutput effects */ });
it('renders a folder input per entry', async () => { /* type into export-entry-0-folder; assert entry.folder patched */ });
it('allows adding the same table twice (F-11)', async () => { /* add table T, then open the select again: T still listed; add; two entries */ });
```

Write them as real tests following the file's existing patterns (the suite mocks `artifactsApi.getArtifact` and drives the real state module — copy the arrangement of the neighboring `it()`s; the sketches above fix names/testids/assertions, not the boilerplate).

- [ ] **Step 2: Run to verify failure** — `pixi run frontend-test -- src/lib/state/__tests__/exporter-editor.test.ts src/lib/components/Export/__tests__/ExporterTab.test.ts` — expected: FAIL.

- [ ] **Step 3: Implement** — types.ts + editor per the Interfaces block. ExporterTab: an output-settings row under the header bar (filename input, zip/bare toggle pair, manifest checkbox — visible when `editable`, disabled while `locked`); a `folder` input in each entry row beside the name input; **delete the `usedRefs` derived and its filter** so `availableTables = referenceableArtifactHeaders('table')` (F-11 — the server dedupes colliding output names, `routes/exports.py::_dedupe_path`).

- [ ] **Step 4: Run to verify pass** — the two files, then `pixi run frontend-test && pixi run frontend-check` — expected: PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src
git commit -m "feat(frontend): exporter output settings, per-entry folders, duplicate entries (F-11)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Wrap-up — F-10 amendment, backlog, full verification

**Files:**
- Modify: `BACKLOG.md`, `docs/superpowers/specs/2026-08-13-table-export-split-and-custom-export-design.md` (uncommitted — gitignored)

**Interfaces:** none (documentation + verification).

- [ ] **Step 1: F-10 spec amendment** — append to the 2026-08-13 spec:

```markdown
## Amendments

- 2026-08-19 (Exporter v2, F-10): §5.1's "an invalid `${name}` template
  blocks Save" is retracted. Shipped behavior — block **Export** with a 422,
  never Save — is the intended contract: a stored-but-invalid presentation
  setting must never block saving or evaluating (the stance
  `JsonSplitOptions`' docstring already states), and Exporter v2 §4 extends
  export-time strictness to every template uniformly.
```

(Do not commit this file.)

- [ ] **Step 2: Update BACKLOG.md**

- **P-15.2** and **P-15.3** → `done` (2026-08-19, feat/exporter-v2-phase1): filename via `output.filename` template, folder via `ExporterEntry.folder` (note per-segment sanitizing + per-folder dedupe landed as specced). **P-15.1** stays `open` — note "scheduled: Exporter v2 Phase 3".
- **F-10** → `done` (2026-08-19): resolved by spec amendment, shipped behavior kept.
- **F-11** → `done` (2026-08-19): filter dropped; duplicate entries expressible.
- **C-10** → `done` (2026-08-19): wire type renamed `ExporterEntry` by the kind rename.
- **P-16** → note "in progress — design settled in `2026-08-19-custom-export-v2-design.md` §9.1/§10; lands in Exporter v2 Phases 3/5".
- Add one line under §2 noting the rename: "the `custom_export` kind is now `exporter` (Exporter v2 Phase 1)."
- Update the "Last updated" header line.

- [ ] **Step 3: Full verification**

Run: `pixi run dr-tidy` — expected: clean (ruff may reformat; re-add).
Run: `pixi run dr-test` — expected: core + frontend suites pass.
Run: `grep -rni "custom.export" src/ frontend/src/ tests/ --include="*.py" --include="*.ts" --include="*.svelte"` — expected: only deliberate historical mentions (Alembic docstrings, db_models width note).

- [ ] **Step 4: Commit**

```bash
git add BACKLOG.md
git commit -m "docs: backlog updates for Exporter v2 Phase 1 (P-15.2/.3, F-10, F-11, C-10 done)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Post-plan note for the executor

- The owner will **wipe the database** after this lands (clean-slate stance, spec §1). Alembic 0012 exists only so a non-wiped dev DB doesn't crash on enum lookup; don't build anything else on old-data survival.
- Phases 2–5 of the spec (formats/`json_doc`, draft runs/run-by-name/picker, transform hook, bundle drafts) are **separate plans** — do not start them from this one.
