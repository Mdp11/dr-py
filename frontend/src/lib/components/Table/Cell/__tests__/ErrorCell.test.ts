// ErrorCell renders a script-column evaluation error: a warning glyph + the
// message, with the full traceback (when present) surfaced via `title` for
// hover detail. Same render convention as ValueCell.test.ts/ElementCell.test.ts
// (mount/unmount/flushSync — @testing-library/svelte is not a dependency).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import type { TableCell } from '$lib/api/types';
import ErrorCell from '../ErrorCell.svelte';

function errorCell(
	overrides: Partial<Extract<TableCell, { kind: 'error' }>> = {}
): Extract<TableCell, { kind: 'error' }> {
	return { kind: 'error', message: 'division by zero', traceback: null, ...overrides };
}

afterEach(() => {
	document.body.innerHTML = '';
});

describe('ErrorCell', () => {
	it('renders the message and exposes it as data-testid="error-cell"', () => {
		const c = mount(ErrorCell, { target: document.body, props: { cell: errorCell() } });
		flushSync();
		try {
			const el = document.querySelector('[data-testid="error-cell"]');
			expect(el).not.toBeNull();
			expect(el?.textContent).toContain('division by zero');
		} finally {
			unmount(c);
		}
	});

	it('sets title to the traceback when present', () => {
		const c = mount(ErrorCell, {
			target: document.body,
			props: { cell: errorCell({ traceback: 'Traceback (most recent call last):\n  ...' }) }
		});
		flushSync();
		try {
			const el = document.querySelector('[data-testid="error-cell"]') as HTMLElement;
			expect(el.title).toBe('Traceback (most recent call last):\n  ...');
		} finally {
			unmount(c);
		}
	});

	it('falls back to the message for title when traceback is null', () => {
		const c = mount(ErrorCell, {
			target: document.body,
			props: { cell: errorCell({ traceback: null }) }
		});
		flushSync();
		try {
			const el = document.querySelector('[data-testid="error-cell"]') as HTMLElement;
			expect(el.title).toBe('division by zero');
		} finally {
			unmount(c);
		}
	});
});
