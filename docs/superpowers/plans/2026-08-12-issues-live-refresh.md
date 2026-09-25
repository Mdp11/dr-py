# Issues Panel Live Refresh (F-4 + U-8, F-3 rides along) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Issues panel (and every issue-badge consumer) renders live committed
validation issues — populated on project open, spliced on own commits, refetched on
peer commits / feed reconnect / sweep completion — without ever re-running full-model
validation; the explicit Validate button becomes an origin-tagged *overlay* on top.

**Architecture:** One new cheap backend route `GET /model/issues` reads the session's
already-maintained `ValidationState` under the write mutex. The frontend's existing
(but unconsumed) `_issuesByOwner` map in `model.svelte.ts` becomes the single live
source; `validation.svelte.ts` is reinterpreted as the Validate *overlay* store; a new
tiny `issue-source.ts` module selects `overlay ?? live` for all consumers (panel, tree,
graph, diff drawer, top bar).

**Tech Stack:** FastAPI + pydantic (backend), Svelte 5 runes + zod (frontend),
pytest / vitest.

**Spec:** `docs/superpowers/specs/2026-08-12-issues-live-refresh-design.md` (approved
2026-08-12).

## Global Constraints

- Everything runs through pixi: backend tests `pixi run -e core-dev pytest tests/api/...`,
  frontend tests `pixi run frontend-test` (or `pixi run -e frontend npm run test -- <file>`
  won't work — pixi tasks set cwd=frontend; use `pixi run frontend-test -- <pattern>` if
  supported, otherwise run the full `pixi run frontend-test`).
