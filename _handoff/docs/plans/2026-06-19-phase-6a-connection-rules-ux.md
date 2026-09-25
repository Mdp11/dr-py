# Phase 6A — Connection-rules editing UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inspector "New relationship" picker metamodel-driven — offer only the relationship types the metamodel's `mappings` allow from the selected source, with an always-available "Show all types" escape hatch and source-side multiplicity gray-out.

**Architecture:** All decision logic lives in a new pure module `frontend/src/lib/metamodel/connection-rules.ts` (Svelte-free, unit-tested like the existing `helpers.ts`). `NewRelationshipPicker.svelte` becomes a thin view over that module. Out-counts for the gray-out come from the client's reactive relationship cache (`getCachedRelationships`), so they reflect staged/uncommitted edits. **No backend changes.**

**Tech Stack:** SvelteKit (Svelte 5 runes), TypeScript, Zod types in `$lib/api/types`, Vitest (happy-dom) for units, Playwright for e2e. All commands run through `pixi run -e frontend ...`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-19-phase-6a-connection-rules-ux-design.md`.
- Frontend env only; run tests via `pixi run -e frontend npm test` (vitest) and `pixi run -e frontend npm run test:e2e` (playwright). Typecheck via `pixi run -e frontend npm run check`.
- **No backend / route / schema / core changes.** Pure frontend.
- Gesture scope: `NewRelationshipPicker.svelte` only. Do NOT touch other connect gestures (ContainmentTree drag, DetailView) or `RelationshipsList.svelte`.
- Multiplicity enforced in the picker is **source-side `target_multiplicity`** only (bounds the source's out-degree). Do NOT enforce `source_multiplicity` (target-side) — it stays a soft commit-time flag.
- Escape hatch is a per-picker "Show all types" toggle. Do NOT introduce a strict-mode flag/setting.
- Multiplicity semantics (verified against `core/validation/validators/multiplicity.py`): `target_multiplicity` bounds `count_out(source, rel_type)`. A type is "at max" when `upper !== null && count_out >= upper`.
- New pure functions reuse existing helpers from `frontend/src/lib/metamodel/helpers.ts`: `isSubtype`, `parseMultiplicity` (returns `{ lower: number; upper: number | null }`). Do NOT reimplement these.
- Existing types (`$lib/api/types`): `RelationshipType` has `{ name, abstract, source, target, mappings: {source,target}[], source_multiplicity, target_multiplicity, ... }`; `Relationship` has `{ id, type_name, source_id, target_id, properties }`; `Element` has `{ id, type_name, properties }`.

---

### Task 1: Pure connection-rules predicates

**Files:**
- Create: `frontend/src/lib/metamodel/connection-rules.ts`
- Test: `frontend/src/lib/metamodel/connection-rules.test.ts`

**Interfaces:**
- Consumes: `isSubtype`, `parseMultiplicity` from `./helpers`; `Metamodel`, `RelationshipType` from `$lib/api/types`.
- Produces:
  - `allowedTargetTypes(mm: Metamodel, sourceType: string, rt: RelationshipType): string[]`
  - `interface RelTypeFromSource { rt: RelationshipType; targetTypes: string[] }`
  - `relationshipTypesFromSource(mm: Metamodel, sourceType: string): RelTypeFromSource[]`
  - `targetMultiplicityExceeded(rt: RelationshipType, currentOutCount: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/metamodel/connection-rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { Metamodel, RelationshipType } from '$lib/api/types';
import {
	allowedTargetTypes,
	relationshipTypesFromSource,
	targetMultiplicityExceeded
} from './connection-rules';

// Minimal relationship-type factory (fills schema defaults).
function rel(p: Partial<RelationshipType> & { name: string }): RelationshipType {
	return {
		name: p.name,
		abstract: p.abstract ?? false,
		extends: p.extends ?? null,
		containment: p.containment ?? false,
		source: p.source ?? '',
		target: p.target ?? '',
		mappings: p.mappings ?? [],
		source_multiplicity: p.source_multiplicity ?? '0..*',
		target_multiplicity: p.target_multiplicity ?? '0..*',
		properties: p.properties ?? []
	};
}

const mm: Metamodel = {
	enums: {},
	elements: [
		{ name: 'Element', abstract: true, extends: null, properties: [], key: null },
		{ name: 'Component', abstract: false, extends: 'Element', properties: [], key: null },
		{ name: 'Microservice', abstract: false, extends: 'Component', properties: [], key: null },
		{ name: 'Requirement', abstract: false, extends: 'Element', properties: [], key: null },
		{ name: 'Database', abstract: false, extends: 'Element', properties: [], key: null }
	],
	relationships: [
		// multi-mapping: from Component->Requirement OR Microservice->Database
		rel({
			name: 'Multi',
			mappings: [
				{ source: 'Component', target: 'Requirement' },
				{ source: 'Microservice', target: 'Database' }
			]
		}),
		// single-pair via shorthand only (mappings empty -> fall back)
		rel({ name: 'Shorthand', source: 'Requirement', target: 'Requirement' }),
		rel({ name: 'Abstract', abstract: true, mappings: [{ source: 'Component', target: 'Database' }] }),
		// bounded out-degree
		rel({
			name: 'OwnsOne',
			source: 'Component',
			target: 'Database',
			mappings: [{ source: 'Component', target: 'Database' }],
			target_multiplicity: '0..1'
		})
	]
};

describe('allowedTargetTypes', () => {
	it('selects targets whose mapping source matches via inheritance', () => {
		const multi = mm.relationships.find((r) => r.name === 'Multi')!;
		// Microservice is a Component AND a Microservice -> both mappings match.
		expect(allowedTargetTypes(mm, 'Microservice', multi).sort()).toEqual(
			['Database', 'Requirement'].sort()
		);
		// A plain Component matches only the Component->Requirement mapping.
		expect(allowedTargetTypes(mm, 'Component', multi)).toEqual(['Requirement']);
		// Requirement matches neither mapping source.
		expect(allowedTargetTypes(mm, 'Requirement', multi)).toEqual([]);
	});

	it('falls back to source/target shorthand when mappings is empty', () => {
		const sh = mm.relationships.find((r) => r.name === 'Shorthand')!;
		expect(allowedTargetTypes(mm, 'Requirement', sh)).toEqual(['Requirement']);
		expect(allowedTargetTypes(mm, 'Component', sh)).toEqual([]);
	});
});

describe('relationshipTypesFromSource', () => {
	it('returns non-abstract types with a non-empty target set, sorted by name', () => {
		const fromComponent = relationshipTypesFromSource(mm, 'Component');
		expect(fromComponent.map((e) => e.rt.name)).toEqual(['Multi', 'OwnsOne']);
		// Abstract excluded even though its mapping matches Component.
		expect(fromComponent.find((e) => e.rt.name === 'Abstract')).toBeUndefined();
	});
});

describe('targetMultiplicityExceeded', () => {
	const ownsOne = mm.relationships.find((r) => r.name === 'OwnsOne')!;
	const unbounded = mm.relationships.find((r) => r.name === 'Multi')!;

	it('is true once count reaches a finite upper bound', () => {
		expect(targetMultiplicityExceeded(ownsOne, 0)).toBe(false);
		expect(targetMultiplicityExceeded(ownsOne, 1)).toBe(true);
		expect(targetMultiplicityExceeded(ownsOne, 2)).toBe(true);
	});

	it('is never true for an unbounded (..*) upper', () => {
		expect(targetMultiplicityExceeded(unbounded, 9999)).toBe(false);
	});

	it('treats a malformed spec as unbounded (parseMultiplicity returns 0..*)', () => {
		expect(targetMultiplicityExceeded(rel({ name: 'X', target_multiplicity: 'garbage' }), 5)).toBe(
			false
		);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend npm test -- src/lib/metamodel/connection-rules.test.ts`
Expected: FAIL — `Failed to resolve import "./connection-rules"` / functions not defined.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/lib/metamodel/connection-rules.ts`:

```ts
// Pure connection-rules helpers mirroring the backend metamodel mapping +
// end-constraint semantics (core/validation/validators/endpoint_typing.py and
// multiplicity.py). Svelte-free so they unit-test in isolation, like helpers.ts.

import type { Metamodel, RelationshipType } from '$lib/api/types';
import { isSubtype, parseMultiplicity } from './helpers';

/**
 * Distinct target types reachable from `sourceType` through `rt`'s mappings:
 * every `mapping.target` whose `mapping.source` is a supertype-or-equal of
 * `sourceType`. Falls back to the single-pair `rt.source`/`rt.target`
 * shorthand when `rt.mappings` is empty (the backend keeps them in sync, but
 * the zod schema defaults `mappings` to `[]`).
 */
export function allowedTargetTypes(
	mm: Metamodel,
	sourceType: string,
	rt: RelationshipType
): string[] {
	const mappings = rt.mappings.length > 0 ? rt.mappings : [{ source: rt.source, target: rt.target }];
	const targets: string[] = [];
	for (const m of mappings) {
		if (isSubtype(mm, sourceType, m.source) && !targets.includes(m.target)) {
			targets.push(m.target);
		}
	}
	return targets;
}

export interface RelTypeFromSource {
	rt: RelationshipType;
	targetTypes: string[];
}

/**
 * Non-abstract relationship types creatable from `sourceType`, each paired
 * with its allowed target types. Excludes types with no matching mapping.
 * Sorted by relationship-type name.
 */
export function relationshipTypesFromSource(
	mm: Metamodel,
	sourceType: string
): RelTypeFromSource[] {
	return mm.relationships
		.filter((rt) => !rt.abstract)
		.map((rt) => ({ rt, targetTypes: allowedTargetTypes(mm, sourceType, rt) }))
		.filter((entry) => entry.targetTypes.length > 0)
		.sort((a, b) => a.rt.name.localeCompare(b.rt.name));
}

/**
 * True when `rt`'s `target_multiplicity` has a finite upper bound and the
 * source already has >= upper outgoing edges of this type. Matches the
 * MultiplicityValidator target-end check (target_multiplicity bounds
 * count_out(source, rel_type)). A malformed spec parses to `0..*` (no upper),
 * so this returns false rather than throwing.
 */
export function targetMultiplicityExceeded(rt: RelationshipType, currentOutCount: number): boolean {
	const { upper } = parseMultiplicity(rt.target_multiplicity);
	return upper !== null && currentOutCount >= upper;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e frontend npm test -- src/lib/metamodel/connection-rules.test.ts`
Expected: PASS (all `describe` blocks green).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/metamodel/connection-rules.ts frontend/src/lib/metamodel/connection-rules.test.ts
git commit -m "feat(frontend): mappings-aware connection-rules predicates (Phase 6A)"
```

---

### Task 2: Picker option builder + out-count grouping

**Files:**
- Modify: `frontend/src/lib/metamodel/connection-rules.ts` (append)
- Test: `frontend/src/lib/metamodel/connection-rules.test.ts` (append)

**Interfaces:**
- Consumes: `relationshipTypesFromSource`, `targetMultiplicityExceeded` (Task 1); `parseMultiplicity` from `./helpers`; `Relationship`, `Metamodel` from `$lib/api/types`.
- Produces:
  - `outCountsByType(relationships: Iterable<Relationship>, sourceId: string): Map<string, number>`
  - `interface PickerTypeOption { rt: RelationshipType; targetTypes: string[]; allowed: boolean; atMax: boolean; outCount: number; max: number | null; disabled: boolean }`
  - `buildPickerTypeOptions(mm: Metamodel, sourceType: string, outCounts: Map<string, number>, showAll: boolean): PickerTypeOption[]`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/metamodel/connection-rules.test.ts`:

```ts
import type { Relationship } from '$lib/api/types';
import { buildPickerTypeOptions, outCountsByType } from './connection-rules';

function relInstance(p: Partial<Relationship> & { id: string; type_name: string }): Relationship {
	return {
		id: p.id,
		type_name: p.type_name,
		source_id: p.source_id ?? '',
		target_id: p.target_id ?? '',
		properties: p.properties ?? {},
		rev: p.rev ?? 0
	};
}

describe('outCountsByType', () => {
	it('counts only outgoing edges of the given source, grouped by type', () => {
		const rels = [
			relInstance({ id: 'r1', type_name: 'OwnsOne', source_id: 'a', target_id: 'd1' }),
			relInstance({ id: 'r2', type_name: 'Multi', source_id: 'a', target_id: 'q1' }),
			relInstance({ id: 'r3', type_name: 'Multi', source_id: 'a', target_id: 'q2' }),
			relInstance({ id: 'r4', type_name: 'Multi', source_id: 'OTHER', target_id: 'q3' })
		];
		const counts = outCountsByType(rels, 'a');
		expect(counts.get('OwnsOne')).toBe(1);
		expect(counts.get('Multi')).toBe(2);
		expect(counts.has('OTHER')).toBe(false);
	});
});

describe('buildPickerTypeOptions', () => {
	it('filtered mode: only allowed types; disables a maxed type', () => {
		const counts = new Map([['OwnsOne', 1]]);
		const opts = buildPickerTypeOptions(mm, 'Component', counts, false);
		expect(opts.map((o) => o.rt.name)).toEqual(['Multi', 'OwnsOne']);
		const ownsOne = opts.find((o) => o.rt.name === 'OwnsOne')!;
		expect(ownsOne.allowed).toBe(true);
		expect(ownsOne.atMax).toBe(true);
		expect(ownsOne.disabled).toBe(true);
		expect(ownsOne.outCount).toBe(1);
		expect(ownsOne.max).toBe(1);
		const multi = opts.find((o) => o.rt.name === 'Multi')!;
		expect(multi.atMax).toBe(false);
		expect(multi.disabled).toBe(false);
	});

	it('show-all mode: includes disallowed types and downgrades the maxed disable', () => {
		const counts = new Map([['OwnsOne', 1]]);
		const opts = buildPickerTypeOptions(mm, 'Component', counts, true);
		// Shorthand (Requirement->Requirement) is NOT allowed from Component but shows in show-all.
		const shorthand = opts.find((o) => o.rt.name === 'Shorthand')!;
		expect(shorthand.allowed).toBe(false);
		expect(shorthand.targetTypes).toEqual(['Requirement']);
		// Abstract types are excluded even in show-all.
		expect(opts.find((o) => o.rt.name === 'Abstract')).toBeUndefined();
		// Maxed type still flagged atMax but NOT disabled (escape hatch overrides).
		const ownsOne = opts.find((o) => o.rt.name === 'OwnsOne')!;
		expect(ownsOne.atMax).toBe(true);
		expect(ownsOne.disabled).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend npm test -- src/lib/metamodel/connection-rules.test.ts`
Expected: FAIL — `buildPickerTypeOptions`/`outCountsByType` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/src/lib/metamodel/connection-rules.ts`:

```ts
import type { Relationship } from '$lib/api/types';

/** Outgoing-edge counts per relationship type for one source element. */
export function outCountsByType(
	relationships: Iterable<Relationship>,
	sourceId: string
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const r of relationships) {
		if (r.source_id !== sourceId) continue;
		counts.set(r.type_name, (counts.get(r.type_name) ?? 0) + 1);
	}
	return counts;
}

export interface PickerTypeOption {
	rt: RelationshipType;
	/** Allowed target types to fetch candidates from. */
	targetTypes: string[];
	/** Allowed by the metamodel mappings from this source type. */
	allowed: boolean;
	/** Source already at target_multiplicity upper bound for this type. */
	atMax: boolean;
	outCount: number;
	/** Upper bound, or null when unbounded. */
	max: number | null;
	/** Hard guardrail: render disabled (atMax AND not in show-all mode). */
	disabled: boolean;
}

function uniqueTargets(rt: RelationshipType): string[] {
	const raw = rt.mappings.length > 0 ? rt.mappings.map((m) => m.target) : [rt.target];
	return [...new Set(raw)];
}

/**
 * The relationship-type options the picker renders for `sourceType`.
 *
 * - filtered (`showAll === false`): only mapping-allowed types; a type whose
 *   source is at target_multiplicity max is `disabled`.
 * - escape hatch (`showAll === true`): every non-abstract type (allowed flag
 *   distinguishes off-metamodel ones); the maxed disable is downgraded to a
 *   non-disabling `atMax` flag so the user can still create it.
 */
export function buildPickerTypeOptions(
	mm: Metamodel,
	sourceType: string,
	outCounts: Map<string, number>,
	showAll: boolean
): PickerTypeOption[] {
	const allowed = relationshipTypesFromSource(mm, sourceType);
	const allowedByName = new Map(allowed.map((e) => [e.rt.name, e]));

	const base: { rt: RelationshipType; targetTypes: string[]; allowed: boolean }[] = showAll
		? mm.relationships
				.filter((rt) => !rt.abstract)
				.slice()
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((rt) => {
					const hit = allowedByName.get(rt.name);
					return {
						rt,
						targetTypes: hit ? hit.targetTypes : uniqueTargets(rt),
						allowed: hit !== undefined
					};
				})
		: allowed.map((e) => ({ rt: e.rt, targetTypes: e.targetTypes, allowed: true }));

	return base.map(({ rt, targetTypes, allowed: isAllowed }) => {
		const outCount = outCounts.get(rt.name) ?? 0;
		const { upper } = parseMultiplicity(rt.target_multiplicity);
		const atMax = targetMultiplicityExceeded(rt, outCount);
		return {
			rt,
			targetTypes,
			allowed: isAllowed,
			atMax,
			outCount,
			max: upper,
			disabled: atMax && !showAll
		};
	});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e frontend npm test -- src/lib/metamodel/connection-rules.test.ts`
Expected: PASS (Task 1 + Task 2 blocks green).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/metamodel/connection-rules.ts frontend/src/lib/metamodel/connection-rules.test.ts
git commit -m "feat(frontend): picker option builder + out-count grouping (Phase 6A)"
```

---

### Task 3: Rewire NewRelationshipPicker.svelte

**Files:**
- Modify: `frontend/src/lib/components/Inspector/NewRelationshipPicker.svelte`

**Interfaces:**
- Consumes: `buildPickerTypeOptions`, `outCountsByType`, `type PickerTypeOption` (Task 2); existing state exports `getMetamodel`, `getCachedElements`, `getCachedRelationships`, `seedRelationships`, `createTempId`, `emit`, `ensureElement` from `$lib/state`; `fetchElementsOfType` from `$lib/state/element-queries`; `listElementRelationships` from `$lib/api/model-read`; `connectLock` from `$lib/state/edit-gate`.
- Produces: no new exports (a component).

- [ ] **Step 1: Replace the component script + add the toggle UI**

Rewrite `frontend/src/lib/components/Inspector/NewRelationshipPicker.svelte` to the following. (The `<select>` for target, the `create`/`cancel` flow and styling are kept; the type list, the seed-out-rels effect, the multi-target fetch, and the Show-all toggle are new.)

```svelte
<script lang="ts">
	import type { Element } from '$lib/api/types';
	import { buildPickerTypeOptions, outCountsByType } from '$lib/metamodel/connection-rules';
	import {
		createTempId,
		emit,
		ensureElement,
		getCachedElements,
		getCachedRelationships,
		getMetamodel,
		seedRelationships
	} from '$lib/state';
	import { connectLock } from '$lib/state/edit-gate';
	import { fetchElementsOfType } from '$lib/state/element-queries';
	import { listElementRelationships } from '$lib/api/model-read';
	import { elementDisplayName as displayName } from '$lib/util/element-name';
	import { Plus, X } from '@lucide/svelte';

	type Props = {
		sourceId: string;
	};

	let { sourceId }: Props = $props();

	const mm = $derived(getMetamodel());
	const elements = $derived(getCachedElements());
	const relationships = $derived(getCachedRelationships());

	$effect(() => {
		void ensureElement(sourceId);
	});

	const source = $derived(elements.get(sourceId) ?? null);

	let expanded = $state(false);
	let showAll = $state(false);
	let selectedType = $state<string>('');
	let selectedTarget = $state<string>('');

	// Seed this source's outgoing relationships once expanded, so out-counts
	// (and thus the multiplicity gray-out) are available. The list itself is
	// derived from the reactive cache, so optimistic emits update counts live.
	const SEED_LIMIT = 500;
	$effect(() => {
		if (!expanded) return;
		const id = sourceId;
		void (async () => {
			try {
				const page = await listElementRelationships(id, { direction: 'out', limit: SEED_LIMIT });
				seedRelationships(page.items);
			} catch (err) {
				console.error('Failed to seed source relationships', err);
			}
		})();
	});

	const outCounts = $derived(outCountsByType(relationships.values(), sourceId));

	const typeOptions = $derived.by(() => {
		if (mm === null || source === null) return [];
		return buildPickerTypeOptions(mm, source.type_name, outCounts, showAll);
	});

	const chosenOption = $derived(
		selectedType === '' ? null : (typeOptions.find((o) => o.rt.name === selectedType) ?? null)
	);

	// Candidate targets are fetched server-side per chosen type, across the
	// UNION of its allowed target types (a type can map to several).
	const TARGET_CAP = 200;
	let candidateTargets: Element[] = $state([]);
	let candidatesTotal = $state(0);
	let candidatesTotalExact = $state(true);
	let fetchSeq = 0;

	$effect(() => {
		const meta = mm;
		const opt = chosenOption;
		const seq = ++fetchSeq;
		if (meta === null || opt === null) {
			candidateTargets = [];
			candidatesTotal = 0;
			candidatesTotalExact = true;
			return;
		}
		void (async () => {
			try {
				const byId = new Map<string, Element>();
				let total = 0;
				let exact = true;
				for (const targetType of opt.targetTypes) {
					const remaining = TARGET_CAP - byId.size;
					if (remaining <= 0) {
						exact = false;
						break;
					}
					const res = await fetchElementsOfType(meta, targetType, remaining);
					if (seq !== fetchSeq) return;
					for (const el of res.elements) byId.set(el.id, el);
					total += res.total;
					if (!res.totalIsExact) exact = false;
				}
				if (seq !== fetchSeq) return;
				candidateTargets = [...byId.values()].sort((a, b) =>
					displayName(a).localeCompare(displayName(b))
				);
				candidatesTotal = total;
				candidatesTotalExact = exact;
			} catch (err) {
				if (seq !== fetchSeq) return;
				candidateTargets = [];
				candidatesTotal = 0;
				candidatesTotalExact = true;
				console.error('Target candidates fetch failed', err);
			}
		})();
	});

	function reset(): void {
		selectedType = '';
		selectedTarget = '';
	}

	function onTypeChange(e: Event): void {
		selectedType = (e.target as HTMLSelectElement).value;
		selectedTarget = '';
	}

	function onTargetChange(e: Event): void {
		selectedTarget = (e.target as HTMLSelectElement).value;
	}

	async function create(): Promise<void> {
		if (selectedType === '' || selectedTarget === '') return;
		if (!(await connectLock(sourceId, selectedTarget))) return;
		emit({
			kind: 'create_relationship',
			temp_id: createTempId(),
			type_name: selectedType,
			source_id: sourceId,
			target_id: selectedTarget,
			properties: {}
		});
		reset();
	}

	function cancel(): void {
		reset();
		showAll = false;
		expanded = false;
	}

	function optionLabel(o: (typeof typeOptions)[number]): string {
		const targets = o.targetTypes.join(' | ');
		const base = `${o.rt.name} → ${targets}`;
		if (o.disabled) return `${base}  (max ${o.outCount}/${o.max})`;
		return base;
	}

	const selectCls =
		'h-7 w-full rounded border border-zinc-800 bg-zinc-900 px-1 text-xs text-zinc-100 outline-none focus:border-zinc-600';
</script>

<div class="flex flex-col">
	{#if !expanded}
		{#if mm === null || source === null}
			<p class="text-[11px] italic text-zinc-500">(loading…)</p>
		{:else}
			<button
				type="button"
				class="inline-flex w-fit items-center gap-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
				onclick={() => (expanded = true)}
			>
				<Plus class="h-3 w-3" /> New relationship
			</button>
		{/if}
	{:else}
		<div class="flex flex-col gap-2 rounded border border-zinc-800 bg-zinc-950 p-2">
			<div class="flex items-center justify-between">
				<span class="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
					New relationship
				</span>
				<button
					type="button"
					class="rounded p-0.5 text-zinc-500 hover:text-zinc-200"
					onclick={cancel}
					aria-label="Cancel"
				>
					<X class="h-3 w-3" />
				</button>
			</div>

			<label class="flex items-center gap-1 text-[10px] text-zinc-400">
				<input
					type="checkbox"
					checked={showAll}
					onchange={(e) => {
						showAll = (e.target as HTMLInputElement).checked;
						selectedType = '';
						selectedTarget = '';
					}}
				/>
				Show all types
			</label>

			<label class="flex flex-col gap-1">
				<span class="text-[10px] text-zinc-500">Type</span>
				<select class={selectCls} value={selectedType} onchange={onTypeChange}>
					<option value="">(choose type)</option>
					{#each typeOptions as o (o.rt.name)}
						<option
							value={o.rt.name}
							disabled={o.disabled}
							title={o.disabled
								? `${source?.type_name} already has ${o.outCount}/${o.max} ${o.rt.name} target(s)`
								: o.allowed
									? undefined
									: 'Not allowed by the metamodel from this source type'}
						>
							{optionLabel(o)}{o.allowed ? '' : '  (off-metamodel)'}
						</option>
					{/each}
				</select>
				{#if typeOptions.length === 0}
					<span class="text-[10px] italic text-zinc-500">
						(no valid relationships from this type)
					</span>
				{/if}
			</label>

			{#if chosenOption !== null}
				<label class="flex flex-col gap-1">
					<span class="text-[10px] text-zinc-500">Target ({chosenOption.targetTypes.join(' | ')})</span>
					<select class={selectCls} value={selectedTarget} onchange={onTargetChange}>
						<option value="">(choose target)</option>
						{#each candidateTargets as el (el.id)}
							<option value={el.id}>
								{displayName(el)} — {el.type_name}
							</option>
						{/each}
					</select>
					{#if candidateTargets.length === 0}
						<span class="text-[10px] italic text-zinc-500">
							No elements of type {chosenOption.targetTypes.join(' | ')} (or subtype) exist.
						</span>
					{:else if candidatesTotal > candidateTargets.length || !candidatesTotalExact}
						<span class="text-[10px] italic text-zinc-500">
							Showing the first {candidateTargets.length} of {candidatesTotal}{candidatesTotalExact
								? ''
								: '+'} candidates.
						</span>
					{/if}
				</label>
			{/if}

			<div class="flex justify-end gap-1">
				<button
					type="button"
					class="rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
					onclick={cancel}
				>
					Cancel
				</button>
				<button
					type="button"
					class="rounded border border-zinc-700 bg-blue-900/40 px-2 py-0.5 text-[11px] text-zinc-100 hover:bg-blue-900/60 disabled:cursor-not-allowed disabled:opacity-50"
					disabled={selectedType === '' || selectedTarget === ''}
					onclick={create}
				>
					Create
				</button>
			</div>
		</div>
	{/if}
</div>
```

- [ ] **Step 2: Typecheck**

Run: `pixi run -e frontend npm run check`
Expected: PASS — no svelte-check / TypeScript errors for `NewRelationshipPicker.svelte`. (If `listElementRelationships`'s option key differs, fix the call to match its real signature — it is the same call `RelationshipsList.svelte` uses with `{ direction, limit }`.)

- [ ] **Step 3: Run the existing unit suite (regression)**

Run: `pixi run -e frontend npm test`
Expected: PASS — full vitest suite green (no test imported the old picker internals; the connection-rules tests pass).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/components/Inspector/NewRelationshipPicker.svelte
git commit -m "feat(frontend): metamodel-driven relationship picker — filter, escape hatch, multiplicity gray-out (Phase 6A)"
```

---

### Task 4: E2E — filtered picker + escape hatch + create

**Files:**
- Create: `frontend/e2e/relationship-picker.spec.ts`

**Interfaces:**
- Consumes: the `loadFiles` helper from `frontend/e2e/helpers/load.ts` (signature: `loadFiles(page, { metamodel: FileArg, model: FileArg, view? })`, where `FileArg = string | { name, mimeType, buffer }`).
- Produces: a Playwright spec; no exports.

- [ ] **Step 1: Write the e2e spec**

Create `frontend/e2e/relationship-picker.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { loadFiles } from './helpers/load';

// Self-contained fixtures (mirrors how smoke.spec.ts builds inline buffers).
// From an `A` element: AtoB is metamodel-allowed; BtoB is not (B-source only).
const METAMODEL = {
	name: 'picker.metamodel.yaml',
	mimeType: 'application/x-yaml',
	buffer: Buffer.from(
		[
			'elements:',
			'  - name: A',
			'    properties:',
			'      - {name: name, datatype: string, multiplicity: "0..1"}',
			'  - name: B',
			'    properties:',
			'      - {name: name, datatype: string, multiplicity: "0..1"}',
			'relationships:',
			'  - name: AtoB',
			'    source: A',
			'    target: B',
			'    target_multiplicity: "0..*"',
			'  - name: BtoB',
			'    source: B',
			'    target: B',
			''
		].join('\n')
	)
};

const MODEL = {
	name: 'picker.model.json',
	mimeType: 'application/json',
	buffer: Buffer.from(
		JSON.stringify({
			elements: [
				{ id: 'a1', type_name: 'A', properties: { name: 'Alpha' } },
				{ id: 'b1', type_name: 'B', properties: { name: 'Bravo' } }
			],
			relationships: []
		})
	)
};

test.beforeEach(async ({ page }) => {
	page.on('dialog', (dialog) => void dialog.accept());
});

test('relationship picker filters by metamodel and reveals all via escape hatch', async ({
	page
}) => {
	test.setTimeout(90_000);
	await page.goto('/');
	await loadFiles(page, { metamodel: METAMODEL, model: MODEL });

	// Select element Alpha (type A) in the tree.
	await page.getByText('Alpha', { exact: true }).first().click();

	// Open the New relationship picker.
	await page.getByRole('button', { name: 'New relationship' }).click();

	const typeSelect = page.getByRole('combobox').first();

	// Filtered (default): AtoB allowed, BtoB hidden.
	await expect(typeSelect.getByRole('option', { name: /AtoB/ })).toHaveCount(1);
	await expect(typeSelect.getByRole('option', { name: /BtoB/ })).toHaveCount(0);

	// Escape hatch: Show all types reveals BtoB (off-metamodel).
	await page.getByLabel('Show all types').check();
	await expect(typeSelect.getByRole('option', { name: /BtoB/ })).toHaveCount(1);

	// Create AtoB -> Bravo and confirm it lands as an uncommitted change.
	await page.getByLabel('Show all types').uncheck();
	await typeSelect.selectOption({ label: 'AtoB → B' });
	const targetSelect = page.getByRole('combobox').nth(1);
	await targetSelect.selectOption({ label: /Bravo/ });
	await page.getByRole('button', { name: 'Create', exact: true }).click();

	// The new outgoing relationship appears in the inspector's relationship list.
	await expect(page.getByText('AtoB').first()).toBeVisible();
});
```

- [ ] **Step 2: Run the e2e spec**

Run: `pixi run -e frontend npm run test:e2e -- relationship-picker.spec.ts`
Expected: PASS. (Playwright boots the backend + dev server itself.)

If a selector mismatches (e.g. the tree renders Alpha differently, or the Create flow needs a check-out first), adjust the selectors to the real DOM — keep the three assertions (AtoB present, BtoB hidden→revealed, relationship created). If element creation requires an active check-out/lock, acquire it the way `commit-flow.spec.ts` does before `Create`.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/relationship-picker.spec.ts
git commit -m "test(e2e): metamodel-driven relationship picker filter + escape hatch (Phase 6A)"
```

---

## Self-Review notes (already reconciled)

- **Spec coverage:** mappings-aware filter (Task 1 `allowedTargetTypes`/`relationshipTypesFromSource`, used in Task 3); escape hatch (Task 2 `buildPickerTypeOptions` showAll + Task 3 toggle); source-side multiplicity gray-out (Task 1 `targetMultiplicityExceeded` + Task 2 `disabled` + Task 3 rendering); multi-target candidate fetch (Task 3 union loop); staging-aware counts (Task 3 `outCountsByType` over `getCachedRelationships`); inspector-only scope; no backend changes. E2e (Task 4) covers filter + escape hatch + create.
- **Type consistency:** `PickerTypeOption` fields (`rt, targetTypes, allowed, atMax, outCount, max, disabled`) are defined in Task 2 and consumed verbatim in Task 3. `parseMultiplicity` returns `{ lower, upper }` (used as `.upper`). `Relationship.source_id`/`type_name` and `Element.id`/`type_name` match `$lib/api/types`.
- **Deferred (per spec §9):** target-side `source_multiplicity` enforcement, strict-mode, other gestures, `GET /metamodel/connections`, sandbox/rebind (Phase 6B).
```
