# Validate Reflects Staged Edits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the **Validate** action reflect staged (uncommitted) edits and tag each issue's origin (on-server / uncommitted / resolved), so a rule-violating edit shows up in the Validation panel without having to commit first.

**Architecture:** Extend `POST /model/validate` with an optional `ops` batch. When present, the backend reuses the committed-model issue baseline, applies the ops, validates only the dirty scope (via the existing `DirtyCollector`), rolls back, computes the working issue set functionally, and diffs it against the committed baseline to tag origins. The frontend sends staged ops on Validate and renders origin badges plus a filter bar in the Issues panel.

**Tech Stack:** Python 3.14 / FastAPI / Pydantic v2 (backend, env `core-dev`), SvelteKit 5 (runes) / Zod / vitest + MSW (frontend, env `frontend`).

## Global Constraints

- Toolchain is **pixi**; there is no global `python`/`node`. Backend tests: `pixi run -e core-dev pytest <args>`. Frontend tests: `pixi run -e frontend npm test`. Lint/format/typecheck: `pixi run tidy` (ruff + mypy + pyright + frontend).
- Backend type-check floor is **Python 3.10** (`pyrightconfig.json`), though the runtime is 3.14. Import `Self`/`assert_never` from `typing_extensions`, not `typing`.
- `pythonpath=src` is set in `pytest.ini`; import as `from data_rover.core...` / `from data_rover.api...`.
- API tests need **no** database service — `tests/api/conftest.py` runs in-memory SQLite. The `client` fixture in `tests/api/test_routes.py` pre-seeds the `default` project and sets `AUTH_HEADERS`, so bare `client.post(f"{API}/...")` is authenticated. `API = "/api/v1/projects/default"`.
- Construct **one** `default_pipeline()` per request (validators carry per-thread memo caches — never share across threads).
- The validation pipeline's per-entity hooks must stay O(entity); whole-model work uses `Scope.all()`.
- Property values are replaced wholesale, never mutated in place (the op-log inverse patches alias prior values).
- Frontend: read `frontend/README.md` before touching `frontend/src/lib/state/`. Svelte 5 runes (`$state`, `$derived`, `$effect`).

---

## File Structure

Backend:
- `src/data_rover/api/schemas.py` — modify: `IssueOut.origin` field + `from_core(origin=...)`; `ValidateRequest.ops` + `base_rev`.
- `src/data_rover/api/routes/validation.py` — modify: add `classify_issue_origins` pure helper + the staged validation branch in `validate_model`.

Frontend:
- `frontend/src/lib/api/types.ts` — modify: `IssueSchema.origin`.
- `frontend/src/lib/api/validation.ts` — modify: `validateModel` accepts `ops`/`baseRev`.
- `frontend/src/lib/state/model.svelte.ts` — modify: `validateAll` passes staged ops + rev; fix the staged-validation docstring.
- `frontend/src/lib/state/validate-action.ts` — modify: fix stale docstring; handle 409 conflict.
- `frontend/src/lib/components/Workspace/IssuesPanel.svelte` — modify: filter bar + origin badges + resolved styling.

Tests:
- `tests/api/test_validate_staged.py` — create.
- `frontend/src/lib/api/__tests__/validation.test.ts` — modify (extend).
- `frontend/src/lib/state/__tests__/validate-staged.test.ts` — create.
- `frontend/src/lib/components/__tests__/IssuesPanel.origin.test.ts` — create.

---

## Task 1: Backend — origin schema + `classify_issue_origins` helper

**Files:**
- Modify: `src/data_rover/api/schemas.py` (`IssueOut` ~ lines 89-102; `ValidateRequest` ~ lines 84-86)
- Modify: `src/data_rover/api/routes/validation.py`
- Test: `tests/api/test_validate_staged.py` (create)

**Interfaces:**
- Produces:
  - `IssueOut.origin: str` (default `"on_server"`); `IssueOut.from_core(issue: Issue, origin: str = "on_server") -> IssueOut`.
  - `ValidateRequest.ops: list[OpIn] | None = None`, `ValidateRequest.base_rev: int | None = None`.
  - `classify_issue_origins(committed: list[Issue], working: list[Issue]) -> list[IssueOut]` in `routes/validation.py` — tags every `working` issue `on_server`/`uncommitted` (multiset-matched against `committed`) and appends `committed` issues absent from `working` as `resolved`.

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_validate_staged.py`:

```python
from __future__ import annotations

from data_rover.api.routes.validation import classify_issue_origins
from data_rover.core.validation.issue import Issue, IssueCategory, Severity


def _issue(msg: str, owner: str, sev: Severity = Severity.ERROR) -> Issue:
    return Issue(severity=sev, message=msg, target_ids=[owner])


