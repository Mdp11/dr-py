# Unpaged Relationship Lister Removal (K-25) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `GET /model/relationships` — the last API read with no `limit`/`offset` and no cap, which spends 2 423 ms of request CPU and +145 MiB of transient pydantic objects to ship a 29 MiB body at scale 320 — together with its test-only frontend client function, leaving the two paged endpoints that already serve every capability it had.

**Architecture:** This is a deletion, not a port. `api/routes/relationships.py::list_relationships` goes; the sibling `POST /model/relationships` and `DELETE /model/relationships/{id}` (the legacy direct-mutation pair CLAUDE.md keeps for tests and scripts, called by three `tests/api` modules) stay mounted and untouched, so FastAPI answers the now-method-less `GET` with `405 {"detail":"Method Not Allowed"}` — pinned by one test so a future unpaged lister is not re-added by reflex. On the client, `listRelationships`, the `RelationshipFilters` interface and the then-unreferenced `RelationshipListSchema` go, along with the two `__tests__/relationships.test.ts` cases that covered only its query-string builder; `createRelationship`/`deleteRelationship` and the `api` barrel entry stay. A measurement task then pins, at scale 320, that the two replacements (`GET /model/elements/{id}/relationships?direction=out|in` and `POST /model/search` with `target: "relationship"`) return **exactly** the rows the deleted route returned for each of its three filters.

**Tech Stack:** Python 3.14 + FastAPI (backend), TypeScript + vitest/MSW (frontend); pytest and vitest via pixi (`pixi run -e core-dev pytest`, `pixi run frontend-test`). No core, DB, migration or setting change.

**Spec:** `docs/superpowers/specs/2026-08-26-large-model-performance-program.md` (§ "Program" item 7, § "K-25 design" — its spike table is the evidence this plan argues from, and its Non-goals record the decision to delete rather than page). The BACKLOG entry `K-25` (`BACKLOG.md:1117`) carries the owner's item.

## Global Constraints

