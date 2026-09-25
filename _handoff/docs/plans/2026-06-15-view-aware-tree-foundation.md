# View-aware Tree — Foundation & Curation Logic (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend endpoints, frontend API client, store batching, and pure tree/curation logic that the virtualized view-aware sidebar tree depends on — each piece fully unit-tested, with no UI rewiring yet.

**Architecture:** Two new read endpoints (batch element fetch; the "excluded" complement of view-placed roots) plus their typed frontend API wrappers; a batched `ensureElements` store helper to replace per-element window fetches; and pure transforms for positional placement/reorder and curated-scope tree assembly. Plan 2 (rendering) consumes all of this.

**Tech Stack:** Python / FastAPI / pytest (backend); TypeScript / SvelteKit / Vitest / MSW (frontend). Spec: `docs/superpowers/specs/2026-06-15-view-aware-virtualized-tree-design.md`.

**Conventions:**
- Backend tests run with `pixi run test-backend` (or `pytest tests/api/...`). API prefix is `/api/v1` (the `API` constant in `tests/api/test_read_routes.py`).
- Frontend tests run with `npm test` (vitest) from `frontend/`. API tests use MSW (`server` from `src/lib/api/__tests__/server.ts`).
- `docs/` is gitignored in this repo (specs/plans are kept local); the per-task commits below only add tracked source/test files.

---

### Task 1: Backend — batch element fetch endpoint

`POST /model/elements/batch` takes `{ids: [...]}` and returns the known elements in request order, silently omitting unknown/deleted ids; rejects > 500 ids with 422.

**Files:**
- Modify: `src/data_rover/api/routes/read.py`
- Test: `tests/api/test_read_routes.py`

- [ ] **Step 1: Write the failing tests**

Add to `tests/api/test_read_routes.py` (uses the existing `client` fixture, `_load_model`, `_item`, `API`):

```python
# ---------------------------------------------------------------------------
# POST /model/elements/batch
# ---------------------------------------------------------------------------


def test_elements_batch_returns_known_in_request_order_omits_unknown(
    client: TestClient,
) -> None:
    _load_model(client, [_item("a", "A"), _item("b", "B"), _item("c", "C")], [])
    res = client.post(
        f"{API}/model/elements/batch", json={"ids": ["c", "missing", "a"]}
    )
    assert res.status_code == 200, res.text
    ids = [e["id"] for e in res.json()["items"]]
    assert ids == ["c", "a"]  # request order preserved; unknown id dropped


def test_elements_batch_empty_ids_returns_empty(client: TestClient) -> None:
    _load_model(client, [_item("a", "A")], [])
    res = client.post(f"{API}/model/elements/batch", json={"ids": []})
    assert res.status_code == 200
    assert res.json()["items"] == []


def test_elements_batch_rejects_oversized(client: TestClient) -> None:
    _load_model(client, [_item("a", "A")], [])
    res = client.post(
        f"{API}/model/elements/batch",
        json={"ids": [str(n) for n in range(MAX_PAGE_LIMIT + 1)]},
    )
    assert res.status_code == 422


def test_elements_batch_404_without_model() -> None:
    reset_session()
    c = TestClient(create_app())
    c.post(
        f"{API}/metamodel",
        content=READ_MM,
        headers={"content-type": "application/x-yaml"},
    )
    res = c.post(f"{API}/model/elements/batch", json={"ids": ["a"]})
    assert res.status_code == 404  # no model loaded
```

Add `MAX_PAGE_LIMIT` to the imports at the top of the test file if not already present:

```python
from data_rover.api.routes.read import MAX_PAGE_LIMIT
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run test-backend tests/api/test_read_routes.py -k elements_batch -v`
Expected: FAIL — 404/405 (route does not exist) or ImportError for `MAX_PAGE_LIMIT`.

- [ ] **Step 3: Implement the endpoint**

In `src/data_rover/api/routes/read.py`, extend the fastapi import and add the pydantic import near the top:

```python
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
```

Add a request/response model after the `MAX_PAGE_LIMIT = 500` line:

```python
class BatchElementsIn(BaseModel):
    ids: list[str]


class ElementListOut(BaseModel):
    items: list[ElementOut]
```

