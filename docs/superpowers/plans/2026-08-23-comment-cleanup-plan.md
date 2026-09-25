# Comment & Docstring Cleanup Plan

Repo-wide editorial cleanup of comments, docstrings, and prose docs. No behavior
changes of any kind: every diff hunk must touch only comments, docstrings, test
names/descriptions, or Markdown prose. Approved by the user 2026-08-23.

## Global Constraints (the rubric — binding for every task)

**Delete outright:**

1. Any reference to specs, plans, backlogs, phases, review findings, or dated
   design docs. Banned patterns (case-insensitive): `spec §`, `the spec`,
   `docs/superpowers`, `Phase <N>` / `phase-<N>`, `backlog`, `review finding`,
   `P-<N>.<N>` item ids, `né`, `renamed 20XX`, `Spec A/B`, `(M1)`/`(M2)`/`(M3)`
   milestone tags, `Alembic <NNNN>` provenance tags in comments (Alembic
   migration files' own docstrings keep their revision identifiers — those are
   functional).
2. Historical narration: "used to", "previously", "no longer", "formerly",
   "retired", "was renamed", "before this change", "this replaces / replaced
   the old X", "deferred to", "the legacy X era", "regression: X used to".
   Code describes what IS; git history owns what WAS. (Exception: the word
   "legacy" may survive where it names a still-live compatibility surface,
   e.g. a route that genuinely exists for backward compatibility — but say
   what it is, not its story.)
3. Comments that restate what the adjacent code plainly does.

**Keep, rewritten concisely in present tense:**

4. Genuine invariants and contracts that do NOT emerge from the code itself:
   concurrency rules ("must hold `write_mutex`"), aliasing/ownership rules
   ("values are replaced wholesale, never mutated — inverse patches alias
   them by reference"), non-obvious status-code semantics (409 vs 422 vs 503
   choices), security rationale, deliberate limitations and their supported
   workaround. The RATIONALE survives; the PROVENANCE dies.
5. Docstrings shrink to a one-line summary plus only those invariants.
   Module docstrings describe the module's current role in a few lines, not
   its development story. `#:` attribute-doc comments (settings) stay but get
   the same treatment.
6. Section-divider comments (`# --- foo ---`) may stay, minus any banned refs.

**Tests:**

7. Regression-test comments keep a one-line present-tense statement of the
   behavior being pinned, never the story of the old bug.
8. Test names/descriptions phrased historically (e.g. `no longer
   special-cases X`, `test_legacy_...` where "legacy" is narrative) are
   renamed to present-tense behavior statements.

**Judgment rule:** when a comment mixes history and invariant, keep one tight
sentence of invariant, drop the rest. When in doubt whether something is
inferable from the code, keep a short version rather than delete.

**Hard safety rule:** never change executable code. No renamed identifiers
(except test function/it() names), no reordered imports, no logic edits, no
reformatting of code lines. If a docstring/comment edit makes ruff reflow a
line, that is acceptable; nothing else is.

**Do not touch:** `docs/`, `examples/`, `alembic/` migration bodies (their
docstring headers may be trimmed of narrative but keep revision ids),
`spikes/`, generated files, `pixi.toml`, lockfiles. `frontend/src/lib/components/ui/`
(vendored shadcn-style primitives) — skip entirely.

## Verification (every task)

- Python tasks: `pixi run core-lint` (and `pixi run backend-lint` if api files
  changed) + the pytest subset named in the task, run as
  `pixi run -e core-dev pytest <paths> -m "not integration"`.
- Frontend tasks: `pixi run frontend-test` and `pixi run frontend-check`
  (already scoped to `frontend/`).
- After tests pass, self-check the diff: `git diff <base>` must contain only
  comment/docstring/test-name/Markdown hunks.
- Commit with a `chore(comments):` message describing the area.

## Tasks

### Task 1 — core (non-script/table)
Files: `src/data_rover/core/` EXCEPT `script/` and `table/` (metamodel, model,
navigation, search, validation, view, top-level `__init__`/modules).
Tests: `tests/metamodel tests/model tests/navigation tests/search tests/validation tests/view`.

### Task 2 — core/script + core/table
Files: `src/data_rover/core/script/`, `src/data_rover/core/table/` (`.py` only;
the script README is Task 9).
Tests: `tests/script tests/table`.

### Task 3 — api (non-routes)
Files: `src/data_rover/api/*.py` (43 files: session, hydration, locking,
storage, content, db*, settings, schemas, feed, main, importer, exporters,
sweeps, …).
Tests: `tests/api` (single run at the end of the task).

### Task 4 — api/routes + migration
Files: `src/data_rover/api/routes/`, `src/data_rover/migration/*.py`
(migration README is Task 9).
Tests: `tests/api tests/migration`.

### Task 5 — Python tests
Files: `tests/` (grep-driven: only files containing offending comments/names
need edits). Includes rule 8 renames.
Tests: full `pixi run core-test -m "not integration"` at the end.

### Task 6 — frontend lib (non-component, non-test)
Files: `frontend/src/lib/{state,api,editor,table,metamodel,snippet,search,script,util}/*.ts`
(excluding `__tests__`), `frontend/src/lib/*.ts`, `frontend/src/routes/`.
Tests: `pixi run frontend-test` + `pixi run frontend-check`.

### Task 7 — frontend components (non-test)
Files: `frontend/src/lib/components/**` excluding `__tests__` and `ui/`.
Tests: `pixi run frontend-test` + `pixi run frontend-check`.

### Task 8 — frontend tests + e2e
Files: all `frontend/src/**/__tests__/`, `frontend/e2e/` (grep-driven).
Includes rule 8 renames of `it()`/`describe()` strings.
Tests: `pixi run frontend-test` (e2e NOT run — comment-only edits; note this
in the report).

### Task 9 — prose docs
Files: `frontend/README.md`, `src/data_rover/core/script/README.md`,
`src/data_rover/migration/README.md`, `CLAUDE.md`. Rewrite to describe the
system as it IS (no phases, no spec paths, no history). CLAUDE.md additionally
replaces the "dense docstrings … preserve and extend that style" convention
with the new comment policy (concise; only for critical details that don't
emerge from the code). Keep CLAUDE.md's command/architecture content accurate
but apply the same concision standard.
Tests: none (prose); `git diff` self-check only.

### Task 10 — final sweep
Grep the whole repo for the banned patterns; triage survivors (runtime strings
and functional identifiers are legitimate); fix stragglers. Then full
`pixi run dr-tidy` + `pixi run core-test -m "not integration"` +
`pixi run frontend-test` + `pixi run frontend-check`.
