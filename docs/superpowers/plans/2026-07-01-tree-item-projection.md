# Tree-item projection: fast folder-open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make opening a view folder with ~1k elements on a large model feel instant by rendering the containment/view tree from a lightweight per-row projection instead of full-element payloads, and by prefetching a whole folder's rows in one request on expand.

**Architecture:** Add a `TreeItem` projection (`{id, type_name, display_name, child_count}`) served by a new by-ids endpoint (`POST /model/elements/tree-items`) and by the three existing containment-level endpoints (switched to a `TreeItemPage` shape). The frontend gains a `_treeItems` cache and an `ensureTreeItems` fetch; the sidebar tree renders from a merged map where full `_elements` (loaded on selection) win and lite items fill the rest. Full elements are fetched only on selection (already done by `DetailView`).

**Tech Stack:** Python 3.14 (pyright floor 3.10), FastAPI, Pydantic v2, pytest; SvelteKit 5 (runes), Zod, Vitest. All commands go through `pixi`.

## Global Constraints

- Python: runtime 3.14, but **pyright floor is 3.10** — import `Self`/`assert_never` from `typing_extensions`, not `typing`; no stdlib features newer than 3.10.
- All Python runs through pixi: `pixi run -e core-dev pytest ...`, lint via `pixi run lint-backend` (ruff + mypy + pyright must all pass).
- Frontend npm scripts MUST run from inside `frontend/`: `pixi run -e frontend bash -c 'cd frontend && npm test'` etc. The bare `pixi run -e frontend npm test` fails.
- API tests need no DB service (in-memory SQLite via `tests/api/conftest.py`); data-route tests use the `client` fixture + `seed_default_project` / `AUTH_HEADERS` / `papi` helpers; conftest pins `DATA_ROVER_IDENTITY_PROVIDER=header`.
- `MAX_PAGE_LIMIT = 500` (backend) mirrors `READ_PAGE_LIMIT = 500` (frontend). Requests above it are **rejected (422), not clamped**.
- Preserve the dense "why" docstrings/comments in the areas touched (immutability, mutation boundary, ordering contracts, lite-cache-defers-to-full invariant).
- Ordering contract for containment levels: **display-name then id ascending** — unchanged by this work.

---

## File map

**Backend**
- `src/data_rover/api/schemas.py` — add `TreeItem`, `TreeItemPage`.
- `src/data_rover/api/routes/read.py` — `_display_name` parity fix; `_tree_item()` helper; `POST /model/elements/tree-items`; switch the 3 containment endpoints to `TreeItemPage`.
- `src/data_rover/api/authz.py` — add `/model/elements/tree-items` to the read-only POST allowlist.
- Tests: `tests/api/test_read_endpoints.py` (or the existing read-endpoint test module), `tests/api/test_authz*.py`.

**Frontend**
- `frontend/src/lib/api/types.ts` — `TreeItemSchema`, `TreeItemPageSchema`, types; repoint containment page functions.
- `frontend/src/lib/api/model-read.ts` — `getTreeItemsBatch`; switch containment page functions to `TreeItemPage`.
- `frontend/src/lib/state/model.svelte.ts` — `_treeItems` cache, `getCachedTreeItems`, `seedTreeItems`, `ensureTreeItems`, `getTreeElements`, delete/remap eviction, reset clear.
- `frontend/src/lib/state/index.ts` — re-export the new store functions.
- `frontend/src/lib/components/Sidebar/ContainmentTree.svelte` — render from lite; whole-folder-on-expand prefetch; structural refresh.
- Tests: `frontend/src/lib/state/__tests__/model.*.test.ts`, `frontend/src/lib/components/Sidebar/*.test.ts`.

---

## Task 1: Backend `TreeItem`/`TreeItemPage` schema + display-name parity

**Files:**
- Modify: `src/data_rover/api/schemas.py` (after `ElementOut`, ~line 30)
- Modify: `src/data_rover/api/routes/read.py:416` (`_display_name`) and add `_tree_item()` near `_containment_item` (~line 443)
- Test: `tests/api/test_read_tree_items.py` (new)

**Interfaces:**
- Produces: `schemas.TreeItem(id: str, type_name: str, display_name: str, child_count: int)`, `schemas.TreeItemPage(items: list[TreeItem], total: int)`; `read._tree_item(model, element_id) -> TreeItem`; `read._display_name` now case-insensitive.

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_read_tree_items.py`:

```python
from data_rover.api.routes.read import _display_name, _tree_item
from data_rover.core.model.element import Element


def _el(eid, props, type_name="Thing"):
    return Element(id=eid, type_name=type_name, properties=props)


