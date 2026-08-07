import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearStagedView,
	discardStagedView,
	getStagedViewDepth,
	getStagedViewEntries,
	getStagedViewOps,
	notifyViewCommitted,
	onViewCommitted,
	resetViewEdits,
	stageViewOp
} from '../view-edits.svelte';

beforeEach(() => resetViewEdits());

describe('staged view journal', () => {
	it('preserves insertion order — view ops are order-dependent', () => {
		stageViewOp({ kind: 'create_folder', temp_id: 'tmp_a', parent_id: 'root', name: 'N' }, 'Created folder "N"');
		stageViewOp({ kind: 'place_element', element_id: 'e1', folder_id: 'tmp_a' }, 'Placed e1 in "N"');
		stageViewOp({ kind: 'rename_folder', id: 'tmp_a', name: 'M' }, 'Renamed folder "N" → "M"');
		expect(getStagedViewOps().map((o) => o.kind)).toEqual([
			'create_folder', 'place_element', 'rename_folder'
		]);
		expect(getStagedViewDepth()).toBe(3);
		expect(getStagedViewEntries()[2].label).toBe('Renamed folder "N" → "M"');
	});
	it('clear and discard both wipe; neither fires the commit listeners', () => {
		const committed = vi.fn();
		const unsub = onViewCommitted(committed);
		stageViewOp({ kind: 'delete_folder', id: 'f1' }, 'Deleted folder');
		clearStagedView();
		expect(getStagedViewDepth()).toBe(0);
		stageViewOp({ kind: 'delete_folder', id: 'f2' }, 'Deleted folder');
		discardStagedView();
		expect(getStagedViewDepth()).toBe(0);
		expect(committed).not.toHaveBeenCalled();
		unsub();
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