Add the route (place it just after the `GET /model/elements` listing, before the neighborhood route):

```python
@router.post("/model/elements/batch")
def batch_elements(
    payload: BatchElementsIn,
    session: Session = Depends(get_session),
) -> ElementListOut:
    """Fetch many elements by id in one request. Ids are returned in request
    order; unknown/deleted ids are silently omitted (a stale window id must not
    fail the whole batch). Caps at MAX_PAGE_LIMIT ids (422 above)."""
    _, model = require_model(session)
    if len(payload.ids) > MAX_PAGE_LIMIT:
        raise HTTPException(
            status_code=422,
            detail=f"too many ids: {len(payload.ids)} (max {MAX_PAGE_LIMIT})",
        )
    items = [
        ElementOut.from_core(model.elements[eid])
        for eid in payload.ids
        if eid in model.elements
    ]
    return ElementListOut(items=items)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run test-backend tests/api/test_read_routes.py -k elements_batch -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/routes/read.py tests/api/test_read_routes.py
git commit -m "feat(api): POST /model/elements/batch for batched element reads"
```

---

### Task 2: Backend — excluded containment roots endpoint

`GET /model/containment/roots/excluded` returns containment roots NOT placed in the active view's folders, paged like `/model/containment/roots`. With no active view it returns all roots.

**Files:**
- Modify: `src/data_rover/api/routes/read.py`
- Test: `tests/api/test_read_routes.py`

- [ ] **Step 1: Write the failing tests**

Add to `tests/api/test_read_routes.py`:

```python
# ---------------------------------------------------------------------------
# GET /model/containment/roots/excluded
# ---------------------------------------------------------------------------


def _put_view(client: TestClient, folders: list[dict]) -> None:
    res = client.put(f"{API}/view/snapshot", json={"name": "v", "folders": folders})
    assert res.status_code == 200, res.text


def test_excluded_roots_omits_placed(client: TestClient) -> None:
    _load_model(
        client, [_item("a", "A"), _item("b", "B"), _item("c", "C")], []
    )
    _put_view(client, [{"name": "F", "folders": [], "elements": ["b"]}])
    res = client.get(f"{API}/model/containment/roots/excluded")
    assert res.status_code == 200, res.text
    body = res.json()
    assert [i["element"]["id"] for i in body["items"]] == ["a", "c"]
    assert body["total"] == 2


def test_excluded_roots_nested_folder_placement(client: TestClient) -> None:
    _load_model(client, [_item("a", "A"), _item("b", "B")], [])
    _put_view(
        client,
        [
            {
                "name": "F",
                "folders": [{"name": "G", "folders": [], "elements": ["a"]}],
                "elements": [],
            }
        ],
    )
    res = client.get(f"{API}/model/containment/roots/excluded")
    assert [i["element"]["id"] for i in res.json()["items"]] == ["b"]


def test_excluded_roots_no_view_returns_all_roots(client: TestClient) -> None:
    _load_model(client, [_item("a", "A"), _item("b", "B")], [])
    res = client.get(f"{API}/model/containment/roots/excluded")
    assert [i["element"]["id"] for i in res.json()["items"]] == ["a", "b"]
    assert res.json()["total"] == 2


def test_excluded_roots_paging(client: TestClient) -> None:
    _load_model(client, [_item(f"i{n}", f"n{n}") for n in range(5)], [])
    res = client.get(
        f"{API}/model/containment/roots/excluded", params={"limit": 2, "offset": 2}
    )
    body = res.json()
    assert [i["element"]["id"] for i in body["items"]] == ["i2", "i3"]
    assert body["total"] == 5
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run test-backend tests/api/test_read_routes.py -k excluded_roots -v`
Expected: FAIL — 404/405 (route does not exist).

- [ ] **Step 3: Implement the endpoint**

In `src/data_rover/api/routes/read.py`, add the core View import near the other core imports:

```python
from data_rover.core.view.schema import View
```

Add a placed-id collector and the route just after `list_containment_roots`:

```python
def _placed_element_ids(view: View) -> set[str]:
    """All element ids referenced anywhere in the view's folder tree."""
    out: set[str] = set()

    def walk(folders: list) -> None:  # list[Folder]
        for folder in folders:
            out.update(folder.elements)
            walk(folder.folders)

    walk(view.folders)
    return out


@router.get("/model/containment/roots/excluded")
def list_excluded_roots(
    limit: int = Query(100, ge=1, le=MAX_PAGE_LIMIT),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
) -> ContainmentPage:
    """Containment roots NOT placed in the active view (the 'excluded pool').
    In model insertion order, like ``list_containment_roots``. With no active
    view, every root is excluded (returns all roots)."""
    _, model = require_model(session)
    idx = model.indexes
    placed = (
        _placed_element_ids(session.view) if session.view is not None else set()
    )
    root_ids = [
        eid
        for eid in model.elements
        if idx.first_parent(eid) is None and eid not in placed
    ]
    return ContainmentPage(
        items=[
            _containment_item(model, eid)
            for eid in root_ids[offset : offset + limit]
        ],
        total=len(root_ids),
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run test-backend tests/api/test_read_routes.py -k excluded_roots -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/routes/read.py tests/api/test_read_routes.py
git commit -m "feat(api): GET /model/containment/roots/excluded (view complement)"
```

---

### Task 3: Frontend API — `getElementsBatch`

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (add `ElementListSchema`)
- Modify: `frontend/src/lib/api/model-read.ts` (add `getElementsBatch`)
- Test: `frontend/src/lib/api/__tests__/model-read.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/api/__tests__/model-read.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { getElementsBatch } from '../model-read';
import { server } from './server';

const BASE = 'http://api.test/api/v1';
const cfg = { baseUrl: BASE };

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('getElementsBatch', () => {
	it('posts ids and returns the parsed items array', async () => {
		let received: unknown;
		server.use(
			http.post(`${BASE}/model/elements/batch`, async ({ request }) => {
				received = await request.json();
				return HttpResponse.json({
					items: [
						{ id: 'a', type_name: 'Block', properties: {}, rev: 1 },
						{ id: 'b', type_name: 'Block', properties: {}, rev: 1 }
					]
				});
			})
		);
		const out = await getElementsBatch(['a', 'b'], cfg);
		expect(received).toEqual({ ids: ['a', 'b'] });
		expect(out.map((e) => e.id)).toEqual(['a', 'b']);
	});

	it('rejects on a schema mismatch', async () => {
		server.use(
			http.post(`${BASE}/model/elements/batch`, () =>
				HttpResponse.json({ items: 'nope' })
			)
		);
		await expect(getElementsBatch(['a'], cfg)).rejects.toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test -- model-read`
Expected: FAIL — `getElementsBatch` is not exported.

- [ ] **Step 3: Implement schema + function**

In `frontend/src/lib/api/types.ts`, after `ElementPageSchema` (around line 205) add:

```ts
export const ElementListSchema = z.object({
	items: z.array(ElementSchema).default([])
});
export type ElementList = z.infer<typeof ElementListSchema>;
```

In `frontend/src/lib/api/model-read.ts`, add `ElementListSchema` (and `Element`) to the type imports, then add after `getModelSummary` (or near the other element reads):

```ts
/**
 * POST /model/elements/batch — fetch many elements by id in one request.
 * Ids come back in request order; unknown/deleted ids are omitted by the
 * server. Caller must keep `ids.length <= READ_PAGE_LIMIT`.
 */
export function getElementsBatch(ids: string[], cfg?: ClientConfig): Promise<Element[]> {
	return apiFetch(
		'/model/elements/batch',
		{ method: 'POST', body: { ids }, schema: ElementListSchema },
		cfg
	).then((r) => r.items);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `frontend/`): `npm test -- model-read`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/api/model-read.ts \
  frontend/src/lib/api/__tests__/model-read.test.ts
git commit -m "feat(api-client): getElementsBatch for batched element reads"
```

---

### Task 4: Frontend API — `listExcludedRoots` / `listExcludedRootsPaged`

**Files:**
- Modify: `frontend/src/lib/api/model-read.ts`
- Test: `frontend/src/lib/api/__tests__/model-read.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/api/__tests__/model-read.test.ts` (add the imports to the existing top import line):