- Every command goes through **pixi**: single backend test file `pixi run -e core-dev pytest tests/api/test_routes.py -v`; whole backend suite `pixi run core-test`; frontend unit tests `pixi run frontend-test`; lint/format/typecheck `pixi run dr-tidy` (ruff + mypy + pyright + prettier/eslint — all must pass; pyright covers `tests/` too, so no `# type: ignore` shortcuts). Check-only forms `pixi run dr-tidy true` / `pixi run core-tidy true` modify nothing — use those while an implementer is mid-edit. The `[feature.api.activation]` hook prints `[ensure_guest]` lines before every command — ignore them. **Ruff does NOT enforce import ordering** in this repo (`ruff.toml` selects `UP` on top of the E4/E7/E9/F defaults; no isort rules, no `ANN` rules) — do not "fix" import order, do not claim ruff wants it, and do not add a `# noqa: ANN001` (it would be flagged as unused).
- Work on a branch `perf/relationships-lister-removal` off `main` (create it via `superpowers:using-git-worktrees` at execution time; `EnterWorktree` names the branch `worktree-<name>` — `git branch -m perf/relationships-lister-removal` right after entering, and read `git branch --list` before merging because `ExitWorktree` later reports the stale creation name). In a fresh worktree run `pixi run frontend-install` before `dr-tidy` or `frontend-test` (both die otherwise). The repo integrates feature branches into `main` with a merge commit, then pushes (`BACKLOG.md`, Process/infra: pushing `main` is standing policy). **`main` can move under you** — a concurrent session commits to it directly: re-check `git log origin/main` immediately before merging and pushing.
- **Worktree harness guard:** inside a worktree the harness refuses compound Bash (loops, `&&`-chains, heredocs, `$(...)` groups, parenthesised groups, even `${PIPESTATUS[0]}`). Use plain single commands, the Write/Edit tools, or put the logic in a script under the session scratchpad and run `bash <script>` / `pixi run -e core-dev python <script>`. To merge, `ExitWorktree keep` first, then merge from the main checkout and `git worktree remove` the path.
- Comments/docstrings: concise, present tense, only invariants and non-obvious contracts. No spec/plan references, no history narration ("was", "used to", "K-25", "removed in").
- Python 3.14 idioms (`X | Y` unions, `collections.abc` imports).
- `docs/` is gitignored — the spec and this plan are never committed; every other step commits.
- **The K-25 decision (the spec's): delete, do not page.** Do NOT add a `RelationshipPage`-returning lister, do NOT add `limit`/`offset` to the removed route, do NOT add a `relationships_by_type` index to `IndexSet`, and do NOT touch `POST`/`DELETE /model/relationships` or their client wrappers — all four are recorded Non-goals.
- **Nothing in `src/data_rover/core/` changes.** This plan touches only `src/data_rover/api/routes/relationships.py`, `tests/api/test_routes.py`, three frontend files, `CLAUDE.md` and `BACKLOG.md`.
- **K-24 / K-23 / K-22 / K-21 / K-20 / K-6 contracts are untouched** by this plan (it never touches `evaluate.py`, `indexes.py`, `model.py`, the snapshot codec or the journal): `_scope_ids` returns the ascending-id list; `_trigrams_of` entry ⇔ indexed; `element_order` maintained by the two element hooks only; bytes-sniffing snapshot reader; no search index on transient models; `entity_states` NULL = reconstruct.
- Model choices that worked for SDD on K-6 → K-24: **haiku** for transcription tasks carrying the literal code and single-file docs edits (Tasks 1, 2, 4), **sonnet** for the measurement task and the per-task reviews (Task 3, all reviews), the most capable model for the final whole-branch review only. Run the verification suites in the background while a review is pending — never alongside a timing measurement.

**Cross-task test preconditions** (the pre-flight conflict scan; re-check every anchor against the tree before dispatching Task 1):

| Task | Its tests assume | Installed by |
|---|---|---|
| 1 | `tests/api/test_routes.py` exposes the module-level `client` fixture, `API = "/api/v1/projects/default"`, and imports `AUTH_HEADERS`/`seed_default_project` from `.conftest`; `POST /model/relationships` and `DELETE /model/relationships/{id}` remain registered (that is what makes the path match and the method not); a method mismatch on a registered path answers `405 {"detail":"Method Not Allowed"}` (verified against `PUT /model/relationships` on the pre-change tree) | Task 1 itself (all pre-existing) |
| 2 | `frontend/src/lib/api/__tests__/relationships.test.ts` keeps its `createRelationship`/`deleteRelationship` cases and its `server`/`sampleRel` scaffolding; `RelationshipSchema` (not `RelationshipListSchema`) stays exported from `frontend/src/lib/api/types.ts`; `frontend/src/lib/api/index.ts:8` keeps `export * as relationships from './relationships'` | Task 2 itself (all pre-existing); independent of Task 1 |
| 3 | Tasks 1–2 merged into the tree; a scale-320 fixture in the session scratchpad; `data_rover.api.routes._snapshot.build_model_from_dicts`; `examples/smart-city.metamodel.yaml`; `tests/api/conftest.py`'s env pins reproduced in the script | Tasks 1–2 |

---

### Task 1: Delete `GET /model/relationships` and pin the 405

**Files:**
- Modify: `src/data_rover/api/routes/relationships.py:11-26` (delete `list_relationships`)
- Test: `tests/api/test_routes.py` (append one test)

**Interfaces:**
- Consumes: nothing new. The module's existing imports (`APIRouter`, `Depends`, `Response`, `Session`, `get_request_session`, `require_model`, `CreateRelationshipRequest`, `RelationshipOut`) are **all still used** by `create_relationship` and `delete_relationship` after the deletion — do not prune any import line.
- Produces: `GET /api/v1/projects/{project_id}/model/relationships` answers `405`. No other route, schema or signature changes.

- [ ] **Step 1: Write the failing test**

Append to `tests/api/test_routes.py` (after the last test in the file):

```python
def test_relationship_listing_is_paged_only(client: TestClient) -> None:
    """There is no whole-collection relationship read: the incident set comes
    from GET /model/elements/{id}/relationships and a whole-model listing from
    POST /model/search with target="relationship", both paged."""
    res = client.get(f"{API}/model/relationships")
    assert res.status_code == 405, res.text
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_routes.py::test_relationship_listing_is_paged_only -v`

Expected: FAIL with `assert 404 == 405`. That exact red is the point: `404` means the `GET` handler is registered and ran, then `require_metamodel`/`require_model` rejected the bare `client` fixture (which loads no model). A `405` here would mean the handler is already gone — stop and check the tree. Any other status: stop and report.

- [ ] **Step 3: Delete the handler**

In `src/data_rover/api/routes/relationships.py`, delete lines 11–27 — the whole `list_relationships` handler and the blank lines that separated it — so the file reads:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, Response

from ..deps import Session, get_request_session, require_model
from ..schemas import CreateRelationshipRequest, RelationshipOut

router = APIRouter()


@router.post("/model/relationships", status_code=201)
def create_relationship(
    payload: CreateRelationshipRequest,
    session: Session = Depends(get_request_session),
) -> RelationshipOut:
    _, model = require_model(session)
    rel = model.connect(payload.type, payload.source_id, payload.target_id)
    session.touch_model()  # mutation outside the ops protocol
    return RelationshipOut.from_core(rel)


@router.delete("/model/relationships/{relationship_id}", status_code=204)
def delete_relationship(
    relationship_id: str,
    session: Session = Depends(get_request_session),
) -> Response:
    _, model = require_model(session)
    model.disconnect(relationship_id)
    session.touch_model()  # mutation outside the ops protocol
    return Response(status_code=204)
```

Change nothing else in the file. Do not add a docstring or a comment explaining the absence.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_routes.py::test_relationship_listing_is_paged_only -v`

Expected: PASS.

- [ ] **Step 5: Run the modules that touch the sibling routes**

Run: `pixi run -e core-dev pytest tests/api/test_routes.py tests/api/test_ops_route.py tests/api/test_artifacts_routes.py tests/api/test_read_routes.py tests/api/test_search_routes.py -q`

Expected: all pass — those three modules use only `POST`/`DELETE /model/relationships`, and the last two cover the paged replacements.

- [ ] **Step 6: Lint**

Run: `pixi run core-tidy true`

Expected: exit 0, no unused-import finding (every import in the file is still used by the two remaining handlers).

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/routes/relationships.py tests/api/test_routes.py
git commit -m "perf(api): drop the unpaged GET /model/relationships"
```

---

### Task 2: Drop the client's `listRelationships` and its dead schema

**Files:**
- Modify: `frontend/src/lib/api/relationships.ts:1-32` (drop the import of `RelationshipListSchema`, the `RelationshipFilters` interface and `listRelationships`)
- Modify: `frontend/src/lib/api/types.ts:193` (drop `RelationshipListSchema`)
- Test: `frontend/src/lib/api/__tests__/relationships.test.ts:1-51` (drop the import of `listRelationships` and its two cases)

**Interfaces:**
- Consumes: `apiFetch`, `ClientConfig` from `./client`; `RelationshipSchema`, `CreateRelationshipRequest`, `Relationship` from `./types` — all still used by the two remaining functions.
- Produces: `frontend/src/lib/api/relationships.ts` exports exactly `createRelationship` and `deleteRelationship`. `frontend/src/lib/api/index.ts:8`'s `export * as relationships from './relationships'` stays as-is.

- [ ] **Step 1: Delete the two client-side tests**

Replace `frontend/src/lib/api/__tests__/relationships.test.ts` lines 1–51 so the file starts like this (the `createRelationship` and `deleteRelationship` cases from line 53 on stay byte-identical, and the closing `});` stays):

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { createRelationship, deleteRelationship } from '../relationships';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const sampleRel = {
	id: 'r1',
	type_name: 'Conn',
	source_id: 's1',
	target_id: 't1',
	properties: {},
	rev: 1
};

describe('relationships client', () => {
	it('createRelationship POSTs payload and parses Relationship', async () => {
```