def test_classify_tags_on_server_uncommitted_and_resolved() -> None:
    pre_existing = _issue("dangling ref", "z1")
    fixed = _issue("name not unique", "r2")
    committed = [pre_existing, fixed]

    introduced = _issue("priority above max", "req1")
    working = [pre_existing, introduced]  # `fixed` is gone, `introduced` is new

    out = classify_issue_origins(committed, working)
    by_msg = {o.message: o.origin for o in out}

    assert by_msg["dangling ref"] == "on_server"
    assert by_msg["priority above max"] == "uncommitted"
    assert by_msg["name not unique"] == "resolved"
    # resolved issues are returned in addition to the working set
    assert len(out) == 3


def test_classify_duplicate_issues_use_multiset_matching() -> None:
    committed = [_issue("dup", "a")]
    working = [_issue("dup", "a"), _issue("dup", "a")]  # one pre-existing, one new

    origins = sorted(o.origin for o in classify_issue_origins(committed, working))
    assert origins == ["on_server", "uncommitted"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_validate_staged.py -v`
Expected: FAIL with `ImportError: cannot import name 'classify_issue_origins'`.

- [ ] **Step 3: Add the schema fields**

In `src/data_rover/api/schemas.py`, change `ValidateRequest` (currently lines 84-86) to:

```python
class ValidateRequest(BaseModel):
    scope: list[str] | None = None
    inline: InlineModel | None = None
    #: staged (uncommitted) op batch to validate against the committed model;
    #: when present, the response tags each issue's origin. Mirrors PreviewRequest.
    ops: list[OpIn] | None = None
    #: model_rev the ops were computed against; mismatch -> 409 (like preview).
    base_rev: int | None = None
```

`OpIn` is defined later in the same module (line ~221). Pydantic resolves the
forward reference at model-build time, but to be safe the field uses the symbol
directly — `OpIn` is module-level, so move the `ValidateRequest` class to AFTER
the `OpIn` definition is NOT required (Pydantic v2 resolves module-global
annotations lazily). If `pixi run lint-backend` reports an undefined-name, wrap
the annotation as a string: `ops: "list[OpIn] | None" = None`.

Change `IssueOut` (currently lines 89-102) to:

```python
class IssueOut(BaseModel):
    severity: str
    message: str
    target_ids: list[str] = Field(default_factory=list)
    category: str = "conformance"
    #: relationship to the committed model: "on_server" (pre-existing),
    #: "uncommitted" (introduced by staged edits), or "resolved" (fixed by them).
    origin: str = "on_server"

    @classmethod
    def from_core(cls, issue: Issue, origin: str = "on_server") -> "IssueOut":
        return cls(
            severity=issue.severity.value,
            message=issue.message,
            target_ids=list(issue.target_ids),
            category=issue.category.value,
            origin=origin,
        )
```

- [ ] **Step 4: Add the `classify_issue_origins` helper**

In `src/data_rover/api/routes/validation.py`, add imports at the top (after the existing imports):

```python
from collections import Counter

from data_rover.core.validation.issue import Issue
```

Then add the helper (above `validate_model`):

```python
def _issue_key(issue: Issue) -> tuple[str, str, tuple[str, ...], str]:
    """Content identity used to match an issue across two validation runs.

    The pipeline emits ``target_ids`` owner-first deterministically, so the
    same rule on the same entities yields the same tuple across runs.
    """
    return (
        issue.severity.value,
        issue.message,
        tuple(issue.target_ids),
        issue.category.value,
    )


def classify_issue_origins(
    committed: list[Issue], working: list[Issue]
) -> list[IssueOut]:
    """Tag working-state issues against the committed baseline (multiset-matched).

    Every ``working`` issue is tagged ``on_server`` if it has a matching
    committed counterpart (consumed one-for-one) else ``uncommitted``; every
    committed issue with no working counterpart is appended as ``resolved``.
    """
    committed_counts: Counter[tuple[str, str, tuple[str, ...], str]] = Counter(
        _issue_key(i) for i in committed
    )
    seen: Counter[tuple[str, str, tuple[str, ...], str]] = Counter()
    out: list[IssueOut] = []
    for issue in working:
        key = _issue_key(issue)
        seen[key] += 1
        origin = "on_server" if seen[key] <= committed_counts[key] else "uncommitted"
        out.append(IssueOut.from_core(issue, origin=origin))
    remaining = committed_counts - seen  # multiset difference keeps positives only
    for issue in committed:
        key = _issue_key(issue)
        if remaining[key] > 0:
            remaining[key] -= 1
            out.append(IssueOut.from_core(issue, origin="resolved"))
    return out
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_validate_staged.py -v`
Expected: PASS (both tests).

- [ ] **Step 6: Lint + typecheck**

Run: `pixi run lint-backend`
Expected: clean (no ruff/mypy/pyright errors).

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/routes/validation.py tests/api/test_validate_staged.py
git commit -m "feat(api): issue origin tagging helper + validate ops schema"
```

---

## Task 2: Backend — staged validation branch in `POST /model/validate`

**Files:**
- Modify: `src/data_rover/api/routes/validation.py` (`validate_model`, currently lines 16-40)
- Test: `tests/api/test_validate_staged.py` (extend)

**Interfaces:**
- Consumes: `classify_issue_origins` (Task 1); `_apply_batch`, `_rollback` from `routes/ops.py`; `issue_owner` from `core.validation.state`.
- Produces: `POST /model/validate` accepts `{ops, base_rev}`. With `ops`: 409 on stale `base_rev`, 422 on a mutation-boundary error, else 200 with origin-tagged issues, leaving the model and `model_rev` unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_validate_staged.py`:

```python
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import get_session

from .conftest import AUTH_HEADERS, seed_default_project

API = "/api/v1/projects/default"
EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "example.metamodel.yaml"


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _seed(client: TestClient) -> dict:
    """Example metamodel + a Block, a valid Requirement (priority 3), Satisfies."""
    client.post(
        f"{API}/metamodel",
        content=EXAMPLE.read_text(encoding="utf-8"),
        headers={"content-type": "application/x-yaml"},
    )
    client.post(f"{API}/model", json={"elements": [], "relationships": []})
    client.post(
        f"{API}/model/elements",
        json={"type": "Block", "properties": {"name": "Wing", "mass": 12.5}},
    )
    req = client.post(
        f"{API}/model/elements",
        json={"type": "Requirement",
              "properties": {"name": "REQ-1", "status": "Draft", "priority": 3}},
    ).json()
    return {"req_id": req["id"], "rev": get_session().model_rev}


def test_staged_validate_flags_new_violation_as_uncommitted(client: TestClient) -> None:
    seeded = _seed(client)
    # baseline committed model is clean
    assert client.post(f"{API}/model/validate").json() == []

    res = client.post(
        f"{API}/model/validate",
        json={
            "base_rev": seeded["rev"],
            "ops": [{"kind": "update_element", "id": seeded["req_id"],
                     "properties_patch": {"priority": 99}}],
        },
    )
    assert res.status_code == 200, res.text
    issues = res.json()
    bad = [i for i in issues if "priority" in i["message"]]
    assert bad and all(i["origin"] == "uncommitted" for i in bad), issues

    # the live model is untouched: a plain re-validate is still clean and rev held
    assert client.post(f"{API}/model/validate").json() == []
    assert get_session().model_rev == seeded["rev"]


def test_staged_validate_stale_base_rev_returns_409(client: TestClient) -> None:
    seeded = _seed(client)
    res = client.post(
        f"{API}/model/validate",
        json={
            "base_rev": seeded["rev"] - 1,
            "ops": [{"kind": "update_element", "id": seeded["req_id"],
                     "properties_patch": {"priority": 99}}],
        },
    )
    assert res.status_code == 409, res.text
    assert res.json()["model_rev"] == seeded["rev"]


def test_staged_validate_resolved_and_on_server(client: TestClient) -> None:
    seeded = _seed(client)
    # Commit a violation onto the server so it becomes pre-existing.
    client.post(
        f"{API}/model/ops",
        json={"base_rev": seeded["rev"],
              "ops": [{"kind": "update_element", "id": seeded["req_id"],
                       "properties_patch": {"priority": 99}}]},
    )
    rev = get_session().model_rev
    # Stage an op that fixes it.
    res = client.post(
        f"{API}/model/validate",
        json={"base_rev": rev,
              "ops": [{"kind": "update_element", "id": seeded["req_id"],
                       "properties_patch": {"priority": 2}}]},
    )
    assert res.status_code == 200, res.text
    resolved = [i for i in res.json() if "priority" in i["message"]]
    assert resolved and all(i["origin"] == "resolved" for i in resolved), res.json()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_validate_staged.py -v`
Expected: the three HTTP tests FAIL (the staged branch returns the plain
committed validation — no `uncommitted`/`resolved` origins, no 409).

- [ ] **Step 3: Rewrite `validate_model` with the staged branch**

Replace the body of `validate_model` in `src/data_rover/api/routes/validation.py`. Add these imports near the top of the file:

```python
from fastapi.responses import JSONResponse

from data_rover.core.validation.state import ValidationState, issue_owner

from .ops import _apply_batch, _rollback, _ensure_validation_seeded
```

(Keep the existing `ValidationState` import if present — de-duplicate so it is imported once, now alongside `issue_owner`.)

Replace the route (lines 16-40) with:

```python
@router.post("/model/validate", response_model=None)
def validate_model(
    payload: ValidateRequest | None = None,
    session: Session = Depends(get_request_session),
) -> list[IssueOut] | JSONResponse:
    metamodel, current = require_model(session)

    # 1. Inline-snapshot path (unchanged): validate a client-provided model.
    if payload is not None and payload.inline is not None:
        model = _build_model_from_payload(
            metamodel,
            payload.inline.elements,
            payload.inline.relationships,
        )
        scope = Scope(payload.scope) if payload.scope is not None else Scope.all()
        issues = default_pipeline().validate(model, scope)
        return [IssueOut.from_core(i) for i in issues]

    # 2. Staged path: validate the committed model WITH the client's uncommitted
    #    ops applied, then tag each issue's origin against the committed baseline.
    if payload is not None and payload.ops:
        if payload.base_rev is not None and payload.base_rev != session.model_rev:
            return JSONResponse(
                status_code=409,
                content={"detail": "stale base_rev", "model_rev": session.model_rev},
            )
        # committed baseline = the session's maintained issue store (seeded on
        # first use). Reused, not recomputed: avoids a full O(model) pass per
        # Validate and avoids a racy session.validation reassignment outside the
        # write mutex. This is the on-server issue set.
        state = _ensure_validation_seeded(session, current)
        committed = state.all_issues()
        # apply -> scoped re-validate -> roll back, under the write mutex. On a
        # mutation-boundary error _apply_batch self-rolls-back and raises 422.
        with session.write_mutex:
            res = _apply_batch(current, payload.ops, restore=False)
            try:
                scoped = default_pipeline().validate(current, res.dirty.to_scope())
            finally:
                _rollback(current, res.inverse_units)
        dirty_ids = set(res.dirty.ids)
        # working full set = committed issues OUTSIDE the dirty scope ∪ the fresh
        # dirty-scope issues (what state.replace would yield, computed purely).
        working = [i for i in committed if issue_owner(i) not in dirty_ids]
        working.extend(scoped)
        return classify_issue_origins(committed, working)

    # 3. No ops, no inline: full validation of the committed session model.
    scope = (
        Scope(payload.scope) if payload and payload.scope is not None else Scope.all()
    )
    issues = default_pipeline().validate(current, scope)
    if scope.is_all:
        state = ValidationState()
        state.set_full(issues)
        session.validation = state
    return [IssueOut.from_core(i) for i in issues]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_validate_staged.py -v`
Expected: all tests PASS.

- [ ] **Step 5: Run the existing validate suite (no regressions)**

Run: `pixi run -e core-dev pytest tests/api/test_routes.py -k validate -v`
Expected: PASS (inline path, full-session seed, no-ops behavior unchanged).

- [ ] **Step 6: Lint + typecheck**

Run: `pixi run lint-backend`
Expected: clean. (If pyright flags `_apply_batch`/`_rollback` as private cross-module imports, that is acceptable — they are already imported across route modules; if mypy complains, no `# type: ignore` should be needed.)

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/routes/validation.py tests/api/test_validate_staged.py
git commit -m "feat(api): validate staged ops against committed model with origin tags"
```

---

## Task 3: Frontend — send staged ops on Validate + origin type

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (`IssueSchema` ~ lines 27-32)
- Modify: `frontend/src/lib/api/validation.ts`
- Modify: `frontend/src/lib/state/model.svelte.ts` (`validateAll` ~ lines 772-791)
- Modify: `frontend/src/lib/state/validate-action.ts`
- Test: `frontend/src/lib/api/__tests__/validation.test.ts` (extend)
- Test: `frontend/src/lib/state/__tests__/validate-staged.test.ts` (create)

**Interfaces:**
- Consumes: backend `{ops, base_rev}` contract + `origin` field (Tasks 1-2).
- Produces: `Issue.origin?: 'on_server' | 'uncommitted' | 'resolved'`; `validateModel(options?: {inline?, scope?, ops?, baseRev?})` sends `{ops, base_rev}` when `ops` is non-empty.

- [ ] **Step 1: Write the failing api test**

Append to `frontend/src/lib/api/__tests__/validation.test.ts` inside the `describe('validateModel', ...)` block:

```ts
	it('POSTs staged ops with base_rev when ops are present', async () => {
		let body: unknown;
		server.use(
			http.post(`${BASE}/model/validate`, async ({ request }) => {
				body = await request.json();
				return HttpResponse.json([
					{ severity: 'error', message: 'bad', target_ids: ['e1'], origin: 'uncommitted' }
				]);
			})
		);
		const ops = [{ kind: 'update_element', id: 'e1', properties_patch: { p: 1 } }] as const;
		const result = await validateModel({ ops: [...ops], baseRev: 7 }, cfg);
		expect(body).toEqual({ ops: [...ops], base_rev: 7 });
		expect(result[0].origin).toBe('uncommitted');
	});

	it('defaults origin to on_server when the server omits it', async () => {
		server.use(
			http.post(`${BASE}/model/validate`, async () =>
				HttpResponse.json([{ severity: 'warning', message: 'x', target_ids: ['e1'] }])
			)
		);
		const result = await validateModel(undefined, cfg);
		expect(result[0].origin).toBe('on_server');
	});
```

- [ ] **Step 2: Run the api test to verify it fails**

Run: `pixi run -e frontend npm test -- src/lib/api/__tests__/validation.test.ts`
Expected: FAIL — `body` lacks `ops`/`base_rev`; `origin` is `undefined`.

- [ ] **Step 3: Add `origin` to the Issue schema**

In `frontend/src/lib/api/types.ts`, change `IssueSchema` (lines 27-32) to:

```ts
export const IssueSchema = z.object({
	severity: z.enum(['error', 'warning']),
	message: z.string(),
	target_ids: z.array(z.string()),
	origin: z.enum(['on_server', 'uncommitted', 'resolved']).default('on_server')
});
```

- [ ] **Step 4: Wire ops into `validateModel`**

Replace `frontend/src/lib/api/validation.ts` with:

```ts
import { apiFetch, type ClientConfig } from './client';
import type { Op } from '$lib/state/ops';
import { IssueListSchema, type InlineModel, type Issue } from './types';

export interface ValidateOptions {
	inline?: InlineModel;
	scope?: string[];
	/** Staged (uncommitted) ops to validate against the committed model. */
	ops?: Op[];
	/** model_rev the ops were computed against; sent as base_rev (409 on stale). */
	baseRev?: number;
}

export function validateModel(options?: ValidateOptions, cfg?: ClientConfig): Promise<Issue[]> {
	let body: unknown = undefined;
	if (options?.ops !== undefined && options.ops.length > 0) {
		body = { ops: options.ops, base_rev: options.baseRev };
	} else if (options && (options.inline !== undefined || options.scope !== undefined)) {
		body = { inline: options.inline, scope: options.scope };
	}
	return apiFetch('/model/validate', { method: 'POST', body, schema: IssueListSchema }, cfg);
}
```

- [ ] **Step 5: Run the api test to verify it passes**

Run: `pixi run -e frontend npm test -- src/lib/api/__tests__/validation.test.ts`
Expected: PASS (all cases, including the unchanged inline/scope/no-body ones).

- [ ] **Step 6: Write the failing state test**

Create `frontend/src/lib/state/__tests__/validate-staged.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '$lib/api/__tests__/server';
import { emit } from '../model.svelte';
import { validateAll, resetModelStore, adoptSummary, setModelApiConfig } from '../model.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
	server.resetHandlers();
	resetModelStore();
});
afterAll(() => server.close());