```ts
import { getElementsBatch, listExcludedRoots, listExcludedRootsPaged } from '../model-read';

function item(id: string) {
	return { element: { id, type_name: 'Block', properties: {}, rev: 1 }, child_count: 0 };
}

describe('listExcludedRoots', () => {
	it('passes limit/offset and parses the page', async () => {
		let url: URL | undefined;
		server.use(
			http.get(`${BASE}/model/containment/roots/excluded`, ({ request }) => {
				url = new URL(request.url);
				return HttpResponse.json({ items: [item('a')], total: 3 });
			})
		);
		const page = await listExcludedRoots({ limit: 1, offset: 0 }, cfg);
		expect(url?.searchParams.get('limit')).toBe('1');
		expect(page.total).toBe(3);
		expect(page.items[0].element.id).toBe('a');
	});

	it('listExcludedRootsPaged assembles multiple pages up to the limit', async () => {
		const all = ['a', 'b', 'c'];
		server.use(
			http.get(`${BASE}/model/containment/roots/excluded`, ({ request }) => {
				const u = new URL(request.url);
				const offset = Number(u.searchParams.get('offset') ?? '0');
				const limit = Number(u.searchParams.get('limit') ?? '500');
				return HttpResponse.json({
					items: all.slice(offset, offset + limit).map(item),
					total: all.length
				});
			})
		);
		const page = await listExcludedRootsPaged(3, cfg);
		expect(page.items.map((i) => i.element.id)).toEqual(['a', 'b', 'c']);
		expect(page.total).toBe(3);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test -- model-read`
Expected: FAIL — `listExcludedRoots` is not exported.

- [ ] **Step 3: Implement**

In `frontend/src/lib/api/model-read.ts`, add after `listContainmentRootsPaged` (around line 141):

```ts
/** GET /model/containment/roots/excluded — roots not placed in the active view. */
export function listExcludedRoots(
	opts?: { limit?: number; offset?: number },
	cfg?: ClientConfig
): Promise<ContainmentPage> {
	return apiFetch(
		'/model/containment/roots/excluded',
		{
			method: 'GET',
			schema: ContainmentPageSchema,
			query: { limit: opts?.limit, offset: opts?.offset }
		},
		cfg
	);
}

/** Offset-paged assembly of the first `limit` excluded roots (mirrors
 * {@link listContainmentRootsPaged}; backend caps a page at READ_PAGE_LIMIT). */
export async function listExcludedRootsPaged(
	limit: number,
	cfg?: ClientConfig
): Promise<ContainmentPage> {
	const items: ContainmentPage['items'] = [];
	let total = 0;
	while (items.length < limit) {
		const page = await listExcludedRoots(
			{ limit: Math.min(READ_PAGE_LIMIT, limit - items.length), offset: items.length },
			cfg
		);
		items.push(...page.items);
		total = page.total;
		if (items.length >= total || page.items.length === 0) break;
	}
	return { items, total };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `frontend/`): `npm test -- model-read`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api/model-read.ts frontend/src/lib/api/__tests__/model-read.test.ts
git commit -m "feat(api-client): listExcludedRoots(+Paged) for the view excluded pool"
```

---

### Task 5: Frontend store — `ensureElements` (batched window fetch)

Fetches only the uncached, non-temp, not-already-in-flight ids in batched `getElementsBatch` calls (chunked at `READ_PAGE_LIMIT`) and seeds the cache. Replaces per-element `ensureElement` loops for window loading.

**Files:**
- Modify: `frontend/src/lib/state/model.svelte.ts`
- Test: `frontend/src/lib/state/__tests__/model-store.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/lib/state/__tests__/model-store.test.ts` (add `ensureElements` and `getCachedElements`/`seedElements` to the existing import block if missing):

