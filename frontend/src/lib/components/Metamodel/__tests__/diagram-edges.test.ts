import { Position } from '@xyflow/svelte';
import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';

import { noteZoom, resetMetamodelCanvas } from '../../../state/metamodel-canvas.svelte';
import AssociationEdge from '../diagram/AssociationEdge.svelte';
import GeneralizationEdge from '../diagram/GeneralizationEdge.svelte';

/**
 * The edge components mount standalone here — no `<SvelteFlowProvider>` —
 * which works only because neither renders an `EdgeLabel` in these cases:
 * that component reads the flow store and the per-edge id context, and would
 * throw. `GeneralizationEdge` never has a label at all; `AssociationEdge` is
 * given data with no `label` and no multiplicities, so its three `EdgeLabel`
 * sites all stay unrendered. That keeps the assertion below about the ONE
 * thing under test — `BaseEdge`'s invisible interaction path.
 */
const GEOMETRY = {
	sourceX: 0,
	sourceY: 0,
	targetX: 100,
	targetY: 100,
	sourcePosition: Position.Right,
	targetPosition: Position.Left
};

function svgTarget(): SVGSVGElement {
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	document.body.appendChild(svg);
	return svg;
}

/** `stroke-width` of the transparent hit-area path `BaseEdge` renders. */
function interactionWidth(root: Element): string | null {
	const path = root.querySelector('.svelte-flow__edge-interaction');
	if (path === null) throw new Error('no interaction path rendered');
	return path.getAttribute('stroke-width');
}

afterEach(() => {
	resetMetamodelCanvas();
	document.body.innerHTML = '';
});

describe('edge hit area under LOD', () => {
	it('AssociationEdge widens its hit area in simplified mode', () => {
		const target = svgTarget();
		const props = {
			id: 'assoc:Contains:0',
			source: 'el:Zone',
			target: 'el:Building',
			type: 'association',
			data: {},
			...GEOMETRY
		};
		let c = mount(AssociationEdge, { target, props });
		try {
			expect(interactionWidth(target)).toBe('20');
		} finally {
			unmount(c);
		}

		noteZoom(0.1); // below LOD_ENTER
		c = mount(AssociationEdge, { target, props });
		try {
			expect(interactionWidth(target)).toBe('60');
		} finally {
			unmount(c);
		}
	});

	it('GeneralizationEdge widens its hit area in simplified mode', () => {
		const target = svgTarget();
		const props = {
			id: 'gen:rel:A',
			source: 'el:A',
			target: 'el:B',
			type: 'generalization',
			...GEOMETRY
		};
		let c = mount(GeneralizationEdge, { target, props });
		try {
			expect(interactionWidth(target)).toBe('20');
		} finally {
			unmount(c);
		}

		noteZoom(0.1);
		c = mount(GeneralizationEdge, { target, props });
		try {
			expect(interactionWidth(target)).toBe('60');
		} finally {
			unmount(c);
		}
	});
});