def test_display_name_is_case_insensitive():
    assert _display_name(_el("e1", {"name": "Alpha"})) == "Alpha"
    assert _display_name(_el("e2", {"Name": "Beta"})) == "Beta"
    assert _display_name(_el("e3", {"NAME": "Gamma"})) == "Gamma"
    # exact lowercase wins over other casings
    assert _display_name(_el("e4", {"Name": "cap", "name": "low"})) == "low"
    # empty / missing / non-string falls back to id
    assert _display_name(_el("e5", {"name": ""})) == "e5"
    assert _display_name(_el("e6", {})) == "e6"
    assert _display_name(_el("e7", {"name": 123})) == "e7"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_read_tree_items.py::test_display_name_is_case_insensitive -v`
Expected: FAIL — current `_display_name` only checks exact `"name"`, so `Name`/`NAME` cases return the id.

- [ ] **Step 3: Implement the schema + parity fix + helper**

In `src/data_rover/api/schemas.py`, add after the `ElementOut` class (before `RelationshipOut`):

```python
class TreeItem(BaseModel):
    """Lightweight tree-row projection: everything Sidebar/TreeRow.svelte
    renders for a row (display name, type, expand caret) WITHOUT the element's
    full ``properties`` bag. A ~1k-row folder ships as tens of KB instead of
    many MB, and the payload cost no longer scales with property size."""

    id: str
    type_name: str
    display_name: str
    child_count: int = 0


class TreeItemPage(BaseModel):
    items: list["TreeItem"] = Field(default_factory=list)
    #: number of items BEFORE limit/offset paging
    total: int = 0
```

In `src/data_rover/api/routes/read.py`, replace `_display_name` (line ~416) with the case-insensitive version and add `_tree_item` next to `_containment_item`:

```python
def _display_name(element: Element) -> str:
    """``elementDisplayName`` in lib/util/element-name.ts: the case-insensitive
    non-empty ``name`` property, else the id. An exact lowercase ``name`` wins
    over other casings (``Name``/``NAME``) — kept in lock-step with the client
    so a row's label is identical whether it comes from the lite (server) or
    full (client) source."""
    props = element.properties
    exact = props.get("name")
    if isinstance(exact, str) and exact:
        return exact
    for key, value in props.items():
        if key != "name" and key.lower() == "name" and isinstance(value, str) and value:
            return value
    return element.id


def _tree_item(model: Model, element_id: str) -> TreeItem:
    el = model.elements[element_id]
    return TreeItem(
        id=el.id,
        type_name=el.type_name,
        display_name=_display_name(el),
        child_count=len(_containment_child_ids(model, element_id)),
    )
```

Add `TreeItem, TreeItemPage` to the `from ..schemas import (...)` block in `read.py`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/api/test_read_tree_items.py::test_display_name_is_case_insensitive -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/routes/read.py tests/api/test_read_tree_items.py
git commit -m "feat(read): TreeItem projection schema + case-insensitive _display_name"
```

---

## Task 2: `POST /model/elements/tree-items` endpoint + authz allowlist

**Files:**
- Modify: `src/data_rover/api/routes/read.py` (add endpoint after `batch_elements`, ~line 301)
- Modify: `src/data_rover/api/authz.py:45` (`_READ_ONLY_POST_SUFFIXES`)
- Test: `tests/api/test_read_tree_items.py` (extend), `tests/api/` authz test

**Interfaces:**
- Consumes: `schemas.TreeItem` (Task 1), `MAX_PAGE_LIMIT`, `require_model`, `get_request_session`.
- Produces: `POST /model/elements/tree-items` body `{"ids": [...]}` → `{"items": [TreeItem, ...]}`; ids in request order, unknown ids omitted, 422 above `MAX_PAGE_LIMIT`.

- [ ] **Step 1: Write the failing test**

Append to `tests/api/test_read_tree_items.py` (uses the conftest `client`/`papi`/`AUTH_HEADERS` + `seed_default_project` helpers — mirror an existing test in `tests/api/` that seeds elements, e.g. how `test_read_endpoints`/batch tests build a model):

```python
def test_tree_items_endpoint_projects_and_omits_unknown(client, seed_default_project):
    # seed_default_project should install a model with elements "a" (name "Apple")
    # and "b" (no name). Follow the existing helper pattern in this test module /
    # conftest for seeding; if a bespoke model is needed, create it via the same
    # path the batch-endpoint test uses.
    resp = papi(client, "POST", "/model/elements/tree-items", json={"ids": ["a", "b", "nope"]})
    assert resp.status_code == 200
    items = resp.json()["items"]
    # unknown "nope" omitted; order preserved
    assert [i["id"] for i in items] == ["a", "b"]
    assert items[0]["display_name"] == "Apple"
    assert items[1]["display_name"] == "b"  # no name -> id
    assert set(items[0].keys()) == {"id", "type_name", "display_name", "child_count"}


def test_tree_items_endpoint_rejects_oversized_batch(client, seed_default_project):
    resp = papi(client, "POST", "/model/elements/tree-items", json={"ids": [str(i) for i in range(501)]})
    assert resp.status_code == 422
```

