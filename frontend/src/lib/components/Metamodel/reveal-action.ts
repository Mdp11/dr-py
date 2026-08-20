import { revealTarget } from '$lib/metamodel/diagram-reveal';
import type { DiagramSelection } from '$lib/metamodel/diagram-build';
import type { MetamodelDiagramView } from '$lib/state/metamodel-diagram.svelte';
import { selectDiagramNode } from '$lib/state/metamodel-diagram.svelte';
import { setMetamodelPanelCollapsed } from '$lib/state/metamodel-panel.svelte';

/**
 * THE shared navigate action (spec 2026-08-20 §6/§7.1): search picks and the
 * panel TOC rows both come through here, which is what keeps their behaviour
 * from drifting — select, reopen the panel (navigating by name implies
 * wanting the form; a plain canvas click deliberately does not reopen), then
 * pan/fit per `revealTarget`'s geometry.
 *
 * Takes the flow helpers as a parameter rather than calling `useSvelteFlow`
 * itself: hooks bind context at their call site, so the CALLER (a component
 * under `SvelteFlowProvider`) owns the hook and this stays a plain function
 * a test can hand a fake flow.
 */

export interface RevealFlow {
	setCenter: (
		x: number,
		y: number,
		opts?: { zoom?: number; duration?: number }
	) => Promise<boolean>;
	fitBounds: (
		rect: { x: number; y: number; width: number; height: number },
		opts?: { duration?: number }
	) => Promise<boolean>;
}

/** Same zoom the old find input used — close enough to read a box. */
export const REVEAL_ZOOM = 1.2;

export function revealSelection(
	flow: RevealFlow,
	view: MetamodelDiagramView,
	sel: DiagramSelection
): void {
	selectDiagramNode(sel);
	setMetamodelPanelCollapsed(false);
	if (view.mm === null) return;
	const t = revealTarget(sel, view.mm, view.positions, view.collapsed);
	if (t.kind === 'center') {
		void flow.setCenter(t.x, t.y, { zoom: REVEAL_ZOOM, duration: 300 });
	} else if (t.kind === 'bounds') {
		void flow.fitBounds(t.rect, { duration: 300 });
	}
}
