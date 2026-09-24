# CLAUDE.md

Data Rover is a reflective MBSE (Model-Based Systems Engineering) metamodel engine with three stacked data layers:

- **Metamodel** (`*.metamodel.yaml`): element and relationship types, `extends`, typed properties with multiplicity and facets, endpoint `mappings`, uniqueness `key`s.
- **Model** (`*.model.json`): elements and relationships conforming to one metamodel.
- **View** (`*.view.json`): named folder overlays that reference model elements by id and own nothing.

A Python core and FastAPI backend (Postgres, in-memory sessions over a durable commit journal), a SvelteKit frontend, and a TypeScript engine that keeps a full model replica in the browser, hosted in a cross-origin sandbox worker. Example artifacts: `examples/smart-city.*`.

## Where things are documented

This file is the map. How the code works lives in the README next to it; read the one for the area you touch.

| Area | Read |
|---|---|
| Where the system is going: decisions `AD-n`, contracts `CT-n`, constraints `CN-n`, build order `MR-n`. Read before designing or planning anything touching the engine, sync, evaluation, scripts or deployment | `architecture/README.md`, then `architecture/program.md` for what exists yet |
| Repo rules: layout, git, comments, tests (`RC-n`) | `architecture/conventions.md` |
| Python core: metamodel, `Model`, validation pipeline, custom validation rules | `src/data_rover/core/README.md` |
| Backend: sessions, ops and the commit delta, replica routes, tenancy/auth, persistence, locking, feed, tables/exports, metamodel editing | `src/data_rover/api/README.md` |
| Snippets (WASM sandbox) and embedded evaluation | `src/data_rover/core/script/README.md` |
| TypeScript engine | `engine/README.md` |
| Sandbox site and engine worker | `sandbox/README.md` |
| Replica shell (frame, client, sync, surfaces) | `frontend/src/lib/engine/README.md` |
| Frontend architecture and state; **required before touching `frontend/src/lib/state/`** | `frontend/README.md` |
| Legacy-format migration CLI | `migration/README.md` |
| Open items | `BACKLOG.md`, `BACKLOG-ENGINE.md` |

When behaviour changes, update the README that owns it in the same commit (RC-10).

## Commands

Everything runs through **pixi**; there is no global `python` or `node`. Environments: `core`, `core-dev` (lint/test, includes api), `api`, `frontend` (Node 22).

```sh
pixi run dr-test                          # core pytest + frontend, engine and sandbox vitest (not e2e)
pixi run dr-tidy                          # format + lint everywhere; ruff, mypy AND pyright must all pass

# Python
pixi run core-test                        # pytest
pixi run -e core-dev pytest tests/model/test_model.py::test_name
pixi run -e core-dev pytest -k uniqueness
pixi run core-lint                        # core only; backend-lint for the API package
pixi run backend-start                    # uvicorn :8000; needs Postgres + DATA_ROVER_DATABASE_URL, or DATA_ROVER_DEV_SEED with a sqlite DSN
pixi run db-upgrade                       # alembic upgrade head

# Frontend
pixi run frontend-start                   # vite dev :5173, proxies /api/v1 -> :8000
pixi run frontend-test                    # vitest (happy-dom + MSW)
pixi run frontend-check                   # svelte-check
pixi run frontend-test-e2e                # playwright; boots backend, dev server and built sandbox

# Engine / sandbox
pixi run engine-install / sandbox-install # npm install, first time and after dependency changes
pixi run engine-test / engine-check
pixi run sandbox-test / sandbox-check / sandbox-build / sandbox-start
pixi run golden-fixtures                  # regenerate engine/fixtures/golden from the Python core
pixi run engine-bench / engine-bench-browser   # after `pixi run engine-bench-data` once
pixi run engine-parity-large   # engine sweep vs the oracle at M (after engine-bench-data)
```

Gotchas:
- Frontend, engine and sandbox tasks set their own cwd; `pixi run -e frontend npm test` from the repo root fails with "Missing script". Use the tasks.
- e2e reuses a server already on :8000/:5173/:5174. A stale sandbox `vite preview` serves its OLD `dist/`, so stop it first.
- Open the app at `http://127.0.0.1:5173`, not `localhost`: the sandbox is `localhost:5174` and must be a different site (CN-17). On `localhost` the app refuses the engine and reads from the server.
- The snippet runner's WASM guest is fetched by a pixi activation hook (`scripts/ensure_guest.sh`, *sourced*, so never `exit` in it). Without it, snippet routes answer 503.
- Python is 3.14 everywhere (runtime, ruff `py314`, pyright); use modern stdlib freely.

## Rules that span the codebase

- **One mutation boundary per store** (RC-8): Python `Model` (`core/model/model.py`), engine op applier (`engine/src/ops/`). Indexes are maintained there; a bulk loader that fills dicts directly must rebuild them. Property values are replaced wholesale, never mutated in place: the op log's inverse patches alias prior values.
- **`Metamodel` is frozen after load.** Go through its cached lookups; never re-walk `extends` chains by hand.
- **The model can be ~80 MB.** A per-request path never copies or scans it: reads are paged, validator hooks are O(entity) over `model.indexes` and metamodel caches, whole-model work runs as background sweeps. Full `POST /model/validate` runs only from an explicit user click.
- **Validation pipelines carry per-metamodel memos**: build one per request/thread (`api/rules.session_pipeline` when the session's rules apply), never share one.
- **The Python core is the oracle for the engine.** Golden fixtures come from it (`pixi run golden-fixtures`); on a mismatch fix the engine, never the fixture. `tests/golden/test_fixtures_current.py` fails when a committed fixture is stale.
- **The frontend imports the engine as types only** (`import type` from `$engine` / `$sandbox`; ESLint refuses value imports outside tests). Engine `src/` has no DOM or Node dependency and imports with `.ts` specifiers.
- **Wire text reaches the engine as received** (AD-26): feed frames, commit responses and tails are never re-serialized, since `JSON.parse` loses `1.0` and integers past 2^53.
- **Tests run the real engine**, never a mock, and without fake timers; `dispose()` every in-process link or the vitest worker never exits.
- **API tests need no database**: `tests/api/conftest.py` runs in-memory SQLite, pins `DATA_ROVER_IDENTITY_PROVIDER=header`, and provides `client`, `seed_default_project`, `AUTH_HEADERS`, `papi`. Cookie-auth tests opt in with `pytestmark = pytest.mark.usefixtures("cookie_provider")`.
- **Comments and docstrings** are concise, present-tense, only for what the code cannot say; no references to specs, plans or phases, no history (RC-6).
