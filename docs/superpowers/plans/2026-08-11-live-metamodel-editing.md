# Live Metamodel Editing (Phase 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the SwapMetamodelDrawer with a live in-app metamodel YAML editor — a singleton workspace tab with tiered feedback (debounced lint, on-demand preview, rebind to land), `mm`-lease-aware, with localStorage draft safety.

**Architecture:** Two new read-only-ish backend routes (`GET /metamodel/raw` serving the stored source blob verbatim; `POST /metamodel/lint` doing parse+schema check only). Frontend: a new `metamodel` workspace tab kind hosting a CodeMirror YAML editor, driven by a new `state/metamodel-editor.svelte.ts` module that composes the existing `metamodel-lease` module, calls the existing `POST /metamodel/diff` for preview and `POST /metamodel/rebind` to land. The drawer is deleted.

**Tech Stack:** FastAPI + pydantic (backend), Svelte 5 + CodeMirror 6 + zod + vitest/msw (frontend), pixi toolchain.

**Spec:** `docs/superpowers/specs/2026-08-11-live-metamodel-editing-design.md` (approved 2026-08-11).

## Global Constraints

- Everything runs through **pixi**: `pixi run core-test`, `pixi run -e core-dev pytest <path> -v`, `pixi run frontend-test`, `pixi run -e frontend bash -c 'cd frontend && npx vitest run <path>'` (a bare `pixi run -e frontend npm test` fails — pixi runs from repo root).
- Work on branch **`feat/live-metamodel-editor`** off `main`. `--no-ff` merge into local `main` at the end, delete the branch. **Never push to origin.**
- Conventional commits, **NO attribution/co-author trailers**.
- Frontend files are **TAB-indented**; run `pixi run dr-tidy` (or frontend prettier) before committing frontend changes. Python is 4-space.
- Components import state through the **`$lib/state` barrel** (`frontend/src/lib/state/index.ts`) — every new state export must be re-exported there. State modules import siblings directly (relative paths).
- `@testing-library/svelte` is **NOT** a dependency; component tests use `mount`/`flushSync`/`unmount` from `svelte`.
- **Read `frontend/README.md` before touching `frontend/src/lib/state/`** (mandatory house rule).
- The Phase 1–4 backend contract is **frozen — ADD only**. Do not modify `POST /metamodel/diff`, `POST /metamodel/rebind`, `POST /metamodel`, `DELETE /metamodel`, or the lock routes.
- **Honor-don't-require `mm` semantics stand**: no lock token on any request; the server never releases the caller's lease; the client surface releases its own. Do not "upgrade" to token verification.
- The quiet predicate **excludes `mm`** (`hasModelLocks` in `realtime.svelte.ts`) — do not "fix" that; it is correct.
- Svelte 5 async rules: generation guards on async flows; the lease module already has one — do NOT add a competing guard around lease calls (the editor module guards only its OWN async).
- Beware Edit tools writing control bytes into `.svelte` files — if `git diff` shows `Bin`, hunt NULs.
- API tests: hermetic in-memory SQLite; use `client` fixtures with `seed_default_project`/`AUTH_HEADERS`/`papi` from `tests/api/conftest.py`.
- Localstorage key convention: `ui.<area>.<thing>`; storage access wrapped in try/catch, **no `browser` guard** (vitest stubs `browser` to false — the try/catch precedent is `editor-size.ts` / `workspace.svelte.ts`).

---

### Task 0: Branch

- [ ] **Step 1: Create the feature branch**

```bash
cd /home/mdp/workspace/data-rover-py
git checkout -b feat/live-metamodel-editor
```

No commit; verification only: `git branch --show-current` → `feat/live-metamodel-editor`.

---

### Task 1: Backend — `GET /metamodel/raw`

**Files:**
- Modify: `src/data_rover/api/schemas.py` (add response model near `MetamodelDiffResponse`, ~line 137)
- Modify: `src/data_rover/api/routes/metamodel.py` (add route after `get_metamodel`, ~line 93)
- Test: `tests/api/test_metamodel_raw.py` (create)

**Interfaces:**
- Consumes: `content.get_model_row(db, project_id) -> ModelRow | None`, `content.get_metamodel_row(db, metamodel_id) -> MetamodelRow | None`, `deps.require_metamodel(session) -> Metamodel` (404 "No metamodel loaded" when unbound), `deps.get_request_session`, `db.get_db`.
- Produces: `GET /api/v1/projects/{project_id}/metamodel/raw` → 200 `{"blob": str, "source": "stored" | "serialized"}`, 404 when no metamodel bound. `RawMetamodelResponse` pydantic model in `schemas.py`.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_metamodel_raw.py`:

```python
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import get_session
from data_rover.core.metamodel.loader import load_metamodel_str

from .conftest import AUTH_HEADERS, papi, seed_default_project

# Leading comment + odd spacing are the point: raw must be byte-identical.
_MM = """\
# smart-city seed (comment must survive verbatim)
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""

_MM2 = """\
# candidate v2
elements:
  - name: Node
  - name: Sensor
relationships:
  - name: Link
    source: Node
    target: Node
"""

_YAML = {"content-type": "application/x-yaml"}


def _client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary")).json()["model_rev"]


def test_raw_404_when_no_metamodel_bound() -> None:
    c = _client()
    r = c.get(papi("/metamodel/raw"))
    assert r.status_code == 404


def test_raw_returns_stored_blob_verbatim_after_upload() -> None:
    c = _client()
    assert c.post(papi("/metamodel"), content=_MM, headers=_YAML).status_code == 200
    r = c.get(papi("/metamodel/raw"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "stored"
    assert body["blob"] == _MM  # byte-identical, comment intact


def test_raw_returns_rebound_blob_verbatim() -> None:
    c = _client()
    assert c.post(papi("/metamodel"), content=_MM, headers=_YAML).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    r = c.post(
        papi("/metamodel/rebind"),
        content=_MM2,
        headers=_YAML,
        params={"base_rev": _rev(c), "message": "adopt v2"},
    )
    assert r.status_code == 200, r.text
    raw = c.get(papi("/metamodel/raw"))
    assert raw.status_code == 200
    assert raw.json() == {"blob": _MM2, "source": "stored"}


def test_raw_serialized_fallback_without_durable_rows() -> None:
    """A session with an in-memory metamodel but no DB rows degrades to a
    re-serialized blob rather than 404ing (house degraded-never-failed)."""
    c = _client()
    sess = get_session()
    sess.set_metamodel(load_metamodel_str(_MM))
    r = c.get(papi("/metamodel/raw"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "serialized"
    load_metamodel_str(body["blob"])  # must round-trip through the loader
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_raw.py -v`
Expected: FAIL — 404s/405s on `/metamodel/raw` (route doesn't exist).

- [ ] **Step 3: Add `RawMetamodelResponse` to `schemas.py`**

In `src/data_rover/api/schemas.py`, ensure `Literal` is imported (`from typing import Any, Literal` — extend the existing typing import), then add directly above `class MetamodelDiffResponse`:

```python
class RawMetamodelResponse(BaseModel):
    """The current metamodel's SOURCE text (Phase 5 editor baseline).

    ``blob`` is the stored ``MetamodelRow`` YAML verbatim — comments and
    formatting intact (the rebind route's persist-the-original-blob
    invariant made visible). ``source`` is ``"serialized"`` only on the
    degraded fallback where no durable row resolves and the in-memory
    metamodel is re-serialized instead.
    """

    blob: str
    source: Literal["stored", "serialized"]
```

- [ ] **Step 4: Add the route to `routes/metamodel.py`**

Add to imports: `from ..schemas import RawMetamodelResponse`. Then after the existing `get_metamodel` handler:

```python
@router.get("/metamodel/raw")
def get_metamodel_raw(
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> RawMetamodelResponse:
    """The current metamodel's source YAML for the live editor (Phase 5).

    Prefers the stored blob (author's comments/formatting intact); a session
    whose metamodel never landed in a durable row (legacy/test setups)
    degrades to re-serializing the in-memory object rather than failing.
    """
    metamodel = require_metamodel(session)
    model_row = content.get_model_row(db, project_id)
    if model_row is not None and model_row.metamodel_id is not None:
        mm_row = content.get_metamodel_row(db, model_row.metamodel_id)
        if mm_row is not None:
            return RawMetamodelResponse(blob=mm_row.blob, source="stored")
    blob = yaml.safe_dump(
        metamodel.model_dump(mode="json", exclude_none=True), sort_keys=False
    )
    return RawMetamodelResponse(blob=blob, source="serialized")
```

`routes/metamodel.py` needs these names already imported at top: `yaml`, `content`, `get_db`, `DbSession`, `require_metamodel` — all present except possibly `require_metamodel` (it IS imported: `from ..deps import Session, get_request_session, require_metamodel`). Verify, add if missing.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_raw.py -v`
Expected: 4 passed.

- [ ] **Step 6: Lint + commit**

```bash
pixi run backend-lint
git add src/data_rover/api/schemas.py src/data_rover/api/routes/metamodel.py tests/api/test_metamodel_raw.py
git commit -m "feat(api): GET /metamodel/raw serves the stored metamodel source"
```

---

### Task 2: Backend — `POST /metamodel/lint`

**Files:**
- Modify: `src/data_rover/api/schemas.py` (two models, next to `RawMetamodelResponse`)
- Modify: `src/data_rover/api/routes/metamodel_swap.py` (route reusing `_read_metamodel_blob`)
- Test: `tests/api/test_metamodel_lint.py` (create)

**Interfaces:**
- Consumes: `_read_metamodel_blob(request) -> str` (module-local in `metamodel_swap.py`), `load_metamodel_str`, `MetamodelError` (both already imported there), `authz.require_membership`.
- Produces: `POST /api/v1/projects/{project_id}/metamodel/lint` → **always 200** for members: `{"ok": bool, "errors": [{"message": str, "line": int|null, "column": int|null}]}`. Viewers get 403 (NOT in the read-only-POST allowlist — deliberate; only the owner-gated editing flow calls it). `LintErrorOut` + `MetamodelLintResponse` in `schemas.py`.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_metamodel_lint.py`:

```python
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import Role, User
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID
from data_rover.api.tenancy import add_member

from .conftest import AUTH_HEADERS, papi, seed_default_project

_YAML = {"content-type": "application/x-yaml"}

_VALID = """\
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""

# Unclosed flow mapping -> yaml.YAMLError with a problem_mark.
_SYNTAX_BAD = "elements: [ {"

# Parses as YAML but violates the metamodel schema -> MetamodelError, no mark.
_SCHEMA_BAD = """\
elements:
  - name: Node
    properties:
      - name: p
        datatype: bogus_datatype
"""


def _client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def test_lint_valid_ok() -> None:
    r = _client().post(papi("/metamodel/lint"), content=_VALID, headers=_YAML)
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "errors": []}


