import { beforeEach, describe, expect, it } from 'vitest';

import { buildAdjacency } from '$lib/metamodel/diagram-adjacency';
import type { DiagramEdgeSpec } from '$lib/metamodel/diagram-build';
import {
	getDiagramHighlight,
	getDiagramHover,
	getDiagramHoverLabel,
	getHoverCursor,
	getLodActive,
	LOD_ENTER,
	LOD_EXIT,
	noteZoom,
	resetMetamodelCanvas,
	setDiagramAdjacency,
	setDiagramHover,
	setHoverCursor
} from '../metamodel-canvas.svelte';

const EDGES: DiagramEdgeSpec[] = [
	{
		id: 'assoc:Contains:0',
		source: 'el:Zone',
		target: 'el:Building',
		type: 'association',
		data: { relName: 'Contains' }
	}
];

beforeEach(() => {
	resetMetamodelCanvas();
});

describe('LOD hysteresis', () => {
	it('enters below LOD_ENTER, exits above LOD_EXIT, holds in between', () => {
		expect(getLodActive()).toBe(false);
		noteZoom(LOD_ENTER + 0.01);
		expect(getLodActive()).toBe(false);
		noteZoom(LOD_ENTER - 0.01);
		expect(getLodActive()).toBe(true);
		// Inside the band: the current mode holds — no flicker at the boundary.
		noteZoom((LOD_ENTER + LOD_EXIT) / 2);
		expect(getLodActive()).toBe(true);
		noteZoom(LOD_EXIT + 0.01);
		expect(getLodActive()).toBe(false);
		noteZoom((LOD_ENTER + LOD_EXIT) / 2);
		expect(getLodActive()).toBe(false);
	});
});

describe('hover + highlight', () => {
	it('is null with no hover or no adjacency', () => {
		expect(getDiagramHighlight()).toBeNull();
		setDiagramHover({ kind: 'node', id: 'el:Zone' });
		expect(getDiagramHighlight()).toBeNull(); // adjacency not set yet
	});

	it('derives the highlight and memoizes it per (hover, adjacency)', () => {
		setDiagramAdjacency(buildAdjacency(EDGES));
		setDiagramHover({ kind: 'node', id: 'el:Zone' });
		const first = getDiagramHighlight();
		expect(first?.nodes).toEqual(new Set(['el:Zone', 'el:Building']));
		expect(getDiagramHighlight()).toBe(first); // same identity: memo hit
		setDiagramHover({ kind: 'node', id: 'el:Building' });
		expect(getDiagramHighlight()).not.toBe(first);
	});

	it('exposes the hover label through the same pair', () => {
		setDiagramAdjacency(buildAdjacency(EDGES));
		setDiagramHover({ kind: 'edge', id: 'assoc:Contains:0', relName: 'Contains' });
		expect(getDiagramHoverLabel()).toBe('Contains: Zone → Building');
	});
});

describe('reset', () => {
	it('clears everything', () => {
		setDiagramAdjacency(buildAdjacency(EDGES));
		setDiagramHover({ kind: 'node', id: 'el:Zone' });
		setHoverCursor({ x: 10, y: 20 });
		noteZoom(0.1);
		resetMetamodelCanvas();
		expect(getDiagramHover()).toBeNull();
		expect(getDiagramHighlight()).toBeNull();
		expect(getHoverCursor()).toBeNull();
		expect(getLodActive()).toBe(false);
	});
});
