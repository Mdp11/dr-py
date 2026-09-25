# Advanced Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a structured "advanced search" — a popup that builds a multi-criterion query over elements or relationships — whose results appear in a resizable, closable bottom panel; clicking a result opens its detail in the Inspector.

**Architecture:** Pure, unit-tested query model (`lib/search/types.ts` + `lib/search/evaluate.ts`) runs client-side over the in-memory working model. A runes state store (`lib/state/advanced-search.svelte.ts`) holds the draft query, dialog/panel open state, and committed results. Svelte components (`AdvancedSearchDialog`, `CriterionRow`, `ResultsPanel`) provide the UI; `+page.svelte` gains a full-width bottom row for the panel; `ResizeHandle` is generalized to resize vertically.

**Tech Stack:** SvelteKit, Svelte 5 runes, TypeScript, Tailwind, `bits-ui` (Popover/Dialog), `@lucide/svelte`, Vitest (unit), Playwright (e2e).

---

## File structure

**Create:**
- `frontend/src/lib/search/types.ts` — `Criterion` union, `AdvancedQuery`, `SearchResultItem`, factories/helpers.
- `frontend/src/lib/search/evaluate.ts` — pure `runQuery()` + `isValidRegex()`.
- `frontend/src/lib/search/__tests__/types.test.ts` — helper tests.
- `frontend/src/lib/search/__tests__/evaluate.test.ts` — evaluator tests.
- `frontend/src/lib/state/advanced-search.svelte.ts` — search state store.
- `frontend/src/lib/components/Sidebar/AdvancedSearchDialog.svelte` — the popup.
- `frontend/src/lib/components/Sidebar/CriterionRow.svelte` — one criterion's editor.
- `frontend/src/lib/components/ResultsPanel.svelte` — bottom results panel.
- `frontend/e2e/advanced-search.spec.ts` — Playwright smoke.

**Modify:**
- `frontend/src/lib/state/index.ts` — re-export the new store.
- `frontend/src/lib/components/ResizeHandle.svelte` — add `axis: 'x' | 'y'`.
- `frontend/src/lib/components/Sidebar/Search.svelte` — add the trigger button + mount the dialog.
- `frontend/src/routes/+page.svelte` — grid row for the panel + height persistence.

**Conventions to follow:**
- State stores use accessor functions (`getX`/`setX`) and live in `*.svelte.ts`. Re-export from `state/index.ts`.
- Components import UI primitives from `$lib/components/ui/*`; icons from `@lucide/svelte`.
- Tests use Vitest (`describe`/`it`/`expect`), factory helpers like `el()`/`rel()` (see `state/__tests__/diff.test.ts`).
- Run from `frontend/`: `npm run test`, `npm run check`, `npm run lint`, `npm run test:e2e`.

---

## Task 1: Search types & helpers

**Files:**
- Create: `frontend/src/lib/search/types.ts`
- Test: `frontend/src/lib/search/__tests__/types.test.ts`

- [ ] **Step 1: Write the types module**

Create `frontend/src/lib/search/types.ts`:

```ts
import type { Element, Relationship } from '$lib/api/types';

export type TargetKind = 'element' | 'relationship';
export type Direction = 'outgoing' | 'incoming' | 'either';

export type PropertyOp =
	| 'equals'
	| 'not_equals'
	| 'contains'
	| 'matches'
	| 'gt'
	| 'lt'
	| 'gte'
	| 'lte'
	| 'exists'
	| 'is_empty';

export type TextOp = 'contains' | 'matches' | 'equals';
export type CountOp = 'at_least' | 'at_most' | 'exactly';

export type Criterion =
	| { type: 'entity_type'; names: string[] }
	| { type: 'property'; name: string; op: PropertyOp; value: string }
	| { type: 'name_id'; field: 'name' | 'id'; op: TextOp; value: string }
	| { type: 'relation_count'; op: CountOp; count: number; direction: Direction; relTypes: string[] }
	| { type: 'orphan' }
	| { type: 'connected_to_type'; direction: Direction; names: string[] }
	| { type: 'endpoint_type'; endpoint: 'source' | 'target'; names: string[] };

export type CriterionType = Criterion['type'];

export interface AdvancedQuery {
	target: TargetKind;
	criteria: Criterion[];
}

export interface SearchResultItem {
	kind: TargetKind;
	id: string;
}

/** Re-exported for evaluator typing; mirrors lib/state/ops Snapshot. */
export interface SearchModel {
	elements: Element[];
	relationships: Relationship[];
}

export const CRITERION_LABELS: Record<CriterionType, string> = {
	entity_type: 'Has type',
	property: 'Property',
	name_id: 'Name / ID',
	relation_count: 'Relation count',
	orphan: 'Is orphan (no relations)',
	connected_to_type: 'Connected to type',
	endpoint_type: 'Endpoint type'
};

const ELEMENT_CRITERIA: CriterionType[] = [
	'entity_type',
	'property',
	'name_id',
	'relation_count',
	'orphan',
	'connected_to_type'
];
const RELATIONSHIP_CRITERIA: CriterionType[] = ['entity_type', 'property', 'name_id', 'endpoint_type'];

/** Criterion types offered for a given target kind, in display order. */
export function criteriaForKind(kind: TargetKind): CriterionType[] {
	return kind === 'element' ? ELEMENT_CRITERIA : RELATIONSHIP_CRITERIA;
}

/** A fresh criterion of the given type with sensible defaults. */
export function newCriterion(type: CriterionType): Criterion {
	switch (type) {
		case 'entity_type':
			return { type, names: [] };
		case 'property':
			return { type, name: '', op: 'equals', value: '' };
		case 'name_id':
			return { type, field: 'name', op: 'contains', value: '' };
		case 'relation_count':
			return { type, op: 'at_least', count: 1, direction: 'either', relTypes: [] };
		case 'orphan':
			return { type };
		case 'connected_to_type':
			return { type, direction: 'either', names: [] };
		case 'endpoint_type':
			return { type, endpoint: 'source', names: [] };
	}
}

/** Drop criteria that do not apply to `target` (used when switching kind). */
export function pruneCriteria(criteria: Criterion[], target: TargetKind): Criterion[] {
	const allowed = criteriaForKind(target);
	return criteria.filter((c) => allowed.includes(c.type));
}
```

- [ ] **Step 2: Write the failing test**

Create `frontend/src/lib/search/__tests__/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { criteriaForKind, newCriterion, pruneCriteria, type Criterion } from '../types';

describe('criteriaForKind', () => {
	it('offers element-only criteria for elements', () => {
		expect(criteriaForKind('element')).toContain('relation_count');
		expect(criteriaForKind('element')).not.toContain('endpoint_type');
	});
	it('offers relationship-only criteria for relationships', () => {
		expect(criteriaForKind('relationship')).toContain('endpoint_type');
		expect(criteriaForKind('relationship')).not.toContain('relation_count');
	});
});

describe('newCriterion', () => {
	it('builds a relation_count with defaults', () => {
		expect(newCriterion('relation_count')).toEqual({
			type: 'relation_count',
			op: 'at_least',
			count: 1,
			direction: 'either',
			relTypes: []
		});
	});
});

describe('pruneCriteria', () => {
	it('removes criteria not valid for the new target', () => {
		const criteria: Criterion[] = [
			{ type: 'name_id', field: 'name', op: 'contains', value: 'x' },
			{ type: 'relation_count', op: 'at_least', count: 1, direction: 'either', relTypes: [] }
		];
		const pruned = pruneCriteria(criteria, 'relationship');
		expect(pruned.map((c) => c.type)).toEqual(['name_id']);
	});
});
```