- [ ] **Step 2: Confirm the suite is green on the reduced file**

Run: `pixi run frontend-test src/lib/api/__tests__/relationships.test.ts`

Expected: PASS, 2 tests (down from 4). There is no red-first step here — deleting tests cannot fail a suite, so this task's gate is Step 4's grep (nothing else references what Step 3 removes) and Step 5's `frontend-check` (no unresolved import, no unused export). Report the test count.

- [ ] **Step 3: Delete `listRelationships` and the dead schema**

Replace the whole of `frontend/src/lib/api/relationships.ts` with:

```ts
import { apiFetch, type ClientConfig } from './client';
import { RelationshipSchema, type CreateRelationshipRequest, type Relationship } from './types';

export function createRelationship(
	payload: CreateRelationshipRequest,
	cfg?: ClientConfig
): Promise<Relationship> {
	return apiFetch(
		'/model/relationships',
		{ method: 'POST', body: payload, schema: RelationshipSchema },
		cfg
	);
}

export function deleteRelationship(relationshipId: string, cfg?: ClientConfig): Promise<void> {
	return apiFetch(
		`/model/relationships/${encodeURIComponent(relationshipId)}`,
		{ method: 'DELETE' },
		cfg
	);
}
```

In `frontend/src/lib/api/types.ts`, delete the single line