```ts
describe('ensureElements (batched)', () => {
	it('fetches only uncached ids in one batch and seeds the cache', async () => {
		seedElements([el('a', { name: 'cached' })]);
		const bodies: string[][] = [];
		server.use(
			http.post(`${BASE}/model/elements/batch`, async ({ request }) => {
				const { ids } = (await request.json()) as { ids: string[] };
				bodies.push(ids);
				return HttpResponse.json({ items: ids.map((id) => el(id, { name: id })) });
			})
		);

		await ensureElements(['a', 'b', 'c']);

		// 'a' was cached, so only b,c are requested, in one batch
		expect(bodies).toEqual([['b', 'c']]);
		const cache = getCachedElements();
		expect(cache.get('b')?.properties.name).toBe('b');
		expect(cache.get('c')?.properties.name).toBe('c');
	});

	it('is a no-op when every id is cached or a temp id', async () => {
		seedElements([el('a')]);
		server.use(
			http.post(`${BASE}/model/elements/batch`, () => {
				throw new Error('should not fetch');
			})
		);
		await expect(ensureElements(['a', 'tmp_1'])).resolves.toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test -- model-store -t "ensureElements"`
Expected: FAIL — `ensureElements` is not exported.

- [ ] **Step 3: Implement**

In `frontend/src/lib/state/model.svelte.ts`:

No new import line is needed — the file already has `import * as modelReadApi from '../api/model-read'` (line 15) and `import { isTempId, ... } from './ops'` (line 18). `getElementsBatch` and `READ_PAGE_LIMIT` are reached through the `modelReadApi.` namespace.

Add an in-flight id set near `_pendingElementFetches` (around line 630):

```ts
/** Ids currently being fetched by an {@link ensureElements} batch, so
 * overlapping windows do not double-request the same id. Cleared on settle
 * and on resetModelStore. */
const _inFlightBatchIds = new Set<string>();
```

Add the function after `ensureElement` (around line 660):

```ts
/**
 * Batched cache-or-fetch for many ids: fetches only the uncached, non-temp,
 * not-already-in-flight ids via POST /model/elements/batch (chunked at
 * READ_PAGE_LIMIT) and seeds the cache. The window renderer calls this with
 * the on-screen id slice; unknown ids are omitted by the server and simply
 * stay uncached.
 */
export async function ensureElements(ids: readonly string[]): Promise<void> {
	const want: string[] = [];
	const seen = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		if (_elements.has(id) || isTempId(id) || _inFlightBatchIds.has(id)) continue;
		want.push(id);
	}
	if (want.length === 0) return;
	for (const id of want) _inFlightBatchIds.add(id);
	try {
		for (let i = 0; i < want.length; i += modelReadApi.READ_PAGE_LIMIT) {
			const chunk = want.slice(i, i + modelReadApi.READ_PAGE_LIMIT);
			const fetched = await modelReadApi.getElementsBatch(chunk, _clientConfig);
			for (const e of fetched) _elements.set(e.id, e);
		}
	} finally {
		for (const id of want) _inFlightBatchIds.delete(id);
	}
}
```

In `resetModelStore` (around line 796), add the clear alongside `_pendingElementFetches.clear()`:

```ts
	_inFlightBatchIds.clear();
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `frontend/`): `npm test -- model-store -t "ensureElements"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/model.svelte.ts \
  frontend/src/lib/state/__tests__/model-store.test.ts
