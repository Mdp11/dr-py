import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearStagedNodeMoves,
	getStagedMetamodelDepth,
	getStagedMetamodelOps,
	initMetamodelStage,
	notifyMetamodelCommitted,
	onMetamodelCommitted,
	registerMetamodelDraftProvider,
	stageNodeMove
} from '../metamodel-stage.svelte';

describe('metamodel-stage', () => {
	beforeEach(() => {
		initMetamodelStage('p1');
		clearStagedNodeMoves();
		registerMetamodelDraftProvider(() => ({ dirty: false, blob: '' }));
	});

	it('coalesces repeated moves of the same node', () => {
		stageNodeMove('el:A', { x: 1, y: 1 });
		stageNodeMove('el:A', { x: 2, y: 2 });
		const ops = getStagedMetamodelOps();
		expect(ops).toEqual([{ kind: 'metamodel.move_node', node: 'el:A', pos: { x: 2, y: 2 } }]);
		expect(getStagedMetamodelDepth()).toBe(1);
	});

	it('puts the rebind op first when the draft is dirty', () => {
		registerMetamodelDraftProvider(() => ({ dirty: true, blob: 'elements: []\n' }));
		stageNodeMove('el:A', null);
		const ops = getStagedMetamodelOps();
		expect(ops[0]).toEqual({ kind: 'metamodel.rebind', blob: 'elements: []\n' });
		expect(ops[1]).toEqual({ kind: 'metamodel.move_node', node: 'el:A', pos: null });
		expect(getStagedMetamodelDepth()).toBe(2);
	});

	it('notifies committed listeners', () => {
		const cb = vi.fn();
		const off = onMetamodelCommitted(cb);
		notifyMetamodelCommitted({ rebound: true, blob: 'x' });
		expect(cb).toHaveBeenCalledWith({ rebound: true, blob: 'x' });
		off();
	});

	it('persists staged moves per project in localStorage', () => {
		stageNodeMove('el:A', { x: 3, y: 4 });
		initMetamodelStage('p1'); // re-open restores
		expect(getStagedMetamodelOps()).toHaveLength(1);
	});
});
