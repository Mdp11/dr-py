import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import IssuesPanel from '../Workspace/IssuesPanel.svelte';
import { setOverlay, clearOverlay } from '$lib/state/validation.svelte';
import { adoptSummary, resetModelStore } from '$lib/state/model.svelte';

// Stub child components / actions that IssuesPanel depends on
vi.mock('$lib/state/validate-action', () => ({
	runValidation: vi.fn(async () => {})
}));

afterEach(() => {
	document.body.innerHTML = '';
	clearOverlay();
	resetModelStore();
	vi.clearAllMocks();
});

function seedIssues() {
	adoptSummary({
		model_rev: 1,
		element_count: 0,
		relationship_count: 0,
		elements_by_type: {},
		issue_counts: {},
		undo_depth: 0
	});
	setOverlay([
		{
			severity: 'error',
			message: 'multiplicity issue message one',
			target_ids: ['a'],
			origin: 'on_server',
			check: 'multiplicity'
		},
		{
			severity: 'error',
			message: 'multiplicity issue message two',
			target_ids: ['b'],
			origin: 'on_server',
			check: 'multiplicity'
		},
		{
			severity: 'warning',
			message: 'facets issue message',
			target_ids: ['c'],
			origin: 'on_server',
			check: 'facets'
		},
		{
			severity: 'error',
			message: 'other issue message',
			target_ids: ['d'],
			origin: 'on_server',
			check: ''
		}
	]);
}

function chipButtons(): HTMLButtonElement[] {
	const chips = document.body.querySelector('[data-testid="check-chips"]');
	if (chips === null) throw new Error('check-chips not found');
	return Array.from(chips.querySelectorAll('button'));
}

describe('IssuesPanel check chips', () => {
	it('renders one chip per check with counts and an All chip', () => {
		seedIssues();
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();

		const chips = document.body.querySelector('[data-testid="check-chips"]');
		expect(chips).not.toBeNull();
		const labels = chipButtons().map((b) => b.textContent?.trim());
		expect(labels).toContain('All');
		expect(labels).toContain('Multiplicity (2)');
		expect(labels).toContain('Facets (1)');
		expect(labels).toContain('Other (1)');

		unmount(c);
	});

	it('clicking a chip filters the list to that check', async () => {
		seedIssues();
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();

		const facetsChip = chipButtons().find((b) => b.textContent?.trim() === 'Facets (1)');
		expect(facetsChip).toBeTruthy();
		facetsChip!.click();
		flushSync();

		const text = document.body.textContent ?? '';
		expect(text).not.toContain('multiplicity issue message');
		expect(text).toContain('facets issue message');

		unmount(c);
	});
});