- [ ] **Step 3: Run the test**

Run: `cd frontend && npm run test -- src/lib/search/__tests__/types.test.ts`
Expected: PASS (3 describe blocks green).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/search/types.ts frontend/src/lib/search/__tests__/types.test.ts
git commit -m "feat(search): add advanced-search criteria types and helpers"
```

---

## Task 2: Evaluator — type, property, and name/id criteria

**Files:**
- Create: `frontend/src/lib/search/evaluate.ts`
- Test: `frontend/src/lib/search/__tests__/evaluate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/search/__tests__/evaluate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Element, Relationship } from '$lib/api/types';
import type { AdvancedQuery, SearchModel } from '../types';
import { isValidRegex, runQuery } from '../evaluate';

function el(id: string, type_name = 'Thing', properties: Record<string, unknown> = {}): Element {
	return { id, type_name, properties, rev: 1 };
}
function rel(
	id: string,
	source_id: string,
	target_id: string,
	type_name = 'Link',
	properties: Record<string, unknown> = {}
): Relationship {
	return { id, type_name, source_id, target_id, properties, rev: 1 };
}
function model(elements: Element[] = [], relationships: Relationship[] = []): SearchModel {
	return { elements, relationships };
}
function ids(q: AdvancedQuery, m: SearchModel): string[] {
	return runQuery(q, m)
		.map((r) => r.id)
		.sort();
}

describe('runQuery — entity_type', () => {
	const m = model([el('e1', 'Block'), el('e2', 'Port'), el('e3', 'Block')]);
	it('matches elements whose type is in the set', () => {
		expect(ids({ target: 'element', criteria: [{ type: 'entity_type', names: ['Block'] }] }, m)).toEqual(
			['e1', 'e3']
		);
	});
	it('empty name set means no type constraint (all match)', () => {
		expect(ids({ target: 'element', criteria: [{ type: 'entity_type', names: [] }] }, m)).toEqual([
			'e1',
			'e2',
			'e3'
		]);
	});
});

describe('runQuery — property', () => {
	const m = model([
		el('e1', 'Block', { name: 'Alpha', size: 5 }),
		el('e2', 'Block', { name: 'Beta', size: 12 }),
		el('e3', 'Block', {})
	]);
	it('equals', () => {
		expect(
			ids({ target: 'element', criteria: [{ type: 'property', name: 'name', op: 'equals', value: 'Alpha' }] }, m)
		).toEqual(['e1']);
	});
	it('contains is case-insensitive', () => {
		expect(
			ids({ target: 'element', criteria: [{ type: 'property', name: 'name', op: 'contains', value: 'a' }] }, m)
		).toEqual(['e1', 'e2']);
	});
	it('gt coerces to number, non-numeric fails', () => {
		expect(
			ids({ target: 'element', criteria: [{ type: 'property', name: 'size', op: 'gt', value: '10' }] }, m)
		).toEqual(['e2']);
	});
	it('exists vs is_empty', () => {
		expect(
			ids({ target: 'element', criteria: [{ type: 'property', name: 'name', op: 'exists', value: '' }] }, m)
		).toEqual(['e1', 'e2']);
		expect(
			ids({ target: 'element', criteria: [{ type: 'property', name: 'name', op: 'is_empty', value: '' }] }, m)
		).toEqual(['e3']);
	});
	it('matches uses regex; invalid regex matches nothing', () => {
		expect(
			ids({ target: 'element', criteria: [{ type: 'property', name: 'name', op: 'matches', value: '^A' }] }, m)
		).toEqual(['e1']);
		expect(
			ids({ target: 'element', criteria: [{ type: 'property', name: 'name', op: 'matches', value: '[' }] }, m)
		).toEqual([]);
	});
});

describe('runQuery — name_id', () => {
	const m = model([el('block-1', 'Block', { name: 'Alpha' }), el('port-1', 'Port', { name: 'Beta' })]);
	it('matches on id contains', () => {
		expect(
			ids({ target: 'element', criteria: [{ type: 'name_id', field: 'id', op: 'contains', value: 'block' }] }, m)
		).toEqual(['block-1']);
	});
	it('matches on name regex', () => {
		expect(
			ids({ target: 'element', criteria: [{ type: 'name_id', field: 'name', op: 'matches', value: '^Be' }] }, m)
		).toEqual(['port-1']);
	});
});

describe('runQuery — relationships target & shared criteria', () => {
	const m = model(
		[el('e1', 'Block'), el('e2', 'Port')],
		[rel('r1', 'e1', 'e2', 'Connects', { name: 'wire' })]
	);
	it('returns relationships filtered by type and property', () => {
		expect(
			runQuery(
				{
					target: 'relationship',
					criteria: [
						{ type: 'entity_type', names: ['Connects'] },
						{ type: 'property', name: 'name', op: 'equals', value: 'wire' }
					]
				},
				m
			)
		).toEqual([{ kind: 'relationship', id: 'r1' }]);
	});
});

describe('runQuery — empty criteria lists everything of the target kind', () => {
	const m = model([el('e1'), el('e2')], [rel('r1', 'e1', 'e2')]);
	it('elements', () => {
		expect(ids({ target: 'element', criteria: [] }, m)).toEqual(['e1', 'e2']);
	});
	it('relationships', () => {
		expect(ids({ target: 'relationship', criteria: [] }, m)).toEqual(['r1']);
	});
});

