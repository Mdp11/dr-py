// Inline-mode tests for the nav-column editor: switching modes seeds/closes
// an embedded draft in the navigation-editor store, and embedded-draft edits
// are mirrored back into the column via onChange. Real stores (reset per
// test), spied artifacts API — same convention as status-chip.test.ts.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import { resetArtifacts, resetCheckout, resetNavigationEditors, setProjectInfo } from '$lib/state';
import type { Column } from '$lib/api/types';
import NavigationColumnEditor from '../NavigationColumnEditor.svelte';

type NavColumn = Extract<Column, { kind: 'navigation' }>;

const CHAIN_PAGE = {
	step_types: [],
	chains: [[{ id: 'e1', type_name: 'B', display_name: 'e1', child_count: 0 }]],
	total: 1,
	truncated: false
};

function navColumn(navigation: NavColumn['navigation']): NavColumn {
	return {
		kind: 'navigation',
		source: { kind: 'row', chain_index: 0 },
		navigation,
		step_index: null,
		mode: 'collapse',
		keep_empty: true,
		sort_mode: 'value',
		cell_cap: 20,
		header: '',
		width_px: null,
		hidden: false
	};
}

function render(column: NavColumn, onChange: (next: NavColumn) => void) {
	const c = mount(NavigationColumnEditor, {
		target: document.body,
		props: { column, columnIndex: 1, columns: [column], sampleRowElementId: 'row-el-1', onChange }
	});
	flushSync();
	return c;
}

function click(el: Element | null): void {
	if (!el) throw new Error('element not found');
	el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	flushSync();
}

beforeEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
	vi.spyOn(artifactsApi, 'evaluateNavigation').mockResolvedValue(CHAIN_PAGE);
});
afterEach(() => {
	resetNavigationEditors();
	resetArtifacts();
	resetCheckout();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('NavigationColumnEditor inline mode', () => {
	it('switching to inline seeds a fresh row-rooted definition', async () => {
		const onChange = vi.fn();
		const c = render(navColumn({}), onChange);
		try {
			click(document.querySelector('[data-testid="nav-mode-inline"]'));
			await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
			const next = onChange.mock.calls.at(-1)![0] as NavColumn;
			expect(next.navigation.definition).toMatchObject({
				kind: 'path',
				start: { kind: 'row' }
			});
			expect(next.navigation.ref).toBeUndefined();
		} finally {
			unmount(c);
		}
	});

	it('switching to inline with a saved ref selected seeds a copy of that navigation', async () => {
		const saved = {
			kind: 'path',
			schema_version: 2,
			start: { kind: 'scope', types: ['System'], criteria: [] },
			steps: [],
			exclude_visited: true
		};
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'navigation',
			name: 'Saved',
			artifact_rev: 1,
			updated_at: '',
			updated_by: null,
			payload: saved as unknown as Record<string, unknown>
		});
		const onChange = vi.fn();
		const c = render(navColumn({ ref: 'a1' }), onChange);
		try {
			click(document.querySelector('[data-testid="nav-mode-inline"]'));
			await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
			const next = onChange.mock.calls.at(-1)![0] as NavColumn;
			expect(next.navigation.definition).toMatchObject({
				kind: 'path',
				start: { kind: 'scope', types: ['System'] }
			});
		} finally {
			unmount(c);
		}
	});

	it('renders the embedded builder for an inline column and mirrors edits via onChange', async () => {
		const inline = {
			kind: 'path' as const,
			schema_version: 2,
			start: { kind: 'row' as const },
			steps: [],
			exclude_visited: true
		};
		const onChange = vi.fn();
		const c = render(navColumn({ definition: inline }), onChange);
		try {
			await vi.waitFor(() =>
				expect(document.querySelector('[data-testid="inline-nav-editor"]')).toBeTruthy()
			);
			// Embedded PathCards default COLLAPSED (table-settings readability) —
			// expand it to reach the step-adding buttons.
			click(document.querySelector('[data-testid="path-collapse-toggle"]'));
			// Edit through the REAL embedded PathCard: add a relationship step.
			click(
				[...document.querySelectorAll('button')].find((b) =>
					b.textContent?.includes('Follow a relationship')
				) ?? null
			);
			await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
			const next = onChange.mock.calls.at(-1)![0] as NavColumn;
			expect(next.navigation.definition).toMatchObject({
				kind: 'path',
				steps: [{ kind: 'relationship' }]
			});
		} finally {
			unmount(c);
		}
	});

	it('switching back to saved clears the inline definition from the column', async () => {
		const inline = {
			kind: 'path' as const,
			schema_version: 2,
			start: { kind: 'row' as const },
			steps: [],
			exclude_visited: true
		};
		const onChange = vi.fn();
		const c = render(navColumn({ definition: inline }), onChange);
		try {
			await vi.waitFor(() =>
				expect(document.querySelector('[data-testid="inline-nav-editor"]')).toBeTruthy()
			);
			click(document.querySelector('[data-testid="nav-mode-ref"]'));
			const next = onChange.mock.calls.at(-1)![0] as NavColumn;
			expect(next.navigation).toEqual({});
		} finally {
			unmount(c);
		}
	});

	it('keep_empty is available without the split toggle (collapse mode)', () => {
		const onChange = vi.fn();
		const c = render(navColumn({}), onChange);
		try {
			const keep = document.querySelector(
				'input[aria-label="Keep rows with no value"]'
			) as HTMLInputElement;
			expect(keep).not.toBeNull();
			expect(keep.checked).toBe(true);
			click(keep);
			expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ keep_empty: false }));
		} finally {
			unmount(c);
		}
	});
});