```ts
export const RelationshipListSchema = z.array(RelationshipSchema);
```

leaving the `IssueListSchema` line that follows it and the `MetamodelStructuralDiff` block above it untouched.

- [ ] **Step 4: Verify nothing else referenced them**

Run: `grep -rn "listRelationships\|RelationshipListSchema\|RelationshipFilters" frontend/src frontend/e2e`

Expected: no output. If anything prints, stop and report it — the spec's premise (the function is test-only) is wrong and the task needs re-planning.

- [ ] **Step 5: Run the frontend checks**

Run: `pixi run frontend-test src/lib/api/__tests__/relationships.test.ts`

Expected: PASS, 2 tests.

Run: `pixi run frontend-check`

Expected: exit 0, no unused-export or unresolved-import diagnostics.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api/relationships.ts frontend/src/lib/api/types.ts frontend/src/lib/api/__tests__/relationships.test.ts
git commit -m "refactor(frontend): drop the listRelationships client and its schema"
```

---

### Task 3: Measure and pin the replacements at scale 320

This task produces **no diff** — its deliverable is a report. Its stop-condition table is the review gate.

**Files:**
- Create: `<session scratchpad>/k25_verify.py` (scratchpad only — **never** inside the repo; `docs/` is gitignored but the scratchpad is not in the repo at all)
- Fixture: `<session scratchpad>/prod.model.json`

**Interfaces:**
- Consumes: the merged Tasks 1–2 tree; `data_rover.api.routes._snapshot.build_model_from_dicts(metamodel, raw, strict=False) -> Model`; `data_rover.core.metamodel.loader.load_metamodel_file(path) -> Metamodel`; `IndexSet.outgoing_ids(id) -> Set[str]` / `incoming_ids(id) -> Set[str]`.
- Produces: the numbers Task 4 writes into `BACKLOG.md`.

- [ ] **Step 1: Ensure the fixture exists**

Run (from the repo root, ~1 min, writes ~145 MB):

```bash
pixi run -e core-dev python examples/generate_large_model.py --scale 320 --out <session scratchpad>/prod.model.json
```

Skip if the file is already there. **Never write it into the repo** — no `benchmarks/`, no `examples/`.

- [ ] **Step 2: Write the verification script**

Create `<session scratchpad>/k25_verify.py`:

```python
"""K-25 verification: the paged replacements return exactly the rows the
deleted GET /model/relationships returned, and the removed route is gone."""

from __future__ import annotations

import gc
import json
import os
import time
from pathlib import Path