def test_lint_syntax_error_carries_position() -> None:
    r = _client().post(papi("/metamodel/lint"), content=_SYNTAX_BAD, headers=_YAML)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    (err,) = body["errors"]
    assert err["message"]
    assert isinstance(err["line"], int) and err["line"] >= 1
    assert isinstance(err["column"], int) and err["column"] >= 1


def test_lint_schema_error_message_only() -> None:
    r = _client().post(papi("/metamodel/lint"), content=_SCHEMA_BAD, headers=_YAML)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    (err,) = body["errors"]
    assert err["message"]
    assert err["line"] is None and err["column"] is None


def test_lint_works_without_a_bound_metamodel() -> None:
    """Lint checks the CANDIDATE text only — no session content needed."""
    r = _client().post(papi("/metamodel/lint"), content=_VALID, headers=_YAML)
    assert r.status_code == 200


def test_viewer_gets_403() -> None:
    """Deliberately NOT in the read-only-POST allowlist."""
    c = _client()
    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id="vw", email="vw@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "vw", Role.viewer)
        s.commit()
    finally:
        gen.close()
    r = c.post(
        papi("/metamodel/lint"),
        content=_VALID,
        headers={**_YAML, "x-user-id": "vw", "x-user-email": "vw@example.com"},
    )
    assert r.status_code == 403
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_lint.py -v`
Expected: FAIL (404/405 on `/metamodel/lint`).

- [ ] **Step 3: Add the schemas**

In `src/data_rover/api/schemas.py`, below `RawMetamodelResponse`:

```python
class LintErrorOut(BaseModel):
    """One metamodel lint finding. Position is best-effort: YAML syntax
    errors carry a 1-based line/column from the parser mark; schema errors
    (``MetamodelError``) are message-only."""

    message: str
    line: int | None = None
    column: int | None = None


class MetamodelLintResponse(BaseModel):
    """Cheap parse/schema check for the live editor (Phase 5). Always 200 —
    a failed parse is the RESULT, not an error."""

    ok: bool
    errors: list[LintErrorOut] = Field(default_factory=list)
```

- [ ] **Step 4: Add the route to `routes/metamodel_swap.py`**

Extend the schemas import to `from ..schemas import IssueOut, LintErrorOut, MetamodelDiffResponse, MetamodelLintResponse, RebindResponse`. Add after `diff_metamodel` (route order does not matter — distinct paths):

```python
@router.post("/metamodel/lint")
async def lint_metamodel(
    request: Request,
    membership: Membership = Depends(require_membership),
) -> MetamodelLintResponse:
    """Parse + metamodel-schema check ONLY — no session, no model, no
    ``write_mutex`` — cheap enough for the editor's debounced calls. It
    deliberately takes no ``Session`` dependency, so a cold project is not
    even hydrated. NOT in the read-only-POST allowlist: only the
    owner-gated editing flow calls it, and viewers have nothing to lint.
    """
    blob = await _read_metamodel_blob(request)
    try:
        load_metamodel_str(blob)
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        return MetamodelLintResponse(
            ok=False,
            errors=[
                LintErrorOut(
                    message=str(exc),
                    line=mark.line + 1 if mark is not None else None,
                    column=mark.column + 1 if mark is not None else None,
                )
            ],
        )
    except MetamodelError as exc:
        return MetamodelLintResponse(ok=False, errors=[LintErrorOut(message=str(exc))])
    return MetamodelLintResponse(ok=True)
```

(`yaml`, `MetamodelError`, `load_metamodel_str`, `require_membership`, `Membership`, `Request` are all already imported in that module.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_metamodel_lint.py tests/api/test_metamodel_raw.py -v`
Expected: all pass.

- [ ] **Step 6: Run the full backend suite, lint, commit**

Run: `pixi run core-test` — expected: no new failures (pre-existing flake: `tests/model/test_search_index.py::test_string_properties_indexed_non_strings_ignored` ~0.8%; rerun if it trips).

```bash
pixi run backend-lint
git add src/data_rover/api/schemas.py src/data_rover/api/routes/metamodel_swap.py tests/api/test_metamodel_lint.py
git commit -m "feat(api): POST /metamodel/lint cheap parse/schema check"
```

---

### Task 3: Frontend API — zod types + client functions

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (add three schemas after `RebindSchema`, ~line 363)
- Modify: `frontend/src/lib/api/metamodel.ts` (two functions)
- Test: `frontend/src/lib/api/__tests__/metamodel.test.ts` (extend)

**Interfaces:**
- Consumes: `apiFetch(path, init, cfg)` from `./client`, msw `server` from `./__tests__/server`.
- Produces (later tasks import these):
  - `RawMetamodelSchema` / `type RawMetamodel = { blob: string; source: 'stored' | 'serialized' }`
  - `MetamodelLintErrorSchema` / `type MetamodelLintError = { message: string; line: number | null; column: number | null }`
  - `MetamodelLintSchema` / `type MetamodelLint = { ok: boolean; errors: MetamodelLintError[] }`
  - `getMetamodelRaw(cfg?: ClientConfig): Promise<RawMetamodel>`
  - `lintMetamodel(body: string, cfg?: ClientConfig): Promise<MetamodelLint>`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/api/__tests__/metamodel.test.ts` (inside the existing `describe('metamodel client', ...)`; the file already imports `http`, `HttpResponse`, `server`, `BASE`, `cfg` — extend the top import from `'../metamodel'` with `getMetamodelRaw, lintMetamodel`):

```ts
	it('getMetamodelRaw parses blob + source', async () => {
		server.use(
			http.get(`${BASE}/metamodel/raw`, () =>
				HttpResponse.json({ blob: '# hi\nelements: []\n', source: 'stored' })
			)
		);
		const res = await getMetamodelRaw(cfg);
		expect(res.blob).toContain('# hi');
		expect(res.source).toBe('stored');
	});

	it('lintMetamodel posts YAML and parses errors with nullable position', async () => {
		server.use(
			http.post(`${BASE}/metamodel/lint`, async ({ request }) => {
				expect(request.headers.get('content-type')).toContain('application/x-yaml');
				expect(await request.text()).toBe('elements: [ {');
				return HttpResponse.json({
					ok: false,
					errors: [{ message: 'bad flow mapping', line: 1, column: 13 }]
				});
			})
		);
		const res = await lintMetamodel('elements: [ {', cfg);
		expect(res.ok).toBe(false);
		expect(res.errors[0].line).toBe(1);
	});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/metamodel.test.ts'`
Expected: FAIL — `getMetamodelRaw` is not exported.

- [ ] **Step 3: Add the schemas to `types.ts`**

After `RebindSchema`/`export type Rebind` (~line 363):

```ts
export const RawMetamodelSchema = z.object({
	blob: z.string(),
	source: z.enum(['stored', 'serialized'])
});
export type RawMetamodel = z.infer<typeof RawMetamodelSchema>;

export const MetamodelLintErrorSchema = z.object({
	message: z.string(),
	line: z.number().int().nullable().default(null),
	column: z.number().int().nullable().default(null)
});
export type MetamodelLintError = z.infer<typeof MetamodelLintErrorSchema>;

export const MetamodelLintSchema = z.object({
	ok: z.boolean(),
	errors: z.array(MetamodelLintErrorSchema).default([])
});
export type MetamodelLint = z.infer<typeof MetamodelLintSchema>;
```

- [ ] **Step 4: Add the client functions to `metamodel.ts`**

Extend the types import with `RawMetamodelSchema, MetamodelLintSchema` and the type import with `RawMetamodel, MetamodelLint`, then:

```ts
export function getMetamodelRaw(cfg?: ClientConfig): Promise<RawMetamodel> {
	return apiFetch('/metamodel/raw', { method: 'GET', schema: RawMetamodelSchema }, cfg);
}

export function lintMetamodel(body: string, cfg?: ClientConfig): Promise<MetamodelLint> {
	const init: ApiFetchInit = {
		method: 'POST',
		body,
		schema: MetamodelLintSchema,
		headers: { 'Content-Type': 'application/x-yaml' }
	};
	return apiFetch('/metamodel/lint', init, cfg);
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/api/__tests__/metamodel.test.ts'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/api/metamodel.ts frontend/src/lib/api/__tests__/metamodel.test.ts
git commit -m "feat(ui): api client + zod types for metamodel raw/lint"
```