describe('isValidRegex', () => {
	it('true for valid, false for invalid', () => {
		expect(isValidRegex('^a.*')).toBe(true);
		expect(isValidRegex('[')).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm run test -- src/lib/search/__tests__/evaluate.test.ts`
Expected: FAIL — `Failed to resolve import "../evaluate"`.

- [ ] **Step 3: Write the evaluator**

Create `frontend/src/lib/search/evaluate.ts`:

```ts
import type { Element, Relationship } from '$lib/api/types';
import type { AdvancedQuery, Criterion, Direction, SearchModel, SearchResultItem } from './types';

interface RelIndex {
	outgoing: Map<string, Relationship[]>; // keyed by source_id
	incoming: Map<string, Relationship[]>; // keyed by target_id
}

interface Ctx {
	relIndex: RelIndex;
	elementsById: Map<string, Element>;
}

export function isValidRegex(pattern: string): boolean {
	try {
		new RegExp(pattern);
		return true;
	} catch {
		return false;
	}
}

function safeRegexTest(pattern: string, value: string): boolean {
	try {
		return new RegExp(pattern).test(value);
	} catch {
		return false;
	}
}

function pushTo(map: Map<string, Relationship[]>, key: string, r: Relationship): void {
	const arr = map.get(key);
	if (arr) arr.push(r);
	else map.set(key, [r]);
}

function buildRelIndex(rels: Relationship[]): RelIndex {
	const outgoing = new Map<string, Relationship[]>();
	const incoming = new Map<string, Relationship[]>();
	for (const r of rels) {
		pushTo(outgoing, r.source_id, r);
		pushTo(incoming, r.target_id, r);
	}
	return { outgoing, incoming };
}

function relationsFor(index: RelIndex, elementId: string, direction: Direction): Relationship[] {
	if (direction === 'outgoing') return index.outgoing.get(elementId) ?? [];
	if (direction === 'incoming') return index.incoming.get(elementId) ?? [];
	return [...(index.outgoing.get(elementId) ?? []), ...(index.incoming.get(elementId) ?? [])];
}

function otherEndpoint(r: Relationship, elementId: string): string {
	return r.source_id === elementId ? r.target_id : r.source_id;
}

function entityName(props: Record<string, unknown>): string {
	const n = props?.name;
	return typeof n === 'string' ? n : '';
}

function matchEntityType(typeName: string, names: string[]): boolean {
	return names.length === 0 ? true : names.includes(typeName);
}

function matchProperty(props: Record<string, unknown>, c: Extract<Criterion, { type: 'property' }>): boolean {
	const raw = props ? props[c.name] : undefined;
	switch (c.op) {
		case 'exists':
			return raw !== undefined && raw !== null && raw !== '';
		case 'is_empty':
			return raw === undefined || raw === null || raw === '';
		case 'equals':
			return String(raw ?? '') === c.value;
		case 'not_equals':
			return String(raw ?? '') !== c.value;
		case 'contains':
			return String(raw ?? '')
				.toLowerCase()
				.includes(c.value.toLowerCase());
		case 'matches':
			return safeRegexTest(c.value, String(raw ?? ''));
		case 'gt':
		case 'lt':
		case 'gte':
		case 'lte': {
			const lhs = Number(raw);
			const rhs = Number(c.value);
			if (Number.isNaN(lhs) || Number.isNaN(rhs)) return false;
			if (c.op === 'gt') return lhs > rhs;
			if (c.op === 'lt') return lhs < rhs;
			if (c.op === 'gte') return lhs >= rhs;
			return lhs <= rhs;
		}
	}
}

function matchNameId(
	subjectName: string,
	subjectId: string,
	c: Extract<Criterion, { type: 'name_id' }>
): boolean {
	const subject = c.field === 'name' ? subjectName : subjectId;
	switch (c.op) {
		case 'contains':
			return subject.toLowerCase().includes(c.value.toLowerCase());
		case 'equals':
			return subject === c.value;
		case 'matches':
			return safeRegexTest(c.value, subject);
	}
}

function matchElement(e: Element, c: Criterion, ctx: Ctx): boolean {
	switch (c.type) {
		case 'entity_type':
			return matchEntityType(e.type_name, c.names);
		case 'property':
			return matchProperty(e.properties, c);
		case 'name_id':
			return matchNameId(entityName(e.properties), e.id, c);
		case 'relation_count': {
			const rels = relationsFor(ctx.relIndex, e.id, c.direction);
			const filtered = c.relTypes.length === 0 ? rels : rels.filter((r) => c.relTypes.includes(r.type_name));
			const n = filtered.length;
			if (c.op === 'at_least') return n >= c.count;
			if (c.op === 'at_most') return n <= c.count;
			return n === c.count;
		}
		case 'orphan':
			return relationsFor(ctx.relIndex, e.id, 'either').length === 0;
		case 'connected_to_type': {
			const rels = relationsFor(ctx.relIndex, e.id, c.direction);
			return rels.some((r) => {
				const other = ctx.elementsById.get(otherEndpoint(r, e.id));
				return other != null && c.names.includes(other.type_name);
			});
		}
		default:
			// relationship-only criterion on an element query: skip (no-op).
			return true;
	}
}

function matchRelationship(r: Relationship, c: Criterion, ctx: Ctx): boolean {
	switch (c.type) {
		case 'entity_type':
			return matchEntityType(r.type_name, c.names);
		case 'property':
			return matchProperty(r.properties, c);
		case 'name_id':
			return matchNameId(entityName(r.properties), r.id, c);
		case 'endpoint_type': {
			const endId = c.endpoint === 'source' ? r.source_id : r.target_id;
			const el = ctx.elementsById.get(endId);
			return el != null && c.names.includes(el.type_name);
		}
		default:
			// element-only criterion on a relationship query: skip (no-op).
			return true;
	}
}

/** Run an advanced query against a working-model snapshot. Pure. */
export function runQuery(query: AdvancedQuery, model: SearchModel): SearchResultItem[] {
	const ctx: Ctx = {
		relIndex: buildRelIndex(model.relationships),
		elementsById: new Map(model.elements.map((e) => [e.id, e]))
	};
	if (query.target === 'element') {
		return model.elements
			.filter((e) => query.criteria.every((c) => matchElement(e, c, ctx)))
			.map((e) => ({ kind: 'element', id: e.id }));
	}
	return model.relationships
		.filter((r) => query.criteria.every((c) => matchRelationship(r, c, ctx)))
		.map((r) => ({ kind: 'relationship', id: r.id }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm run test -- src/lib/search/__tests__/evaluate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/search/evaluate.ts frontend/src/lib/search/__tests__/evaluate.test.ts
git commit -m "feat(search): add runQuery evaluator with type/property/name-id criteria"
```

---

## Task 3: Evaluator — relation_count, orphan, connected_to_type, endpoint_type

The implementation for these already exists from Task 2; this task adds the tests that lock down the element-relation and relationship-endpoint behavior.

**Files:**
- Test: `frontend/src/lib/search/__tests__/evaluate.test.ts` (append)

- [ ] **Step 1: Append the failing tests**

Append to `frontend/src/lib/search/__tests__/evaluate.test.ts` (the `el`/`rel`/`model`/`ids` helpers are already defined at the top of the file):

```ts
describe('runQuery — relation_count & orphan', () => {
	// e1 -> e2 (Connects), e1 -> e3 (Owns), e4 isolated
	const m = model(
		[el('e1', 'Block'), el('e2', 'Port'), el('e3', 'Port'), el('e4', 'Block')],
		[rel('r1', 'e1', 'e2', 'Connects'), rel('r2', 'e1', 'e3', 'Owns'), rel('r3', 'e2', 'e1', 'Connects')]
	);
	it('counts outgoing relations', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [
						{ type: 'relation_count', op: 'at_least', count: 2, direction: 'outgoing', relTypes: [] }
					]
				},
				m
			)
		).toEqual(['e1']);
	});
	it('counts incoming relations', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [
						{ type: 'relation_count', op: 'exactly', count: 1, direction: 'incoming', relTypes: [] }
					]
				},
				m
			)
		).toEqual(['e1', 'e3']);
	});
	it('filters relation_count by relationship type', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [
						{ type: 'relation_count', op: 'at_least', count: 1, direction: 'either', relTypes: ['Owns'] }
					]
				},
				m
			)
		).toEqual(['e1']);
	});
	it('orphan finds elements with no relations', () => {
		expect(ids({ target: 'element', criteria: [{ type: 'orphan' }] }, m)).toEqual(['e4']);
	});
});

describe('runQuery — connected_to_type', () => {
	const m = model(
		[el('e1', 'Block'), el('e2', 'Port'), el('e3', 'Block')],
		[rel('r1', 'e1', 'e2', 'Connects'), rel('r2', 'e3', 'e1', 'Connects')]
	);
	it('matches elements connected (either direction) to a Port', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [{ type: 'connected_to_type', direction: 'either', names: ['Port'] }]
				},
				m
			)
		).toEqual(['e1']);
	});
});