describe('validateAll with staged ops', () => {
	it('sends staged ops + base_rev to /model/validate', async () => {
		setModelApiConfig({ baseUrl: BASE });
		adoptSummary({ model_rev: 4, element_count: 0, relationship_count: 0, issue_counts: {} });
		emit({ kind: 'create_element', temp_id: 'tmp1', type_name: 'Block', properties: {} });

		let body: { ops?: unknown[]; base_rev?: number } | undefined;
		server.use(
			http.post(`${BASE}/model/validate`, async ({ request }) => {
				body = (await request.json()) as typeof body;
				return HttpResponse.json([
					{ severity: 'error', message: 'e', target_ids: ['tmp1'], origin: 'uncommitted' }
				]);
			})
		);

		const issues = await validateAll();
		expect(body?.base_rev).toBe(4);
		expect(body?.ops).toHaveLength(1);
		expect(issues[0].origin).toBe('uncommitted');
	});
});
```

(If `adoptSummary`'s `ModelSummary` shape differs, match the fields the type
requires — check `ModelSummary` in `types.ts`; the test only needs `model_rev`
to be 4 and a loaded summary so `validateAll` does not early-return.)

- [ ] **Step 7: Run the state test to verify it fails**

Run: `pixi run -e frontend npm test -- src/lib/state/__tests__/validate-staged.test.ts`
Expected: FAIL — `validateAll` currently sends no body (`base_rev`/`ops` undefined).

- [ ] **Step 8: Update `validateAll` to pass staged ops**

In `frontend/src/lib/state/model.svelte.ts`, the `validateAll` function (lines 780-791). Update its docstring (lines 772-779) and body to:

```ts
/**
 * Full validation run that INCLUDES staged (uncommitted) edits. When the staged
 * buffer is non-empty, the staged ops + current rev are sent to POST
 * /model/validate, which applies them against the committed model, validates,
 * rolls back, and tags each issue's origin (on_server / uncommitted / resolved).
 * With an empty buffer it is a plain committed-model validation (all on_server).
 * Resets `issuesByOwner` and the counts from the result.
 */