---

### Task 4: Workspace store — `metamodel` tab kind + singleton open

**Files:**
- Modify: `frontend/src/lib/state/workspace.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts` (barrel: add `openMetamodelTab` to the workspace block, lines 120–135)
- Test: `frontend/src/lib/state/__tests__/workspace.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `DynamicTab.kind` union widened to `'navigation' | 'table' | 'snippet' | 'metamodel'`; `openMetamodelTab(): string` (returns/focuses the singleton tab id `'mm:editor'`); the metamodel tab persists in `ui.workspace.tabs.<projectId>` despite `artifactId: null`. `openArtifactTab`'s parameter type stays the 3-kind union (metamodel opens ONLY via `openMetamodelTab`).

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/state/__tests__/workspace.test.ts` (add `openMetamodelTab` to the existing import from `'../workspace.svelte'`):

```ts
describe('metamodel singleton tab', () => {
	it('opens once and focuses on reopen', () => {
		initWorkspaceTabs('p1');
		const id = openMetamodelTab();
		expect(id).toBe('mm:editor');
		expect(getDynamicTabs()).toHaveLength(1);
		setActiveTab('detail');
		expect(openMetamodelTab()).toBe(id);
		expect(getDynamicTabs()).toHaveLength(1);
		expect(getActiveTab()).toBe(id);
	});

	it('persists across init despite having no artifact', () => {
		initWorkspaceTabs('p1');
		openMetamodelTab();
		resetWorkspaceTabs();
		initWorkspaceTabs('p1');
		expect(getDynamicTabs().map((t) => t.kind)).toContain('metamodel');
	});

	it('closes like any tab', () => {
		initWorkspaceTabs('p1');
		const id = openMetamodelTab();
		closeTab(id);
		expect(getDynamicTabs()).toEqual([]);
		expect(getActiveTab()).toBe('detail');
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/workspace.test.ts'`
Expected: FAIL — `openMetamodelTab` not exported.

- [ ] **Step 3: Implement in `workspace.svelte.ts`**

1. Widen the interface: `kind: 'navigation' | 'table' | 'snippet' | 'metamodel';` in `DynamicTab`. Leave `openArtifactTab(kind: 'navigation' | 'table' | 'snippet', ...)` as-is.
2. `const PREFIX = { navigation: 'nav', table: 'tbl', snippet: 'snip', metamodel: 'mm' } as const;`
3. Add:

```ts
const METAMODEL_TAB_ID = 'mm:editor';

/** Open (or focus) the singleton metamodel editor tab. Not artifact-backed;
 * dedupe is by KIND, which is why it does not go through openArtifactTab. */
export function openMetamodelTab(): string {
	const existing = _tabs.find((t) => t.kind === 'metamodel');
	if (existing) {
		_activeTab = existing.id;
		persist();
		return existing.id;
	}
	_tabs = [..._tabs, { id: METAMODEL_TAB_ID, kind: 'metamodel', artifactId: null, title: 'Metamodel' }];
	_activeTab = METAMODEL_TAB_ID;
	persist();
	return METAMODEL_TAB_ID;
}
```

4. Persistence: change `persistable` to

```ts
function persistable(t: DynamicTab): boolean {
	// The metamodel tab has no artifact but is a stable singleton — restoring
	// it is cheap and its draft persists independently (ui.metamodel.draft.*).
	if (t.kind === 'metamodel') return true;
	return t.artifactId !== null && !isTempId(t.artifactId);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/workspace.test.ts'`
Expected: PASS (including all pre-existing cases).

- [ ] **Step 5: Barrel + commit**

Add `openMetamodelTab,` (alphabetical position) to the workspace export block in `frontend/src/lib/state/index.ts`.

```bash
git add frontend/src/lib/state/workspace.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/workspace.test.ts
git commit -m "feat(ui): metamodel workspace tab kind + singleton open"
```

---

### Task 5: Frontend state — `metamodel-editor.svelte.ts`

**Files:**
- Create: `frontend/src/lib/state/metamodel-editor.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts` (new barrel block)
- Test: `frontend/src/lib/state/__tests__/metamodel-editor.test.ts` (create)

**Interfaces:**
- Consumes: `getMetamodelRaw`, `lintMetamodel`, `diffMetamodel`, `rebindMetamodel` from `$lib/api/metamodel`; `ApiError` from `$lib/api`; `acquireMetamodelLease`, `dropMetamodelLease`, `getMetamodelLockHolder` from `./metamodel-lease.svelte`; `getRole` from `./checkout.svelte`; `getModelRev` from `./model.svelte`; `isProjectQuiet` from `./quiet`; types `MetamodelDiff`, `MetamodelLintError`, `Rebind` from `$lib/api/types`.
- Produces (all re-exported through the barrel; MetamodelTab and unsaved.ts consume these):
  - `initMetamodelEditor(projectId: string): Promise<void>`
  - `editMetamodelBuffer(code: string): void`
  - `previewMetamodelChanges(): Promise<void>`
  - `commitMetamodelRebind(message: string): Promise<Rebind | null>` (null on refusal/failure; the CALLER does the post-success global refresh)
  - `discardMetamodelDraft(): void`
  - `retryMetamodelLease(): void`
  - `closeMetamodelEditor(): void` (tab close/unmount: flush draft, release lease, reset to idle)
  - `resetMetamodelEditor(): void` (tests)
  - `isMetamodelEditorDirty(): boolean`
  - `getMetamodelEditor(): MetamodelEditorView`
  - `METAMODEL_LINT_DEBOUNCE_MS = 500`, `METAMODEL_DRAFT_DEBOUNCE_MS = 500`
  - `interface MetamodelEditorView { phase: 'idle' | 'loading' | 'ready' | 'error'; loadError: string | null; source: 'stored' | 'serialized'; buffer: string; dirty: boolean; readOnly: boolean; lockedBy: string | null; draftRestored: boolean; lintErrors: MetamodelLintError[]; preview: MetamodelDiff | null; previewCurrent: boolean; previewing: boolean; previewError: string | null; rebinding: boolean; rebindError: string | null }`

- [ ] **Step 1: Read `frontend/README.md`** (mandatory before touching `frontend/src/lib/state/`).

- [ ] **Step 2: Write the failing tests**

Create `frontend/src/lib/state/__tests__/metamodel-editor.test.ts`. Follow `checkout.metamodel.test.ts`'s spy style (`vi.spyOn` on api modules — it patches the module record the lease module imports). Skeleton with the full case list:

```ts
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { resetCheckout, setProjectInfo } from '../checkout.svelte';
import {
	closeMetamodelEditor,
	commitMetamodelRebind,
	discardMetamodelDraft,
	editMetamodelBuffer,
	getMetamodelEditor,
	initMetamodelEditor,
	isMetamodelEditorDirty,
	METAMODEL_DRAFT_DEBOUNCE_MS,
	METAMODEL_LINT_DEBOUNCE_MS,
	previewMetamodelChanges,
	resetMetamodelEditor,
	retryMetamodelLease
} from '../metamodel-editor.svelte';
import * as mmApi from '$lib/api/metamodel';
import * as lockApi from '$lib/api/checkout';
import { ConflictError } from '$lib/api/errors';

const BASE = '# base\nelements: []\n';
const LEASE = {
	token: 't-mm',
	leases: [
		{
			resource_id: 'mm',
			mode: 'exclusive',
			holder: 'default-user',
			holder_email: 'default@example.com',
			intent: 'edit',
			expires_in: 300
		}
	]
};

beforeEach(() => {
	localStorage.clear();
	resetCheckout();
	resetMetamodelEditor();
	setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
	vi.spyOn(mmApi, 'getMetamodelRaw').mockResolvedValue({ blob: BASE, source: 'stored' });
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
```