describe('runQuery — endpoint_type', () => {
	const m = model(
		[el('e1', 'Block'), el('e2', 'Port')],
		[rel('r1', 'e1', 'e2', 'Connects'), rel('r2', 'e2', 'e1', 'Connects')]
	);
	it('matches relationships whose source element is a Block', () => {
		expect(
			runQuery(
				{ target: 'relationship', criteria: [{ type: 'endpoint_type', endpoint: 'source', names: ['Block'] }] },
				m
			).map((r) => r.id)
		).toEqual(['r1']);
	});
	it('matches relationships whose target element is a Block', () => {
		expect(
			runQuery(
				{ target: 'relationship', criteria: [{ type: 'endpoint_type', endpoint: 'target', names: ['Block'] }] },
				m
			).map((r) => r.id)
		).toEqual(['r2']);
	});
});

describe('runQuery — multi-criterion AND', () => {
	const m = model(
		[el('e1', 'Block', { name: 'Alpha' }), el('e2', 'Block', { name: 'Beta' })],
		[rel('r1', 'e1', 'e2', 'Connects')]
	);
	it('requires all criteria to pass', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [
						{ type: 'entity_type', names: ['Block'] },
						{ type: 'relation_count', op: 'at_least', count: 1, direction: 'outgoing', relTypes: [] }
					]
				},
				m
			)
		).toEqual(['e1']);
	});
});
```

- [ ] **Step 2: Run the tests**

Run: `cd frontend && npm run test -- src/lib/search/__tests__/evaluate.test.ts`
Expected: PASS (all describe blocks, old and new).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/search/__tests__/evaluate.test.ts
git commit -m "test(search): cover relation-count, orphan, connected/endpoint type, AND"
```

---

## Task 4: Search state store

**Files:**
- Create: `frontend/src/lib/state/advanced-search.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts`

- [ ] **Step 1: Write the store**

Create `frontend/src/lib/state/advanced-search.svelte.ts`:

```ts
// Advanced-search UI + draft-query state. Accessor-function convention,
// matching the other *.svelte.ts stores. The query model and evaluation
// live in $lib/search; this store only holds editable/committed state.

import {
	criteriaForKind,
	newCriterion,
	pruneCriteria,
	type AdvancedQuery,
	type Criterion,
	type CriterionType,
	type SearchResultItem,
	type TargetKind
} from '$lib/search/types';

let _dialogOpen = $state(false);
let _panelOpen = $state(false);
let _target: TargetKind = $state('element');
let _criteria: Criterion[] = $state([]);
let _results: SearchResultItem[] = $state([]);
let _resultsTarget: TargetKind = $state('element');

export function getSearchDialogOpen(): boolean {
	return _dialogOpen;
}
export function setSearchDialogOpen(open: boolean): void {
	_dialogOpen = open;
}

export function getResultsPanelOpen(): boolean {
	return _panelOpen;
}

export function getSearchTarget(): TargetKind {
	return _target;
}
export function setSearchTarget(target: TargetKind): void {
	if (target === _target) return;
	_target = target;
	_criteria = pruneCriteria(_criteria, target);
}

export function getSearchCriteria(): Criterion[] {
	return _criteria;
}
export function addSearchCriterion(type: CriterionType): void {
	_criteria = [..._criteria, newCriterion(type)];
}
export function updateSearchCriterion(index: number, next: Criterion): void {
	_criteria = _criteria.map((c, i) => (i === index ? next : c));
}
export function removeSearchCriterion(index: number): void {
	_criteria = _criteria.filter((_, i) => i !== index);
}
export function clearSearchCriteria(): void {
	_criteria = [];
}

/** Criterion types available for the current target. */
export function availableCriterionTypes(): CriterionType[] {
	return criteriaForKind(_target);
}

export function getDraftQuery(): AdvancedQuery {
	return { target: _target, criteria: _criteria };
}

export function getSearchResults(): SearchResultItem[] {
	return _results;
}
export function getSearchResultsTarget(): TargetKind {
	return _resultsTarget;
}

/** Store results and open the bottom panel. */
export function commitSearchResults(results: SearchResultItem[], target: TargetKind): void {
	_results = results;
	_resultsTarget = target;
	_panelOpen = true;
}

/** X button: clear results and close the panel. */
export function closeResultsPanel(): void {
	_results = [];
	_panelOpen = false;
}
```

- [ ] **Step 2: Re-export from the state barrel**

In `frontend/src/lib/state/index.ts`, add this export block (place it next to the other `export { ... } from './...'` lines, e.g. just after the `ui.svelte` export):

```ts
export {
	addSearchCriterion,
	availableCriterionTypes,
	clearSearchCriteria,
	closeResultsPanel,
	commitSearchResults,
	getDraftQuery,
	getResultsPanelOpen,
	getSearchCriteria,
	getSearchDialogOpen,
	getSearchResults,
	getSearchResultsTarget,
	getSearchTarget,
	removeSearchCriterion,
	setSearchDialogOpen,
	setSearchTarget,
	updateSearchCriterion
} from './advanced-search.svelte';
```

- [ ] **Step 3: Verify it type-checks**

Run: `cd frontend && npm run check`
Expected: 0 errors (the new store and barrel export resolve).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/state/advanced-search.svelte.ts frontend/src/lib/state/index.ts
git commit -m "feat(state): add advanced-search store"
```

---

## Task 5: Generalize ResizeHandle to a vertical axis

**Files:**
- Modify: `frontend/src/lib/components/ResizeHandle.svelte`

- [ ] **Step 1: Replace the component**

Overwrite `frontend/src/lib/components/ResizeHandle.svelte` with:

```svelte
<script lang="ts">
	type Props = {
		/** Current size in px (width for axis 'x', height for axis 'y'). */
		value: number;
		/** Axis to resize along. 'x' = column width, 'y' = row height. */
		axis?: 'x' | 'y';
		/** For axis 'x': 'left' grows on drag-right, 'right' grows on drag-left.
		 *  Ignored for axis 'y' (drag-up always grows). */
		side?: 'left' | 'right';
		min?: number;
		max?: number;
		onchange: (next: number) => void;
	};

	let { value, axis = 'x', side = 'left', min = 160, max = 720, onchange }: Props = $props();

	let dragging = $state(false);
	let start = 0;
	let startSize = 0;

	function coord(e: PointerEvent): number {
		return axis === 'y' ? e.clientY : e.clientX;
	}

	function onPointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		dragging = true;
		start = coord(e);
		startSize = value;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		e.preventDefault();
	}

	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		const delta = coord(e) - start;
		// axis 'y': drag up (negative delta) grows the panel below.
		const signed = axis === 'y' ? -delta : side === 'left' ? delta : -delta;
		const next = Math.max(min, Math.min(max, startSize + signed));
		onchange(next);
	}

	function onPointerUp(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
	}
</script>

<div
	role="separator"
	aria-orientation={axis === 'y' ? 'horizontal' : 'vertical'}
	tabindex="-1"
	class="group relative select-none bg-zinc-800 hover:bg-zinc-700"
	class:h-full={axis === 'x'}
	class:w-1={axis === 'x'}
	class:cursor-col-resize={axis === 'x'}
	class:w-full={axis === 'y'}
	class:h-1={axis === 'y'}
	class:cursor-row-resize={axis === 'y'}
	class:bg-sky-600={dragging}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