os.environ.setdefault("DATA_ROVER_DATABASE_URL", "sqlite://")
os.environ.setdefault("DATA_ROVER_DEV_SEED", "false")
os.environ.setdefault("DATA_ROVER_SNAPSHOT_STORE", "memory")
os.environ.setdefault("DATA_ROVER_IDLE_EVICT_SECONDS", "0")
os.environ.setdefault("DATA_ROVER_LOCK_SWEEP_SECONDS", "0")
os.environ.setdefault("DATA_ROVER_VALIDATION_SWEEP_SYNC", "false")
os.environ.setdefault("DATA_ROVER_SEARCH_INDEX_SYNC", "false")
os.environ.setdefault("DATA_ROVER_SNAPSHOT_SYNC", "true")
os.environ.setdefault("DATA_ROVER_IDENTITY_PROVIDER", "header")
os.environ.setdefault("DATA_ROVER_BOOTSTRAP_ADMIN_EMAIL", "")
os.environ.setdefault("DATA_ROVER_BOOTSTRAP_ADMIN_PASSWORD", "")

from fastapi.testclient import TestClient  # noqa: E402

from data_rover.api import db  # noqa: E402
from data_rover.api import db_models  # noqa: E402,F401
from data_rover.api.db_models import Membership, Project, Role, User  # noqa: E402
from data_rover.api.main import create_app  # noqa: E402
from data_rover.api.routes._snapshot import build_model_from_dicts  # noqa: E402
from data_rover.api.session import (  # noqa: E402
    DEFAULT_PROJECT_ID,
    get_session,
    install_persistent_registry,
    reset_session,
)
from data_rover.api.storage import MemorySnapshotStore, set_snapshot_store  # noqa: E402
from data_rover.core.metamodel.loader import load_metamodel_file  # noqa: E402

SCRATCH = Path(__file__).resolve().parent
AUTH = {"x-user-id": "test-user", "x-user-email": "test@example.com"}
BASE = f"/api/v1/projects/{DEFAULT_PROJECT_ID}"


def timed(fn, reps: int = 3) -> tuple[float, object]:
    out, times = None, []
    for _ in range(reps):
        gc.collect()
        t0 = time.perf_counter()
        out = fn()
        times.append((time.perf_counter() - t0) * 1000.0)
    return min(times), out


def page_all(client: TestClient, path: str, params: dict) -> list[dict]:
    """Drain a limit/offset-paged endpoint into one list."""
    rows, offset = [], 0
    while True:
        q = dict(params, limit=500, offset=offset)
        res = client.get(f"{BASE}{path}", params=q, headers=AUTH)
        assert res.status_code == 200, res.text
        body = res.json()
        rows.extend(body["items"])
        offset += 500
        if offset >= body["total"]:
            return rows


def search_all(client: TestClient, criteria: list[dict]) -> list[dict]:
    rows, offset = [], 0
    while True:
        res = client.post(
            f"{BASE}/model/search",
            json={
                "target": "relationship",
                "criteria": criteria,
                "limit": 500,
                "offset": offset,
            },
            headers=AUTH,
        )
        assert res.status_code == 200, res.text
        body = res.json()
        rows.extend(body["relationships"])
        offset += 500
        if offset >= body["total"]:
            return rows


