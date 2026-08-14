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

	it('renders two byte-identical issues without an each_key_duplicate crash', () => {
		const dupe = {
			severity: 'error' as const,
			message: 'missing required label',
			target_ids: ['el-1', 'el-1'],
			category: 'conformance' as const,
			origin: 'on_server' as const
		};
		const c = mount(MetamodelPreviewPanel, {
			target: document.body,
			props: { diff: makeDiff({ now_failing: [dupe, { ...dupe }] }) }
		});
		flushSync();
		try {
			const text = document.body.textContent ?? '';
			expect(text).toContain('Now failing (2)');
			expect(text.match(/missing required label/g)).toHaveLength(2);
		} finally {
			unmount(c);
		}
	});
});