Cases (each an `it`; write them all):
1. **init loads the baseline** — `await initMetamodelEditor('p1')`; `getMetamodelEditor()` has `phase: 'ready'`, `buffer === BASE`, `dirty === false`, `draftRestored === false`.
2. **init failure → error phase** — `getMetamodelRaw` rejects; `phase === 'error'`, `loadError` set.
3. **edit marks dirty and acquires the lease once** — spy `vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE)`; init, `editMetamodelBuffer(BASE + 'x')`, `editMetamodelBuffer(BASE + 'xy')`; await a microtask (`await Promise.resolve()`); expect `acquireLocks` called exactly once and `isMetamodelEditorDirty()` true.
4. **lease conflict → readOnly with holder, typed chars kept** — `acquireLocks` rejects with `new ConflictError(409, { conflicts: [{ resource_id: 'mm', held_by: 'u2', held_by_email: 'peer@example.com' }] }, 'conflict')`; after edit + flush microtasks: `readOnly === true`, `lockedBy === 'peer@example.com'`, `buffer` still contains the typed suffix; a further `editMetamodelBuffer` call is IGNORED (buffer unchanged).
5. **retry after conflict re-attempts** — same as 4, then make `acquireLocks` resolve `LEASE`; `retryMetamodelLease()`; flush; `readOnly === false`, `lockedBy === null`.
6. **draft persistence** — fake timers; init, edit, `vi.advanceTimersByTime(METAMODEL_DRAFT_DEBOUNCE_MS)`; expect `localStorage.getItem('ui.metamodel.draft.p1')` to equal the buffer. Then `resetMetamodelEditor()` (keeps storage), re-init → `draftRestored === true`, `buffer` is the draft, `dirty === true`.
7. **discard restores baseline, clears storage, releases lease** — spy `lockApi.releaseLock`; after a held edit, `discardMetamodelDraft()`; buffer === BASE, storage key null, `releaseLock` called.
8. **lint debounces and stores errors** — fake timers; spy `mmApi.lintMetamodel` resolving `{ ok: false, errors: [{ message: 'bad', line: 2, column: 1 }] }`; two rapid edits then `vi.advanceTimersByTime(METAMODEL_LINT_DEBOUNCE_MS)`; flush microtasks (`await vi.runAllTimersAsync()` or advance + `await Promise.resolve()` twice); `lintMetamodel` called once, `lintErrors` length 1. A rejected lint call clears `lintErrors` and does not throw.
9. **preview + invalidation** — spy `mmApi.diffMetamodel` resolving a minimal `MetamodelDiff` (`{ now_failing: [], now_passing: [], unchanged_count: 0, current_error_count: 0, candidate_error_count: 0, structural: { enums: { added: [], removed: [], changed: [] }, element_types: { added: [], removed: [], changed: [] }, relationship_types: { added: [], removed: [], changed: [] } } }`); after edit + `await previewMetamodelChanges()`: `previewCurrent === true`; one more `editMetamodelBuffer` → `previewCurrent === false` (preview object retained).
10. **rebind success updates baseline, clears draft, releases lease, returns response** — spy `mmApi.rebindMetamodel` resolving `{ model_rev: 5, metamodel_id: 'mm2', validation_error_count: 0, issue_counts: {}, issues: [] }` and `lockApi.releaseLock`; edited + previewed state; `const res = await commitMetamodelRebind('msg')`; `res?.model_rev === 5`, `dirty === false`, storage cleared, `releaseLock` called.
11. **rebind 409 branches** — `rebindMetamodel` rejects with `new ConflictError(409, { detail: 'metamodel locked', holder_email: 'p@x.com' }, 'conflict')` → `rebindError` contains `p@x.com`; `{ detail: 'active locks; rebind requires a quiet project' }` → message contains 'not quiet'; `{ detail: 'stale base_rev', model_rev: 9 }` → message contains 're-run'. A 422 `ApiError` → 'invalid'.
12. **rebind refuses without a current preview** — edited but not previewed → `commitMetamodelRebind` returns null, `rebindMetamodelApi` never called.
13. **close mid-init is generation-guarded** — start `initMetamodelEditor` with a hanging promise (deferred), `closeMetamodelEditor()`, resolve; `phase` stays `'idle'`.

Use a local `function deferred<T>()` helper (same as `checkout.metamodel.test.ts`).

- [ ] **Step 3: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/metamodel-editor.test.ts'`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement `metamodel-editor.svelte.ts`**

```ts
import {
	diffMetamodel,
	getMetamodelRaw,
	lintMetamodel,
	rebindMetamodel as rebindMetamodelApi
} from '$lib/api/metamodel';
import { ApiError } from '$lib/api/errors';
import type { MetamodelDiff, MetamodelLintError, Rebind } from '$lib/api/types';
import {
	acquireMetamodelLease,
	dropMetamodelLease,
	getMetamodelLockHolder
} from './metamodel-lease.svelte';
import { getRole } from './checkout.svelte';
import { getModelRev } from './model.svelte';
import { isProjectQuiet } from './quiet';

/**
 * The live metamodel editor's state (Phase 5) — buffer, draft, lint,
 * preview, rebind. COMPOSES the `mm` lease module: the lease is acquired on
 * the first divergent edit and released on close/discard/successful rebind.
 * This module never re-implements lease logic and adds no competing guard
 * around lease calls (the lease module's generation guard is the only one
 * for that concern); `_gen` below guards only this module's OWN async
 * (init/lint/preview/rebind) against a closed surface.
 *
 * Draft safety: the dirty buffer mirrors to localStorage per project
 * (`ui.metamodel.draft.<projectId>`), debounced; it survives refreshes and
 * is cleared only by a successful rebind or an explicit discard. The lease
 * does NOT survive a refresh — it re-acquires on the next edit, so a
 * restored draft under a peer's lease opens read-only instead of fighting.
 */

export const METAMODEL_LINT_DEBOUNCE_MS = 500;
export const METAMODEL_DRAFT_DEBOUNCE_MS = 500;

type Phase = 'idle' | 'loading' | 'ready' | 'error';

export interface MetamodelEditorView {
	phase: Phase;
	loadError: string | null;
	source: 'stored' | 'serialized';
	buffer: string;
	dirty: boolean;
	readOnly: boolean;
	lockedBy: string | null;
	draftRestored: boolean;
	lintErrors: MetamodelLintError[];
	preview: MetamodelDiff | null;
	previewCurrent: boolean;
	previewing: boolean;
	previewError: string | null;
	rebinding: boolean;
	rebindError: string | null;
}

let _gen = 0;
let _projectId: string | null = null;
let _phase = $state<Phase>('idle');
let _loadError = $state<string | null>(null);
let _source = $state<'stored' | 'serialized'>('stored');
let _baseline = $state('');
let _buffer = $state('');
let _draftRestored = $state(false);
let _lintErrors = $state<MetamodelLintError[]>([]);
let _preview = $state<MetamodelDiff | null>(null);
let _previewFor = $state<string | null>(null);
let _previewing = $state(false);
let _previewError = $state<string | null>(null);
let _rebinding = $state(false);
let _rebindError = $state<string | null>(null);
let _lockedBy = $state<string | null>(null);
let _leaseHeld = false;
let _acquiring = false;
let _lintTimer: ReturnType<typeof setTimeout> | null = null;
let _draftTimer: ReturnType<typeof setTimeout> | null = null;

function draftKey(projectId: string): string {
	return `ui.metamodel.draft.${projectId}`;
}

// try/catch instead of a `browser` guard — the vitest alias stubs `browser`
// to false; `editor-size.ts` / `workspace.svelte.ts` set the precedent.
function readDraft(projectId: string): string | null {
	try {
		return localStorage.getItem(draftKey(projectId));
	} catch {
		return null;
	}
}

function writeDraftNow(): void {
	if (_projectId === null) return;
	try {
		if (_buffer === _baseline) localStorage.removeItem(draftKey(_projectId));
		else localStorage.setItem(draftKey(_projectId), _buffer);
	} catch {
		/* storage full/denied: the draft simply doesn't persist */
	}
}

function clearDraftStorage(): void {
	if (_projectId === null) return;
	try {
		localStorage.removeItem(draftKey(_projectId));
	} catch {
		/* ignore */
	}
}

function clearTimers(): void {
	if (_lintTimer !== null) clearTimeout(_lintTimer);
	if (_draftTimer !== null) clearTimeout(_draftTimer);
	_lintTimer = null;
	_draftTimer = null;
}

export function isMetamodelEditorDirty(): boolean {
	return _phase === 'ready' && _buffer !== _baseline;
}

function isReadOnly(): boolean {
	return _phase !== 'ready' || getRole() !== 'owner' || _lockedBy !== null;
}

export function getMetamodelEditor(): MetamodelEditorView {
	return {
		phase: _phase,
		loadError: _loadError,
		source: _source,
		buffer: _buffer,
		dirty: isMetamodelEditorDirty(),
		readOnly: isReadOnly(),
		lockedBy: _lockedBy,
		draftRestored: _draftRestored,
		lintErrors: _lintErrors,
		preview: _preview,
		previewCurrent: _preview !== null && _previewFor === _buffer,
		previewing: _previewing,
		previewError: _previewError,
		rebinding: _rebinding,
		rebindError: _rebindError
	};
}

export async function initMetamodelEditor(projectId: string): Promise<void> {
	const gen = ++_gen;
	_projectId = projectId;
	_phase = 'loading';
	_loadError = null;
	try {
		const raw = await getMetamodelRaw();
		if (gen !== _gen) return;
		_baseline = raw.blob;
		_source = raw.source;
		const draft = readDraft(projectId);
		if (draft !== null && draft !== raw.blob) {
			_buffer = draft;
			_draftRestored = true;
		} else {
			if (draft !== null) clearDraftStorage(); // stale: equals baseline
			_buffer = raw.blob;
			_draftRestored = false;
		}
		_phase = 'ready';
	} catch (e) {
		if (gen !== _gen) return;
		_loadError = e instanceof Error ? e.message : String(e);
		_phase = 'error';
	}
}

function maybeAcquireLease(): void {
	if (_leaseHeld || _acquiring || _buffer === _baseline) return;
	_acquiring = true;
	const gen = _gen;
	void acquireMetamodelLease().then((ok) => {
		_acquiring = false;
		if (gen !== _gen) return;
		if (ok) {
			_leaseHeld = true;
			_lockedBy = null;
		} else {
			// Conflict → read-only with the holder's label. A NON-conflict
			// refusal (transient network, etc.) leaves the editor editable:
			// the server honors the lease as backstop, and the next
			// keystroke retries the acquire.
			const holder = getMetamodelLockHolder();
			if (holder !== null) _lockedBy = holder;
		}
	});
}

function scheduleLint(): void {
	if (_lintTimer !== null) clearTimeout(_lintTimer);
	const gen = _gen;
	_lintTimer = setTimeout(() => {
		_lintTimer = null;
		lintMetamodel(_buffer).then(
			(res) => {
				if (gen !== _gen) return;
				_lintErrors = res.ok ? [] : res.errors;
			},
			() => {
				// Advisory: a failed lint call clears the gutter, never blocks.
				if (gen !== _gen) return;
				_lintErrors = [];
			}
		);
	}, METAMODEL_LINT_DEBOUNCE_MS);
}

function scheduleDraftWrite(): void {
	if (_draftTimer !== null) clearTimeout(_draftTimer);
	const gen = _gen;
	_draftTimer = setTimeout(() => {
		_draftTimer = null;
		if (gen !== _gen) return;
		writeDraftNow();
	}, METAMODEL_DRAFT_DEBOUNCE_MS);
}

export function editMetamodelBuffer(code: string): void {
	if (isReadOnly()) return;
	_buffer = code;
	_rebindError = null;
	scheduleDraftWrite();
	scheduleLint();
	maybeAcquireLease();
}

export function retryMetamodelLease(): void {
	_lockedBy = null;
	maybeAcquireLease();
}

export async function previewMetamodelChanges(): Promise<void> {
	if (_phase !== 'ready' || _previewing) return;
	const gen = _gen;
	const buf = _buffer;
	_previewing = true;
	_previewError = null;
	try {
		const diff = await diffMetamodel(buf);
		if (gen !== _gen) return;
		_preview = diff;
		_previewFor = buf;
	} catch (e) {
		if (gen !== _gen) return;
		_previewError =
			e instanceof ApiError && e.status === 422
				? 'The candidate metamodel is invalid.'
				: 'Preview failed; try again.';
	} finally {
		if (gen === _gen) _previewing = false;
	}
}

function rebindErrorMessage(e: unknown): string {
	// Ported verbatim from SwapMetamodelDrawer: three distinct 409 refusals
	// share one status, so branch on the exact structured detail.
	if (e instanceof ApiError && e.status === 409) {
		const body = (typeof e.body === 'object' && e.body ? e.body : {}) as {
			detail?: unknown;
			holder_email?: unknown;
		};
		const detail = typeof body.detail === 'string' ? body.detail : '';
		if (detail === 'metamodel locked') {
			const who =
				typeof body.holder_email === 'string' && body.holder_email
					? body.holder_email
					: 'another user';
			return `Metamodel locked by ${who}. Try again when they finish.`;
		}
		if (detail.startsWith('active locks')) {
			return 'The project is not quiet (a lock is active). Try again once edits are committed.';
		}
		return 'The model changed since you previewed — re-run the preview and try again.';
	}
	if (e instanceof ApiError && e.status === 422) return 'The candidate metamodel is invalid.';
	return 'Rebind failed; no changes were applied.';
}

export async function commitMetamodelRebind(message: string): Promise<Rebind | null> {
	const view = getMetamodelEditor();
	if (getRole() !== 'owner' || !isProjectQuiet() || !view.previewCurrent || _rebinding) {
		return null;
	}
	const gen = _gen;
	_rebinding = true;
	_rebindError = null;
	try {
		const res = await rebindMetamodelApi(_buffer, { baseRev: getModelRev(), message });
		if (gen !== _gen) return null;
		_baseline = _buffer;
		_preview = null;
		_previewFor = null;
		_draftRestored = false;
		clearDraftStorage();
		_leaseHeld = false;
		void dropMetamodelLease();
		return res;
	} catch (e) {
		if (gen !== _gen) return null;
		_rebindError = rebindErrorMessage(e);
		return null;
	} finally {
		if (gen === _gen) _rebinding = false;
	}
}

export function discardMetamodelDraft(): void {
	_buffer = _baseline;
	_draftRestored = false;
	_lintErrors = [];
	_preview = null;
	_previewFor = null;
	_rebindError = null;
	clearDraftStorage();
	if (_leaseHeld) {
		_leaseHeld = false;
		void dropMetamodelLease();
	}
}

/** Tab close / unmount: flush the pending draft write, release the lease,
 * reset to idle. The DRAFT deliberately survives (localStorage). */
export function closeMetamodelEditor(): void {
	writeDraftNow();
	_gen++;
	clearTimers();
	if (_leaseHeld) {
		_leaseHeld = false;
		void dropMetamodelLease();
	}
	_phase = 'idle';
	_lockedBy = null;
	_draftRestored = false;
	_preview = null;
	_previewFor = null;
	_previewError = null;
	_rebindError = null;
	_lintErrors = [];
	_acquiring = false;
}

/** Full reset for tests (does NOT touch the checkout registry). */
export function resetMetamodelEditor(): void {
	_gen++;
	clearTimers();
	_projectId = null;
	_phase = 'idle';
	_loadError = null;
	_source = 'stored';
	_baseline = '';
	_buffer = '';
	_draftRestored = false;
	_lintErrors = [];
	_preview = null;
	_previewFor = null;
	_previewing = false;
	_previewError = null;
	_rebinding = false;
	_rebindError = null;
	_lockedBy = null;
	_leaseHeld = false;
	_acquiring = false;
}
```