> Note for the implementer: match the exact seeding + request helpers already used by the `/model/elements/batch` test in this repo (`tests/api/`). Use `grep -rn "elements/batch" tests/api` to find the closest existing test and copy its fixture/setup shape verbatim so element ids and helpers line up.

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_read_tree_items.py -k endpoint -v`
Expected: FAIL — endpoint returns 404 (route not defined).

- [ ] **Step 3: Implement the endpoint + authz allowlist**

In `read.py`, after the `batch_elements` handler (~line 301), add:

```python
class TreeItemsIn(BaseModel):
    ids: list[str]


class TreeItemsOut(BaseModel):
    items: list[TreeItem]


@router.post("/model/elements/tree-items")
def batch_tree_items(
    payload: TreeItemsIn,
    session: Session = Depends(get_request_session),
) -> TreeItemsOut:
    """Lightweight by-id projection for tree rows (see :class:`TreeItem`).

    Same contract as ``POST /model/elements/batch`` — ids returned in request
    order (duplicates duplicated), unknown/deleted ids silently omitted (a
    stale window id must not fail the whole batch), capped at MAX_PAGE_LIMIT
    (422 above) — but ships ~4 short fields per row instead of the full
    ``properties`` bag."""
    _, model = require_model(session)
    if len(payload.ids) > MAX_PAGE_LIMIT:
        raise HTTPException(
            status_code=422,
            detail=f"too many ids: {len(payload.ids)} (max {MAX_PAGE_LIMIT})",
        )
    return TreeItemsOut(
        items=[_tree_item(model, eid) for eid in payload.ids if eid in model.elements]
    )
```

In `src/data_rover/api/authz.py`, add the suffix to `_READ_ONLY_POST_SUFFIXES`:

```python
_READ_ONLY_POST_SUFFIXES = (
    "/model/search",
    "/model/elements/batch",
    "/model/elements/tree-items",
    "/model/validate",
    "/commits/preview",
    "/metamodel/diff",
    "/clone",
)
```

- [ ] **Step 4: Add an authz test for viewer read access**

Find the existing authz test that asserts a viewer can call read-only POSTs (`grep -rn "elements/batch\|_READ_ONLY_POST\|viewer" tests/api`). Add an assertion that a viewer role gets a non-403 (200) from `POST /model/elements/tree-items`, mirroring the batch assertion exactly.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_read_tree_items.py -v && pixi run -e core-dev pytest tests/api -k "authz and (batch or tree)" -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/routes/read.py src/data_rover/api/authz.py tests/api
git commit -m "feat(read): POST /model/elements/tree-items lite by-id projection"
```

---

## Task 3: Switch the 3 containment endpoints to `TreeItemPage`

**Files:**
- Modify: `src/data_rover/api/routes/read.py` — `list_containment_roots`, `list_excluded_roots`, `list_containment_children` (return `TreeItemPage`, build items via `_tree_item`)
- Test: `tests/api/` existing containment endpoint tests

**Interfaces:**
- Produces: `GET /model/containment/roots`, `/model/containment/roots/excluded`, `GET /model/elements/{id}/children` now return `{"items": [TreeItem, ...], "total": int}` (flat rows, no nested `element`). Ordering unchanged (display-name then id).

- [ ] **Step 1: Update the containment endpoint tests first (they encode the old nested shape)**

Find the containment endpoint tests: `grep -rn "containment/roots\|/children\|child_count\|\"element\"" tests/api`. For each assertion that reads `item["element"]["id"]` / `item["element"]["type_name"]`, change to the flat shape: `item["id"]`, `item["type_name"]`, and add `item["display_name"]`. Keep `item["child_count"]` and `total` assertions. Keep the ordering assertions unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api -k containment -v`
Expected: FAIL — endpoints still return the nested `{"element": {...}, "child_count": ...}` shape.

- [ ] **Step 3: Switch the three endpoints to `TreeItemPage`**

In `read.py`, change each of the three handlers' return type from `ContainmentPage` to `TreeItemPage` and each `_containment_item(model, eid)` to `_tree_item(model, eid)`. Example for `list_containment_roots`:

```python
@router.get("/model/containment/roots")
def list_containment_roots(
    limit: int = Query(100, ge=1, le=MAX_PAGE_LIMIT),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_request_session),
) -> TreeItemPage:
    """Elements with no containment parent, sorted by display name then id.

    Display-name order (not insertion order) on purpose, exactly like
    ``list_containment_children``: it is the order ContainmentTree.svelte
    renders the root level in, and a paged client cannot re-sort a level it
    only holds one page of. Rows are the lite :class:`TreeItem` projection."""
    _, model = require_model(session)
    idx = model.indexes
    root_ids = [eid for eid in model.elements if idx.first_parent(eid) is None]
    root_ids.sort(key=lambda eid: (_display_name(model.elements[eid]), eid))
    return TreeItemPage(
        items=[_tree_item(model, eid) for eid in root_ids[offset : offset + limit]],
        total=len(root_ids),
    )
