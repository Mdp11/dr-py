import { afterEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import IssuesPanel from '../Workspace/IssuesPanel.svelte';
import { setIssues, clearIssues } from '$lib/state/validation.svelte';
import { adoptSummary, resetModelStore } from '$lib/state/model.svelte';

// Stub child components / actions that IssuesPanel depends on
import { vi } from 'vitest';
vi.mock('$lib/state/validate-action', () => ({
	runValidation: vi.fn(async () => {})
}));

afterEach(() => {
	document.body.innerHTML = '';
	clearIssues();
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
	setIssues([
		{ severity: 'error', message: 'new boom', target_ids: ['a'], origin: 'uncommitted' },
		{ severity: 'error', message: 'old boom', target_ids: ['b'], origin: 'on_server' },
		{ severity: 'warning', message: 'now fixed', target_ids: ['c'], origin: 'resolved' }
	]);
}

describe('IssuesPanel origin', () => {
	it('renders origin badges and excludes resolved from the error count', () => {
		seedIssues();
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();

		const text = document.body.textContent ?? '';
		// 2 active errors (uncommitted + on_server); resolved warning not counted
		expect(/2 errors/i.test(text)).toBe(true);
		// badge for 'new' should be present
		expect(/\bnew\b/i.test(text)).toBe(true);

		unmount(c);
	});

	it('filters to only uncommitted issues when the New filter is clicked', async () => {
		seedIssues();
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();

		// Click the "New" filter button
		const buttons = document.body.querySelectorAll('button');
		const newBtn = Array.from(buttons).find((b) => b.textContent?.trim() === 'New');
		expect(newBtn).toBeTruthy();
		newBtn!.click();
		flushSync();

		const text = document.body.textContent ?? '';
		expect(text).toContain('new boom');
		expect(text).not.toContain('old boom');

		unmount(c);
	});

	it('shows all-clear header when only resolved issues remain (staged edits fixed everything)', () => {
		adoptSummary({
			model_rev: 1,
			element_count: 0,
			relationship_count: 0,
			elements_by_type: {},
			issue_counts: {},
			undo_depth: 0
		});
		setIssues([
			{ severity: 'error', message: 'was broken', target_ids: ['x'], origin: 'resolved' },
			{ severity: 'warning', message: 'also fixed', target_ids: ['y'], origin: 'resolved' }
		]);
		const c = mount(IssuesPanel, { target: document.body });
		flushSync();

		const text = document.body.textContent ?? '';
		// should show all-clear with fixed hint, not the error/warning count line
		expect(/No issues/i.test(text)).toBe(true);
		expect(/fixed/i.test(text)).toBe(true);
		expect(/0 errors/i.test(text)).toBe(false);

		unmount(c);
	});
});