></div>
```

- [ ] **Step 2: Verify existing usage still type-checks**

The two existing `<ResizeHandle ... side="left|right" />` calls in `+page.svelte` omit `axis`, so they default to `'x'` and keep working.

Run: `cd frontend && npm run check`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/components/ResizeHandle.svelte
git commit -m "feat(ui): add vertical axis to ResizeHandle"
```

---

## Task 6: CriterionRow component

**Files:**
- Create: `frontend/src/lib/components/Sidebar/CriterionRow.svelte`

This row renders the editor for one criterion. It reuses `StereotypePicker` (filter mode) for multi-select name lists, and uses native `<select>` for enum operators and `Input` for values. Candidate names come from the metamodel plus property keys present in the working model.

- [ ] **Step 1: Create the component**

Create `frontend/src/lib/components/Sidebar/CriterionRow.svelte`:

```svelte
<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { Trash2 } from '@lucide/svelte';
	import { Input } from '$lib/components/ui/input';
	import { getMetamodel, getWorkingModel } from '$lib/state';
	import { isValidRegex } from '$lib/search/evaluate';
	import { CRITERION_LABELS, type Criterion, type TargetKind } from '$lib/search/types';
	import StereotypePicker from './StereotypePicker.svelte';

	type Props = {
		criterion: Criterion;
		index: number;
		target: TargetKind;
		onChange: (index: number, next: Criterion) => void;
		onRemove: (index: number) => void;
	};
	let { criterion, index, target, onChange, onRemove }: Props = $props();

	const mm = $derived(getMetamodel());
	const working = $derived(getWorkingModel());

	const elementTypeNames = $derived([...(mm?.elements ?? []).map((e) => e.name)].sort());
	const relTypeNames = $derived([...(mm?.relationships ?? []).map((r) => r.name)].sort());
	const propertyNames = $derived.by(() => {
		const set = new Set<string>();
		const defs = target === 'element' ? (mm?.elements ?? []) : (mm?.relationships ?? []);
		for (const t of defs) for (const p of t.properties ?? []) set.add(p.name);
		const entities = target === 'element' ? working.elements : working.relationships;
		for (const e of entities) for (const k of Object.keys(e.properties ?? {})) set.add(k);
		return [...set].sort();
	});

	// Which inline picker popover is open (keyed by a string id within this row).
	let openPicker = $state<string | null>(null);

	function patch(next: Partial<Criterion>): void {
		onChange(index, { ...criterion, ...next } as Criterion);
	}

	function toggleName(field: 'names' | 'relTypes', name: string): void {
		const current = (criterion as Record<string, unknown>)[field] as string[];
		const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name];
		patch({ [field]: next } as Partial<Criterion>);
	}

	const regexInvalid = $derived(
		(criterion.type === 'property' && criterion.op === 'matches' && !isValidRegex(criterion.value)) ||
			(criterion.type === 'name_id' && criterion.op === 'matches' && !isValidRegex(criterion.value))
	);

	function summary(names: string[]): string {
		return names.length === 0 ? 'any' : names.join(', ');
	}
</script>

<div class="flex flex-col gap-1 rounded border border-zinc-800 bg-zinc-900/50 p-2">
	<div class="flex items-center gap-2">
		<span class="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
			{CRITERION_LABELS[criterion.type]}
		</span>
		<button
			type="button"
			class="ml-auto flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-red-300"
			aria-label="Remove criterion"
			onclick={() => onRemove(index)}
		>
			<Trash2 class="h-3 w-3" />
		</button>
	</div>

	<div class="flex flex-wrap items-center gap-2 text-xs">
		{#if criterion.type === 'entity_type'}
			<StereotypePicker
				mode="filter"
				names={target === 'element' ? elementTypeNames : relTypeNames}
				checked={new SvelteSet(criterion.names)}
				onToggle={(n) => toggleName('names', n)}
				onSelectAll={() => patch({ names: target === 'element' ? elementTypeNames : relTypeNames })}
				onDeselectAll={() => patch({ names: [] })}
				open={openPicker === 'names'}
				onOpenChange={(o) => (openPicker = o ? 'names' : null)}
				searchPlaceholder="Filter types…"
			>
				<span class="rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800">
					Type: {summary(criterion.names)}
				</span>
			</StereotypePicker>
		{:else if criterion.type === 'property'}
			<StereotypePicker
				mode="create"
				names={propertyNames}
				onPick={(n) => patch({ name: n })}
				open={openPicker === 'prop'}
				onOpenChange={(o) => (openPicker = o ? 'prop' : null)}
				searchPlaceholder="Filter properties…"
			>
				<span class="rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800">
					{criterion.name || 'property…'}
				</span>
			</StereotypePicker>
			<select
				class="rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-zinc-200"
				value={criterion.op}
				onchange={(e) => patch({ op: e.currentTarget.value as typeof criterion.op })}
			>
				<option value="equals">=</option>
				<option value="not_equals">≠</option>
				<option value="contains">contains</option>
				<option value="matches">matches</option>
				<option value="gt">&gt;</option>
				<option value="lt">&lt;</option>
				<option value="gte">≥</option>
				<option value="lte">≤</option>
				<option value="exists">exists</option>
				<option value="is_empty">is empty</option>
			</select>
			{#if criterion.op !== 'exists' && criterion.op !== 'is_empty'}
				<Input
					type="text"
					value={criterion.value}
					oninput={(e) => patch({ value: (e.currentTarget as HTMLInputElement).value })}
					class="h-7 w-32 border-zinc-700 bg-zinc-900 text-xs"
					placeholder="value"
				/>
			{/if}
		{:else if criterion.type === 'name_id'}
			<select
				class="rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-zinc-200"
				value={criterion.field}
				onchange={(e) => patch({ field: e.currentTarget.value as 'name' | 'id' })}
			>
				<option value="name">name</option>
				<option value="id">id</option>
			</select>
			<select
				class="rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-zinc-200"
				value={criterion.op}
				onchange={(e) => patch({ op: e.currentTarget.value as typeof criterion.op })}
			>
				<option value="contains">contains</option>
				<option value="equals">equals</option>
				<option value="matches">matches</option>
			</select>
			<Input
				type="text"
				value={criterion.value}
				oninput={(e) => patch({ value: (e.currentTarget as HTMLInputElement).value })}
				class="h-7 w-32 border-zinc-700 bg-zinc-900 text-xs"
				placeholder="value"
			/>
		{:else if criterion.type === 'relation_count'}
			<span>has</span>
			<select
				class="rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-zinc-200"
				value={criterion.op}
				onchange={(e) => patch({ op: e.currentTarget.value as typeof criterion.op })}
			>
				<option value="at_least">at least</option>
				<option value="at_most">at most</option>
				<option value="exactly">exactly</option>
			</select>
			<Input
				type="number"
				value={String(criterion.count)}
				oninput={(e) => patch({ count: Number((e.currentTarget as HTMLInputElement).value) || 0 })}
				class="h-7 w-16 border-zinc-700 bg-zinc-900 text-xs"
			/>
			<span>relations</span>
			<select
				class="rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-zinc-200"
				value={criterion.direction}
				onchange={(e) => patch({ direction: e.currentTarget.value as typeof criterion.direction })}
			>
				<option value="either">either</option>
				<option value="outgoing">outgoing</option>
				<option value="incoming">incoming</option>
			</select>
			<StereotypePicker
				mode="filter"
				names={relTypeNames}
				checked={new SvelteSet(criterion.relTypes)}
				onToggle={(n) => toggleName('relTypes', n)}
				onSelectAll={() => patch({ relTypes: relTypeNames })}
				onDeselectAll={() => patch({ relTypes: [] })}
				open={openPicker === 'relTypes'}
				onOpenChange={(o) => (openPicker = o ? 'relTypes' : null)}
				searchPlaceholder="Filter rel types…"
			>
				<span class="rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800">
					of type: {summary(criterion.relTypes)}
				</span>
			</StereotypePicker>
		{:else if criterion.type === 'orphan'}
			<span class="text-zinc-400">No relations (orphan element).</span>
		{:else if criterion.type === 'connected_to_type'}
			<span>connected</span>
			<select
				class="rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-zinc-200"
				value={criterion.direction}
				onchange={(e) => patch({ direction: e.currentTarget.value as typeof criterion.direction })}
			>
				<option value="either">either</option>
				<option value="outgoing">outgoing</option>
				<option value="incoming">incoming</option>
			</select>
			<span>to type</span>
			<StereotypePicker
				mode="filter"
				names={elementTypeNames}
				checked={new SvelteSet(criterion.names)}
				onToggle={(n) => toggleName('names', n)}
				onSelectAll={() => patch({ names: elementTypeNames })}
				onDeselectAll={() => patch({ names: [] })}
				open={openPicker === 'names'}
				onOpenChange={(o) => (openPicker = o ? 'names' : null)}
				searchPlaceholder="Filter types…"
			>
				<span class="rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800">
					{summary(criterion.names)}
				</span>
			</StereotypePicker>
		{:else if criterion.type === 'endpoint_type'}
			<select
				class="rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-zinc-200"
				value={criterion.endpoint}
				onchange={(e) => patch({ endpoint: e.currentTarget.value as 'source' | 'target' })}
			>
				<option value="source">source</option>
				<option value="target">target</option>
			</select>
			<span>is type</span>
			<StereotypePicker
				mode="filter"
				names={elementTypeNames}
				checked={new SvelteSet(criterion.names)}
				onToggle={(n) => toggleName('names', n)}
				onSelectAll={() => patch({ names: elementTypeNames })}
				onDeselectAll={() => patch({ names: [] })}
				open={openPicker === 'names'}
				onOpenChange={(o) => (openPicker = o ? 'names' : null)}
				searchPlaceholder="Filter types…"
			>
				<span class="rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800">
					{summary(criterion.names)}
				</span>
			</StereotypePicker>
		{/if}
	</div>

	{#if regexInvalid}
		<p class="text-[11px] text-red-400">Invalid regular expression.</p>
	{/if}
</div>
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd frontend && npm run check`
Expected: 0 errors.

