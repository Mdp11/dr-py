import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE } from '$lib/metamodel/__tests__/fixtures';
import { parseDraft } from '$lib/metamodel/yaml-edit';
import type { MetamodelDiagramView } from '$lib/state/metamodel-diagram.svelte';
import { getMetamodelDiagramView, selectDiagramNode } from '$lib/state/metamodel-diagram.svelte';
import {
	getMetamodelPanel,
	initMetamodelPanel,
	setMetamodelPanelCollapsed
} from '$lib/state/metamodel-panel.svelte';
import { revealSelection, REVEAL_ZOOM, type RevealFlow } from '../reveal-action';

const mm = parseDraft(FIXTURE).mm!;

function makeView(): MetamodelDiagramView {
	return {
		view: 'diagram',
		mm,
		parseErrors: [],
		selection: null,
		positions: { 'el:Zone': { x: 100, y: 200 } },
		collapsed: new Set<string>(),
		canUndo: false,
		errorNodeIds: new Set<string>(),
		unattributedErrorCount: 0
	};
}

function makeFlow(): RevealFlow & {
	setCenter: ReturnType<typeof vi.fn>;
	fitBounds: ReturnType<typeof vi.fn>;
} {
	return {
		setCenter: vi.fn().mockResolvedValue(true),
		fitBounds: vi.fn().mockResolvedValue(true)
	};
}

beforeEach(() => {
	localStorage.clear();
	initMetamodelPanel('p1');
	selectDiagramNode(null);
});

describe('revealSelection', () => {
	it('selects, reopens the panel, and centers on an element', () => {
		setMetamodelPanelCollapsed(true);
		const flow = makeFlow();
		revealSelection(flow, makeView(), { kind: 'element', name: 'Zone' });
		expect(getMetamodelDiagramView().selection).toEqual({ kind: 'element', name: 'Zone' });
		expect(getMetamodelPanel().collapsed).toBe(false);
		expect(flow.setCenter).toHaveBeenCalledTimes(1);
		const [, , opts] = flow.setCenter.mock.calls[0];
		expect(opts).toEqual({ zoom: REVEAL_ZOOM, duration: 300 });
		expect(flow.fitBounds).not.toHaveBeenCalled();
	});

	it('fits bounds for a mapped relationship', () => {
		const flow = makeFlow();
		revealSelection(flow, makeView(), { kind: 'relationship', name: 'Contains' });
		expect(flow.fitBounds).toHaveBeenCalledTimes(1);
		expect(flow.setCenter).not.toHaveBeenCalled();
		expect(getMetamodelDiagramView().selection).toEqual({
			kind: 'relationship',
			name: 'Contains'
		});
	});

	it('selects without panning when nothing is drawn', () => {
		const flow = makeFlow();
		revealSelection(flow, makeView(), { kind: 'element', name: 'Ghost' });
		expect(flow.setCenter).not.toHaveBeenCalled();
		expect(flow.fitBounds).not.toHaveBeenCalled();
		expect(getMetamodelDiagramView().selection).toEqual({ kind: 'element', name: 'Ghost' });
	});
});
