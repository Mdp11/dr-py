// Same render convention as ErrorCell.test.ts/ValueCell.test.ts
// (mount/unmount/flushSync — @testing-library/svelte is not a dependency).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import MetamodelStructuralDiff from '../MetamodelStructuralDiff.svelte';
import type { MetamodelStructuralDiff as Diff } from '$lib/api/types';

const EMPTY: Diff = {
	enums: { added: [], removed: [], changed: [] },
	element_types: { added: [], removed: [], changed: [] },
	relationship_types: { added: [], removed: [], changed: [] }
};

afterEach(() => {
	document.body.innerHTML = '';
});

function bodyText(): string {
	return document.body.textContent ?? '';
}

describe('MetamodelStructuralDiff', () => {
	it('renders the empty state when nothing changed', () => {
		const c = mount(MetamodelStructuralDiff, { target: document.body, props: { diff: EMPTY } });
		flushSync();
		try {
			expect(/no structural changes/i.test(bodyText())).toBe(true);
		} finally {
			unmount(c);
		}
	});

	it('renders added/removed type names and per-facet changes', () => {
		const diff: Diff = {
			...EMPTY,
			element_types: {
				added: [{ name: 'Sensor', abstract: false, extends: null, properties: [], key: null }],
				removed: [],
				changed: [
					{
						name: 'Building',
						attributes: [{ field: 'extends', from: null, to: 'Asset' }],
						properties: {
							added: [],
							removed: [],
							changed: [{ name: 'height', fields: [{ field: 'max', from: 10, to: 20 }] }]
						}
					}
				]
			}
		};
		const c = mount(MetamodelStructuralDiff, { target: document.body, props: { diff } });
		flushSync();
		try {
			const text = bodyText();
			expect(text).toContain('Sensor');
			expect(text).toContain('Building');
			expect(/max/.test(text)).toBe(true);
			expect(/10\s*→\s*20/.test(text)).toBe(true);
		} finally {
			unmount(c);
		}
	});

	it('renders enum literal changes and relationship mapping changes', () => {
		const diff: Diff = {
			...EMPTY,
			enums: {
				added: [],
				removed: [],
				changed: [{ name: 'Status', added: ['archived'], removed: [] }]
			},
			relationship_types: {
				added: [],
				removed: [],
				changed: [
					{
						name: 'Owns',
						attributes: [],
						properties: { added: [], removed: [], changed: [] },
						mappings: { added: [{ source: 'City', target: 'Park' }], removed: [] }
					}
				]
			}
		};
		const c = mount(MetamodelStructuralDiff, { target: document.body, props: { diff } });
		flushSync();
		try {
			const text = bodyText();
			expect(text).toContain('Status');
			expect(/archived/.test(text)).toBe(true);
			expect(/City\s*→\s*Park/.test(text)).toBe(true);
		} finally {
			unmount(c);
		}
	});
});