One subtlety for case 13 (`closeMetamodelEditor` during init): `writeDraftNow()` runs while `_projectId` is set and `_buffer === _baseline === ''` — it removes a nonexistent key, harmless.

- [ ] **Step 5: Run to verify pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/metamodel-editor.test.ts'`
Expected: all cases pass. If the lease-acquire microtask timing is flaky, `await Promise.resolve()` twice (the acquire chains two promises) or use `await vi.waitFor(...)`.

- [ ] **Step 6: Barrel + commit**

Add a new block to `frontend/src/lib/state/index.ts` (alphabetical position, after the `metamodel-lease.svelte` block at lines 203–207):

```ts
export {
	closeMetamodelEditor,
	commitMetamodelRebind,
	discardMetamodelDraft,
	editMetamodelBuffer,
	getMetamodelEditor,
	initMetamodelEditor,
	isMetamodelEditorDirty,
	METAMODEL_DRAFT_DEBOUNCE_MS,
	METAMODEL_LINT_DEBOUNCE_MS,
	previewMetamodelChanges,
	resetMetamodelEditor,
	retryMetamodelLease,
	type MetamodelEditorView
} from './metamodel-editor.svelte';
```

```bash
git add frontend/src/lib/state/metamodel-editor.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/metamodel-editor.test.ts
git commit -m "feat(ui): metamodel editor state module (draft, lease, preview, rebind)"
```

---

### Task 6: `MetamodelYamlEditor.svelte` (CodeMirror host)

**Files:**
- Modify: `frontend/package.json` (add `@codemirror/lang-yaml` devDependency)
- Create: `frontend/src/lib/components/Metamodel/MetamodelYamlEditor.svelte`
- Test: `frontend/src/lib/components/Metamodel/__tests__/metamodel-yaml-editor.test.ts` (create)

**Interfaces:**
- Consumes: `toCmDiagnostics(doc, diags)` from `$lib/editor/lint-map` (expects `{line: 1-based, col: 0-based, severity, message}` items), `editorLuxuryTheme` from `$lib/editor/theme`, `luxurySearch` from `$lib/editor/search-panel`, `MetamodelLintError` from `$lib/api/types`.
- Produces: component with props `{ code: string; errors?: MetamodelLintError[]; readOnly?: boolean; onChange: (code: string) => void }`. Host div has `data-testid="metamodel-editor"`. Null-`line` errors are NOT rendered here (the host tab shows them in a message strip); positioned errors go to the lint gutter.

- [ ] **Step 1: Install the YAML language package**

```bash
pixi run -e frontend bash -c 'cd frontend && npm install --save-dev @codemirror/lang-yaml'
```

- [ ] **Step 2: Write the failing test**

Create `frontend/src/lib/components/Metamodel/__tests__/metamodel-yaml-editor.test.ts` (pattern: `Snippet/__tests__/code-editor.test.ts` — CodeMirror mounts fine under happy-dom):

```ts
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import MetamodelYamlEditor from '../MetamodelYamlEditor.svelte';

afterEach(() => {
	document.body.innerHTML = '';
});

describe('MetamodelYamlEditor', () => {
	it('renders the document and reports edits via onChange', () => {
		const onChange = vi.fn();
		const c = mount(MetamodelYamlEditor, {
			target: document.body,
			props: { code: 'elements: []\n', onChange }
		});
		flushSync();
		try {
			const host = document.querySelector('[data-testid="metamodel-editor"]');
			expect(host).not.toBeNull();
			expect(host!.textContent).toContain('elements');
		} finally {
			unmount(c);
		}
	});

	it('readOnly blocks user edits at the CodeMirror level', () => {
		const onChange = vi.fn();
		const c = mount(MetamodelYamlEditor, {
			target: document.body,
			props: { code: 'elements: []\n', onChange, readOnly: true }
		});
		flushSync();
		try {
			const cmContent = document.querySelector('.cm-content');
			expect(cmContent?.getAttribute('contenteditable')).toBe('false');
		} finally {
			unmount(c);
		}
	});
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Metamodel/__tests__/metamodel-yaml-editor.test.ts'`
Expected: FAIL — component doesn't exist.

- [ ] **Step 4: Implement the component**

Create `frontend/src/lib/components/Metamodel/MetamodelYamlEditor.svelte`:

