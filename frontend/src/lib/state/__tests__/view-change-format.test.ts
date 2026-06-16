import { describe, it, expect } from 'vitest';
import { formatViewChange, viewChangeSegments } from '../view-change-format';
import type { ViewChange } from '../view-diff';

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

describe('viewChangeSegments', () => {
	it('splits a move into typed, colourable segments that rejoin to the string', () => {
		const change: ViewChange = { kind: 'element-moved', id: 'e1', from: ['A'], to: ['B', 'C'] };
		const segs = viewChangeSegments(change, name);
		expect(segs).toEqual([
			{ text: 'Pump', kind: 'element' },
			{ text: ' moved ', kind: 'plain' },
			{ text: 'from', kind: 'prep' },
			{ text: ' ', kind: 'plain' },
			{ text: "'A'", kind: 'folder' },
			{ text: ' ', kind: 'plain' },
			{ text: 'to', kind: 'prep' },
			{ text: ' ', kind: 'plain' },
			{ text: "'B/C'", kind: 'folder' }
		]);
		// concatenating segment texts reproduces formatViewChange exactly
		expect(segs.map((s) => s.text).join('')).toBe(formatViewChange(change, name));
	});

	it('tags the folder in a folder-created change', () => {
		const segs = viewChangeSegments({ kind: 'folder-added', path: ['A', 'B'] }, name);
		expect(segs).toEqual([
			{ text: 'Folder ', kind: 'plain' },
			{ text: "'A/B'", kind: 'folder' },
			{ text: ' created', kind: 'plain' }
		]);
	});
});