git commit -m "feat(store): ensureElements batched window fetch"
```

---

### Task 6: Frontend logic — positional placement & reorder (`view-ops`)

Add `placeElementsInViewAt(view, path, ids, index)` — strip ids from every folder, then (for a non-empty path) splice them into the target folder at `index`. Refactor `placeElementsInView` to delegate (append). This one helper covers include-at-position, intra-folder reorder, and (empty path) exclude.

**Files:**
- Modify: `frontend/src/lib/state/view-ops.ts`
- Test: `frontend/src/lib/state/__tests__/view-ops.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/lib/state/__tests__/view-ops.test.ts` (add `placeElementsInViewAt` to the imports):

```ts
describe('placeElementsInViewAt', () => {
	it('inserts at the given index in the target folder', () => {
		const v = view(folder('F', ['a', 'b', 'c']));
		const out = placeElementsInViewAt(v, ['F'], ['x'], 1);
		expect(out.folders[0].elements).toEqual(['a', 'x', 'b', 'c']);
	});

	it('reorders within a folder (strip then insert at new index)', () => {
		const v = view(folder('F', ['a', 'b', 'c']));
		// move 'c' to the front: after stripping -> [a,b], insert at 0
		const out = placeElementsInViewAt(v, ['F'], ['c'], 0);
		expect(out.folders[0].elements).toEqual(['c', 'a', 'b']);
	});

	it('moves an element from one folder to a position in another', () => {
		const v = view(folder('F', ['a', 'b']), folder('G', ['x', 'y']));
		const out = placeElementsInViewAt(v, ['G'], ['a'], 1);
		expect(out.folders[0].elements).toEqual(['b']);
		expect(out.folders[1].elements).toEqual(['x', 'a', 'y']);
	});

	it('clamps an out-of-range index to the end', () => {
		const v = view(folder('F', ['a', 'b']));
		const out = placeElementsInViewAt(v, ['F'], ['x'], 999);
		expect(out.folders[0].elements).toEqual(['a', 'b', 'x']);
	});

	it('empty path strips from all folders (exclude from view)', () => {
		const v = view(folder('F', ['a', 'b']));
		const out = placeElementsInViewAt(v, [], ['a'], 0);
		expect(out.folders[0].elements).toEqual(['b']);
	});

	it('does not mutate the input view', () => {
		const v = view(folder('F', ['a', 'b']));
		placeElementsInViewAt(v, ['F'], ['b'], 0);
		expect(v.folders[0].elements).toEqual(['a', 'b']);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `npm test -- view-ops -t "placeElementsInViewAt"`
Expected: FAIL — `placeElementsInViewAt` is not exported.

- [ ] **Step 3: Implement**

In `frontend/src/lib/state/view-ops.ts`, replace the existing `placeElementsInView` with the positional core plus a delegating wrapper:

```ts
/**
 * Return a new view with `ids` placed into the folder at `path`, inserted at
 * `index` among that folder's existing elements. Each id is first stripped from
 * every folder that holds it (single-folder rule), so this also covers
 * intra-folder reorder (strip then re-insert at the new index) and cross-folder
 * moves. An empty `path` strips the ids and re-adds them nowhere (exclude from
 * the view). `index` is clamped to `[0, target.length]`.
 */
export function placeElementsInViewAt(
	view: View,
	path: string[],
	ids: string[],
	index: number
): View {
	const next = cloneView(view);
	const idSet = new Set(ids);

	const stripFrom = (folder: Folder): void => {
		folder.elements = folder.elements.filter((e) => !idSet.has(e));
		for (const child of folder.folders) stripFrom(child);
	};
	for (const f of next.folders) stripFrom(f);

	if (path.length > 0) {
		const target = findFolderByPath(next, path);
		if (target === null) throw new Error(`Folder not found: ${path.join('/')}`);
		// preserve given order, drop duplicates within the incoming selection
		const insertion = ids.filter((id, i) => ids.indexOf(id) === i);
		const at = Math.max(0, Math.min(index, target.elements.length));
		target.elements.splice(at, 0, ...insertion);
	}
	return next;
}

/**
 * Append-at-end placement (backwards-compatible wrapper around
 * {@link placeElementsInViewAt}). Empty path = exclude from the view.
 */
export function placeElementsInView(view: View, path: string[], ids: string[]): View {
	return placeElementsInViewAt(view, path, ids, Number.MAX_SAFE_INTEGER);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `frontend/`): `npm test -- view-ops`
Expected: PASS — the new `placeElementsInViewAt` block AND the existing `placeElementsInView` tests (the wrapper preserves append/exclude behavior).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/state/view-ops.ts \
  frontend/src/lib/state/__tests__/view-ops.test.ts
git commit -m "feat(view-ops): placeElementsInViewAt for positional place/reorder"
```

---

### Task 7: Frontend logic — curated-scope `buildUnifiedTree`

When a view is active, the tree's top level is folders only — no interleaved unplaced model roots (those move to the excluded pool, rendered separately in Plan 2). Placed elements still render under their folders; the no-view path is unchanged.

**Files:**
- Modify: `frontend/src/lib/components/Sidebar/view-tree.ts`
- Test: `frontend/src/lib/components/Sidebar/view-tree-build.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/components/Sidebar/view-tree-build.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Element, View } from '$lib/api/types';
import { buildUnifiedTree, folderKey, isFolderKey } from './view-tree';

function el(id: string, name = id): Element {
	return { id, type_name: 'Block', properties: { name }, rev: 1 };
}
function elements(...ids: string[]): Map<string, Element> {
	return new Map(ids.map((id) => [id, el(id)]));
}
const displayName = (e: Element) => String(e.properties.name ?? e.id);

describe('buildUnifiedTree — curated scope', () => {
	it('with a view, top-level roots are folders only (no unplaced roots)', () => {
		const view: View = { name: 'v', folders: [{ name: 'F', folders: [], elements: ['a'] }] };
		const tree = buildUnifiedTree(
			view,
			['a', 'b', 'c'], // b,c are unplaced model roots
			elements('a', 'b', 'c'),
			new Map(),
			new Set(),
			displayName
		);
		expect(tree.roots.every(isFolderKey)).toBe(true);
		expect(tree.roots).toEqual([folderKey(['F'])]);
		// placed element still appears under its folder
		expect(tree.children.get(folderKey(['F']))).toEqual(['a']);
		expect([...tree.placedElementIds]).toEqual(['a']);
	});

	it('without a view, roots are the (name-sorted) model roots (unchanged)', () => {
		const tree = buildUnifiedTree(
			null,
			['b', 'a'],
			elements('a', 'b'),
			new Map(),
			new Set(),
			displayName
		);
		expect(tree.roots).toEqual(['a', 'b']);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `npm test -- view-tree-build`
Expected: FAIL — the first test fails because today `tree.roots` includes the unplaced ids `b` and `c` after the folder key.

- [ ] **Step 3: Implement**

In `frontend/src/lib/components/Sidebar/view-tree.ts`, in `buildUnifiedTree`'s `view !== null` branch, drop the unplaced interleave. Replace:

```ts
		const unplaced = rootElements.filter((id) => !out.placedElementIds.has(id));
		unplaced.sort((a, b) =>
			displayName(elementsById.get(a)!).localeCompare(displayName(elementsById.get(b)!))
		);
		out.roots = [...topFolderKeys, ...unplaced];
```

with:

```ts
		// Curated scope: the in-view region is folders only. Model roots that are
		// not placed in a folder belong to the excluded pool, which is rendered
		// as a separate section (see ContainmentTree), not interleaved here.
		out.roots = [...topFolderKeys];
```

The `rootElements` parameter is now unused in the view branch (still used by the no-view branch). Leave the signature unchanged — Plan 2 keeps passing the placed-roots' containment data through `containmentChildren`, and callers are untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run (from `frontend/`): `npm test -- view-tree-build`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the existing view-tree DnD tests to confirm no regression**

Run (from `frontend/`): `npm test -- view-tree`
Expected: PASS — `view-tree-dnd.test.ts` and the new build test both green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/Sidebar/view-tree.ts \
  frontend/src/lib/components/Sidebar/view-tree-build.test.ts
git commit -m "feat(view-tree): curated scope — folders-only top level when a view is active"
```

---

## Final verification

- [ ] **Backend suite:** `pixi run test-backend tests/api/test_read_routes.py -v` → all green.
- [ ] **Backend lint/types:** `pixi run lint-backend` → clean.
- [ ] **Frontend unit suite:** from `frontend/`, `npm test` → all green.
- [ ] **Frontend types:** from `frontend/`, `npm run check` → no new errors.

## Spec coverage (this plan)

- Batch element fetch endpoint + client → spec "Backend" item 2, "API layer" item 4, "store" item 5.
- Excluded complement endpoint + client → spec "Backend" item 1, "API layer" item 3.
- Curated-scope tree (folders only) → spec "In-view region", `buildUnifiedTree` change item 6.
- Positional place / reorder / exclude → spec "Curation semantics", `view-ops` item 7.

## Deferred to Plan 2 (rendering & DnD)

Virtualized windowed list; excluded-pool section UI + auto-scroll loading (no "Show more"); removal of the eager `ensureElement` loop (replaced by windowed `ensureElements`); DnD edge auto-scroll + reorder/include/exclude drop handlers wired to `placeElementsInViewAt`; structural-refetch reset of the pool; drag-from-search-into-folder; e2e (`view.spec.ts`).