export async function validateAll(): Promise<Issue[]> {
	const staged = getStagedOps();
	const options = staged.length > 0 ? { ops: staged, baseRev: _modelRev } : undefined;
	const issues = await validateModel(options, _clientConfig);
	_issuesByOwner.clear();
	const counts: IssueCounts = {};
	for (const issue of issues) {
		// resolved issues are not active problems — keep them out of the counts
		if (issue.origin === 'resolved') continue;
		addIssueToOwner(issue);
		counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
	}
	_issueCounts = counts;
	if (_summary !== null) _summary = { ..._summary, issue_counts: counts };
	return issues;
}
```

(`getStagedOps` is defined in this same module; `_modelRev` is the module-level
rev state. No new imports needed.)

- [ ] **Step 9: Handle the 409 conflict in `validate-action.ts`**

In `frontend/src/lib/state/validate-action.ts`: fix the stale docstring (lines
5-9) and handle the conflict. Replace the file with:

```ts
import { getModelSummary, validateAll } from './model.svelte';
import { setActiveTab } from './workspace.svelte';
import { isRunning, setIssues, setLastError, setRunning } from './validation.svelte';
import { ConflictError } from '$lib/api/errors';
import { setModelError } from './model.svelte';

/**
 * Run a full validation that INCLUDES staged (uncommitted) edits via the store's
 * `validateAll()`. On success: switch the workspace tab to "issues" and store the
 * origin-tagged result. A 409 (the committed rev advanced under us, e.g. a peer
 * commit) marks the store conflicted so the UI prompts a reload. Other errors are
 * stored as the panel's lastError. No-op if no model is loaded or a run is in flight.
 */