```

Apply the same two changes (`-> TreeItemPage`, `_tree_item`) to `list_excluded_roots` and `list_containment_children`. Update the `from ..schemas import (...)` block: remove `ContainmentItem, ContainmentPage` if now unused (run `grep -n "ContainmentItem\|ContainmentPage" src/data_rover/api/routes/read.py`); if unused everywhere, also delete `ContainmentItem`/`ContainmentPage` from `schemas.py` and `_containment_item` from `read.py`. If any other module still imports them, leave them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api -k containment -v`
Expected: PASS

- [ ] **Step 5: Lint the backend**

Run: `pixi run lint-backend`
Expected: ruff + mypy + pyright all clean (catches any dangling `ContainmentItem` import).

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/routes/read.py src/data_rover/api/schemas.py tests/api
git commit -m "feat(read): containment levels return lite TreeItemPage"
```

---

## Task 4: Frontend API — `TreeItem` types + `getTreeItemsBatch` + lite containment pages

**Files:**
- Modify: `frontend/src/lib/api/types.ts:330` (`ContainmentItemSchema`/`ContainmentPageSchema`)
- Modify: `frontend/src/lib/api/model-read.ts`
- Test: `frontend/src/lib/api/__tests__/model-read.test.ts` (or the closest existing api test)

**Interfaces:**
- Produces: `TreeItem = {id: string; type_name: string; display_name: string; child_count: number}`, `TreeItemPage = {items: TreeItem[]; total: number}`; `getTreeItemsBatch(ids: string[], cfg?) => Promise<TreeItem[]>`; `listContainmentRoots/Paged`, `listExcludedRoots/Paged`, `listContainmentChildren` now resolve `TreeItemPage`.

- [ ] **Step 1: Write the failing test**

In the api test file, add (adapt to the existing MSW/fetch-mock style in `frontend/src/lib/api/__tests__`):

```ts
import { getTreeItemsBatch } from '$lib/api/model-read';