```svelte
<script lang="ts">
	import { untrack } from 'svelte';
	import { basicSetup } from 'codemirror';
	import { EditorView } from '@codemirror/view';
	import { Compartment, EditorState } from '@codemirror/state';
	import { yaml } from '@codemirror/lang-yaml';
	import { lintGutter, setDiagnostics } from '@codemirror/lint';
	import { toCmDiagnostics } from '$lib/editor/lint-map';
	import { editorLuxuryTheme } from '$lib/editor/theme';
	import { luxurySearch } from '$lib/editor/search-panel';
	import type { MetamodelLintError } from '$lib/api/types';

	let {
		code,
		errors = [],
		readOnly = false,
		onChange
	}: {
		code: string;
		errors?: MetamodelLintError[];
		readOnly?: boolean;
		onChange: (code: string) => void;
	} = $props();

	let host: HTMLDivElement;
	let view: EditorView | undefined;
	const readOnlyCompartment = new Compartment();

	function readOnlyExt(ro: boolean) {
		return [EditorState.readOnly.of(ro), EditorView.editable.of(!ro)];
	}

	$effect(() => {
		view = untrack(
			() =>
				new EditorView({
					parent: host,
					doc: code,
					extensions: [
						basicSetup,
						yaml(),
						editorLuxuryTheme,
						luxurySearch,
						lintGutter(),
						readOnlyCompartment.of(readOnlyExt(readOnly)),
						EditorView.updateListener.of((u) => {
							if (u.docChanged) onChange(u.state.doc.toString());
						})
					]
				})
		);
		return () => view?.destroy();
	});

	// External replacement (baseline load / draft restore / discard) — never
	// user typing, which flows through the updateListener above.
	$effect(() => {
		if (view && code !== view.state.doc.toString()) {
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } });
		}
	});

	$effect(() => {
		if (view) view.dispatch({ effects: readOnlyCompartment.reconfigure(readOnlyExt(readOnly)) });
	});

	// Positioned errors → gutter diagnostics; null-line errors are the host's
	// job (message strip) — they have no anchor in the document.
	$effect(() => {
		if (!view) return;
		const positioned = errors
			.filter((e) => e.line !== null)
			.map((e) => ({
				line: e.line as number,
				col: Math.max(0, (e.column ?? 1) - 1),
				severity: 'error' as const,
				message: e.message
			}));
		view.dispatch(setDiagnostics(view.state, toCmDiagnostics(view.state.doc, positioned)));
	});
</script>

<div bind:this={host} class="h-full overflow-auto text-sm" data-testid="metamodel-editor"></div>
```

- [ ] **Step 5: Run to verify pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Metamodel/__tests__/metamodel-yaml-editor.test.ts'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/lib/components/Metamodel/
git commit -m "feat(ui): CodeMirror YAML editor host for the metamodel tab"
```

---

### Task 7: `MetamodelPreviewPanel.svelte` + restyle `MetamodelStructuralDiff` in place

**Files:**
- Create: `frontend/src/lib/components/Metamodel/MetamodelPreviewPanel.svelte`
- Modify: `frontend/src/lib/components/MetamodelStructuralDiff.svelte` (restyle only — no logic/prop change)
- Test: `frontend/src/lib/components/Metamodel/__tests__/metamodel-preview-panel.test.ts` (create)

**Interfaces:**
- Consumes: `MetamodelStructuralDiff.svelte` (prop `diff`), types `MetamodelDiff`, `IssueOut` from `$lib/api/types`, icons `AlertCircle`, `AlertTriangle` from `@lucide/svelte`.
- Produces: `MetamodelPreviewPanel` with props `{ diff: MetamodelDiff }` — renders the structural section, the counts line, and the now-failing/now-passing lists (CAP 200), all ported from the drawer's review step.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/Metamodel/__tests__/metamodel-preview-panel.test.ts`:

```ts
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import MetamodelPreviewPanel from '../MetamodelPreviewPanel.svelte';
import type { MetamodelDiff } from '$lib/api/types';

const EMPTY_STRUCTURAL = {
	enums: { added: [], removed: [], changed: [] },
	element_types: { added: [], removed: [], changed: [] },
	relationship_types: { added: [], removed: [], changed: [] }
};

function makeDiff(overrides: Partial<MetamodelDiff> = {}): MetamodelDiff {
	return {
		now_failing: [],
		now_passing: [],
		unchanged_count: 3,
		current_error_count: 1,
		candidate_error_count: 2,
		structural: EMPTY_STRUCTURAL,
		...overrides
	};
}

afterEach(() => {
	document.body.innerHTML = '';
});

describe('MetamodelPreviewPanel', () => {
	it('renders counts and the structural empty state', () => {
		const c = mount(MetamodelPreviewPanel, {
			target: document.body,
			props: { diff: makeDiff() }
		});
		flushSync();
		try {
			const text = document.body.textContent ?? '';
			expect(text).toContain('0 now failing');
			expect(text).toContain('0 now passing');
			expect(text).toContain('3 unchanged');
			expect(/no structural changes/i.test(text)).toBe(true);
		} finally {
			unmount(c);
		}
	});

	it('renders now-failing issues with target chips', () => {
		const c = mount(MetamodelPreviewPanel, {
			target: document.body,
			props: {
				diff: makeDiff({
					now_failing: [
						{
							severity: 'error',
							message: 'missing required label',
							target_ids: ['el-1'],
							category: 'conformance',
							origin: 'on_server'
						}
					]
				})
			}
		});
		flushSync();
		try {
			const text = document.body.textContent ?? '';
			expect(text).toContain('Now failing (1)');
			expect(text).toContain('missing required label');
			expect(text).toContain('el-1');
		} finally {
			unmount(c);
		}
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Metamodel/__tests__/metamodel-preview-panel.test.ts'`
Expected: FAIL — component doesn't exist.

- [ ] **Step 3: Implement the panel**

Create `frontend/src/lib/components/Metamodel/MetamodelPreviewPanel.svelte` — a direct port of the drawer's review-step markup (structural section, counts row, issue-list snippet), minus the rebind controls (those live in MetamodelTab):

```svelte
<script lang="ts">
	import { AlertCircle, AlertTriangle } from '@lucide/svelte';
	import MetamodelStructuralDiff from '../MetamodelStructuralDiff.svelte';
	import type { IssueOut, MetamodelDiff } from '$lib/api/types';

	type Props = { diff: MetamodelDiff };
	let { diff }: Props = $props();

	const CAP = 200;
</script>

<div class="flex flex-col gap-3 text-sm">
	<section class="flex flex-col gap-1">
		<h3 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
			Structural changes
		</h3>
		<MetamodelStructuralDiff diff={diff.structural} />
	</section>

	<div class="flex flex-wrap items-center gap-3 text-xs">
		<span class="text-destructive">{diff.now_failing.length} now failing</span>
		<span class="text-success">{diff.now_passing.length} now passing</span>
		<span class="text-muted-foreground">{diff.unchanged_count} unchanged</span>
		<span class="text-muted-foreground/70">
			errors {diff.current_error_count} → {diff.candidate_error_count}
		</span>
	</div>

	{@render section('Now failing', diff.now_failing, 'fail')}
	{@render section('Now passing', diff.now_passing, 'pass')}
</div>

{#snippet section(title: string, issues: IssueOut[], kind: 'fail' | 'pass')}
	{#if issues.length > 0}
		<section class="flex flex-col gap-1">
			<h3
				class="text-[10px] font-semibold uppercase tracking-wider {kind === 'fail'
					? 'text-destructive'
					: 'text-success'}"
			>
				{title} ({issues.length})
			</h3>
			<ul class="flex max-h-48 flex-col gap-1 overflow-auto">
				{#each issues.slice(0, CAP) as it (it.message + it.target_ids.join(','))}
					<li
						class="flex flex-col gap-1 rounded border border-border bg-muted/40 px-2 py-1.5 text-xs"
					>
						<div class="flex items-start gap-1.5">
							{#if it.severity === 'error'}
								<AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
							{:else}
								<AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
							{/if}
							<span class="flex-1 text-foreground/90">{it.message}</span>
						</div>
						{#if it.target_ids.length > 0}
							<div class="flex flex-wrap gap-1 pl-5">
								{#each it.target_ids as tid (tid)}
									<span
										class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
										title={tid}
									>
										{tid}
									</span>
								{/each}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
			{#if issues.length > CAP}
				<p class="text-[10px] text-muted-foreground/70">…and {issues.length - CAP} more</p>
			{/if}
		</section>
	{/if}
{/snippet}
```

Note the test above asserts `Now failing (1)` — the snippet only renders a section when non-empty, and the counts row always shows `0 now failing`, so both assertions hold.

- [ ] **Step 4: Restyle `MetamodelStructuralDiff.svelte` in place**

Constraints: NO prop or logic change; every text marker asserted by `frontend/src/lib/components/__tests__/MetamodelStructuralDiff.test.ts` must keep rendering (`No structural changes.`, `+ added`, `− removed`, names, `from → to` rows). Changes:

1. Wrap `typeSection`'s content in the same card style `changedType` already uses — change its `<section class="flex flex-col gap-1">` to `<section class="flex flex-col gap-0.5 rounded border border-border bg-muted/40 px-2 py-1.5">` and move the `<h4>` inside it unchanged.
2. Same card treatment for the Enums section (`<section class="flex flex-col gap-1">` → the card classes above).
3. Add a counts summary line at the top of the non-empty branch, before the sections:

```svelte
	{@const counts = [
		['element types', diff.element_types],
		['relationship types', diff.relationship_types],
		['enums', diff.enums]
	] as const}
	<p class="text-[10px] text-muted-foreground">
		{#each counts as [label, d] (label)}
			{#if d.added.length + d.removed.length + d.changed.length > 0}
				<span class="mr-3">
					{label}:
					{#if d.added.length}<span class="text-success">+{d.added.length}</span>{/if}
					{#if d.removed.length}<span class="text-destructive">−{d.removed.length}</span>{/if}
					{#if d.changed.length}<span class="text-foreground/80">~{d.changed.length}</span>{/if}
				</span>
			{/if}
		{/each}
	</p>
```

