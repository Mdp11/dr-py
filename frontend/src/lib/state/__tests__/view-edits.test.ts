import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearStagedView,
	discardStagedView,
	getStagedViewDepth,
	getStagedViewEntries,
	getStagedViewOps,
	notifyViewCommitted,
	onViewCommitted,
	onViewDiscarded,
	resetViewEdits,
	stageViewOp
} from '../view-edits.svelte';

beforeEach(() => resetViewEdits());

describe('staged view journal', () => {
	it('preserves insertion order — view ops are order-dependent', () => {
		stageViewOp(
			{ kind: 'create_folder', temp_id: 'tmp_a', parent_id: 'root', name: 'N' },
			'Created folder "N"'
		);
		stageViewOp(
			{ kind: 'place_element', element_id: 'e1', folder_id: 'tmp_a' },
			'Placed e1 in "N"'
		);
		stageViewOp({ kind: 'rename_folder', id: 'tmp_a', name: 'M' }, 'Renamed folder "N" → "M"');
		expect(getStagedViewOps().map((o) => o.kind)).toEqual([
			'create_folder',
			'place_element',
			'rename_folder'
		]);
		expect(getStagedViewDepth()).toBe(3);
		expect(getStagedViewEntries()[2].label).toBe('Renamed folder "N" → "M"');
	});
	it('clear and discard both wipe; neither fires the commit listeners', async () => {
		const committed = vi.fn();
		const unsub = onViewCommitted(committed);
		stageViewOp({ kind: 'delete_folder', id: 'f1' }, 'Deleted folder');
		clearStagedView();
		expect(getStagedViewDepth()).toBe(0);
		stageViewOp({ kind: 'delete_folder', id: 'f2' }, 'Deleted folder');
		await discardStagedView();
		expect(getStagedViewDepth()).toBe(0);
		expect(committed).not.toHaveBeenCalled();
		unsub();
	});

	// The reconciliation invariant lives in the STORE: `_view` has the optimistic
	// applies baked in, so a discard that does not refetch leaves a phantom tree.
	// Every discard surface therefore goes through discardStagedView, and this
	// registry is what makes the refetch impossible to forget.
	it('only discardStagedView fires the discard listeners, and it AWAITS them', async () => {
		const seen: number[] = [];
		const discarded = vi.fn(async () => {
			// journal is already empty when the listener runs — it refetches, it
			// does not inspect what was dropped.
			seen.push(getStagedViewDepth());
			await Promise.resolve();
		});
		const unsub = onViewDiscarded(discarded);

		stageViewOp({ kind: 'delete_folder', id: 'f1' }, 'Deleted folder');
		clearStagedView();
		resetViewEdits();
		expect(discarded).not.toHaveBeenCalled(); // silent wipes stay silent

		stageViewOp({ kind: 'delete_folder', id: 'f2' }, 'Deleted folder');
		await discardStagedView();
		expect(discarded).toHaveBeenCalledOnce();
		expect(seen).toEqual([0]);

		unsub();
		stageViewOp({ kind: 'delete_folder', id: 'f3' }, 'Deleted folder');
		await discardStagedView();
		expect(discarded).toHaveBeenCalledOnce(); // unsubscribed
	});
	it('notifyViewCommitted fans out to listeners and unsubscribes cleanly', () => {
		const a = vi.fn();
		const b = vi.fn();
		const unsubA = onViewCommitted(a);
		onViewCommitted(b);
		notifyViewCommitted();
		unsubA();
		notifyViewCommitted();
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(2);
	});
});