export async function runValidation(): Promise<void> {
	if (getModelSummary() === null) return;
	if (isRunning()) return;
	setRunning(true);
	setLastError(null);
	try {
		const issues = await validateAll();
		setIssues(issues);
		setActiveTab('issues');
	} catch (err) {
		if (err instanceof ConflictError) {
			setModelError({ kind: 'conflict', message: 'Model changed on the server. Reload to continue.' });
			setLastError('Model changed on the server — reload to validate.');
		} else {
			const message = err instanceof Error ? err.message : String(err);
			console.error('Validation failed', err);
			setLastError(message);
		}
	} finally {
		setRunning(false);
	}
}
```

(Confirm `ConflictError` is exported from `$lib/api/errors` — it is used in
`checkout.svelte.ts`. `setModelError` is exported from `model.svelte.ts`.)

- [ ] **Step 10: Run the state test + typecheck**

Run: `pixi run -e frontend npm test -- src/lib/state/__tests__/validate-staged.test.ts`
Expected: PASS.
Run: `pixi run -e frontend npm run check`
Expected: no svelte-check / TS errors.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/api/validation.ts \
  frontend/src/lib/state/model.svelte.ts frontend/src/lib/state/validate-action.ts \
  frontend/src/lib/api/__tests__/validation.test.ts \
  frontend/src/lib/state/__tests__/validate-staged.test.ts
git commit -m "feat(frontend): Validate sends staged ops and consumes issue origin"
```