> Note: `StereotypePicker`'s `Props` is `(FilterMode | CreateMode) & {...}`. The `mode="filter"` usages must supply `names`, `checked`, `onToggle`, `onSelectAll`, `onDeselectAll`; the `mode="create"` usage must supply `names`, `onPick`. Both supply `open`, `onOpenChange`, and a child trigger. If `svelte-check` complains, re-check those props against `StereotypePicker.svelte:5-28`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/components/Sidebar/CriterionRow.svelte
git commit -m "feat(search): add CriterionRow editor component"
```

---

## Task 7: AdvancedSearchDialog component

**Files:**
- Create: `frontend/src/lib/components/Sidebar/AdvancedSearchDialog.svelte`

- [ ] **Step 1: Create the component**

Create `frontend/src/lib/components/Sidebar/AdvancedSearchDialog.svelte`:

```svelte
<script lang="ts">
	import { Plus } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import {
		addSearchCriterion,
		availableCriterionTypes,
		clearSearchCriteria,
		commitSearchResults,
		getDraftQuery,
		getSearchCriteria,
		getSearchDialogOpen,
		getSearchTarget,
		getWorkingModel,
		removeSearchCriterion,
		setSearchDialogOpen,
		setSearchTarget,
		updateSearchCriterion
	} from '$lib/state';
	import { isValidRegex } from '$lib/search/evaluate';
	import { runQuery } from '$lib/search/evaluate';
	import { CRITERION_LABELS, type Criterion } from '$lib/search/types';
	import CriterionRow from './CriterionRow.svelte';

	const open = $derived(getSearchDialogOpen());
	const target = $derived(getSearchTarget());
	const criteria = $derived(getSearchCriteria());

	const hasInvalidRegex = $derived(
		criteria.some(
			(c) =>
				(c.type === 'property' && c.op === 'matches' && !isValidRegex(c.value)) ||
				(c.type === 'name_id' && c.op === 'matches' && !isValidRegex(c.value))
		)
	);

	function onOpenChange(next: boolean): void {
		setSearchDialogOpen(next);
	}

	function onSearch(): void {
		if (hasInvalidRegex) return;
		const query = getDraftQuery();
		const results = runQuery(query, getWorkingModel());
		commitSearchResults(results, query.target);
		setSearchDialogOpen(false);
	}
</script>