4. In `changedType`, render from→to values in mono: change `<p class="pl-2">{a.field}: {fmt(a.from)} → {fmt(a.to)}</p>` to `<p class="pl-2">{a.field}: <span class="font-mono">{fmt(a.from)}</span> → <span class="font-mono">{fmt(a.to)}</span></p>`, and the same for the `{p.name}.{f.field}` property-change row.

- [ ] **Step 5: Run to verify pass (both new and existing)**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Metamodel/__tests__/metamodel-preview-panel.test.ts src/lib/components/__tests__/MetamodelStructuralDiff.test.ts'`
Expected: PASS — including the untouched pre-existing structural-diff assertions.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/Metamodel/ frontend/src/lib/components/MetamodelStructuralDiff.svelte
git commit -m "feat(ui): metamodel preview panel; restyle structural diff in place"
```

---

### Task 8: `MetamodelTab.svelte`

**Files:**
- Create: `frontend/src/lib/components/Metamodel/MetamodelTab.svelte`
- Test: `frontend/src/lib/components/Metamodel/__tests__/metamodel-tab.test.ts` (create)

**Interfaces:**
- Consumes (all via `$lib/state` barrel): `getActiveProjectId`, `getMetamodelEditor`, `initMetamodelEditor`, `editMetamodelBuffer`, `previewMetamodelChanges`, `commitMetamodelRebind`, `discardMetamodelDraft`, `retryMetamodelLease`, `closeMetamodelEditor`, `getRole`, `isProjectQuiet`, `setIssues`, `setMetamodel`, `refreshSummary`; `getMetamodel as fetchMetamodel` from `$lib/api/metamodel`; components `MetamodelYamlEditor`, `MetamodelPreviewPanel`, `Button` from `$lib/components/ui/button`; `Issue` type from `$lib/api/types`.
- Produces: `<MetamodelTab />` (no props) — registered for the `metamodel` tab kind in Task 9.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/components/Metamodel/__tests__/metamodel-tab.test.ts`. Mock the state barrel-adjacent modules the component drives (spy on `$lib/api/metamodel.getMetamodelRaw` so `initMetamodelEditor` resolves; drive role via `setProjectInfo`):

```ts
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MetamodelTab from '../MetamodelTab.svelte';
import { resetCheckout, setProjectInfo } from '../../../state/checkout.svelte';
import { resetMetamodelEditor } from '../../../state/metamodel-editor.svelte';
import { setActiveProject } from '../../../state/active-project.svelte';
import * as mmApi from '$lib/api/metamodel';

const BASE = '# base\nelements: []\n';

beforeEach(() => {
	localStorage.clear();
	resetCheckout();
	resetMetamodelEditor();
	setActiveProject('p1');
	vi.spyOn(mmApi, 'getMetamodelRaw').mockResolvedValue({ blob: BASE, source: 'stored' });
});

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	flushSync();
}

describe('MetamodelTab', () => {
	it('owner sees Preview and Rebind controls', async () => {
		setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
		const c = mount(MetamodelTab, { target: document.body });
		await settle();
		try {
			const text = document.body.textContent ?? '';
			expect(text).toContain('Preview changes');
			expect(text).toContain('Rebind');
		} finally {
			unmount(c);
		}
	});

	it('non-owner gets the read-only notice and no rebind controls', async () => {
		setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
		const c = mount(MetamodelTab, { target: document.body });
		await settle();
		try {
			const text = document.body.textContent ?? '';
			expect(/read-only/i.test(text)).toBe(true);
			expect(text).not.toContain('Rebind');
		} finally {
			unmount(c);
		}
	});

	it('shows the load-error state with a retry button when raw fetch fails', async () => {
		setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
		vi.spyOn(mmApi, 'getMetamodelRaw').mockRejectedValue(new Error('boom'));
		const c = mount(MetamodelTab, { target: document.body });
		await settle();
		try {
			const text = document.body.textContent ?? '';
			expect(text).toContain("Couldn't load the metamodel");
			expect(text).toContain('Retry');
		} finally {
			unmount(c);
		}
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Metamodel/__tests__/metamodel-tab.test.ts'`
Expected: FAIL — component doesn't exist.

- [ ] **Step 3: Implement the component**

Create `frontend/src/lib/components/Metamodel/MetamodelTab.svelte`:

```svelte
<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import MetamodelYamlEditor from './MetamodelYamlEditor.svelte';
	import MetamodelPreviewPanel from './MetamodelPreviewPanel.svelte';
	import { getMetamodel as fetchMetamodel } from '$lib/api/metamodel';
	import type { Issue } from '$lib/api/types';
	import {
		closeMetamodelEditor,
		commitMetamodelRebind,
		discardMetamodelDraft,
		editMetamodelBuffer,
		getActiveProjectId,
		getMetamodelEditor,
		getRole,
		initMetamodelEditor,
		isProjectQuiet,
		previewMetamodelChanges,
		refreshSummary,
		retryMetamodelLease,
		setIssues,
		setMetamodel
	} from '$lib/state';

	const ed = $derived(getMetamodelEditor());
	const isOwner = $derived(getRole() === 'owner');
	// Same shared quiet rule as history Revert / the old swap drawer.
	const quiet = $derived(isProjectQuiet());
	/** First message-only lint error (no line anchor) for the strip below the
	 * editor; positioned errors render in the gutter instead. */
	const stripError = $derived(ed.lintErrors.find((e) => e.line === null) ?? null);

	let message = $state('');

	function init(): void {
		const pid = getActiveProjectId();
		if (pid !== null) void initMetamodelEditor(pid);
	}

	onMount(() => {
		init();
		// Unmount without a close transition must release the lease too — the
		// old drawer's known leak, fixed here by pairing mount with teardown.
		return () => closeMetamodelEditor();
	});

	function toIssue(o: { severity: string; message: string; target_ids: string[] }): Issue {
		return {
			severity: o.severity === 'warning' ? 'warning' : 'error',
			message: o.message,
			target_ids: o.target_ids,
			origin: 'on_server'
		};
	}

	async function onRebind(): Promise<void> {
		const res = await commitMetamodelRebind(message);
		if (res === null) return;
		const mm = await fetchMetamodel();
		setMetamodel(mm);
		setIssues(res.issues.map(toIssue));
		await refreshSummary();
		message = '';
	}
</script>

<div class="flex h-full min-h-0 flex-col gap-2 p-2">
	{#if ed.phase === 'loading' || ed.phase === 'idle'}
		<p class="text-sm text-muted-foreground">Loading metamodel…</p>
	{:else if ed.phase === 'error'}
		<div class="flex flex-col items-start gap-2">
			<p
				class="rounded border border-destructive/40 bg-destructive/15 px-2 py-1.5 text-sm text-destructive"
			>
				Couldn't load the metamodel: {ed.loadError}
			</p>
			<Button size="sm" variant="outline" onclick={init}>Retry</Button>
		</div>
	{:else}
		<div class="flex flex-wrap items-center gap-2 text-xs">
			{#if isOwner}
				<Button
					size="sm"
					disabled={ed.previewing || ed.readOnly}
					aria-busy={ed.previewing}
					onclick={() => void previewMetamodelChanges()}
				>
					{ed.previewing ? 'Previewing…' : 'Preview changes'}
				</Button>
				<input
					class="rounded bg-card px-2 py-1 text-xs text-foreground"
					bind:value={message}
					placeholder="Commit message (optional)"
				/>
				<Button
					size="sm"
					disabled={!quiet || !ed.previewCurrent || ed.rebinding || ed.readOnly}
					aria-busy={ed.rebinding}
					onclick={() => void onRebind()}
				>
					{ed.rebinding ? 'Rebinding…' : 'Rebind'}
				</Button>
				{#if ed.dirty}
					<Button size="sm" variant="ghost" onclick={discardMetamodelDraft}>Discard changes</Button>
				{/if}
			{:else}
				<p class="text-muted-foreground/70">
					The metamodel is read-only for your role. Only an owner can edit and rebind.
				</p>
			{/if}
			{#if ed.source === 'serialized'}
				<span class="text-muted-foreground/70" title="No stored source; showing a re-serialized document">
					re-serialized source
				</span>
			{/if}
		</div>

		{#if ed.lockedBy}
			<div
				class="flex items-center gap-2 rounded border border-warning/40 bg-warning/15 px-2 py-1.5 text-xs text-warning"
			>
				<span>Metamodel locked by {ed.lockedBy}. Your changes stay local until they finish.</span>
				<Button size="sm" variant="outline" onclick={retryMetamodelLease}>Retry</Button>
			</div>
		{/if}

		{#if ed.draftRestored}
			<p class="rounded border border-border bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
				Draft restored from your last session. “Discard changes” returns to the current metamodel.
			</p>
		{/if}

		{#if isOwner && !quiet && ed.dirty}
			<p class="text-xs text-warning">
				Commit or discard staged edits first — rebind needs a quiet project (no active locks).
			</p>
		{/if}

		<div class="min-h-0 flex-1">
			<MetamodelYamlEditor
				code={ed.buffer}
				errors={ed.lintErrors}
				readOnly={ed.readOnly}
				onChange={editMetamodelBuffer}
			/>
		</div>

		{#if stripError}
			<p
				class="max-h-24 overflow-auto whitespace-pre-wrap rounded border border-destructive/40 bg-destructive/15 px-2 py-1.5 text-xs text-destructive"
			>
				{stripError.message}
			</p>
		{/if}

		{#if ed.rebindError}
			<p
				class="rounded border border-destructive/40 bg-destructive/15 px-2 py-1.5 text-xs text-destructive"
			>
				{ed.rebindError}
			</p>
		{/if}

		{#if ed.previewError}
			<p
				class="rounded border border-destructive/40 bg-destructive/15 px-2 py-1.5 text-xs text-destructive"
			>
				{ed.previewError}
			</p>
		{/if}

		{#if ed.preview}
			<div class="max-h-72 overflow-auto border-t border-border pt-2">
				{#if !ed.previewCurrent}
					<p class="mb-1 text-[10px] text-muted-foreground/70">
						The buffer changed since this preview — re-run Preview before rebinding.
					</p>
				{/if}
				<MetamodelPreviewPanel diff={ed.preview} />
			</div>
		{/if}
	{/if}
</div>
```