---

## Task 4: Frontend — IssuesPanel filter bar + origin badges

**Files:**
- Modify: `frontend/src/lib/components/Workspace/IssuesPanel.svelte`
- Test: `frontend/src/lib/components/__tests__/IssuesPanel.origin.test.ts` (create)

**Interfaces:**
- Consumes: `Issue.origin` (Task 3) from `getIssues()`.
- Produces: a panel with a `[All | New | On server | Fixed]` filter, per-row badges, and struck-through resolved rows excluded from header counts.

- [ ] **Step 1: Write the failing component test**

Create `frontend/src/lib/components/__tests__/IssuesPanel.origin.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';

import IssuesPanel from '../Workspace/IssuesPanel.svelte';
import { setIssues } from '$lib/state/validation.svelte';
import { adoptSummary, resetModelStore } from '$lib/state/model.svelte';

afterEach(() => {
	cleanup();
	resetModelStore();
});

function seedIssues() {
	adoptSummary({ model_rev: 1, element_count: 0, relationship_count: 0, issue_counts: {} });
	setIssues([
		{ severity: 'error', message: 'new boom', target_ids: ['a'], origin: 'uncommitted' },
		{ severity: 'error', message: 'old boom', target_ids: ['b'], origin: 'on_server' },
		{ severity: 'warning', message: 'now fixed', target_ids: ['c'], origin: 'resolved' }
	]);
}

describe('IssuesPanel origin', () => {
	it('renders origin badges and excludes resolved from the error count', () => {
		seedIssues();
		const { getByText, queryAllByText } = render(IssuesPanel);
		// 2 active errors (uncommitted + on_server); resolved warning not counted
		expect(getByText(/2 errors/i)).toBeTruthy();
		expect(queryAllByText(/new/i).length).toBeGreaterThan(0);
	});

	it('filters to only uncommitted issues when the New filter is clicked', async () => {
		seedIssues();
		const { getByRole, queryByText } = render(IssuesPanel);
		await fireEvent.click(getByRole('button', { name: /^New$/i }));
		expect(queryByText('new boom')).toBeTruthy();
		expect(queryByText('old boom')).toBeNull();
	});
});
```

