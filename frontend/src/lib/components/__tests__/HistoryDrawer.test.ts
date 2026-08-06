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
// Only `onCommitEvent` is stubbed: the revert gate reads `isProjectQuiet()`,
// whose lock term is the REAL `hasModelLocks()` over the real lock table, so
// these tests drive locks through `handleFeedEvent` the way the feed does.
vi.mock('$lib/state/realtime.svelte', async (orig) => {
	const actual = await orig<typeof import('$lib/state/realtime.svelte')>();
	return { ...actual, onCommitEvent: vi.fn(() => () => {}) };
});
vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		getRole: vi.fn(() => 'owner'),
		getModelRev: vi.fn(() => 2),
		applyDelta: vi.fn()
	};
});
vi.mock('$lib/api/history', async (orig) => {
	const actual = await orig<typeof import('$lib/api/history')>();
	return { ...actual, revertToCommit: vi.fn() };
});

import { loadFirstPage, modelAt } from '$lib/state/history.svelte';
import { revertToCommit } from '$lib/api/history';
import { applyDelta } from '$lib/state';
// Left real by the `...actual` spread above so the revert gate is exercised
// against the actual stores it reads in production.
import { resetArtifactEdits, stageArtifactCreate } from '$lib/state/artifact-edits.svelte';
import { emit, resetModelStore, seedElements } from '$lib/state/model.svelte';
import { handleFeedEvent, resetRealtime } from '$lib/state/realtime.svelte';
import type { LeaseLite } from '$lib/api/feed';
import { ConflictError, ValidationError } from '$lib/api';

/** Install `resourceIds` as the project-wide lock table, as a feed snapshot
 * would. `model_rev: 0` keeps the reducer's "am I behind?" summary refresh
 * (fire-and-forget, network) from firing. */
function seedLocks(...resourceIds: string[]): void {
	handleFeedEvent({
		type: 'snapshot',
		model_rev: 0,
		locks: resourceIds.map(
			(resource_id): LeaseLite => ({ resource_id, mode: 'exclusive', holder_id: 'peer' })
		),
		connected: []
	});
}

afterEach(() => {
	document.body.innerHTML = '';
	resetArtifactEdits();
	resetModelStore();
	resetRealtime();
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
			validation_error_count: 0,
			changed_artifacts: [],
			deleted_artifact_ids: []
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
		seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
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

	it('blocks revert when only artifact ops are staged', async () => {
		stageArtifactCreate('table', 'T', {}, null);
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

	it('blocks revert while a MODEL-scope lease is live', async () => {
		seedLocks('e1');
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

	it('STAYS ENABLED while only an art: lease is live (regression)', async () => {
		// Every open artifact editor tab holds an `art:` lease now. Counting them
		// in the quiet gate disabled Revert for the WHOLE project — for anyone —
		// for the full lock TTL, whenever anyone had a table/navigation/snippet
		// tab open. `art:` is orthogonal to a model revert.
		seedLocks('art:a9');
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
			validation_error_count: 0,
			changed_artifacts: [],
			deleted_artifact_ids: []
		});
		const c = mount(HistoryDrawer, { target: document.body, props: { open: true } });
		flushSync();
		await Promise.resolve();
		flushSync();
		const revertBtn = Array.from(document.querySelectorAll('button')).find((b) =>
			b.textContent?.includes('Revert')
		)!;
		revertBtn.click();
		flushSync();
		expect(document.body.textContent?.toLowerCase()).not.toContain('commit or discard');
		const confirmBtn = Array.from(document.querySelectorAll('button')).find(
			(b) => b.textContent?.trim() === 'Revert'
		)!;
		expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);
		confirmBtn.click();
		await Promise.resolve();
		await Promise.resolve();
		flushSync();
		expect(revertToCommit).toHaveBeenCalled();
		unmount(c);
	});
});