<Dialog.Root bind:open={() => open, onOpenChange}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Advanced search</Dialog.Title>
			<Dialog.Description>
				Search for {target === 'element' ? 'elements' : 'relationships'} matching all criteria.
			</Dialog.Description>
		</Dialog.Header>

		<!-- Target-kind toggle -->
		<div class="flex items-center gap-2">
			<span class="text-xs text-zinc-400">Search for:</span>
			<div class="inline-flex overflow-hidden rounded border border-zinc-700">
				<button
					type="button"
					class="px-3 py-1 text-xs {target === 'element'
						? 'bg-indigo-600 text-white'
						: 'bg-zinc-900 text-zinc-300 hover:bg-zinc-800'}"
					onclick={() => setSearchTarget('element')}
				>
					Elements
				</button>
				<button
					type="button"
					class="px-3 py-1 text-xs {target === 'relationship'
						? 'bg-indigo-600 text-white'
						: 'bg-zinc-900 text-zinc-300 hover:bg-zinc-800'}"
					onclick={() => setSearchTarget('relationship')}
				>
					Relationships
				</button>
			</div>
		</div>

		<!-- Criteria list -->
		<div class="flex max-h-[55vh] flex-col gap-2 overflow-y-auto pr-1">
			{#if criteria.length === 0}
				<p class="text-xs text-zinc-500">
					No criteria — search will list every {target === 'element' ? 'element' : 'relationship'}.
				</p>
			{/if}
			{#each criteria as criterion, index (index)}
				<CriterionRow
					{criterion}
					{index}
					{target}
					onChange={(i, next: Criterion) => updateSearchCriterion(i, next)}
					onRemove={(i) => removeSearchCriterion(i)}
				/>
			{/each}
		</div>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				class="inline-flex w-fit items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
			>
				<Plus class="h-3 w-3" /> Add criterion
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" class="w-52">
				{#each availableCriterionTypes() as t (t)}
					<DropdownMenu.Item onSelect={() => addSearchCriterion(t)}>
						{CRITERION_LABELS[t]}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<Dialog.Footer>
			<Button type="button" variant="ghost" onclick={() => clearSearchCriteria()}>Clear</Button>
			<Button
				type="button"
				class="bg-indigo-600 text-white hover:bg-indigo-500"
				onclick={onSearch}
				disabled={hasInvalidRegex}
			>
				Search
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
```

> Note on `bind:open={() => open, onOpenChange}`: this is the Svelte 5 function-binding form already used in `StereotypePicker.svelte:55`. If `svelte-check` objects in this Dialog context, fall back to a local mirror: `let localOpen = $derived(open)` with `bind:open={localOpen}` plus `$effect(() => onOpenChange(localOpen))`, mirroring `routes/+page.svelte:21-25`.

- [ ] **Step 2: Verify it type-checks**

Run: `cd frontend && npm run check`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/components/Sidebar/AdvancedSearchDialog.svelte
git commit -m "feat(search): add AdvancedSearchDialog popup"
```

---

## Task 8: Wire the trigger button into Search.svelte

**Files:**
- Modify: `frontend/src/lib/components/Sidebar/Search.svelte`

- [ ] **Step 1: Add imports**

In `frontend/src/lib/components/Sidebar/Search.svelte`, extend the existing imports. Change the top import lines to:

```ts
	import { Input } from '$lib/components/ui/input';
	import { SlidersHorizontal } from '@lucide/svelte';
	import {
		getSearchText,
		getWorkingModel,
		select,
		setSearchDialogOpen,
		setSearchText
	} from '$lib/state';
	import type { Element } from '$lib/api/types';
	import AdvancedSearchDialog from './AdvancedSearchDialog.svelte';
```

- [ ] **Step 2: Wrap the input and add the button**

In the same file, replace the `<Input ... />` element (lines ~86-96, the search input) with a flex row containing the input and the advanced-search button:

```svelte
	<div class="flex items-center gap-1">
		<Input
			bind:ref={inputEl}
			type="text"
			placeholder="Filter by name, type, id…"
			value={searchText}
			oninput={onInput}
			onfocus={onFocusOrClick}
			onclick={onFocusOrClick}
			onkeydown={onKeydown}
			class="h-7 flex-1 border-zinc-800 bg-zinc-900 text-xs placeholder:text-zinc-600"
		/>
		<button
			type="button"
			data-testid="advanced-search-button"
			aria-label="Advanced search"
			class="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-zinc-800 bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
			onclick={() => setSearchDialogOpen(true)}
		>
			<SlidersHorizontal class="h-3.5 w-3.5" />
		</button>
	</div>
```

- [ ] **Step 3: Mount the dialog**

At the very end of the `<section>...</section>` block (just before the closing `</section>` on the last line), add:

```svelte
	<AdvancedSearchDialog />
```

- [ ] **Step 4: Verify it type-checks**

Run: `cd frontend && npm run check`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Sidebar/Search.svelte
git commit -m "feat(search): add advanced-search trigger button to sidebar search"
```

---

## Task 9: ResultsPanel component

**Files:**
- Create: `frontend/src/lib/components/ResultsPanel.svelte`

- [ ] **Step 1: Create the component**

Create `frontend/src/lib/components/ResultsPanel.svelte`:

```svelte
<script lang="ts">
	import { X } from '@lucide/svelte';
	import type { Element, Relationship } from '$lib/api/types';
	import {
		closeResultsPanel,
		getSearchResults,
		getSearchResultsTarget,
		getWorkingModel,
		select
	} from '$lib/state';

	const results = $derived(getSearchResults());
	const target = $derived(getSearchResultsTarget());
	const working = $derived(getWorkingModel());

	const elementsById = $derived(new Map(working.elements.map((e) => [e.id, e])));
	const relationshipsById = $derived(new Map(working.relationships.map((r) => [r.id, r])));

	function elementName(e: Element): string {
		const n = e.properties?.name;
		return typeof n === 'string' && n.length > 0 ? n : e.id;
	}

	type Row =
		| { kind: 'element'; id: string; el: Element }
		| { kind: 'relationship'; id: string; rel: Relationship };

	// Resolve display rows from the live model; drop stale ids.
	const rows = $derived.by<Row[]>(() => {
		const out: Row[] = [];
		for (const r of results) {
			if (r.kind === 'element') {
				const el = elementsById.get(r.id);
				if (el) out.push({ kind: 'element', id: r.id, el });
			} else {
				const rel = relationshipsById.get(r.id);
				if (rel) out.push({ kind: 'relationship', id: r.id, rel });
			}
		}
		return out;
	});

	function endpointLabel(id: string): string {
		const el = elementsById.get(id);
		return el ? elementName(el) : id;
	}

	function onPick(row: Row): void {
		select({ kind: row.kind, id: row.id });
	}
</script>

<section
	data-testid="results-panel"
	class="col-span-5 flex h-full flex-col overflow-hidden border-t border-zinc-800 bg-zinc-950"
>
	<header class="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
		<h2 class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
			Results
			<span class="ml-1 font-mono text-zinc-500">({rows.length})</span>
		</h2>
		<span class="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
			{target}
		</span>
		<button
			type="button"
			aria-label="Close results"
			class="ml-auto flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
			onclick={() => closeResultsPanel()}
		>
			<X class="h-3.5 w-3.5" />
		</button>
	</header>

	<div class="flex-1 overflow-y-auto">
		{#if rows.length === 0}
			<p class="px-3 py-2 text-xs text-zinc-600">No results.</p>
		{:else}
			<ul class="flex flex-col p-1 text-xs">
				{#each rows as row (row.id)}
					<li>
						<button
							type="button"
							class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
							onclick={() => onPick(row)}
						>
							{#if row.kind === 'element'}
								<span class="truncate text-zinc-200">{elementName(row.el)}</span>
								<span class="ml-auto shrink-0 rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400">
									{row.el.type_name}
								</span>
								<span class="shrink-0 font-mono text-[10px] text-zinc-600">{row.id}</span>
							{:else}
								<span class="shrink-0 rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400">
									{row.rel.type_name}
								</span>
								<span class="truncate text-zinc-300">
									{endpointLabel(row.rel.source_id)} → {endpointLabel(row.rel.target_id)}
								</span>
								<span class="ml-auto shrink-0 font-mono text-[10px] text-zinc-600">{row.id}</span>
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</section>
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd frontend && npm run check`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/components/ResultsPanel.svelte
git commit -m "feat(search): add bottom ResultsPanel"
```

---

## Task 10: Mount the panel in the page layout

**Files:**
- Modify: `frontend/src/routes/+page.svelte`

- [ ] **Step 1: Add imports and state**

In `frontend/src/routes/+page.svelte`, add to the imports:

```ts
	import ResultsPanel from '$lib/components/ResultsPanel.svelte';
	import { getResultsPanelOpen } from '$lib/state';
```

(The existing `import { getDiffDrawerOpen, setDiffDrawerOpen } from '$lib/state';` can be merged with these — keep one `from '$lib/state'` statement.)

Add panel state next to the existing width state (after the `leftWidth`/`rightWidth` declarations):

```ts
	const LS_PANEL = 'ui.resultsPanelHeight';
	const DEFAULT_PANEL = 240;
	let panelHeight = $state(readWidth(LS_PANEL, DEFAULT_PANEL));
	const panelOpen = $derived(getResultsPanelOpen());

	$effect(() => {
		if (browser) localStorage.setItem(LS_PANEL, String(panelHeight));
	});
```

- [ ] **Step 2: Make the grid rows dynamic**

Replace the `cols` derived line:

```ts
	const cols = $derived(`${leftWidth}px 4px 1fr 4px ${rightWidth}px`);
```

…and add a `rows` derived value beneath it:

```ts
	const cols = $derived(`${leftWidth}px 4px 1fr 4px ${rightWidth}px`);
	const rows = $derived(
		panelOpen ? `auto 1fr auto ${panelHeight}px auto` : 'auto 1fr auto'
	);
```

- [ ] **Step 3: Apply rows to the grid and render the panel**

Change the grid container's class so the static `grid-rows-[auto_1fr_auto]` becomes dynamic, and add `style:grid-template-rows`. The opening `<div>` becomes:

```svelte
<div
	class="grid h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-100"
	style:grid-template-columns={cols}
	style:grid-template-rows={rows}
>
```

Then, between `<Inspector />` and `<StatusBar />`, insert the resize handle and panel (only when open):

```svelte
	<Inspector />
	{#if panelOpen}
		<ResizeHandle
			value={panelHeight}
			axis="y"
			min={120}
			max={700}
			onchange={(n) => (panelHeight = n)}
		/>
		<ResultsPanel />
	{/if}
	<StatusBar />
```

> Why this works: `ResizeHandle` (axis `y`) and `ResultsPanel` both render full-width via `col-span-5`, so grid auto-placement puts each on its own row. With the panel open, `rows` has 5 entries: TopBar / content / handle / panel / StatusBar. The `ResizeHandle` root needs `col-span-5` — add it: in the markup above it inherits width from the grid cell, but to span all columns, wrap it. Simplest: give the handle a wrapper. Replace the `<ResizeHandle .../>` line with:

```svelte
		<div class="col-span-5">
			<ResizeHandle
				value={panelHeight}
				axis="y"
				min={120}
				max={700}
				onchange={(n) => (panelHeight = n)}
			/>
		</div>
```

- [ ] **Step 4: Verify build + types**

Run: `cd frontend && npm run check`
Expected: 0 errors.

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Manual sanity check (dev server)**

Run: `cd frontend && npm run dev` then open the app, load a metamodel + model, click the sliders button, add a `Name / ID contains` criterion, press Search. Confirm: the bottom panel appears, is scrollable, the top edge drags to resize, clicking a row populates the Inspector, and the X closes the panel. Stop the dev server when done.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/routes/+page.svelte
git commit -m "feat(search): mount resizable results panel in page layout"
```

---

## Task 11: Playwright e2e smoke

**Files:**
- Create: `frontend/e2e/advanced-search.spec.ts`

- [ ] **Step 1: Write the e2e test**

Create `frontend/e2e/advanced-search.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METAMODEL_PATH = join(__dirname, '..', '..', 'examples', 'example.metamodel.yaml');

// A model with one Block named "Alpha".
const MODEL = JSON.stringify({
	elements: [{ id: 'e1', type_name: 'Block', properties: { name: 'Alpha' }, rev: 1 }],
	relationships: []
});

test('advanced search finds an element and opens its detail', async ({ page }) => {
	test.setTimeout(90_000);
	await page.goto('/');

	// Load metamodel.
	await page.getByRole('button', { name: 'Load metamodel...' }).click();
	const mmDialog = page.getByRole('dialog', { name: /load metamodel/i });
	await expect(mmDialog).toBeVisible();
	await mmDialog.locator('input[type="file"]').setInputFiles(METAMODEL_PATH);
	await mmDialog.getByRole('button', { name: 'Load', exact: true }).click();
	await expect(mmDialog).toBeHidden();

	// Load model.
	await page.getByRole('button', { name: 'Load model...' }).click();
	const modelDialog = page.getByRole('dialog', { name: /load model/i });
	await expect(modelDialog).toBeVisible();
	await modelDialog.locator('input[type="file"]').setInputFiles({
		name: 'model.json',
		mimeType: 'application/json',
		buffer: Buffer.from(MODEL)
	});
	await modelDialog.getByRole('button', { name: 'Load', exact: true }).click();
	await expect(modelDialog).toBeHidden();

	// Open advanced search.
	await page.getByTestId('advanced-search-button').click();
	const dialog = page.getByRole('dialog', { name: /advanced search/i });
	await expect(dialog).toBeVisible();

	// Add a Name / ID criterion (defaults to name + contains) and type "Alpha".
	await dialog.getByRole('button', { name: 'Add criterion' }).click();
	await page.getByRole('menuitem', { name: 'Name / ID' }).click();
	await dialog.locator('input[placeholder="value"]').fill('Alpha');

	// Search.
	await dialog.getByRole('button', { name: 'Search', exact: true }).click();
	await expect(dialog).toBeHidden();

	// Panel shows the result; clicking it opens the Inspector detail.
	const panel = page.getByTestId('results-panel');
	await expect(panel).toBeVisible();
	await panel.getByRole('button', { name: /Alpha/ }).click();

	const inspector = page.getByTestId('inspector');
	await expect(inspector.locator('input[type="text"]').first()).toHaveValue('Alpha');

	// Close the panel.
	await panel.getByRole('button', { name: 'Close results' }).click();
	await expect(panel).toBeHidden();
});
```

- [ ] **Step 2: Run the e2e test**

Run: `cd frontend && npm run test:e2e -- advanced-search.spec.ts`
Expected: PASS. (The config auto-starts the backend + Vite dev server; first run may take time.)

> If the metamodel example lacks a `Block` type, open `examples/example.metamodel.yaml`, pick any concrete element type name it defines, and substitute it for `Block` in `MODEL` and the assertions.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/advanced-search.spec.ts
git commit -m "test(e2e): smoke advanced search results panel + detail open"
```

---

## Task 12: Final verification

- [ ] **Step 1: Full unit suite**

Run: `cd frontend && npm run test`
Expected: all tests pass (including the new search tests).

- [ ] **Step 2: Type check + lint**

Run: `cd frontend && npm run check && npm run lint`
Expected: 0 errors. (If `prettier --check` flags formatting, run `npm run format` and amend.)

- [ ] **Step 3: e2e suite**

Run: `cd frontend && npm run test:e2e`
Expected: existing smoke/dnd/view specs plus the new advanced-search spec pass.

- [ ] **Step 4: Commit any formatting fixups**

```bash
git add -A
git commit -m "chore(search): formatting and lint fixups"
```

---

## Self-review notes (addressed)

- **Spec coverage:** target toggle (Task 7), all shared + element + relationship criteria (Tasks 1-3, 6), searchable metamodel-aware pickers (Task 6 via `StereotypePicker`), AND semantics + empty-list-lists-all (Tasks 2-3), client-side over working model (Task 7), single replace panel + X clears (Tasks 4, 9), resizable/scrollable full-width bottom panel (Tasks 5, 9, 10), height persistence (Task 10), click-opens-detail via `select()` reusing Inspector (Tasks 9, 11), invalid-regex blocking (Tasks 6, 7).
- **Type consistency:** `Criterion`/`CriterionType`/`AdvancedQuery`/`SearchResultItem`/`TargetKind` defined in Task 1 are used unchanged in Tasks 2-9. Store getters/setters named in Task 4 match their imports in Tasks 6-10. `runQuery`/`isValidRegex` signatures match across Tasks 2, 6, 7.
- **Known follow-up risks (verify during execution, not blockers):** the Svelte 5 `bind:open={() => v, setter}` form (Task 7 note); `StereotypePicker` union-prop typing (Task 6 note); `ResizeHandle` `col-span-5` wrapper (Task 10 Step 3); example metamodel type name (Task 11 note).