Note `getActiveProjectId` must be re-exported through the barrel already — verify (`state/index.ts` exports from `./active-project.svelte`; if `getActiveProjectId` is missing there, add it to that block).

- [ ] **Step 4: Run to verify pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Metamodel/__tests__/metamodel-tab.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Metamodel/
git commit -m "feat(ui): MetamodelTab workspace surface"
```

---

### Task 9: Integration — workspace render/close, dirty marker, TopBar, palette; delete the drawer

**Files:**
- Modify: `frontend/src/lib/components/Workspace.svelte` (render switch + close hook)
- Modify: `frontend/src/lib/state/unsaved.ts` (`isTabDirty` metamodel arm)
- Modify: `frontend/src/lib/components/TopBar.svelte` (menu item; drop drawer)
- Modify: `frontend/src/lib/components/CommandPalette.svelte` (new action)
- Delete: `frontend/src/lib/components/SwapMetamodelDrawer.svelte`
- Delete: `frontend/src/lib/components/__tests__/SwapMetamodelDrawer.test.ts`
- Modify: `frontend/src/lib/components/__tests__/TopBar.test.ts`, `frontend/src/lib/components/__tests__/TopBar.strict.test.ts` (drop drawer expectations, cover the new item)
- Test: extend `frontend/src/lib/components/__tests__/CommandPalette.test.ts` only if it already asserts the full action list (otherwise leave).

**Interfaces:**
- Consumes: `openMetamodelTab` (Task 4), `closeMetamodelEditor`, `isMetamodelEditorDirty` (Task 5), `MetamodelTab` (Task 8).
- Produces: the `metamodel` tab kind renders `MetamodelTab`; closing it (button or `closeTab`) releases the lease; TopBar menu item **"Edit Metamodel"** replaces "Swap Metamodel"; palette action `action:edit-metamodel`; the drawer is gone from the tree.

- [ ] **Step 1: Workspace.svelte — render + close**

1. Import `MetamodelTab` (`import MetamodelTab from './Metamodel/MetamodelTab.svelte';`) and add `closeMetamodelEditor` to the `$lib/state` import.
2. In the close-button handler (lines ~44–58), add a branch:

```svelte
						if (tab.kind === 'table') closeTableDraft(tab.id);
						else if (tab.kind === 'snippet') closeSnippetDraft(tab.id);
						else if (tab.kind === 'metamodel') closeMetamodelEditor();
						else closeDraft(tab.id);
```

3. In the content switch (lines ~86–96), add before the `{:else}` arm:

```svelte
				{:else if tab.kind === 'metamodel'}
					<MetamodelTab />
```

(Note: `closeMetamodelEditor` is ALSO called by MetamodelTab's unmount teardown — closing the tab unmounts it. The double call is idempotent: the second sees `_leaseHeld === false` and an already-idle phase. The explicit branch keeps the close-path symmetric with other kinds and covers any future keep-alive rendering.)

- [ ] **Step 2: `unsaved.ts` — dirty marker**

Add the import and widen the signature:

```ts
import { isMetamodelEditorDirty } from './metamodel-editor.svelte';

export function isTabDirty(
	kind: 'navigation' | 'table' | 'snippet' | 'metamodel',
	tabId: string
): boolean {
	if (kind === 'metamodel') return isMetamodelEditorDirty();
	const draft = /* existing body unchanged */
```

Do NOT add a metamodel term to `hasUnsavedWork()` — the metamodel draft persists to localStorage and survives navigation, so leaving loses nothing. Add one sentence to `hasUnsavedWork`'s docstring saying exactly that.

- [ ] **Step 3: TopBar — replace the drawer entry**

1. Remove: line 38 `import SwapMetamodelDrawer ...`, line 41 `let swapOpen = $state(false);`, the `<SwapMetamodelDrawer bind:open={swapOpen} />` mount (~line 308).
2. Add `openMetamodelTab` to the `$lib/state` import block.
3. Replace the menu item (lines 292–294):

```svelte
				<DropdownMenu.Item disabled={metamodel === null} onclick={() => openMetamodelTab()}>
					Edit Metamodel
				</DropdownMenu.Item>
```

(`getMetamodel`/`metamodelFilename` stay — the status `<dl>` still uses them.)

- [ ] **Step 4: CommandPalette — new action**

Inside the existing `{#if getArtifactDialogsHosted()}` block (the established "workspace is mounted" gate), add after the import-artifacts item:

```svelte
				{#if getMetamodel() !== null}
					<Command.Item value="action:edit-metamodel" onSelect={actionEditMetamodel}>
						<span>Edit Metamodel</span>
					</Command.Item>
				{/if}
```

Add `getMetamodel, openMetamodelTab` to the `$lib/state` import, and next to the other `action*` handlers:

```ts
	function actionEditMetamodel(): void {
		openMetamodelTab();
		setCommandPaletteOpen(false);
	}
```

(Match the exact close-the-palette idiom of the neighboring handlers — if they use a shared helper instead of `setCommandPaletteOpen(false)`, use that helper.)

- [ ] **Step 5: Delete the drawer**

```bash
git rm frontend/src/lib/components/SwapMetamodelDrawer.svelte frontend/src/lib/components/__tests__/SwapMetamodelDrawer.test.ts
```

Then `grep -rn "SwapMetamodelDrawer" frontend/src` — expect zero hits.

- [ ] **Step 6: Update TopBar tests**

In `TopBar.test.ts` / `TopBar.strict.test.ts`: remove/replace any assertion referencing `SwapMetamodelDrawer`, `swapOpen`, or the "Swap Metamodel" label. Where a test asserted the menu item exists, assert the new label:

```ts
expect(document.body.textContent).toContain('Edit Metamodel');
```

If a test opened the drawer end-to-end, replace it with: click the item, then assert the workspace store gained the tab — `getDynamicTabs().some((t) => t.kind === 'metamodel')` (import from `../../state/workspace.svelte`, reset with `resetWorkspaceTabs()` in `beforeEach`).

- [ ] **Step 7: Run the full frontend suite + svelte-check**

Run: `pixi run frontend-test` — expected: all pass, no references to the deleted drawer.
Run: `pixi run frontend-check` — expected: clean.

- [ ] **Step 8: Commit**

```bash
git add -A frontend/src
git commit -m "feat(ui): open metamodel editor from topbar/palette; drop SwapMetamodelDrawer"
```

---

### Task 10: Full verification + merge

- [ ] **Step 1: Full test + lint sweep**

```bash
pixi run dr-tidy          # format + lint across frontend, core, backend — must be clean
pixi run core-test        # 1712+ passed expected (+9 new)
pixi run frontend-test    # 1840+ passed expected (+new)
pixi run frontend-check
pixi run -e frontend bash -c 'cd frontend && npm run lint'
```

All must pass. Known pre-existing flake: `tests/model/test_search_index.py::test_string_properties_indexed_non_strings_ignored` (~0.8%) — rerun once if it trips. If `dr-tidy` reformatted anything, commit as `style: apply formatter`.

- [ ] **Step 2: Manual smoke (optional but recommended)**

`pixi run backend-start` (needs `DATA_ROVER_DEV_SEED` + sqlite DSN) + `pixi run frontend-start`; open a project → TopBar → Edit Metamodel: verify baseline loads with comments, typing shows lint errors after a pause, Preview renders the structural + impact sections, Rebind lands and the tab stays open, refresh restores the draft.

- [ ] **Step 3: Merge (never push)**

```bash
git checkout main
git merge --no-ff feat/live-metamodel-editor -m "Merge branch 'feat/live-metamodel-editor'"
git branch -d feat/live-metamodel-editor
```

---

## Self-Review Notes (already applied)

- **Spec coverage**: raw endpoint (Task 1), lint endpoint (Task 2), client (Task 3), tab kind (Task 4), state module incl. lease-on-first-edit / conflict-keeps-chars / draft rules / preview invalidation / three 409 branches (Task 5), YAML editor (Task 6), preview panel + in-place restyle (Task 7), tab surface incl. read-only role, banners, unmount release (Task 8), TopBar/palette/deletion/dirty marker (Task 9). Out-of-scope items (initial-bind authoring, form editing, server drafts) have no tasks — correct.
- **Types**: `MetamodelEditorView` fields used by MetamodelTab match Task 5's interface; `openMetamodelTab` naming consistent across Tasks 4/8/9; lint error `{message, line, column}` consistent across Tasks 2/3/5/6.
- **Known risk**: exact microtask counts in async state tests (Task 5 cases 3–5) may need `vi.waitFor`; the plan says so. If `@codemirror/lang-yaml`'s version conflicts with the pinned `@codemirror/*` set, pick the latest 6.x compatible release.
