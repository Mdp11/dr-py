import { describe, it, expect } from 'vitest';
import { formatViewChange } from '../view-change-format';

const name = (id: string) => (id === 'e1' ? 'Pump' : id);

describe('formatViewChange', () => {
	it('formats an element move', () => {
		expect(
			formatViewChange({ kind: 'element-moved', id: 'e1', from: ['A'], to: ['B', 'C'] }, name)
		).toBe("Pump moved from 'A' to 'B/C'");
	});

	it('formats an element removed from the view', () => {
		expect(formatViewChange({ kind: 'element-removed', id: 'e1', from: ['A'] }, name)).toBe(
			'Pump removed from view'
		);
	});

	it('formats an element added to a folder', () => {
		expect(formatViewChange({ kind: 'element-added', id: 'e2', to: ['A'] }, name)).toBe(
			"e2 added to 'A'"
		);
	});

	it('formats folder created / deleted', () => {
		expect(formatViewChange({ kind: 'folder-added', path: ['A', 'B'] }, name)).toBe(
			"Folder 'A/B' created"
		);
		expect(formatViewChange({ kind: 'folder-removed', path: ['A'] }, name)).toBe(
			"Folder 'A' deleted"
		);
	});

	it('renders an empty (root) path as (root)', () => {
		expect(formatViewChange({ kind: 'element-added', id: 'e2', to: [] }, name)).toBe(
			"e2 added to '(root)'"
		);
	});
});