it('getTreeItemsBatch posts ids and returns lite items', async () => {
  // mock POST /model/elements/tree-items -> { items: [{id, type_name, display_name, child_count}] }
  const items = await getTreeItemsBatch(['a', 'b']);
  expect(items.map((i) => i.id)).toEqual(['a', 'b']);
  expect(items[0]).toMatchObject({ display_name: expect.any(String), child_count: expect.any(Number) });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- model-read'`
Expected: FAIL — `getTreeItemsBatch` not exported.

- [ ] **Step 3: Add schemas + API functions**

In `types.ts`, add near `ContainmentItemSchema` (line ~330):

```ts
export const TreeItemSchema = z.object({
	id: z.string(),
	type_name: z.string(),
	display_name: z.string(),
	child_count: z.number().default(0)
});
export type TreeItem = z.infer<typeof TreeItemSchema>;

export const TreeItemPageSchema = z.object({
	items: z.array(TreeItemSchema).default([]),
	total: z.number().default(0)
});
export type TreeItemPage = z.infer<typeof TreeItemPageSchema>;
```

In `model-read.ts`:
- Add the batch fetch:

```ts
/**
 * POST /model/elements/tree-items — lite by-id projection for tree rows
 * (id, type_name, display_name, child_count). Ids come back in request order;
 * unknown/deleted ids are omitted. Caller must keep `ids.length <= READ_PAGE_LIMIT`.
 */
export function getTreeItemsBatch(ids: string[], cfg?: ClientConfig): Promise<TreeItem[]> {
	return apiFetch<TreeItemPage>(
		'/model/elements/tree-items',
		{ method: 'POST', body: { ids }, schema: TreeItemPageSchema },
		cfg
	).then((r) => r.items);
}
```

- Repoint the three containment functions + the two `*Paged` helpers from `ContainmentPageSchema`/`ContainmentPage` to `TreeItemPageSchema`/`TreeItemPage` (swap the imported symbol names and the generic types; the request/paging bodies are unchanged). Update the top-of-file imports: replace `ContainmentPageSchema, type ContainmentPage` with `TreeItemPageSchema, type TreeItem, type TreeItemPage`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- model-read'`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: no new type errors from `model-read.ts`/`types.ts` (ContainmentTree errors are expected until Task 7 — note them, don't fix yet).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/api/model-read.ts frontend/src/lib/api/__tests__
git commit -m "feat(api): TreeItem types + getTreeItemsBatch + lite containment pages"
```

---

## Task 5: Store — `_treeItems` cache, `seedTreeItems`, `ensureTreeItems`

**Files:**
- Modify: `frontend/src/lib/state/model.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts` (re-exports)
- Test: `frontend/src/lib/state/__tests__/model.tree-items.test.ts` (new)

**Interfaces:**
- Consumes: `getTreeItemsBatch` (Task 4), `READ_PAGE_LIMIT`, existing `_missingElementIds`, `_inFlightBatchIds`, `isTempId`.
- Produces: `getCachedTreeItems(): ReadonlyMap<string, TreeItem>`; `seedTreeItems(items: readonly TreeItem[]): void`; `ensureTreeItems(ids: readonly string[]): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/state/__tests__/model.tree-items.test.ts` (follow the existing `model.*.test.ts` setup — `resetModelStore`, `setModelApiConfig`, MSW or a stubbed client):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ensureTreeItems, getCachedTreeItems, seedTreeItems, resetModelStore, getMissingElementIds } from '$lib/state';

describe('tree-items cache', () => {
  beforeEach(() => resetModelStore());

  it('seedTreeItems upserts and clears missing', () => {
    seedTreeItems([{ id: 'a', type_name: 'T', display_name: 'A', child_count: 0 }]);
    expect(getCachedTreeItems().get('a')?.display_name).toBe('A');
  });

  it('ensureTreeItems skips cached/temp/in-flight and records omitted as missing', async () => {
    // stub the batch endpoint to return only "a" for ids ["a","gone"]
    // (wire via setModelApiConfig / MSW exactly like the ensureElements test)
    await ensureTreeItems(['a', 'gone']);
    expect(getCachedTreeItems().has('a')).toBe(true);
    expect(getMissingElementIds().has('gone')).toBe(true);
  });
});
```

> Implementer: copy the endpoint-stubbing mechanism from the existing `ensureElements` test (`grep -rn "ensureElements" frontend/src/lib/state/__tests__`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- tree-items'`
Expected: FAIL — `ensureTreeItems`/`seedTreeItems`/`getCachedTreeItems` not exported.

- [ ] **Step 3: Implement the cache + functions**

In `model.svelte.ts`, add the import and cache. Near the `import { getElement } ...` add `import { getTreeItemsBatch } from '../api/model-read';` (or extend the existing `modelReadApi` import — check how `modelReadApi` is imported and match it). Add a `TreeItem` type import from `../api/types`.

Add next to `_elements` / `_missingElementIds`:

```ts
/** Lite display cache for tree rows the user is only VIEWING (id →
 * {type_name, display_name, child_count}). Fed by the by-id tree-items batch
 * and by containment-level pages. Deliberately separate from `_elements`: the
 * moment an element is edited/created/arrives in a delta its FULL entry lands
 * in `_elements`, which `getTreeElements()` prefers — so this cache never needs
 * per-field patching, only eviction on delete and child_count refresh on a
 * structural change. */
const _treeItems = new SvelteMap<string, TreeItem>();

export function getCachedTreeItems(): ReadonlyMap<string, TreeItem> {
	return _treeItems;
}

/** Upsert lite rows (from containment pages / by-id batch) and un-mark any
 * that were previously recorded missing. */
export function seedTreeItems(items: readonly TreeItem[]): void {
	for (const t of items) {
		_treeItems.set(t.id, t);
		_missingElementIds.delete(t.id);
	}
}
```

Add `ensureTreeItems`, mirroring `ensureElements` but skipping ids already in EITHER cache and hitting the tree-items endpoint:

```ts
/**
 * Fetch the lite tree-row projection for `ids` (POST /model/elements/tree-items,
 * chunked at READ_PAGE_LIMIT) into `_treeItems`. Mirrors {@link ensureElements}:
 * dedups against both caches, temp ids, the shared in-flight set, and the
 * confirmed-missing set; ids the server omits are recorded missing so the tree
 * drops a dangling placement instead of holding a skeleton forever. Skips ids
 * already in `_elements` (a full entry already renders that row).
 */
export async function ensureTreeItems(ids: readonly string[]): Promise<void> {
	const want: string[] = [];
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const seen = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		if (
			_elements.has(id) ||
			_treeItems.has(id) ||
			isTempId(id) ||
			_missingElementIds.has(id) ||
			_inFlightBatchIds.has(id) ||
			_pendingElementFetches.has(id)
		)
			continue;
		want.push(id);
	}
	if (want.length === 0) return;
	for (const id of want) _inFlightBatchIds.add(id);
	try {
		for (let i = 0; i < want.length; i += modelReadApi.READ_PAGE_LIMIT) {
			const chunk = want.slice(i, i + modelReadApi.READ_PAGE_LIMIT);
			const fetched = await modelReadApi.getTreeItemsBatch(chunk, _clientConfig);
			seedTreeItems(fetched);
			// eslint-disable-next-line svelte/prefer-svelte-reactivity
			const returned = new Set(fetched.map((t) => t.id));
			for (const id of chunk) if (!returned.has(id)) _missingElementIds.add(id);
		}
	} finally {
		for (const id of want) _inFlightBatchIds.delete(id);
	}
}
```

> If `getTreeItemsBatch` is not on the `modelReadApi` namespace object, either add it there or call the directly-imported `getTreeItemsBatch`. Match whichever import style the file already uses for `getElementsBatch`.

In `resetModelStore` (find it: `grep -n "resetModelStore" model.svelte.ts`), add `_treeItems.clear();` alongside the existing `_elements.clear()` / `_missingElementIds.clear()`.

In `index.ts`, add `getCachedTreeItems, seedTreeItems, ensureTreeItems` to the re-export block that already lists `ensureElements`, `getCachedElements`, etc.

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- tree-items'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/model.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/model.tree-items.test.ts
git commit -m "feat(state): _treeItems lite cache + ensureTreeItems/seedTreeItems"
```

---

## Task 6: Store — `getTreeElements()` merged map + delete/remap eviction

**Files:**
- Modify: `frontend/src/lib/state/model.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts`
- Test: `frontend/src/lib/state/__tests__/model.tree-items.test.ts` (extend)

**Interfaces:**
- Consumes: `_elements`, `_treeItems`.
- Produces: `getTreeElements(): Map<string, Element>` — full `_elements` entries win; lite items appear as minimal `Element`s (`{id, type_name, properties, rev:0}`) so existing `Map<string, Element>` consumers (`buildUnifiedTree`, `computeVisibility`, `TreeRow`, `elementDisplayName`) work unchanged.

- [ ] **Step 1: Write the failing test**

Extend `model.tree-items.test.ts`:

```ts
import { getTreeElements, seedElements } from '$lib/state';

it('getTreeElements prefers full elements, synthesizes name from lite items', () => {
  seedTreeItems([{ id: 'lite', type_name: 'T', display_name: 'LiteName', child_count: 2 }]);
  seedElements([{ id: 'full', type_name: 'U', properties: { name: 'FullName' }, rev: 1 }]);
  const m = getTreeElements();
  expect(m.get('lite')?.properties.name).toBe('LiteName');
  expect(m.get('lite')?.type_name).toBe('T');
  expect(m.get('full')?.properties.name).toBe('FullName');
});

it('a display_name equal to the id synthesizes no name property', () => {
  seedTreeItems([{ id: 'x', type_name: 'T', display_name: 'x', child_count: 0 }]);
  expect(getTreeElements().get('x')?.properties.name).toBeUndefined();
});

it('full element wins over a lite item with the same id', () => {
  seedTreeItems([{ id: 'dup', type_name: 'LITE', display_name: 'lite', child_count: 0 }]);
  seedElements([{ id: 'dup', type_name: 'FULL', properties: { name: 'full' }, rev: 1 }]);
  const e = getTreeElements().get('dup');
  expect(e?.type_name).toBe('FULL');
  expect(e?.properties.name).toBe('full');
});

it('deleting an element via delta evicts its lite entry', () => {
  seedTreeItems([{ id: 'gone', type_name: 'T', display_name: 'G', child_count: 0 }]);
  applyDelta({ changed_elements: [], deleted_element_ids: ['gone'], changed_relationships: [], deleted_relationship_ids: [], model_rev: 1 } as never);
  expect(getCachedTreeItems().has('gone')).toBe(false);
});
```

> Implementer: import `applyDelta` and match the real `ModelDelta` field names (`grep -n "applyDelta" model.svelte.ts` and read the delta shape). Adjust the object literal to the exact type.

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- tree-items'`
Expected: FAIL — `getTreeElements` not exported; delete does not evict `_treeItems`.

- [ ] **Step 3: Implement the merged map + eviction**

In `model.svelte.ts`, add:

```ts
/**
 * The map the sidebar tree renders from: full `_elements` (loaded on selection
 * / arrived via deltas) take precedence; every other cached row appears as a
 * MINIMAL element synthesized from its lite `_treeItems` entry — just enough
 * for `elementDisplayName` (name prop or id), the type filter (`type_name`),
 * and presence checks (`map.has(id)`). The lite cache thus accelerates display
 * without ever masquerading in `_elements` itself (the Inspector still only
 * sees genuinely-loaded full elements).
 */
export function getTreeElements(): Map<string, Element> {
	const out = new Map<string, Element>();
	for (const [id, t] of _treeItems) {
		const properties = t.display_name && t.display_name !== id ? { name: t.display_name } : {};
		out.set(id, { id, type_name: t.type_name, properties, rev: 0 });
	}
	for (const [id, e] of _elements) out.set(id, e); // full wins
	return out;
}
```

In `applyDelta` (the block that does `for (const id of d.deleted_element_ids) _elements.delete(id);`), add `_treeItems.delete(id);` on the same loop:

```ts
for (const id of d.deleted_element_ids) {
	_elements.delete(id);
	_treeItems.delete(id);
}
```

In the temp→canonical remap (the loop that moves `_elements.get(tempId)` to `canonicalId`), evict the lite entry too so a just-created id doesn't keep a stale skeleton: after the `_elements` remap, add `_treeItems.delete(tempId);` (the canonical id will be seeded as a full element by the same delta).

Re-export `getTreeElements` from `index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- tree-items'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/model.svelte.ts frontend/src/lib/state/index.ts frontend/src/lib/state/__tests__/model.tree-items.test.ts
git commit -m "feat(state): getTreeElements merged map + lite eviction on delete/remap"
```

---

## Task 7: Wire `ContainmentTree.svelte` to the lite projection

**Files:**
- Modify: `frontend/src/lib/components/Sidebar/ContainmentTree.svelte`
- Test: `frontend/src/lib/components/Sidebar/view-tree-window.test.ts` / a component test as applicable

**Interfaces:**
- Consumes: `getTreeElements`, `ensureTreeItems`, `seedTreeItems`, `getCachedTreeItems` (Tasks 5–6); `TreeItem`, `TreeItemPage` (Task 4). Lite containment pages resolve `TreeItemPage` whose items are flat `TreeItem`s.

- [ ] **Step 1: Update the component (type + data-source switch)**

Make these edits in `ContainmentTree.svelte`:

1. Imports: change `import type { ContainmentItem, Element } from '$lib/api/types';` to `import type { TreeItem, Element } from '$lib/api/types';`. In the `$lib/state` import block, replace `ensureElements` with `ensureTreeItems`, `getCachedElements` with `getTreeElements`, and `seedElements` with `seedTreeItems`.

2. State declarations: `let roots: ContainmentItem[]` → `let roots: TreeItem[]`; `let excludedRoots: ContainmentItem[]` → `TreeItem[]`; `const childLevels = new SvelteMap<string, ContainmentItem[]>();` → `<string, TreeItem[]>`.

3. Fetch functions — replace the seed calls and drop `.element`:
   - `refreshRoots`: `seedElements(page.items.map((i) => i.element));` → `seedTreeItems(page.items);`
   - `refreshExcluded`: `seedElements(page.items.map((i) => i.element));` → `seedTreeItems(page.items);`
   - `fetchChildLevel`: `seedElements(cp.items.map((i) => i.element));` → `seedTreeItems(cp.items);`

4. Derivations — replace `i.element.id` with `i.id` and `getCachedElements()` with `getTreeElements()`:
   - `const elementsById = $derived(getCachedElements() as Map<string, Element>);` → `const elementsById = $derived(getTreeElements());`
   - `containmentChildren`: `items.map((i) => i.element.id)` → `items.map((i) => i.id)`
   - `rootElementIds`: `roots.map((i) => i.element.id)` → `roots.map((i) => i.id)`
   - `childCounts`: `m.set(i.element.id, i.child_count)` → `m.set(i.id, i.child_count)` (all three loops: roots, excludedRoots, childLevels)
   - `registerExcludedRoots(t, excludedRoots.map((i) => i.element.id))` → `.map((i) => i.id)`
   - child prefetch walk: `for (const c of childLevels.get(id) ?? []) next.push(c.element.id);` → `next.push(c.id);`
   - drag helper `const el = elementsById.get(ids[0]);` stays (merged map).

5. Windowed body fetch effect: `void ensureElements(ids);` → `void ensureTreeItems(ids);`.

- [ ] **Step 2: Typecheck**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: no type errors in `ContainmentTree.svelte` (the `.element` accesses and `ContainmentItem`/`Element` mismatches are resolved).

- [ ] **Step 3: Run the Sidebar tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- Sidebar'`
Expected: PASS. If a test asserted the old `.element` page shape or `seedElements` seeding, update it to the flat `TreeItem` shape / `seedTreeItems` (the tree-build tests use synthetic maps, so most are unaffected — only fetch-shape tests change).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/components/Sidebar/ContainmentTree.svelte frontend/src/lib/components/Sidebar
git commit -m "feat(sidebar): render containment/view tree from lite TreeItem projection"
```

---

## Task 8: Whole-folder prefetch on expand + structural refresh

**Files:**
- Modify: `frontend/src/lib/components/Sidebar/ContainmentTree.svelte`
- Test: `frontend/src/lib/components/Sidebar/*.test.ts` (new focused test if the harness supports it) or verify via the perf-sanity step in Task 9

**Interfaces:**
- Consumes: `getView`, `expandedFolders`, `findFolderByPath`, `ensureTreeItems`, `getStructureRev`, `getCachedTreeItems`.

**Rationale:** Today the tree ensures only the on-screen window's ids, so scrolling a folder flashes skeletons. Because a view folder is ≤1k and its element ids are already in the client's view, on expand we fetch the folder's ENTIRE placed set in one `ensureTreeItems` call — rows are then cached before they scroll into view.

- [ ] **Step 1: Add the whole-folder prefetch effect**

In `ContainmentTree.svelte`, after the windowed body-fetch effect, add a helper + effect. Use the view + `expandedFolders` to collect placed ids of every expanded folder (direct elements are enough — nested folders prefetch when themselves expanded):

```ts
// Whole-folder prefetch: when a view folder is expanded, pull the lite rows for
// ALL of its placed elements in one request (a folder is <=1k, so this is a
// single small batch) instead of letting the scroll window fetch them piecemeal
// — that piecemeal fetch is what flashes skeletons. Full elements still arrive
// only on selection; this only warms the display cache.
$effect(() => {
	const v = getView();
	if (v === null) return;
	const ids: string[] = [];
	for (const key of expandedFolders) {
		if (!isFolderKey(key)) continue;
		const folder = findFolderByPath(v, folderPathFromKey(key));
		if (folder) ids.push(...folder.elements);
	}
	if (ids.length > 0) void ensureTreeItems(ids);
});
```

Add `findFolderByPath` to the `$lib/state` (or `state/view-ops`) import — check where it lives: `grep -rn "export function findFolderByPath" frontend/src`. `folderPathFromKey` and `isFolderKey` are already imported from `./view-tree`.

- [ ] **Step 2: Add the structural-refresh of expanded folders**

`child_count` (and folder membership) can shift on a structural delta. `_structureRev` already drives a childLevels invalidation effect. Add a companion that re-warms expanded folders' lite rows after a structural change by dropping their `_treeItems` entries so `ensureTreeItems` refetches them. Simplest correct form — extend the existing structural effect (the one reading `getStructureRev()` that clears `childLevels`) to also clear the lite entries of currently-expanded folders' placed ids:

```ts
// (inside the existing effect that voids getStructureRev()/getModelGeneration()
//  and clears childLevels) — also drop lite rows for expanded folders so the
//  whole-folder prefetch effect above refetches fresh display_name/child_count.
const v = getView();
if (v !== null) {
	for (const key of expandedFolders) {
		if (!isFolderKey(key)) continue;
		const folder = findFolderByPath(v, folderPathFromKey(key));
		if (folder) dropTreeItems(folder.elements);
	}
}
```

Add a `dropTreeItems(ids: readonly string[])` to the store (`model.svelte.ts`, re-exported) that deletes each id from `_treeItems` (and from `_missingElementIds`, so a since-created id can be refetched):

```ts
/** Evict lite rows so a subsequent ensureTreeItems refetches them (used after a
 * structural change that may have altered display_name / child_count). */
export function dropTreeItems(ids: readonly string[]): void {
	for (const id of ids) {
		_treeItems.delete(id);
		_missingElementIds.delete(id);
	}
}
```

> Note: elements the user actually edited are already full entries in `_elements` (delta-fresh) and are unaffected by dropping lite rows — `getTreeElements` still returns them. Only view-only rows get refetched.

- [ ] **Step 3: Typecheck + Sidebar tests**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check && npm test -- Sidebar'`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/components/Sidebar/ContainmentTree.svelte frontend/src/lib/state/model.svelte.ts frontend/src/lib/state/index.ts
git commit -m "feat(sidebar): whole-folder prefetch on expand + structural refresh"
```

---

## Task 9: Full verification + perf sanity

**Files:** none (verification only)

- [ ] **Step 1: Backend suite + lint**

Run: `pixi run test-core && pixi run lint-backend`
Expected: all pass; no ruff/mypy/pyright errors.

- [ ] **Step 2: Frontend unit + check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test && npm run check'`
Expected: all pass.

- [ ] **Step 3: Frontend format/lint (tidy)**

Run: `pixi run tidy`
Expected: clean.

- [ ] **Step 4: Manual perf sanity (the actual acceptance check)**

Boot the stack (`pixi run start-backend`, `pixi run start-frontend`), import/open a large model with a view (see root `README.md` reset-to-clean-slate recipe), and open a folder with ~1k elements. In the browser Network panel confirm:
- Expanding the folder issues **one** `POST /model/elements/tree-items` request (plus at most the containment-children pages), each response small (tens of KB, no full `properties`).
- Scrolling the open folder issues **no** new per-row fetches and shows **no** placeholder flash.
- Selecting a row issues a single `GET /model/elements/{id}` (full element for the Inspector).

Record the before/after payload sizes in the PR description.

- [ ] **Step 5: Final commit / branch wrap-up**

Use `superpowers:finishing-a-development-branch` to open the PR. Include the perf-sanity numbers and note the endpoint contract changes (containment endpoints now return `TreeItemPage`).

---

## Self-review notes (coverage check)

- **Over-fetch fix** → Tasks 1–3 (backend lite projection) + Task 7 (frontend renders from lite).
- **Piecemeal-fetch/flash fix** → Task 8 (whole-folder prefetch on expand).
- **Prefer-full-cache render** → Task 6 (`getTreeElements` full-wins merge); selection still loads full via existing `DetailView` `ensureElement`.
- **Eviction on delete / remap** → Task 6.
- **child_count refresh on structural change** → Task 8.
- **display_name parity (case-insensitive)** → Task 1.
- **Missing/dangling ids, temp ids, cap overflow** → Task 5 (`ensureTreeItems` mirrors `ensureElements` guards) + Task 2 (422 cap).
- **Authz (viewer read access)** → Task 2 (allowlist + test).
- **Locks orthogonal** → untouched (lock badges come from `lockBadgeFor`, no code change needed).
