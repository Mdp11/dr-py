import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import HistoryDrawer from '../HistoryDrawer.svelte';

vi.mock('$lib/state/history.svelte', () => ({
	loadFirstPage: vi.fn(async () => {}),
	loadMore: vi.fn(async () => {}),
	getCommits: vi.fn(() => [
		{
			rev: 2,
			commit_id: 'c2',
			author_id: 'u',
			ts: '2026-01-01T00:00:00Z',
			message: 'second',
			validation_error_count: 0,
			op_count: 1,
			is_rebind: false
		},
		{
			rev: 1,
			commit_id: 'c1',
			author_id: 'u',
			ts: '2026-01-01T00:00:00Z',
			message: 'first',
			validation_error_count: 2,
			op_count: 3,
			is_rebind: true
		}
	]),
	getHasMore: vi.fn(() => false),
	getLoading: vi.fn(() => false),
	modelAt: vi.fn(),
	resetHistory: vi.fn()
}));
vi.mock('$lib/state/realtime.svelte', () => ({ onCommitEvent: vi.fn(() => () => {}) }));
vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		getRole: vi.fn(() => 'owner'),
		getModelRev: vi.fn(() => 2),
		getStagedDepth: vi.fn(() => 0),
		getLockState: vi.fn(() => new Map()),
		applyDelta: vi.fn()
	};
});
vi.mock('$lib/api/history', async (orig) => {
	const actual = await orig<typeof import('$lib/api/history')>();
	return { ...actual, revertToCommit: vi.fn() };
});

import { loadFirstPage, modelAt } from '$lib/state/history.svelte';
import { revertToCommit } from '$lib/api/history';
import { applyDelta, getStagedDepth } from '$lib/state';
import { ConflictError, ValidationError } from '$lib/api';

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

describe('HistoryDrawer list', () => {
	it('loads + lists commits with rebind/issue badges when open', async () => {
		const c = mount(HistoryDrawer, { target: document.body, props: { open: true } });
		flushSync();
		await Promise.resolve();
		flushSync();
		expect(loadFirstPage).toHaveBeenCalled();
		expect(document.body.textContent).toContain('second');
		expect(document.body.textContent).toContain('first');
		expect(document.body.textContent?.toLowerCase()).toContain('rebind');
		unmount(c);
	});
});

describe('HistoryDrawer diff', () => {
	it('shows a per-commit diff when a row is clicked', async () => {
		vi.mocked(modelAt).mockImplementation(async (rev: number) =>
			rev <= 1
				? { elements: [], relationships: [] }
				: {
						elements: [{ id: 'e1', type_name: 'Node', properties: { label: 'A' }, rev: 2 }],
						relationships: []
					}
		);
		const c = mount(HistoryDrawer, { target: document.body, props: { open: true } });
		flushSync();
		await Promise.resolve();
		flushSync();
		// click the "Diff" action on the rev-2 row
		const btn = Array.from(document.querySelectorAll('button')).find((b) =>
			b.textContent?.includes('Diff')
		)!;
		btn.click();
		// drain microtask queue: showDiff is async (Promise.all + state update)
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(modelAt).toHaveBeenCalledWith(2);
		expect(modelAt).toHaveBeenCalledWith(1);
		expect(document.body.textContent).toContain('added');
		unmount(c);
	});
});

describe('HistoryDrawer revert', () => {
	it('reverts to a rev, applies the delta, returns to list', async () => {
		vi.mocked(getStagedDepth).mockReturnValue(0);
		vi.mocked(revertToCommit).mockResolvedValue({
			model_rev: 3,
			id_map: {},
			changed_elements: [],
			changed_relationships: [],
			deleted_element_ids: [],
			deleted_relationship_ids: [],
			issues_removed_owner_ids: [],
			issues_added: [],
			issue_counts: {},
			commit_id: 'c3',
			message: 'Revert to rev 1',
			validation_error_count: 0
		});
		const c = mount(HistoryDrawer, { target: document.body, props: { open: true } });
		flushSync();
		await Promise.resolve();
		flushSync();
		// open revert confirm on the rev-1 row, then confirm
		const revertBtn = Array.from(document.querySelectorAll('button')).find((b) =>
			b.textContent?.includes('Revert')
		)!;
		revertBtn.click();
		flushSync();
		const confirmBtn = Array.from(document.querySelectorAll('button')).find(
			(b) => b.textContent?.trim() === 'Revert' || b.textContent?.includes('Confirm')
		)!;
		confirmBtn.click();
		await Promise.resolve();
		await Promise.resolve();
		flushSync();
		expect(revertToCommit).toHaveBeenCalled();
		expect(applyDelta).toHaveBeenCalled();
		// confirm panel should have closed (confirmRev reset → "Revert to rev" text gone)
		expect(document.body.textContent).not.toContain('Revert to rev');
		unmount(c);
	});

	it('shows mapped error for 409 rebind/metamodel-swap and does not call applyDelta', async () => {
		vi.mocked(getStagedDepth).mockReturnValue(0);
		vi.mocked(revertToCommit).mockRejectedValue(
			new ConflictError(
				409,
				{ detail: 'revert across a metamodel swap is not yet supported', rebind_rev: 1 },
				'conflict'
			)
		);
		const c = mount(HistoryDrawer, { target: document.body, props: { open: true } });
		flushSync();
		await Promise.resolve();
		flushSync();
		const revertBtn = Array.from(document.querySelectorAll('button')).find((b) =>
			b.textContent?.includes('Revert to here')
		)!;
		revertBtn.click();
		flushSync();
		const confirmBtn = Array.from(document.querySelectorAll('button')).find(
			(b) => b.textContent?.trim() === 'Revert' || b.textContent?.includes('Confirm')
		)!;
		confirmBtn.click();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		flushSync();
		expect(document.body.textContent).toContain("Can't revert across a metamodel swap (rev 1).");
		expect(applyDelta).not.toHaveBeenCalled();
		unmount(c);
	});

	it('shows mapped error for 422 structural blocker and does not call applyDelta', async () => {
		vi.mocked(getStagedDepth).mockReturnValue(0);
		vi.mocked(revertToCommit).mockRejectedValue(
			new ValidationError(422, { detail: 'structural validation blocker' }, 'invalid')
		);
		const c = mount(HistoryDrawer, { target: document.body, props: { open: true } });
		flushSync();
		await Promise.resolve();
		flushSync();
		const revertBtn = Array.from(document.querySelectorAll('button')).find((b) =>
			b.textContent?.includes('Revert to here')
		)!;
		revertBtn.click();
		flushSync();
		const confirmBtn = Array.from(document.querySelectorAll('button')).find(
			(b) => b.textContent?.trim() === 'Revert' || b.textContent?.includes('Confirm')
		)!;
		confirmBtn.click();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		flushSync();
		expect(document.body.textContent).toContain(
			'Revert would leave a structural error and was rejected.'
		);
		expect(applyDelta).not.toHaveBeenCalled();
		unmount(c);
	});

	it('blocks revert when there are staged edits', async () => {
		vi.mocked(getStagedDepth).mockReturnValue(2);
		const c = mount(HistoryDrawer, { target: document.body, props: { open: true } });
		flushSync();
		await Promise.resolve();
		flushSync();
		const revertBtn = Array.from(document.querySelectorAll('button')).find((b) =>
			b.textContent?.includes('Revert')
		)!;
		revertBtn.click();
		flushSync();
		expect(document.body.textContent?.toLowerCase()).toContain('commit or discard');
		expect(revertToCommit).not.toHaveBeenCalled();
		unmount(c);
	});
});