- `pixi run dr-tidy` (ruff + mypy + pyright + frontend lint) must pass before the final merge.
- BACKLOG.md status flips happen **in the same commit** as the fix (BACKLOG's own rule):
  F-3 in Task 1's commit; F-4 + U-8 in Task 6's commit.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **No push to origin.** Local merge only (repo convention, BACKLOG §10).
- Work in-place on branch `fix/issues-live-refresh` off `main` — no worktree (pixi envs +
  ensure_guest.sh activation hook make worktrees expensive here).
- Do NOT wire `runValidation()`/`validateAll()` into open/commit paths — the whole point
  is to avoid `POST /model/validate`'s full-pipeline run (model can be ~80 MB).
- Frontend rule: `frontend/README.md` documents `frontend/src/lib/state/` — the executor
  of Tasks 3-6 should skim its "State model" section first.
- `docs/superpowers/{plans,specs}/` are gitignored — never `git add` them.

---

### Task 1: Branch + F-3 — `quiet.ts` misses staged view depth

**Files:**
- Modify: `frontend/src/lib/state/quiet.ts` (~line 33)
- Test: `frontend/src/lib/state/__tests__/quiet.test.ts`
- Modify: `BACKLOG.md` (§5 F-3 → `done`)

**Interfaces:**
- Consumes: `getStagedViewDepth()` from `./view-edits.svelte` (already exported, used
  the same way by `unsaved.ts:33`); `stageViewOp(op, label)` + `resetViewEdits()` from
  the same module (test only).
- Produces: `isProjectQuiet()` now has four terms. No signature change.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b fix/issues-live-refresh
```

- [ ] **Step 2: Write the failing test**

Append to `frontend/src/lib/state/__tests__/quiet.test.ts` (imports at top:
add `stageViewOp, resetViewEdits` from `'../view-edits.svelte'`, and add
`resetViewEdits()` to the existing `beforeEach`):

```ts
it('is not quiet with only staged VIEW ops (F-3)', () => {
	expect(isProjectQuiet()).toBe(true);
	stageViewOp({ kind: 'rename_folder', id: 'f1', name: 'New name' }, 'Rename folder');
	expect(isProjectQuiet()).toBe(false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pixi run frontend-test -- quiet`
Expected: the new test FAILS (`isProjectQuiet()` returns `true` after staging) — the
other quiet tests still pass.

- [ ] **Step 4: Fix `quiet.ts`**

Add the import and the fourth term, and extend the docstring's term list with one
bullet in the same style (staged VIEW ops ride the same `POST /commits` batch, so a
revert/rebind invalidates them by the same rev bump as staged model/artifact ops):

```ts
import { getStagedViewDepth } from './view-edits.svelte';
// ...
export function isProjectQuiet(): boolean {
	return (
		getStagedDepth() === 0 &&
		getStagedArtifactDepth() === 0 &&
		getStagedViewDepth() === 0 &&
		!hasModelLocks()
	);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pixi run frontend-test -- quiet`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Flip BACKLOG F-3 to done and commit**

In `BACKLOG.md` §5, change the F-3 heading's `· \`open\` ·` to `· \`done\` ·`.

```bash
git add frontend/src/lib/state/quiet.ts frontend/src/lib/state/__tests__/quiet.test.ts BACKLOG.md
git commit -m "fix(frontend): include staged view depth in the quiet-project predicate (F-3)

A project with only staged view changes reported as quiet, wrongly
enabling history Revert and metamodel Rebind. unsaved.ts already counted
view depth; quiet.ts now agrees.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Backend — `GET /model/issues`

**Files:**
- Modify: `src/data_rover/api/schemas.py` (add `IssueListOut` after `IssueOut`, ~line 133)
- Modify: `src/data_rover/api/routes/validation.py` (new route + cap constant)
- Test: `tests/api/test_issues_route.py` (new file)

**Interfaces:**
- Consumes: `_ensure_validation_seeded(session, model)` from `.ops` (already imported
  in `routes/validation.py`); `ValidationState.all_issues()/counts()`;
  `Session.write_mutex`, `Session.model_rev`; `require_model`, `get_request_session`
  from `..deps`.
- Produces: `GET /api/v1/projects/{pid}/model/issues` →
  `IssueListOut {model_rev: int, issues: list[IssueOut], counts: dict[str, int], truncated: bool}`.
  Constant `ISSUES_RESPONSE_MAX = 5000` in `routes/validation.py`. Task 3's client
  mirrors this shape.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_issues_route.py`:

```python
"""GET /model/issues — cheap read of the session's maintained issue store.

The route must NEVER run the validation pipeline itself on a store-carrying
session (that is the whole point: the Issues panel refreshes without a full
O(model) validate). It snapshots ``session.validation`` under the write mutex.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.routes import validation as validation_routes
from data_rover.api.session import get_session

from .conftest import AUTH_HEADERS, seed_default_project

API = "/api/v1/projects/default"

# Item.name is required (multiplicity 1); creating an Item without it yields
# one multiplicity conformance error owned by the new element.
MM = """
elements:
  - name: Item
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(
        f"{API}/metamodel", content=MM, headers={"content-type": "application/x-yaml"}
    )
    assert res.status_code == 200, res.text
    res = c.post(f"{API}/model", json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text
    return c


def _post_ops(client: TestClient, ops: list[dict]):
    return client.post(
        f"{API}/model/ops",
        json={"base_rev": get_session().model_rev, "ops": ops},
    )


def test_empty_model_returns_empty_list(client: TestClient) -> None:
    res = client.get(f"{API}/model/issues")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["issues"] == []
    assert body["counts"] == {}
    assert body["truncated"] is False
    assert body["model_rev"] == get_session().model_rev


def test_reflects_committed_issue_store_after_ops(client: TestClient) -> None:
    # create an Item WITHOUT the required name -> one conformance error,
    # spliced into the session store by the op path (no full validate).
    res = _post_ops(
        client,
        [{"kind": "create_element", "temp_id": "t1", "type_name": "Item",
          "properties": {}}],
    )
    assert res.status_code == 200, res.text
    new_id = res.json()["id_map"]["t1"]

    body = client.get(f"{API}/model/issues").json()
    assert body["counts"] == {"error": 1}
    assert len(body["issues"]) == 1
    issue = body["issues"][0]
    assert issue["target_ids"][0] == new_id
    assert issue["severity"] == "error"
    assert issue["origin"] == "on_server"
    assert body["model_rev"] == get_session().model_rev


def test_fixing_the_entity_empties_the_store(client: TestClient) -> None:
    res = _post_ops(
        client,
        [{"kind": "create_element", "temp_id": "t1", "type_name": "Item",
          "properties": {}}],
    )
    new_id = res.json()["id_map"]["t1"]
    res = _post_ops(
        client,
        [{"kind": "set_property", "id": new_id, "name": "name", "value": "A"}],
    )
    assert res.status_code == 200, res.text
    body = client.get(f"{API}/model/issues").json()
    assert body["issues"] == []
    assert body["counts"] == {}


def test_truncation_caps_issues_but_not_counts(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(validation_routes, "ISSUES_RESPONSE_MAX", 2)
    ops = [
        {"kind": "create_element", "temp_id": f"t{i}", "type_name": "Item",
         "properties": {}}
        for i in range(3)
    ]
    assert _post_ops(client, ops).status_code == 200
    body = client.get(f"{API}/model/issues").json()
    assert body["truncated"] is True
    assert len(body["issues"]) == 2
    assert body["counts"] == {"error": 3}  # counts stay exact past the cap


def test_membership_enforced(client: TestClient) -> None:
    stranger = {"x-user-id": "stranger", "x-user-email": "s@x.io"}
    res = client.get(f"{API}/model/issues", headers=stranger)
    assert res.status_code == 403
    res = client.get(
        "/api/v1/projects/nope/model/issues", headers=AUTH_HEADERS
    )
    assert res.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_issues_route.py -v`
Expected: FAIL — every test 404s (`GET /model/issues` not routed).

- [ ] **Step 3: Add `IssueListOut` to `schemas.py`**

Directly after the `IssueOut` class (~line 133):

```python
class IssueListOut(BaseModel):
    """Snapshot of the session's maintained issue store (GET /model/issues).

    A cheap read — never a pipeline run: the store is seeded at load/hydrate,
    streamed into by the background sweep, and spliced by every commit.
    ``counts`` is exact even when ``issues`` is truncated, so a client can
    always render true totals.
    """

    model_config = ConfigDict(protected_namespaces=())

    model_rev: int
    issues: list[IssueOut] = Field(default_factory=list)
    counts: dict[str, int] = Field(default_factory=dict)
    truncated: bool = False
```

(`ConfigDict` is already imported in `schemas.py`; the `model_rev` field name trips
pydantic's protected `model_` namespace without it — copy the pattern from
`OpsResponse`.)

- [ ] **Step 4: Add the route to `routes/validation.py`**

Add `IssueListOut` to the existing `..schemas` import. Below the imports:

```python
#: max issues returned by GET /model/issues; counts stay exact past the cap.
#: One flat panel list is the consumer — paging buys nothing (spec, 2026-08-12).
ISSUES_RESPONSE_MAX = 5000
```

Add the route (above `validate_model`, keeping the POST last in the file):

```python
@router.get("/model/issues")
def list_issues(
    session: Session = Depends(get_request_session),
) -> IssueListOut:
    """Snapshot the maintained issue store — the panel's cheap live read.

    Snapshotting happens under the write mutex on purpose: this route is
    called WHILE the background sweep is splicing chunks into
    ``issues_by_owner`` (project open), and ``all_issues()`` iterates that
    dict. The guarded section is a list copy — microseconds.
    """
    _, current = require_model(session)
    state = _ensure_validation_seeded(session, current)
    with session.write_mutex:
        issues = state.all_issues()
        counts = state.counts()
        rev = session.model_rev
    truncated = len(issues) > ISSUES_RESPONSE_MAX
    if truncated:
        issues = issues[:ISSUES_RESPONSE_MAX]
    return IssueListOut(
        model_rev=rev,
        issues=[IssueOut.from_core(i) for i in issues],
        counts=counts,
        truncated=truncated,
    )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_issues_route.py tests/api/test_validate_staged.py tests/api/test_ops_route.py -v`
Expected: PASS (the two neighbor suites guard against regressions in the shared module).

- [ ] **Step 6: Lint and commit**

Run: `pixi run backend-lint` — fix anything it flags.

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/routes/validation.py tests/api/test_issues_route.py
git commit -m "feat(api): GET /model/issues — cheap read of the maintained issue store

Snapshot of session.validation under the write mutex (the sweep splices
chunks under the same mutex), capped at ISSUES_RESPONSE_MAX with exact
counts. Never runs the pipeline on a store-carrying session. First half
of F-4+U-8 (frontend consumption lands next).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — API client + `adoptIssues`/`refetchIssues`/`getLiveIssues` in the model store

**Files:**
- Modify: `frontend/src/lib/api/validation.ts` (add `getModelIssues` + schema)
- Modify: `frontend/src/lib/state/model.svelte.ts`
- Test: `frontend/src/lib/state/__tests__/adopt-issues.test.ts` (new file)

**Interfaces:**
- Consumes: Task 2's wire shape; `IssueSchema`, `IssueCountsSchema` from `$lib/api/types`;
  existing `_issuesByOwner`, `_issueCounts`, `_modelRev`, `addIssueToOwner`,
  `clearIssues` from `./validation.svelte` (today's name; renamed in Task 4).
- Produces (used by Tasks 4-6):
  - `getModelIssues(cfg?): Promise<IssueList>` in `$lib/api/validation` where
    `IssueList = {model_rev: number, issues: Issue[], counts: IssueCounts, truncated: boolean}`.
  - `adoptIssues(issues: Issue[], counts: IssueCounts, modelRev: number, truncated?: boolean): void`
  - `refetchIssues(): Promise<void>` (fetch + adopt, swallows errors)
  - `getLiveIssues(): Issue[]` (flattened `_issuesByOwner`, insertion order)
  - `getIssuesTruncatedTotal(): number | null` (total issue count when the last adopt
    was truncated, else null)

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/state/__tests__/adopt-issues.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as validationApi from '$lib/api/validation';
import type { Issue } from '$lib/api/types';
import {
	adoptIssues,
	adoptSummary,
	applyDelta,
	getIssueCounts,
	getIssuesByOwner,
	getIssuesTruncatedTotal,
	getLiveIssues,
	refetchIssues,
	resetModelStore
} from '../model.svelte';
import { clearIssues, getLastRunAt, setIssues } from '../validation.svelte';

function issue(message: string, owner: string): Issue {
	return { severity: 'error', message, target_ids: [owner], origin: 'on_server' };
}

function summaryAtRev(rev: number): void {
	adoptSummary({
		model_rev: rev,
		element_count: 0,
		relationship_count: 0,
		elements_by_type: {},
		issue_counts: null,
		undo_depth: 0
	});
}

beforeEach(() => {
	resetModelStore();
	clearIssues();
	vi.restoreAllMocks();
});

describe('adoptIssues', () => {
	it('refills the live map and counts', () => {
		summaryAtRev(3);
		adoptIssues([issue('boom', 'e1'), issue('bam', 'e1'), issue('pow', 'e2')], { error: 3 }, 3);
		expect(getIssuesByOwner().get('e1')).toHaveLength(2);
		expect(getIssuesByOwner().get('e2')).toHaveLength(1);
		expect(getLiveIssues()).toHaveLength(3);
		expect(getIssueCounts()).toEqual({ error: 3 });
		expect(getIssuesTruncatedTotal()).toBeNull();
	});

	it('drops a response older than the store rev (race with a commit splice)', () => {
		summaryAtRev(5);
		adoptIssues([issue('current', 'e1')], { error: 1 }, 5);
		adoptIssues([issue('stale', 'e9')], { error: 1 }, 4);
		expect(getLiveIssues()[0].message).toBe('current');
	});

	it('accepts an equal-rev response (sweep splices without a rev bump)', () => {
		summaryAtRev(5);
		adoptIssues([issue('a', 'e1')], { error: 1 }, 5);
		adoptIssues([issue('a', 'e1'), issue('b', 'e2')], { error: 2 }, 5);
		expect(getLiveIssues()).toHaveLength(2);
	});

	it('records the exact total when truncated', () => {
		summaryAtRev(1);
		adoptIssues([issue('a', 'e1')], { error: 40, warning: 2 }, 1, true);
		expect(getIssuesTruncatedTotal()).toBe(42);
	});

	it('clears the Validate overlay (committed truth moved)', () => {
		summaryAtRev(1);
		setIssues([issue('snapshot', 'e1')]);
		expect(getLastRunAt()).not.toBeNull();
		adoptIssues([], {}, 1);
		expect(getLastRunAt()).toBeNull();
	});
});

describe('applyDelta clears the Validate overlay', () => {
	it('a commit delta invalidates the staged snapshot', () => {
		summaryAtRev(1);
		setIssues([issue('snapshot', 'e1')]);
		applyDelta({
			model_rev: 2,
			id_map: {},
			changed_elements: [],
			changed_relationships: [],
			deleted_element_ids: [],
			deleted_relationship_ids: [],
			issues_removed_owner_ids: [],
			issues_added: [],
			issue_counts: {}
		});
		expect(getLastRunAt()).toBeNull();
	});
});

describe('refetchIssues', () => {
	it('fetches GET /model/issues and adopts the result', async () => {
		summaryAtRev(1);
		vi.spyOn(validationApi, 'getModelIssues').mockResolvedValue({
			model_rev: 1,
			issues: [issue('fetched', 'e1')],
			counts: { error: 1 },
			truncated: false
		});
		await refetchIssues();
		expect(getLiveIssues()[0].message).toBe('fetched');
		expect(getIssueCounts()).toEqual({ error: 1 });
	});

	it('swallows fetch errors and keeps the current map', async () => {
		summaryAtRev(1);
		adoptIssues([issue('kept', 'e1')], { error: 1 }, 1);
		vi.spyOn(validationApi, 'getModelIssues').mockRejectedValue(new Error('down'));
		await refetchIssues();
		expect(getLiveIssues()[0].message).toBe('kept');
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run frontend-test -- adopt-issues`
Expected: FAIL — `adoptIssues`, `getLiveIssues`, `getIssuesTruncatedTotal`,
`refetchIssues`, `getModelIssues` are not exported.

- [ ] **Step 3: Add `getModelIssues` to `lib/api/validation.ts`**

Follow the `model-status.ts` pattern (schema local to the api module). Add imports
`z` from `'zod'` and `IssueCountsSchema, IssueSchema` to the existing types import:

```ts
/** GET /model/issues — snapshot of the server's maintained issue store.
 * Cheap by contract (never a pipeline run); `counts` is exact even when
 * `issues` is truncated at the server-side cap. */
export const IssueListOutSchema = z.object({
	model_rev: z.number().int(),
	issues: z.array(IssueSchema).default([]),
	counts: IssueCountsSchema.default({}),
	truncated: z.boolean().default(false)
});
export type IssueList = z.infer<typeof IssueListOutSchema>;

export function getModelIssues(cfg?: ClientConfig): Promise<IssueList> {
	return apiFetch('/model/issues', { method: 'GET', schema: IssueListOutSchema }, cfg);
}
```

- [ ] **Step 4: Add the store functions to `model.svelte.ts`**

Imports: extend the existing `'../api/validation'` import with `getModelIssues`;
add `import { clearIssues } from './validation.svelte';` (no cycle:
`validation.svelte.ts` imports only types).

State, next to `_issueCounts` (~line 104):

```ts
/** Exact total issue count when the last adoptIssues() was truncated at the
 * server cap; null when the live map is complete. Rendered by IssuesPanel. */
let _issuesTruncatedTotal: number | null = $state(null);
```

Getters, next to `getIssuesByOwner()` (~line 181):

```ts
/** The live committed issue list: `_issuesByOwner` flattened in insertion
 * order (deterministic — mirrors the server store's owner ordering). */
export function getLiveIssues(): Issue[] {
	const out: Issue[] = [];
	for (const issues of _issuesByOwner.values()) out.push(...issues);
	return out;
}

export function getIssuesTruncatedTotal(): number | null {
	return _issuesTruncatedTotal;
}
```

Adoption, next to `validateAll()` (~line 995):

```ts
/**
 * Adopt a committed-issue snapshot (GET /model/issues, rebind response) as
 * the live store. Ignores a response STRICTLY older than the cached rev (it
 * lost a race with a commit splice; the next delta or refetch heals) —
 * equal-rev responses are adopted because the background sweep grows the
 * server store WITHOUT bumping model_rev. Clears the Validate overlay:
 * committed truth moved, so any staged snapshot is moot.
 */
export function adoptIssues(
	issues: Issue[],
	counts: IssueCounts,
	modelRev: number,
	truncated = false
): void {
	if (modelRev < _modelRev) return;
	_issuesByOwner.clear();
	for (const issue of issues) addIssueToOwner(issue);
	_issueCounts = counts;
	if (_summary !== null) _summary = { ..._summary, issue_counts: counts };
	_issuesTruncatedTotal = truncated
		? Object.values(counts).reduce((a, b) => a + b, 0)
		: null;
	clearIssues();
}

/** Fetch GET /model/issues and adopt it. Best-effort by contract: every
 * caller is a background refresh (boot, peer commit, sweep completion,
 * feed reconnect) where a miss just means the next event heals. */
export async function refetchIssues(): Promise<void> {
	try {
		const res = await getModelIssues(_clientConfig);
		adoptIssues(res.issues, res.counts, res.model_rev, res.truncated);
	} catch {
		// keep the current map; the next commit delta or refetch heals
	}
}
```

In `applyDelta` (~line 415, right after the `issues_removed_owner_ids`/`issues_added`
splice loops), clear the overlay:

```ts
	clearIssues(); // committed truth moved; any Validate snapshot is moot
```

In `resetModelStore()` (~line 1025), add `_issuesTruncatedTotal = null;` next to
`_issueCounts = null;`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run frontend-test -- adopt-issues`
Expected: PASS. Then run the neighbor suites that exercise `applyDelta`:
`pixi run frontend-test -- model-store realtime checkout` — expected PASS (the added
`clearIssues()` is a no-op when nothing was set).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api/validation.ts frontend/src/lib/state/model.svelte.ts frontend/src/lib/state/__tests__/adopt-issues.test.ts
git commit -m "feat(frontend): adoptIssues/refetchIssues — live committed-issue store

GET /model/issues client + adoption into the existing _issuesByOwner map
(stale-rev guard, truncation total, overlay clear). applyDelta now clears
the Validate overlay: committed truth moved. No consumer changes yet.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend — overlay semantics + `issue-source.ts` + consumer sweep

**Files:**
- Modify: `frontend/src/lib/state/validation.svelte.ts` (overlay reinterpretation)
- Create: `frontend/src/lib/state/issue-source.ts`
- Modify: `frontend/src/lib/state/model.svelte.ts` (`validateAll` stops mutating)
- Modify: `frontend/src/lib/state/validate-action.ts` (rename call sites)
- Modify: `frontend/src/lib/state/index.ts` (exports)
- Modify (consumer sweep, `getIssues()` → `getEffectiveIssues()`):
  `frontend/src/lib/components/TopBar.svelte:68`,
  `frontend/src/lib/components/Workspace/GraphView.svelte:141`,
  `frontend/src/lib/components/DiffDrawer.svelte:168`,
  `frontend/src/lib/components/Sidebar/ContainmentTree.svelte:705`,
  `frontend/src/lib/components/Workspace/IssuesPanel.svelte:19` (minimal — full
  two-mode UI is Task 6), and check
  `frontend/src/lib/components/Inspector/RelationshipsList.svelte:36` (it builds
  `indexIssues(all)` — if `all` comes from `getIssues()`, switch it too)
- Test: `frontend/src/lib/state/__tests__/issue-source.test.ts` (new),
  `frontend/src/lib/state/__tests__/validate-staged.test.ts` (update)

**Interfaces:**
- Consumes: Task 3's `getLiveIssues()`; existing `getIssues`/`setIssues`/`clearIssues`
  from `validation.svelte.ts`.
- Produces:
  - `validation.svelte.ts`: `_issues: Issue[]` becomes `_overlay: Issue[] | null = null`.
    Renames: `getIssues() → getOverlay(): readonly Issue[] | null`,
    `setIssues() → setOverlay(issues: Issue[])`, `clearIssues() → clearOverlay()`.
    `getLastRunAt`/`isRunning`/`getLastError`/`setRunning`/`setLastError` unchanged.
    `clearOverlay()` sets `_overlay = null` and `_lastRunAt = null` (keeps `_lastError`
    — a failed Validate's error strip must survive a peer commit).
  - `issue-source.ts`: `getEffectiveIssues(): readonly Issue[]` =
    `getOverlay() ?? getLiveIssues()`. (A module of its own because it imports BOTH
    stores; putting it in either one would create the model↔validation cycle F-7 warns
    about.)
  - `validateAll()` in `model.svelte.ts` no longer mutates `_issuesByOwner`/`_issueCounts`
    — it only fetches and returns the origin-tagged list. StatusBar therefore always
    shows committed counts (approved behavior change).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/state/__tests__/issue-source.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Issue } from '$lib/api/types';
import { getEffectiveIssues } from '../issue-source';
import { adoptIssues, adoptSummary, resetModelStore } from '../model.svelte';
import { clearOverlay, setOverlay } from '../validation.svelte';

function issue(message: string, origin: Issue['origin'] = 'on_server'): Issue {
	return { severity: 'error', message, target_ids: ['e1'], origin };
}

beforeEach(() => {
	resetModelStore();
	clearOverlay();
	adoptSummary({
		model_rev: 1,
		element_count: 0,
		relationship_count: 0,
		elements_by_type: {},
		issue_counts: null,
		undo_depth: 0
	});
});

describe('getEffectiveIssues', () => {
	it('serves the live map when no overlay is set', () => {
		adoptIssues([issue('live')], { error: 1 }, 1);
		expect(getEffectiveIssues().map((i) => i.message)).toEqual(['live']);
	});

	it('an explicit Validate overlay wins over the live map', () => {
		adoptIssues([issue('live')], { error: 1 }, 1);
		setOverlay([issue('staged', 'uncommitted'), issue('gone', 'resolved')]);
		expect(getEffectiveIssues().map((i) => i.message)).toEqual(['staged', 'gone']);
	});

	it('adopting committed truth clears the overlay back to live', () => {
		setOverlay([issue('staged', 'uncommitted')]);
		adoptIssues([issue('live')], { error: 1 }, 1);
		expect(getEffectiveIssues().map((i) => i.message)).toEqual(['live']);
	});

	it('an EMPTY overlay is still an overlay (clean staged validate)', () => {
		adoptIssues([issue('live')], { error: 1 }, 1);
		setOverlay([]);
		expect(getEffectiveIssues()).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run frontend-test -- issue-source`
Expected: FAIL — `../issue-source` does not exist, `setOverlay`/`clearOverlay` not exported.

- [ ] **Step 3: Rework `validation.svelte.ts` into the overlay store**

Replace the whole file body (keep the module small — this is its entire job):

```ts
import type { Issue } from '$lib/api/types';

/**
 * The Validate OVERLAY store (F-4/U-8 redesign, spec 2026-08-12).
 *
 * The live committed issue list lives in model.svelte.ts (`_issuesByOwner`,
 * fed by open-time adoption, commit-delta splices, and refetches). This store
 * holds only the origin-tagged snapshot of the last EXPLICIT Validate run —
 * the one view that can show 'uncommitted' and 'resolved' issues, because it
 * validated the staged (uncommitted) edits. `null` means "no overlay": render
 * live. Any adoption of committed truth clears it (see adoptIssues/applyDelta
 * in model.svelte.ts) — the stage it described no longer matches reality.
 */
let _overlay: Issue[] | null = $state(null);
let _lastRunAt: number | null = $state(null);
let _running: boolean = $state(false);
let _lastError: string | null = $state(null);

export function getOverlay(): readonly Issue[] | null {
	return _overlay;
}

export function getLastRunAt(): number | null {
	return _lastRunAt;
}

export function isRunning(): boolean {
	return _running;
}

export function getLastError(): string | null {
	return _lastError;
}

export function setOverlay(issues: Issue[]): void {
	_overlay = issues;
	_lastRunAt = Date.now();
	_lastError = null;
}

export function setRunning(b: boolean): void {
	_running = b;
}

export function setLastError(message: string | null): void {
	_lastError = message;
}

/** Drop the overlay (committed truth moved / project reset). Keeps
 * `_lastError`: a failed Validate's error strip must survive a peer commit. */
export function clearOverlay(): void {
	_overlay = null;
	_lastRunAt = null;
}
```

- [ ] **Step 4: Create `issue-source.ts`**

```ts
/**
 * The ONE selector every issue consumer reads (panel, containment tree,
 * graph, diff drawer, top bar): the origin-tagged Validate overlay when one
 * is active, else the live committed issue list. Its own module because it
 * imports BOTH stores — folding it into either would create the
 * model ↔ validation import cycle (see F-7 for why cycles bite here).
 */
import type { Issue } from '$lib/api/types';
import { getLiveIssues } from './model.svelte';
import { getOverlay } from './validation.svelte';

export function getEffectiveIssues(): readonly Issue[] {
	return getOverlay() ?? getLiveIssues();
}
```

- [ ] **Step 5: Update all callers**

- `model.svelte.ts`: change the `clearIssues` import to `clearOverlay` (two call
  sites: `adoptIssues`, `applyDelta`). Then simplify `validateAll()` (~line 995) —
  it no longer mutates the map or counts; update its docstring accordingly (it is
  now a pure fetch of the origin-tagged list; the caller stores it as the overlay):

```ts
export async function validateAll(): Promise<Issue[]> {
	const staged = getStagedOps();
	const options = staged.length > 0 ? { ops: staged, baseRev: _modelRev } : undefined;
	return validateModel(options, _clientConfig);
}
```

- `validate-action.ts`: import `setOverlay` instead of `setIssues`; the call becomes
  `setOverlay(issues)`. Everything else unchanged.
- `state/index.ts`: re-export `getOverlay, setOverlay, clearOverlay` (replacing
  `getIssues, setIssues, clearIssues`) and add
  `export { getEffectiveIssues } from './issue-source';` plus
  `getLiveIssues, getIssuesTruncatedTotal, adoptIssues, refetchIssues` from
  `./model.svelte`.
- Consumer sweep — replace `getIssues` with `getEffectiveIssues` (imported from
  `$lib/state`) in: `TopBar.svelte:68`, `GraphView.svelte:141`, `DiffDrawer.svelte:168`,
  `ContainmentTree.svelte:705`, and `IssuesPanel.svelte:19` (just the import + the
  `modelIssues` derivation for now — the two-mode UI is Task 6). Check
  `RelationshipsList.svelte:36`: if its `all` input is `getIssues()`-sourced, switch
  it the same way.
- Test sweep: `validate-staged.test.ts` asserts `validateAll` mutates
  `_issuesByOwner`/counts — rewrite those assertions to expect NO mutation (counts
  keep their committed value) and move origin-handling assertions to the overlay
  (`setOverlay` via `runValidation`). `IssuesPanel.origin.test.ts` and any other test
  importing `setIssues`/`clearIssues` switch to `setOverlay`/`clearOverlay` (grep
  `setIssues\|clearIssues\|getIssues` under `frontend/src` and fix every hit —
  including `validate-action` tests if present).

- [ ] **Step 6: Run tests to verify they pass**

Run: `pixi run frontend-test`
Expected: PASS across the suite (this task touches wide surface — run everything).
Also run `pixi run frontend-check` (svelte-check) — the renames must leave no
dangling imports.

- [ ] **Step 7: Commit**

```bash
git add -A frontend/src
git commit -m "refactor(frontend): single issue source — live map + Validate overlay

validation.svelte.ts becomes the origin-tagged overlay store (null = live);
issue-source.ts selects overlay ?? live for every consumer (panel, tree,
graph, diff, top bar). validateAll() is now a pure fetch — the StatusBar
always shows committed counts. Groundwork for F-4+U-8.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Frontend — refetch wiring (boot, sweep, peer commits, reconnect, rebind)

**Files:**
- Modify: `frontend/src/routes/p/[projectId]/+page.svelte` (boot seed)
- Modify: `frontend/src/lib/state/open-progress.svelte.ts:60` (sweep completion)
- Modify: `frontend/src/lib/state/realtime.svelte.ts` (peer commit debounce + snapshot resync)
- Modify: `frontend/src/lib/components/Metamodel/MetamodelTab.svelte` (rebind adoption)
- Test: `frontend/src/lib/state/__tests__/realtime.test.ts` (extend),
  `frontend/src/lib/state/__tests__/open-progress.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3's `refetchIssues()` and `adoptIssues()`; existing `handleFeedEvent`,
  `trackOpenProgress`, `boot()`, `onRebind()`; `Rebind` response fields
  `model_rev`/`issue_counts`/`issues` (`RebindSchema`, `types.ts:357`).
- Produces: `scheduleIssuesRefetch()` (module-private in `realtime.svelte.ts`,
  300 ms debounce) — exported as `_scheduleIssuesRefetchForTest` only if the test
  needs direct access (prefer driving it via `handleFeedEvent`).

- [ ] **Step 1: Write the failing tests**

In `realtime.test.ts`, add (mirror the file's existing fixtures for feed events —
reuse its `handleFeedEvent` helpers and `vi.useFakeTimers()` conventions; mock
`$lib/api/validation`'s `getModelIssues` with `vi.spyOn`):

```ts
describe('issue refetch triggers', () => {
	it('a peer commit event schedules ONE debounced GET /model/issues', async () => {
		vi.useFakeTimers();
		const spy = vi.spyOn(validationApi, 'getModelIssues').mockResolvedValue({
			model_rev: 2,
			issues: [],
			counts: {},
			truncated: false
		});
		handleFeedEvent(commitEvent({ rev: 2 })); // reuse/extend the file's commit-event builder
		handleFeedEvent(commitEvent({ rev: 3 }));
		expect(spy).not.toHaveBeenCalled(); // debounced, not immediate
		await vi.advanceTimersByTimeAsync(350);
		expect(spy).toHaveBeenCalledTimes(1); // two events, one refetch
		vi.useRealTimers();
	});

	it('a feed snapshot (reconnect) schedules a refetch too', async () => {
		vi.useFakeTimers();
		const spy = vi.spyOn(validationApi, 'getModelIssues').mockResolvedValue({
			model_rev: 0,
			issues: [],
			counts: {},
			truncated: false
		});
		handleFeedEvent({ type: 'snapshot', model_rev: 0, locks: [], connected: [] });
		await vi.advanceTimersByTimeAsync(350);
		expect(spy).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});
});
```

In `open-progress.test.ts`, extend the existing "refreshes the summary after the
sweep" style test (the file already mocks `getModelStatus` sequences): assert that
when the poll loop saw work, `getModelIssues` was called once after the final
`ready` poll (spy the same way as `getModelSummary` is spied there).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run frontend-test -- realtime open-progress`
Expected: the new tests FAIL (no refetch scheduled anywhere).

- [ ] **Step 3: Wire `realtime.svelte.ts`**

Import `refetchIssues` from `./model.svelte`. Add module state + helper near the
other module-level `let`s:

```ts
// Debounce for issue refetches: peer commits and reconnect snapshots can
// arrive in bursts; the GET is cheap but one call per burst is enough. The
// refetch corrects what the synthesized peer-commit delta below cannot know
// (the feed event carries no issue delta — by design, see the spec).
let _issuesRefetchTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIssuesRefetch(): void {
	if (_issuesRefetchTimer !== null) clearTimeout(_issuesRefetchTimer);
	_issuesRefetchTimer = setTimeout(() => {
		_issuesRefetchTimer = null;
		void refetchIssues();
	}, 300);
}
```

Call sites inside `handleFeedEvent`:
- `case 'snapshot'`: add `scheduleIssuesRefetch();` (unconditional — the sweep grows
  the server store WITHOUT bumping `model_rev`, so the `e.model_rev > getModelRev()`
  guard used for the summary refresh would wrongly skip it; the extra call after a
  clean reconnect is one cheap debounced GET).
- `case 'commit'`: after the existing `applyDelta(delta)`, add
  `scheduleIssuesRefetch();`. Leave the synthesized delta exactly as-is (its empty
  issue arrays + stale counts are now corrected 300 ms later by the refetch).
- In `resetRealtime()` (find it in the same file), clear the timer:
  `if (_issuesRefetchTimer !== null) { clearTimeout(_issuesRefetchTimer); _issuesRefetchTimer = null; }`

- [ ] **Step 4: Wire boot + sweep completion**

- `+page.svelte` `boot()`: right after the `await refreshSummary()` try-block
  succeeds (i.e. immediately after that `try { await refreshSummary(); } catch { return; }`),
  add `void refetchIssues();` (fire-and-forget, best-effort like `loadArtifacts`).
  Import `refetchIssues` alongside the existing `$lib/state` imports.
- `open-progress.svelte.ts` line 60: extend the post-sweep refresh:

```ts
	// issue counts (and possibly the model itself) landed while we watched
	if (sawWork) {
		await refreshSummary().catch(() => {});
		await refetchIssues();
	}
```

(import `refetchIssues` next to the existing `refreshSummary` import).

- [ ] **Step 5: Wire the rebind handler**

`MetamodelTab.svelte` `onRebind()`: replace `setIssues(res.issues.map(toIssue))` with

```ts
			adoptIssues(res.issues.map(toIssue), res.issue_counts, res.model_rev);
```

Import `adoptIssues` from `$lib/state` (drop the `setIssues`/`setOverlay` import if
now unused). Keep the surrounding `fetchMetamodel`/`refreshSummary` flow untouched.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pixi run frontend-test -- realtime open-progress checkout metamodel`
Expected: PASS. Then the full `pixi run frontend-test` — expected PASS.

- [ ] **Step 7: Commit**

```bash
git add -A frontend/src
git commit -m "feat(frontend): refetch live issues on boot, peer commits, reconnect, sweep end, rebind

Boot seeds the live map from GET /model/issues; peer commit events and
reconnect snapshots schedule one debounced refetch (the feed carries no
issue delta by design); the open status-poll loop refetches when the
background sweep finishes; rebind adopts its response's full issue list.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Frontend — IssuesPanel two modes + truncation notice + BACKLOG flip

**Files:**
- Modify: `frontend/src/lib/components/Workspace/IssuesPanel.svelte`
- Test: `frontend/src/lib/components/__tests__/IssuesPanel.origin.test.ts` (extend),
  new `frontend/src/lib/components/__tests__/IssuesPanel.live.test.ts`
- Modify: `BACKLOG.md` (§4 U-8 → `done`, §5 F-4 → `done`)

**Interfaces:**
- Consumes: `getEffectiveIssues` (Task 4), `getOverlay`, `getLastRunAt`, `isRunning`,
  `getLastError` from `$lib/state`; `getIssuesTruncatedTotal`, `getLiveIssues` (Task 3);
  existing `runValidation`, `getViewWarnings`.
- Produces: final user-facing behavior — panel populated on open, fresh after every
  commit; Validate = overlay with today's origin UI.

- [ ] **Step 1: Write the failing tests**

Create `IssuesPanel.live.test.ts` (mirror `IssuesPanel.origin.test.ts`'s
mount/flushSync/afterEach conventions, including the `validate-action` mock):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import IssuesPanel from '../Workspace/IssuesPanel.svelte';
import { clearOverlay, setOverlay } from '$lib/state/validation.svelte';
import { adoptIssues, adoptSummary, resetModelStore } from '$lib/state/model.svelte';
import type { Issue } from '$lib/api/types';

vi.mock('$lib/state/validate-action', () => ({
	runValidation: vi.fn(async () => {})
}));

afterEach(() => {
	document.body.innerHTML = '';
	clearOverlay();
	resetModelStore();
	vi.clearAllMocks();
});

function boot(rev = 1): void {
	adoptSummary({
		model_rev: rev,
		element_count: 0,
		relationship_count: 0,
		elements_by_type: {},
		issue_counts: {},
		undo_depth: 0
	});
}

function issue(message: string, owner: string): Issue {
	return { severity: 'error', message, target_ids: [owner], origin: 'on_server' };
}

describe('IssuesPanel live mode', () => {
	it('renders live issues with no origin filter row and no "Not validated yet"', () => {
		boot();
		adoptIssues([issue('live boom', 'e1')], { error: 1 }, 1);
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();
		const text = document.body.textContent ?? '';
		expect(text).toContain('live boom');
		expect(text).not.toContain('Not validated yet');
		expect(text).not.toContain('On server'); // origin filter row hidden in live mode
		unmount(c);
	});

	it('renders "No issues" (not the not-validated empty state) when the live map is clean', () => {
		boot();
		adoptIssues([], {}, 1);
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();
		expect(document.body.textContent).toContain('No issues');
		expect(document.body.textContent).not.toContain('Not validated yet');
		unmount(c);
	});

	it('shows the truncation notice when the server capped the list', () => {
		boot();
		adoptIssues([issue('a', 'e1')], { error: 5001 }, 1, true);
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();
		expect(document.body.textContent).toMatch(/showing first .* of 5001/i);
		unmount(c);
	});

	it('an overlay brings back the origin UI, and clearing it returns to live', () => {
		boot();
		adoptIssues([issue('live boom', 'e1')], { error: 1 }, 1);
		setOverlay([
			{ severity: 'error', message: 'staged boom', target_ids: ['e2'], origin: 'uncommitted' }
		]);
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();
		expect(document.body.textContent).toContain('staged boom');
		expect(document.body.textContent).toContain('last run'); // overlay header
		clearOverlay();
		flushSync();
		expect(document.body.textContent).toContain('live boom');
		expect(document.body.textContent).not.toContain('last run');
		unmount(c);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run frontend-test -- IssuesPanel`
Expected: the new live-mode tests FAIL (panel still keys everything off `lastRunAt`);
`IssuesPanel.origin.test.ts` must still PASS (overlay mode is unchanged).

- [ ] **Step 3: Rework the panel**

In `IssuesPanel.svelte`'s script:

```ts
	const overlay = $derived(getOverlay());
	const overlayMode = $derived(overlay !== null);
	const modelIssues = $derived(getEffectiveIssues());
	const truncatedTotal = $derived(getIssuesTruncatedTotal());
```

(keep `viewWarnings` and the `issues = [...modelIssues, ...viewWarnings]` merge).
Template changes, semantics only — keep every existing class/snippet:

- Header: `{#if overlayMode}` keeps today's "last run …" line + origin-aware summary;
  live mode renders the same errors/warnings counts but no "last run" line and no
  "Not validated yet" branch (live mode ALWAYS has content once a project is open;
  before `adoptIssues` ever ran, `getLiveIssues()` is `[]`, which renders "No issues" —
  acceptable for the sub-second boot window).
- Body: the `lastRunAt === null` "Not yet validated" empty state is only reachable in
  overlay mode — in live mode replace that branch with the plain
  `issues.length === 0 → "No issues"` case (drop the "(validated … ago)" suffix in
  live mode).
- The origin filter row renders `{#if overlayMode}` only. In live mode `filter` is
  forced to `'all'` (reset it in an `$effect` when `overlayMode` flips false, so a
  user parked on "Fixed" never strands the live view).
- Truncation notice, above the sections, live mode only:

```svelte
	{#if !overlayMode && truncatedTotal !== null}
		<p class="mb-2 text-[10px] text-muted-foreground">
			Showing first {issues.length - viewWarnings.length} of {truncatedTotal} issues.
		</p>
	{/if}
```

- The Re-run button stays as-is in both modes (it produces an overlay).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run frontend-test -- IssuesPanel StatusBar`
Expected: PASS (both new and existing; StatusBar suite guards the counts projection).

- [ ] **Step 5: Flip BACKLOG and commit**

In `BACKLOG.md`: §4 U-8 heading `· \`open\`` → `· \`done\``; §5 F-4 heading
`· \`open\` ·` → `· \`done\` ·`.

```bash
git add frontend/src/lib/components/Workspace/IssuesPanel.svelte frontend/src/lib/components/__tests__ BACKLOG.md
git commit -m "feat(frontend): IssuesPanel live mode — populated on open, fresh after commits (F-4, U-8)

The panel renders the live committed issue map by default (no origin
chrome, truncation notice when server-capped); an explicit Validate
overlays the origin-tagged staged snapshot exactly as before. Closes the
panel-vs-StatusBar disagreement at the root: one source, two projections.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Full verification + finish the branch

**Files:** none new.

- [ ] **Step 1: Full test + lint sweep**

Run, in order, expecting each to pass clean:

```bash
pixi run core-test
pixi run frontend-test
pixi run frontend-check
pixi run dr-tidy
```

If `dr-tidy` reformats anything, commit the formatting as
`style: dr-tidy formatting` (with the Co-Authored-By trailer).

- [ ] **Step 2: Manual smoke (optional but recommended)**

With docker compose services up: `pixi run backend-start` + `pixi run frontend-start`,
open a project → Issues tab shows content immediately; commit an edit that introduces
a conformance error → panel updates without clicking Validate; click Validate with a
staged fix → overlay shows "fixed" rows; commit → overlay clears back to live.

- [ ] **Step 3: Finish the branch**

Invoke `superpowers:finishing-a-development-branch`: merge `fix/issues-live-refresh`
into `main` locally (no push — repo convention), delete the branch.

---

## Self-Review (done at plan-writing time)

- **Spec coverage**: route+cap+mutex (Task 2), adoption/stale-guard/overlay-clear
  (Task 3), single-source + overlay + validateAll change + consumer sweep (Task 4),
  all four refetch triggers + rebind (Task 5), panel two-mode UX + truncation +
  BACKLOG (Task 6), error handling embedded in refetchIssues/tests, F-3 (Task 1). ✓
- **Type consistency**: `adoptIssues(issues, counts, modelRev, truncated?)` used
  identically in Tasks 3/5/6; `getEffectiveIssues`/`getOverlay`/`setOverlay`/
  `clearOverlay` names consistent across Tasks 4/6; `IssueListOut` wire fields match
  `IssueListOutSchema`. ✓
- **Known judgment calls for the executor**: exact placement of the `overlayMode`
  branches in the panel template may vary — the tests, not the snippet, are the
  contract. `realtime.test.ts`'s existing commit-event builder should be reused
  rather than the sketched `commitEvent(...)` if its signature differs.