def main() -> None:
    mm = load_metamodel_file("examples/smart-city.metamodel.yaml")
    raw = json.loads((SCRATCH / "prod.model.json").read_text())
    model = build_model_from_dicts(mm, raw, strict=False)
    del raw
    gc.collect()
    rels = model.relationships
    print(f"{len(model.elements)} elements / {len(rels)} relationships")

    db.init_engine("sqlite://")
    db.create_all()
    reset_session()
    set_snapshot_store(MemorySnapshotStore())
    install_persistent_registry()
    gen = db.get_db()
    s = next(gen)
    s.add(User(id="test-user", email="test@example.com"))
    s.add(Project(id=DEFAULT_PROJECT_ID, name="Default Project"))
    s.add(Membership(user_id="test-user", project_id=DEFAULT_PROJECT_ID, role=Role.owner))
    s.commit()
    gen.close()

    session = get_session()
    session.metamodel = mm
    session.model = model

    # pick a busy source, a busy target and the hottest relationship type
    src = max(model.elements, key=lambda e: len(model.indexes.outgoing_ids(e)))
    tgt = max(model.elements, key=lambda e: len(model.indexes.incoming_ids(e)))
    counts: dict[str, int] = {}
    for r in rels.values():
        counts[r.type_name] = counts.get(r.type_name, 0) + 1
    hot_type = max(counts, key=lambda t: counts[t])
    print(f"src={src} out={len(model.indexes.outgoing_ids(src))} "
          f"tgt={tgt} in={len(model.indexes.incoming_ids(tgt))} "
          f"type={hot_type} x{counts[hot_type]}")

    with TestClient(create_app()) as client:
        gone = client.get(f"{BASE}/model/relationships", headers=AUTH)
        print(f"GET /model/relationships -> {gone.status_code} {gone.text[:80]}")

        # what the deleted route WOULD have returned, derived from the model
        want_src = sorted(r.id for r in rels.values() if r.source_id == src)
        want_tgt = sorted(r.id for r in rels.values() if r.target_id == tgt)
        want_type = sorted(r.id for r in rels.values() if r.type_name == hot_type)
        want_all = sorted(rels)

        ms, got = timed(
            lambda: page_all(
                client, f"/model/elements/{src}/relationships", {"direction": "out"}
            ),
            reps=1,
        )
        print(f"source_id replacement: {ms:.1f} ms  match="
              f"{sorted(r['id'] for r in got) == want_src}  n={len(got)}")

        ms, got = timed(
            lambda: page_all(
                client, f"/model/elements/{tgt}/relationships", {"direction": "in"}
            ),
            reps=1,
        )
        print(f"target_id replacement: {ms:.1f} ms  match="
              f"{sorted(r['id'] for r in got) == want_tgt}  n={len(got)}")

        ms, got = timed(
            lambda: search_all(client, [{"kind": "entity_type", "names": [hot_type]}]),
            reps=1,
        )
        print(f"type replacement (drained): {ms:.1f} ms  match="
              f"{sorted(r['id'] for r in got) == want_type}  n={len(got)}")

        ms, got = timed(lambda: search_all(client, []), reps=1)
        print(f"unfiltered replacement (drained): {ms:.1f} ms  match="
              f"{sorted(r['id'] for r in got) == want_all}  n={len(got)}")

        for label, path, params in (
            ("first page, incident set", f"/model/elements/{src}/relationships",
             {"direction": "out", "limit": 100}),
            ("first page, element list", "/model/elements", {"limit": 100}),
        ):
            ms, _ = timed(
                lambda p=path, q=params: client.get(
                    f"{BASE}{p}", params=q, headers=AUTH
                )
            )
            print(f"{label}: {ms:.1f} ms")

        ms, res = timed(
            lambda: client.post(
                f"{BASE}/model/search",
                json={"target": "relationship", "criteria": [], "limit": 100, "offset": 0},
                headers=AUTH,
            )
        )
        print(f"first page, POST /model/search: {ms:.1f} ms total={res.json()['total']}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Run it**

Run: `PYTHONPATH=src pixi run -e core-dev python <session scratchpad>/k25_verify.py`

(The `PYTHONPATH=src` is required — `pythonpath=src` is a `pytest.ini` setting and does not apply to a plain `python` invocation.)

Expect **1–2 minutes**, most of it in the two drained `search_all` calls: `POST /model/search` re-scans the whole relationship dict per page, so 238 720 rows at `limit=500` is ~478 requests (~35 s) and the type filter's 57 600 rows ~116 requests (~8 s). That is the price of a row-for-row check, not a per-page cost the app pays — the app fetches one page. `limit=500` is the exact cap on both endpoints (`read.py::MAX_PAGE_LIMIT` and `search.py::_MAX_LIMIT`); do not raise it, the request 422s.

- [ ] **Step 4: Fill in the stop-condition table**

Report exactly this table with your measured values. Every "Stop if" that trips means **do not proceed to Task 4** — report to the reviewer instead.

| Check | Expected | Stop if |
|---|---|---|
| `GET /model/relationships` | `405 {"detail":"Method Not Allowed"}` | any other status, or a 200 |
| `source_id` replacement matches | `match=True` | `False` — the incident set is not the source-filtered set |
| `target_id` replacement matches | `match=True` | `False` |
| `type` replacement matches | `match=True` | `False` — `EntityTypeCriterion` does not select the same rows |
| unfiltered replacement matches | `match=True`, `n` = the relationship count | `False`, or `n` short of the count |
| first page, incident set | < 20 ms | > 100 ms — the replacement is not cheap and the removal traded a hazard for a cost |
| first page, `POST /model/search` | < 150 ms (the spike saw 71.5 ms) | > 400 ms |
| spike comparison | the removed route's 2 423 ms / 29 MiB body no longer reachable | — |

- [ ] **Step 5: No commit**

This task has no diff. Do not `git add` the script, do not copy it into the repo, do not commit. Hand the table to the reviewer.

---

### Task 4: Docs and backlog

**Files:**
- Modify: `CLAUDE.md` (the "Reads are paged/on-demand" bullet in § "Backend session & the delta protocol")
- Modify: `BACKLOG.md:1117-1122` (the K-25 entry) and `BACKLOG.md:66-70` (the header narrative)

**Interfaces:**
- Consumes: Task 3's stop-condition table (the numbers below are placeholders to overwrite with the measured ones).
- Produces: nothing code-facing.

- [ ] **Step 1: Add the invariant to CLAUDE.md**

Find the bullet in `CLAUDE.md` that begins `- Reads are **paged/on-demand** (element pages, fuzzy search, containment tree children, BFS neighborhoods); load/save **stream** rather than materializing the serialized model as a string.` and insert one sentence right after that first clause, before `Fuzzy element search`:

```
There is no unpaged whole-collection read: a relationship listing is either an
element's incident set (`GET /model/elements/{id}/relationships`, served from the
adjacency index) or `POST /model/search` with `target: "relationship"`, both
`limit`/`offset` paged with an exact `total`; the only O(model) reads left are the
`deprecated=True` `GET /model` / `PUT /model/snapshot` and the streamed
`GET /model/download`.
```

`CLAUDE.md:82` is **one unwrapped line** — the whole bullet, ~1.4 kB, on a single line. Insert the sentence into that same line (as one flowing sentence, no newlines), immediately after `... materializing the serialized model as a string.` and before `Fuzzy element search`. Do not reflow the bullet, do not wrap it, and change nothing else in `CLAUDE.md`.

- [ ] **Step 2: Close the K-25 backlog entry**

Replace `BACKLOG.md`'s K-25 entry (the five lines from `### K-25 · ...` through `Page it or delete it. Last in the program.`) with — substituting your Task 3 numbers for the bracketed ones:

```markdown
### K-25 · `GET /model/relationships` is unpaged · `done` (2026-08-27, perf/relationships-lister-removal) · perf · *2026-08-26*
`routes/relationships.py::list_relationships` materialized every relationship into pydantic
`RelationshipOut`s with no `limit`/`offset` and no cap, applying each of its three filters as a
separate full list scan. At scale 320 (238,720 relationships) one unfiltered call cost
**2,423 ms** end to end, +145 MiB of transient objects and a 29 MiB body — and the pydantic
materialization, not the scan, was 2,112 ms of it, so index-serving the filters would have
removed 11.7 of a 19.8 ms request and left the hazard. Nothing called it: no Python test issued
a GET, and `frontend/src/lib/api/relationships.ts::listRelationships` was imported only by its
own MSW-mocked unit test. Deleted rather than paged — a paged lister would have been a third
relationship-listing surface with no caller, whose `type` filter would still scan. The two
paged endpoints the app does call cover it exactly, verified row-for-row at scale 320:
`GET /model/elements/{id}/relationships?direction=out|in` (the `source_id`/`target_id` filters,
from `IndexSet.outgoing_ids`/`incoming_ids`, [N] ms for the first page) and `POST /model/search`
with `target: "relationship"` (the whole-model listing including `type` as an
`EntityTypeCriterion`, [N] ms for the first page). `POST`/`DELETE /model/relationships` stay
mounted; a test pins the `GET` at 405.
```

- [ ] **Step 3: Record the program as complete in the header narrative**

After the line in `BACKLOG.md` that begins `The 2026-08-27 pass on \`perf/untyped-navigation-scope\` closes K-24`, insert:

```markdown
The 2026-08-27 pass on `perf/relationships-lister-removal` closes K-25 (the unpaged relationship
lister is deleted; the paged replacements cover it row-for-row) and with it the whole large-model
performance program — K-20, K-6, K-21, K-22, K-23, K-24, K-25 all done.
```

- [ ] **Step 4: Verify the anchors moved correctly**

Run: `grep -n "K-25" BACKLOG.md`

Expected: the `done` heading plus the two pre-existing forward references at `BACKLOG.md:58` and `:853` (which read "K-21 → K-25 as the large-model performance program" and "see K-21 → K-25 for the rest of the program") — leave both alone, they are historical narration that stays true.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md BACKLOG.md
git commit -m "docs: no unpaged whole-collection read; backlog K-25 done, program complete"
```

---

### Task 5: Full verification and integration

**Files:** none (verification and merge only).

- [ ] **Step 1: Full backend suite**

Run: `pixi run core-test`

Expected: all pass, the same deselect count as `main` (31 at the last measurement — integration-marked tests). Compare against `main`'s count and report both.

- [ ] **Step 2: Full frontend suite**

Run: `pixi run frontend-test`

Expected: all pass, **two fewer tests** than `main` (the two deleted `listRelationships` cases). Report both counts.

- [ ] **Step 3: Lint, format, typecheck**

Run: `pixi run dr-tidy true`

Expected: exit 0.

- [ ] **Step 4: Confirm nothing references the removed surface**

Run: `grep -rn "listRelationships\|RelationshipListSchema" frontend/src frontend/e2e src tests`

Expected: no output.

Run: `grep -rn "def list_relationships" src`

Expected: no output.

- [ ] **Step 5: Final whole-branch review**

Dispatch the final review on the most capable model over `git diff main...HEAD`. It checks: no core file changed; no import pruned that is still used; the `405` test does not depend on a loaded model; `CLAUDE.md`'s new sentence is accurate about which O(model) reads remain; the BACKLOG numbers match Task 3's table.

- [ ] **Step 6: Merge and push**

Re-check first — `main` may have moved:

```bash
git fetch origin
git log --oneline -3 origin/main
```

Then from the main checkout (`ExitWorktree keep` first if you are in a worktree; read `git branch --list` to confirm the branch's real name, since `ExitWorktree` reports the stale `worktree-` creation name):

```bash
git checkout main
git merge --no-ff perf/relationships-lister-removal -m "Merge branch 'perf/relationships-lister-removal'"
git push origin main
```

The merge commit body carries the final measured numbers from Task 3.

- [ ] **Step 7: Clean up the worktree**

```bash
git worktree remove <worktree path>
git branch -d perf/relationships-lister-removal
```

Leave `.claude/worktrees/feat-metamodel-diagram-editor` alone — it belongs to another session.

---

### Task 6: Closing handoff — the program is complete

**Files:** `~/.claude/handoffs/data-rover-py-<date>-<time>.md` (written by the `handoff` skill).

- [ ] **Step 1: Write the closing handoff**

Use the `handoff` skill. It records the large-model performance program as **complete** — all seven items — with, for each of K-20, K-6, K-21, K-22, K-23, K-24, K-25: its spec design-section heading, its `BACKLOG.md` entry line, its branch name and its merge commit. It also carries forward the unowned residue the K-24 handoff listed (the scope matcher's ~0.8 µs per criterion per element; the ~11 µs per-write floor and the applier's ~15 µs per op; `_rekey`'s `_frozen(properties)` for keyless types; `on_element_deleted`'s redundant `_trigrams_of` write-then-pop; `element_order`'s ~16 MiB per hydrated session; `ENTITY_STATES_MAX` as an entity-count cap; snapshot blob GC; the four tests calling `schedule_periodic_snapshot` without `write_mutex`; the `snapshot_job` row ahead of `models.model_rev` after `touch_model()`; `scripts/bench.py:208`'s pyright note; the validation sweep's ~33 ms per element chunk) as **unowned**, not as the next plan.

- [ ] **Step 2: State plainly that no next plan is chained**

Unlike K-20 → K-24, this handoff hands off nothing. If the owner wants more, the open perf items are K-26 → K-28 (added on `feat/script-column-inputs`) — name them, do not scope them.
