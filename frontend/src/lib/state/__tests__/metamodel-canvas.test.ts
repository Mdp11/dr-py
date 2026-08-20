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
	noteHoverCursor,
	noteZoom,
	resetMetamodelCanvas,
	setDiagramAdjacency,
	setDiagramHover
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

	/**
	 * The memo keys on the (hover, adjacency) PAIR, and the test above only ever
	 * varies the hover — so this covers the other half: the same hover object,
	 * against a rebuilt adjacency, must not return the stale set.
	 *
	 * Reaching it takes re-setting the IDENTICAL hover object after the rebuild,
	 * because `setDiagramAdjacency` now clears the hover (a rebuild can retire
	 * the hovered id). In the app the hover is a fresh literal per pointer event,
	 * so the adjacency clause is a defensive guard rather than a path a user
	 * walks — but the memo is only correct because it checks both, and a memo
	 * that silently keyed on the hover alone would fail exactly here.
	 */
	it('invalidates the memo when the adjacency is rebuilt under the same hover', () => {
		const hover = { kind: 'node', id: 'el:Zone' } as const;
		setDiagramAdjacency(buildAdjacency(EDGES));
		setDiagramHover(hover);
		const first = getDiagramHighlight();
		expect(first?.nodes).toEqual(new Set(['el:Zone', 'el:Building']));

		// A rebuild in which `el:Zone` gained a second neighbour.
		setDiagramAdjacency(
			buildAdjacency([
				...EDGES,
				{
					id: 'assoc:Monitors:0',
					source: 'el:Zone',
					target: 'el:Sensor',
					type: 'association',
					data: { relName: 'Monitors' }
				}
			])
		);
		setDiagramHover(hover);
		const second = getDiagramHighlight();
		expect(second).not.toBe(first);
		expect(second?.nodes).toEqual(new Set(['el:Zone', 'el:Building', 'el:Sensor']));
	});

	it('drops the hover when the adjacency is replaced', () => {
		setDiagramAdjacency(buildAdjacency(EDGES));
		setDiagramHover({ kind: 'node', id: 'el:Zone' });
		expect(getDiagramHighlight()).not.toBeNull();
		// A diagram rebuild can retire the hovered node outright; a hover left
		// pointing at a dead id yields an EMPTY highlight, which dims the whole
		// canvas until the next pointer event.
		setDiagramAdjacency(buildAdjacency(EDGES));
		expect(getDiagramHover()).toBeNull();
		expect(getDiagramHighlight()).toBeNull();
	});

	it('exposes the hover label through the same pair', () => {
		setDiagramAdjacency(buildAdjacency(EDGES));
		setDiagramHover({ kind: 'edge', id: 'assoc:Contains:0', relName: 'Contains' });
		expect(getDiagramHoverLabel()).toBe('Contains: Zone → Building');
	});
});

describe('noteHoverCursor', () => {
	it('records only while the LOD tooltip could be showing', () => {
		setDiagramAdjacency(buildAdjacency(EDGES));

		// LOD off, nothing hovered: a pointer sweep records nothing.
		noteHoverCursor({ x: 1, y: 2 });
		expect(getHoverCursor()).toBeNull();

		// LOD on but nothing hovered: still nothing — there is no tooltip.
		noteZoom(0.1);
		noteHoverCursor({ x: 3, y: 4 });
		expect(getHoverCursor()).toBeNull();

		setDiagramHover({ kind: 'node', id: 'el:Zone' });
		noteHoverCursor({ x: 5, y: 6 });
		expect(getHoverCursor()).toEqual({ x: 5, y: 6 });
	});

	it('clears the position when the tooltip stops applying', () => {
		setDiagramAdjacency(buildAdjacency(EDGES));
		noteZoom(0.1);
		setDiagramHover({ kind: 'node', id: 'el:Zone' });
		noteHoverCursor({ x: 5, y: 6 });

		// Pointer leaves the node: the next move clears rather than leaving the
		// last position behind for the next time LOD engages.
		setDiagramHover(null);
		noteHoverCursor({ x: 7, y: 8 });
		expect(getHoverCursor()).toBeNull();

		// Same on leaving simplified mode.
		setDiagramHover({ kind: 'node', id: 'el:Zone' });
		noteHoverCursor({ x: 9, y: 10 });
		expect(getHoverCursor()).toEqual({ x: 9, y: 10 });
		noteZoom(0.9);
		noteHoverCursor({ x: 11, y: 12 });
		expect(getHoverCursor()).toBeNull();
	});
});

describe('reset', () => {
	it('clears everything', () => {
		setDiagramAdjacency(buildAdjacency(EDGES));
		noteZoom(0.1);
		setDiagramHover({ kind: 'node', id: 'el:Zone' });
		noteHoverCursor({ x: 10, y: 20 });
		expect(getHoverCursor()).not.toBeNull();
		resetMetamodelCanvas();
		expect(getDiagramHover()).toBeNull();
		expect(getDiagramHighlight()).toBeNull();
		expect(getHoverCursor()).toBeNull();
		expect(getLodActive()).toBe(false);
	});
});