(If the repo's vitest config lacks `@testing-library/svelte`, check an existing
component test such as `TopBar.strict.test.ts` for the exact render helper and
mirror its imports.)

- [ ] **Step 2: Run the component test to verify it fails**

Run: `pixi run -e frontend npm test -- src/lib/components/__tests__/IssuesPanel.origin.test.ts`
Expected: FAIL — no filter buttons, no badges, resolved issue counted/leaks.

- [ ] **Step 3: Add filter state, origin helpers, and badge UI**

Edit `frontend/src/lib/components/Workspace/IssuesPanel.svelte`.

In the `<script>` block, after the existing `issues` derivation (line 21), add filter state and origin-aware derivations. Replace the `errors`/`warnings` derivations (lines 29-30) so resolved issues are excluded from active counts and the filter applies:

```ts
	type OriginFilter = 'all' | 'uncommitted' | 'on_server' | 'resolved';
	let filter = $state<OriginFilter>('all');

	function originBadge(o: Issue['origin']): { label: string; cls: string } {
		if (o === 'uncommitted') return { label: 'new', cls: 'bg-sky-900 text-sky-200' };
		if (o === 'resolved') return { label: 'fixed', cls: 'bg-emerald-950 text-emerald-300' };
		return { label: 'on server', cls: 'bg-zinc-800 text-zinc-400' };
	}

	const filtered = $derived(filter === 'all' ? issues : issues.filter((i) => i.origin === filter));
	// Active = not resolved. Resolved rows are shown (when in view) but never
	// counted as problems and render struck-through.
	const errors = $derived(filtered.filter((i) => i.severity === 'error' && i.origin !== 'resolved'));
	const warnings = $derived(
		filtered.filter((i) => i.severity === 'warning' && i.origin !== 'resolved')
	);
	const resolved = $derived(filtered.filter((i) => i.origin === 'resolved'));
	const hasResolved = $derived(issues.some((i) => i.origin === 'resolved'));
```

Update the `issueRow` snippet (lines 74-100) to show the badge and strike
resolved rows. Replace the snippet's opening `<li>` and the message `<span>`:

```svelte
{#snippet issueRow(it: Issue, idx: number)}
	<li
		class="flex flex-col gap-1 rounded border border-zinc-800 bg-zinc-900/40 px-2 py-1.5"
		class:opacity-60={it.origin === 'resolved'}
	>
		<div class="flex items-start gap-1.5">
			{#if it.severity === 'error'}
				<AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
			{:else}
				<AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
			{/if}
			<span class="flex-1 text-zinc-200" class:line-through={it.origin === 'resolved'}>
				{it.message}
			</span>
			<span class="rounded px-1 py-0.5 text-[9px] uppercase {originBadge(it.origin).cls}">
				{originBadge(it.origin).label}
			</span>
			<span class="font-mono text-[10px] text-zinc-600">#{idx + 1}</span>
		</div>
		{#if it.target_ids.length > 0}
			<div class="flex flex-wrap items-center gap-1 pl-5">
				{#each it.target_ids as tid (tid)}
					<button
						type="button"
						class="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300 hover:bg-zinc-700 hover:text-zinc-50"
						onclick={() => onTargetClick(tid)}
						title={tid}
					>
						{targetLabel(tid)}
					</button>
				{/each}
			</div>
		{/if}
	</li>
{/snippet}
```

