# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A reflective MBSE (Model-Based Systems Engineering) metamodel engine. Three data layers stack on each other:

- **Metamodel** (`*.metamodel.yaml`) — the schema: element types, relationship types, inheritance (`extends`), properties with datatypes/multiplicity/facets, allowed endpoint `mappings`, and `key`s for uniqueness.
- **Model** (`*.model.json`) — instance data: elements and relationships conforming to one metamodel.
- **View** (`*.view.json`) — an optional user-defined folder overlay that *references* model elements by id; it owns nothing.

It ships as a Python core + FastAPI backend and a SvelteKit single-page frontend, with a one-shot CLI to migrate a legacy metamodel/model format into the new one. Example artifacts live in `examples/` (`smart-city.*`).

## Toolchain & commands

Everything runs through **pixi** (conda-based). There is no global `python` or `node` — always go through `pixi run`. Environments: `core` (runtime), `core-dev` (lint/test, includes api), `api` (backend runtime), `frontend` (Node 22).

```sh
# Python core + API
pixi run test-core                       # pytest (pythonpath=src, testpaths=tests)
pixi run -e core-dev pytest tests/model/test_model.py::test_name   # a single test
pixi run -e core-dev pytest -k uniqueness                          # by keyword
pixi run start-backend                   # uvicorn on 127.0.0.1:8000

# Lint / format / typecheck (ruff --fix, mypy, AND pyright — all three must pass)
pixi run tidy                            # format + lint across frontend, core, backend
pixi run lint-core                       # core only; lint-backend for the API package
pixi run -e core-dev pytest .            # run pytest directly when you need flags

# Frontend (run inside the frontend env; there are no pixi wrappers for its tests)
pixi run start-frontend                  # vite dev on :5173, proxies /api/v1 -> :8000
pixi run -e frontend npm test            # vitest (happy-dom + MSW)
pixi run -e frontend npm run test:e2e    # playwright (boots backend + dev server itself)
pixi run -e frontend npm run check       # svelte-check
```

`start-frontend` accepts `metamodel=`, `model=`, `view=` args that autoload files on boot (defaults to the smart-city example).

### Python version gotcha

The runtime is **Python 3.14**, but `pyrightconfig.json` pins the check floor to **3.10**. Don't reach for stdlib features newer than the floor (e.g. import `assert_never`/`Self` from `typing_extensions`, not `typing`) or pyright will fail even though the code runs.

## Architecture — the parts that span files

### Core layering (`src/data_rover/core/`)

- **`metamodel/schema.py` — `Metamodel` is immutable with lazily-built derived caches** (`_Caches`: ancestor chains, effective properties/keys, containment flags, end constraints). Treat it as frozen after load; uploads replace the whole object. If you ever add a mutation path, reset `_cache` to `None` (see `model_copy`). All subtype/effective-property/containment queries go through its cached lookup methods — never re-walk `extends` chains by hand.
- **`model/model.py` — `Model` is the single mutation boundary.** Every create/connect/set_property/delete flows through its methods, which keep `self.indexes` (`IndexSet`, in/out relationship adjacency) in sync. Bulk loaders that populate the dicts directly must call `indexes.rebuild()`. `delete_element` cascades through containment children. Property values are **replaced wholesale, never mutated in place** — the API op-log's inverse patches alias prior values by reference and depend on this.
- **`validation/pipeline.py` — one sweep, many validators.** The pipeline iterates the model (or a `Scope` subset) once and hands each entity to every `Validator` (`type_conformance`, `multiplicity`, `facets`, `endpoint_typing`, `containment`, `uniqueness`). Per-entity hooks must be O(entity) — use metamodel caches and `model.indexes`, not model scans. Whole-model checks go in `validate_global`. Validators carry mutable per-metamodel memo caches (`MetamodelMemo`, identity-keyed), so **construct one pipeline per request/thread**; never share across threads.

### Backend session & the delta protocol (`src/data_rover/api/`)

This is the central design and the thing most likely to surprise you. The model can be **~80 MB**, so the architecture is built to avoid copying it (this is the focus of the `perf/large-model-overhaul` work).

- **`session.py`** holds a single process-wide `Session` (metamodel + model + view + validation baseline + `model_rev` + `op_log`). The **backend session is the source of truth; the client never holds the whole model.**
- **`routes/ops.py` (`POST /model/ops`)** is the mutation path: clients send small op batches (mirroring `frontend/src/lib/state/ops.ts`). Ops are applied **in place** to the live model while inverse ops are collected; a mid-batch failure rolls back by applying inverses in reverse and returns **422**. Each accepted batch bumps `model_rev` once and is appended to `op_log` for undo.
- **Rev conflicts**: clients echo `model_rev` as `base_rev`; a stale batch gets **409** and the client must reload.
- **Undo** (`POST /model/undo`) replays an op-log batch's inverses in restore mode (`Model.restore_element/restore_relationship` reinstate exact ids). `op_log` is capped at `OP_LOG_MAX` (1000 batches); past that, `GET /model/changes` reports `complete: false`.
- **Legacy direct-mutation routes** (`routes/elements.py`, `relationships.py`) bypass the op protocol, so they call `session.touch_model()` to invalidate `op_log`/validation and bump `model_rev`.
- Reads are **paged/on-demand** (element pages, fuzzy search, containment tree children, BFS neighborhoods); load/save **stream** rather than materializing the serialized model as a string.

The frontend mirrors all of this client-side (optimistic ops, serialized flushes, conflict recovery). **`frontend/README.md` documents the frontend architecture in depth — read it before touching `frontend/src/lib/state/`.**

### Migration CLI (`src/data_rover/migration/`, `migration/README.md`)

`python -m data_rover.migration` converts the old JSON metamodel+model format to the new one (stereotype→element type, `owner`→`Owns` containment, `element_type`→`TypedBy`, datatypes inferred from real values). It never raises on invalid output so incomplete inputs stay inspectable; `--remove-inconsistencies` prunes model entities that would block frontend load.

## Conventions

- Tests live in `tests/<area>/` mirroring the source packages (`model`, `metamodel`, `validation`, `view`, `api`, `migration`). `pythonpath=src` is set in `pytest.ini`, so import as `from data_rover.core...`.
- Code in this repo carries dense docstrings explaining *why* invariants exist (immutability, mutation boundary, in-place rollback). Preserve and extend that style when changing those areas — the invariants are load-bearing.
- `docs/superpowers/{plans,specs}/` hold dated design docs (gitignored) that capture the rationale behind major features; consult the matching spec before reworking ops, validation, or the view tree.
