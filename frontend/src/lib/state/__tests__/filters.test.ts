import { beforeEach, describe, expect, it } from 'vitest';

import {
	clearFilters,
	ensureTypeFilterInitialized,
	getTypeFilter,
	setTypeFilter,
	toggleType
} from '../filters.svelte';
import { SvelteSet } from 'svelte/reactivity';

describe('type filter seeding across metamodels', () => {
	beforeEach(() => clearFilters());

	it('seeds the full concrete-type set on first metamodel load', () => {
		ensureTypeFilterInitialized(['A', 'B']);
		expect([...getTypeFilter()].sort()).toEqual(['A', 'B']);
	});

	it('does not re-seed (preserves user toggles) when the same metamodel re-renders', () => {
		ensureTypeFilterInitialized(['A', 'B']);
		toggleType('A'); // user turns A off
		ensureTypeFilterInitialized(['A', 'B']); // same metamodel -> no-op
		expect([...getTypeFilter()]).toEqual(['B']);
	});

	it('treats a reordered name list as the same metamodel (no re-seed)', () => {
		ensureTypeFilterInitialized(['A', 'B']);
		toggleType('A');
		ensureTypeFilterInitialized(['B', 'A']); // reordered -> same signature
		expect([...getTypeFilter()]).toEqual(['B']);
	});

	it('re-seeds to the new full set when a DIFFERENT metamodel is loaded', () => {
		ensureTypeFilterInitialized(['A', 'B']);
		toggleType('A'); // stale user toggle against the old metamodel
		ensureTypeFilterInitialized(['Block', 'Requirement']); // metamodel swap
		expect([...getTypeFilter()].sort()).toEqual(['Block', 'Requirement']);
	});

	it('re-seeds after clearFilters resets the seeded signature', () => {
		ensureTypeFilterInitialized(['A', 'B']);
		setTypeFilter(new SvelteSet()); // user deselects all
		clearFilters(); // forget seeding
		ensureTypeFilterInitialized(['A', 'B']); // same names, but signature was reset
		expect([...getTypeFilter()].sort()).toEqual(['A', 'B']);
	});
});