Add the filter bar in the body. Immediately inside the scrollable
`<div class="flex-1 overflow-auto ...">` (line 143), before the `{#if lastRunAt === null}`,
add a filter bar shown only once a run has happened:

```svelte
		{#if lastRunAt !== null && issues.length > 0}
			<div class="mb-2 flex flex-wrap gap-1">
				{#each [['all', 'All'], ['uncommitted', 'New'], ['on_server', 'On server'], ['resolved', 'Fixed']] as [val, label] (val)}
					<button
						type="button"
						class="rounded px-2 py-0.5 text-[10px] {filter === val
							? 'bg-zinc-200 text-zinc-900'
							: 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}"
						disabled={val === 'resolved' && !hasResolved}
						onclick={() => (filter = val as OriginFilter)}
					>
						{label}
					</button>
				{/each}
			</div>
		{/if}
```

Finally, render a Resolved section when the filtered set has resolved rows. After
the Warnings `{#if warnings.length > 0}...{/if}` section (ends line 173), add:

```svelte
					{#if resolved.length > 0}
						<section class="flex flex-col gap-1">
							<h3 class="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
								Resolved by your edits ({resolved.length})
							</h3>
							<ul class="flex flex-col gap-1">
								{#each resolved as it, i (i)}
									{@render issueRow(it, i)}
								{/each}
							</ul>
						</section>
					{/if}
```

Also update the empty-state guard: the `{:else if issues.length === 0}` /
`{:else}` block that renders sections (line 146-148) should switch on `filtered`
for the "nothing in this filter" case but keep `issues.length === 0` for the
"no issues at all" message. Change the inner block (line 148 `{:else}`) to first
handle an empty filtered set:

```svelte
			{:else if filtered.length === 0}
				<p class="text-zinc-500">No issues match this filter.</p>
			{:else}
```

(Leave the existing header summary counts on lines 110-119 as-is — they read the
`errors`/`warnings` derivations, which now already exclude resolved.)

- [ ] **Step 4: Run the component test to verify it passes**

Run: `pixi run -e frontend npm test -- src/lib/components/__tests__/IssuesPanel.origin.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full frontend test sweep**

Run: `pixi run -e frontend npm run check`
Expected: no errors.
Run: `pixi run -e frontend npm test`
Expected: PASS (no regressions in existing IssuesPanel / state / api tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/Workspace/IssuesPanel.svelte \
  frontend/src/lib/components/__tests__/IssuesPanel.origin.test.ts
git commit -m "feat(frontend): origin filter bar + badges in Issues panel"
```

---

## Task 5: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Backend tests**

Run: `pixi run test-core` then `pixi run -e core-dev pytest tests/api -q`
Expected: all PASS.

- [ ] **Step 2: Frontend tests + check**

Run: `pixi run -e frontend npm test` and `pixi run -e frontend npm run check`
Expected: all PASS, no type errors.

- [ ] **Step 3: Lint/format/typecheck everything**

Run: `pixi run tidy`
Expected: clean across frontend, core, backend.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Start the stack (`pixi run start-backend` + `pixi run start-frontend`), load the
smart-city example, edit an element to violate a rule (e.g. set a property past a
facet max), click **Validate** WITHOUT committing, and confirm the violation
appears tagged **new**. Confirm the `[All | New | On server | Fixed]` filters
work and a fixing edit shows the prior issue under **Resolved**.

- [ ] **Step 5: Commit any formatting changes**

```bash
git add -A
git commit -m "chore: tidy after validate-staged-edits" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:** staged validation (Task 2) ✓; three origin buckets (Task 1 classifier + Task 2 wiring) ✓; full-model picture via committed-baseline ∪ dirty-scope (Task 2) ✓; 409 stale / 422 mutation-boundary (Task 2) ✓; model untouched after call (Task 2 test) ✓; filter bar + badges + struck-resolved excluded from counts (Tasks 3-4) ✓; stale docstring fix (Task 3) ✓; no-ops path unchanged (Task 2 Step 5) ✓.
- **Type consistency:** `origin` values `'on_server' | 'uncommitted' | 'resolved'` are identical across backend (`IssueOut.origin`), Zod (`IssueSchema.origin`), and component (`originBadge`). `classify_issue_origins(committed, working)` signature matches its call site. `validateModel({ops, baseRev})` matches `validateAll`'s call.
- **Perf note (revised — Option C, decided during execution):** the staged path **reuses** the session's maintained committed baseline via `_ensure_validation_seeded` (a full `Scope.all()` run happens only on a cold/unseeded session) plus one O(dirty) scoped pass. This also removes the racy `session.validation` reassignment outside the write mutex that a Task 2 review flagged. The spec's step 2 is updated to match.
