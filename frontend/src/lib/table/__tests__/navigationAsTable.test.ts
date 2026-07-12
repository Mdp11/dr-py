import { describe, it, expect } from 'vitest';
import { navigationAsTableDefinition } from '$lib/table/columns';
import type { PathNavigation } from '$lib/api/types';

describe('navigationAsTableDefinition', () => {
	it('uses a ref when the navigation is saved', () => {
		const definition: PathNavigation = {
			kind: 'path',
			schema_version: 2,
			start: { kind: 'scope', types: ['Block'], criteria: [] },
			steps: [
				{
					kind: 'relationship',
					relationship_type: 'BlockHasPart',
					direction: 'out',
					target_types: [],
					children: []
				}
			],
			exclude_visited: true
		};
		const d = navigationAsTableDefinition({ artifactId: 'nav1', definition });
		expect(d.row_source).toEqual({ kind: 'chains', navigation: { ref: 'nav1' } });
		// one element column per chain step (start + 1 hop = 2)
		expect(d.columns.filter((c) => c.kind === 'element')).toHaveLength(2);
		expect(d.columns[1].source).toEqual({ kind: 'row', chain_index: 1 });
	});

	it('embeds inline when the navigation is an unsaved draft', () => {
		const definition: PathNavigation = {
			kind: 'path',
			schema_version: 2,
			start: { kind: 'scope', types: ['Block'], criteria: [] },
			steps: [],
			exclude_visited: true
		};
		const d = navigationAsTableDefinition({ artifactId: null, definition });
		expect(d.row_source).toEqual({ kind: 'chains', navigation: { definition } });
	});

	it('falls back to a single Start column for a set_op definition', () => {
		const definition = {
			kind: 'set_op' as const,
			schema_version: 2,
			op: 'union' as const,
			operands: []
		};
		const d = navigationAsTableDefinition({ artifactId: null, definition });
		expect(d.columns).toHaveLength(1);
		expect(d.columns[0]).toEqual({
			kind: 'element',
			source: { kind: 'row', chain_index: 0 },
			header: 'Start',
			width_px: null
		});
	});
});
