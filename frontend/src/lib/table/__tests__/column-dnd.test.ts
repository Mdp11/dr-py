// Unit tests for the pointer-driven column-reorder controller shared by
// ColumnManager's grip and TableGrid's header-cell drag. happy-dom has no
// real layout, so `document.elementFromPoint` is stubbed per test to return a
// fake drop-target element carrying the `attr` the module hit-tests for
// (mirroring the tree DnD idiom in ContainmentTree.svelte). Events are plain
// objects rather than real `PointerEvent`s — the module only reads
// button/clientX/clientY/pointerId/currentTarget, and `currentTarget` only
// needs a real `setPointerCapture` (a real detached element provides that,
// same as happy-dom's no-op implementation used by TableGrid's resize-handle
// tests).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableDefinition } from '$lib/api/types';
import {
	AUTO_SCROLL_EDGE_PX,
	AUTO_SCROLL_MAX_PX,
	createColumnDrag,
	edgeScrollVelocity,
	type ColumnDragState
} from '../column-dnd.svelte';

const ATTR = 'data-col-drop';

function defWithColumns(
	count: number,
	refIndex?: { column: number; sourcesIndex: number }
): TableDefinition {
	const columns: TableDefinition['columns'] = [];
	for (let i = 0; i < count; i++) {
		if (refIndex && i === refIndex.column) {
			columns.push({
				kind: 'navigation',
				source: { kind: 'column', index: refIndex.sourcesIndex },
				navigation: {},
				step_index: null,
				mode: 'collapse',
				keep_empty: true,
				sort_mode: 'value',
				cell_cap: 20,
				header: `c${i}`,
				width_px: null,
				hidden: false
			});
		} else {
			columns.push({
				kind: 'element',
				source: { kind: 'row', chain_index: 0 },
				header: `c${i}`,
				width_px: null,
				hidden: false
			});
		}
	}
	return {
		schema_version: 1,
		default_cell_mode: 'collapse',
		show_row_numbers: false,
		export_order: [],
		display_order: [],
		row_source: { kind: 'scope', types: ['Block'], criteria: [] },
		columns
	};
}

/** A fake pointer event: only the fields the module reads. `currentTarget`
 * is a real detached element so `setPointerCapture` (a real DOM method, a
 * no-op in happy-dom) can be called on it. */
function fakeEvent(opts: {
	button?: number;
	clientX: number;
	clientY: number;
	pointerId?: number;
}): PointerEvent {
	return {
		button: opts.button ?? 0,
		clientX: opts.clientX,
		clientY: opts.clientY,
		pointerId: opts.pointerId ?? 1,
		currentTarget: document.createElement('div')
	} as unknown as PointerEvent;
}

/** A fake drop-target element carrying `data-col-drop="<index>"` on itself —
 * `.closest(attr)` matches the element itself since real `Element.closest`
 * walks up from (and including) the element. */
function fakeDropTarget(index: number): HTMLElement {
	const el = document.createElement('div');
	el.setAttribute(ATTR, String(index));
	return el;
}

beforeEach(() => {
	// happy-dom may not define elementFromPoint at all.
	if (!('elementFromPoint' in document)) {
		(document as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null;
	}
});

describe('createColumnDrag', () => {
	it('stays idle (from === null) for a move below the drag threshold', () => {
		const onDrop = vi.fn();
		const defn = defWithColumns(3);
		const drag: ColumnDragState = createColumnDrag({
			attr: ATTR,
			getDefinition: () => defn,
			onDrop
		});
		vi.spyOn(document, 'elementFromPoint').mockReturnValue(fakeDropTarget(2));

		drag.onPointerDown(fakeEvent({ clientX: 10, clientY: 10 }), 0);
		drag.onPointerMove(fakeEvent({ clientX: 12, clientY: 11 })); // 2px, under 4px threshold

		expect(drag.from).toBeNull();
		expect(drag.over).toBeNull();
		expect(drag.valid).toBe(false);
		expect(onDrop).not.toHaveBeenCalled();
	});

	it('dragging column 0 over column 2 (no refs) is valid and drop calls onDrop(0, 2)', () => {
		const onDrop = vi.fn();
		const defn = defWithColumns(3);
		const drag: ColumnDragState = createColumnDrag({
			attr: ATTR,
			getDefinition: () => defn,
			onDrop
		});
		vi.spyOn(document, 'elementFromPoint').mockReturnValue(fakeDropTarget(2));

		drag.onPointerDown(fakeEvent({ clientX: 0, clientY: 0 }), 0);
		drag.onPointerMove(fakeEvent({ clientX: 100, clientY: 0 })); // past threshold

		expect(drag.from).toBe(0);
		expect(drag.over).toBe(2);
		expect(drag.valid).toBe(true);

		drag.onPointerUp(fakeEvent({ clientX: 100, clientY: 0 }));

		expect(onDrop).toHaveBeenCalledExactlyOnceWith(0, 2);
		// fully reset after drop
		expect(drag.from).toBeNull();
		expect(drag.over).toBeNull();
		expect(drag.valid).toBe(false);
	});

	it('a forward-ref-violating move (column 2 sources column 1, dragging 1 past 2) is invalid and drops nothing', () => {
		const onDrop = vi.fn();
		const defn = defWithColumns(3, { column: 2, sourcesIndex: 1 });
		const drag: ColumnDragState = createColumnDrag({
			attr: ATTR,
			getDefinition: () => defn,
			onDrop
		});
		vi.spyOn(document, 'elementFromPoint').mockReturnValue(fakeDropTarget(2));

		drag.onPointerDown(fakeEvent({ clientX: 0, clientY: 0 }), 1);
		drag.onPointerMove(fakeEvent({ clientX: 100, clientY: 0 }));

		expect(drag.from).toBe(1);
		expect(drag.over).toBe(2);
		expect(drag.valid).toBe(false);

		drag.onPointerUp(fakeEvent({ clientX: 100, clientY: 0 }));

		expect(onDrop).not.toHaveBeenCalled();
		expect(drag.from).toBeNull();
		expect(drag.over).toBeNull();
	});

	it('pointerup always resets, even for an idle (never-armed) gesture', () => {
		const onDrop = vi.fn();
		const defn = defWithColumns(3);
		const drag: ColumnDragState = createColumnDrag({
			attr: ATTR,
			getDefinition: () => defn,
			onDrop
		});
		drag.onPointerUp(fakeEvent({ clientX: 0, clientY: 0 }));
		expect(onDrop).not.toHaveBeenCalled();
		expect(drag.from).toBeNull();
		expect(drag.over).toBeNull();
		expect(drag.valid).toBe(false);
	});

	it('pointercancel over a valid target does NOT call onDrop and resets state', () => {
		const onDrop = vi.fn();
		const defn = defWithColumns(3);
		const drag: ColumnDragState = createColumnDrag({
			attr: ATTR,
			getDefinition: () => defn,
			onDrop
		});
		vi.spyOn(document, 'elementFromPoint').mockReturnValue(fakeDropTarget(2));

		drag.onPointerDown(fakeEvent({ clientX: 0, clientY: 0 }), 0);
		drag.onPointerMove(fakeEvent({ clientX: 100, clientY: 0 })); // past threshold

		expect(drag.from).toBe(0);
		expect(drag.over).toBe(2);
		expect(drag.valid).toBe(true);

		drag.onPointerCancel(fakeEvent({ clientX: 100, clientY: 0 }));

		expect(onDrop).not.toHaveBeenCalled();
		expect(drag.from).toBeNull();
		expect(drag.over).toBeNull();
		expect(drag.valid).toBe(false);
	});

	describe('geometry mode (real layout)', () => {
		let container: HTMLElement;

		/** A drop target with a REAL-looking rect: geometry mode engages when any
		 * snapshotted slot has a positive size (happy-dom itself reports zeros). */
		function layoutTarget(index: number, left: number, width: number): HTMLElement {
			const el = document.createElement('div');
			el.setAttribute(ATTR, String(index));
			el.getBoundingClientRect = () =>
				({
					left,
					top: 0,
					width,
					height: 20,
					right: left + width,
					bottom: 20,
					x: left,
					y: 0,
					toJSON: () => ({})
				}) as DOMRect;
			container.appendChild(el);
			return el;
		}

		/** Like fakeEvent, but the event originates ON the slot element so the
		 * controller can resolve the dragged slot and its siblings. */
		function slotEvent(target: HTMLElement, clientX: number, clientY: number): PointerEvent {
			return {
				button: 0,
				clientX,
				clientY,
				pointerId: 1,
				currentTarget: target
			} as unknown as PointerEvent;
		}

		beforeEach(() => {
			container = document.createElement('div');
			document.body.appendChild(container);
		});

		it('hit-tests the snapshot, previews the reflow via offsetOf, and anchors a ghost', () => {
			const onDrop = vi.fn();
			const defn = defWithColumns(3);
			const drag = createColumnDrag({ attr: ATTR, getDefinition: () => defn, onDrop });
			const s0 = layoutTarget(0, 0, 100);
			layoutTarget(1, 100, 100);
			layoutTarget(2, 200, 100);

			drag.onPointerDown(slotEvent(s0, 10, 10), 0);
			drag.onPointerMove(slotEvent(s0, 250, 10));

			expect(drag.from).toBe(0);
			expect(drag.over).toBe(2); // slot 2 spans [200, 300)
			expect(drag.valid).toBe(true);
			// previewed order [1, 2, 0]: both others shift left by the dragged
			// width, the dragged column slides to the end
			expect(drag.offsetOf(1)).toBe(-100);
			expect(drag.offsetOf(2)).toBe(-100);
			expect(drag.offsetOf(0)).toBe(200);
			// ghost anchored at pointer minus the grab offset, sized like the slot
			expect(drag.ghost).toEqual({ x: 240, y: 0, w: 100, h: 20 });

			drag.onPointerUp(slotEvent(s0, 250, 10));
			expect(onDrop).toHaveBeenCalledExactlyOnceWith(0, 2);
			expect(drag.offsetOf(1)).toBe(0); // reset cleared the preview
		});

		it('clamps along the axis (overshoot still targets the last column) but detaches off the cross axis', () => {
			const onDrop = vi.fn();
			const defn = defWithColumns(3);
			const drag = createColumnDrag({ attr: ATTR, getDefinition: () => defn, onDrop });
			const s0 = layoutTarget(0, 0, 100);
			layoutTarget(1, 100, 100);
			layoutTarget(2, 200, 100);

			drag.onPointerDown(slotEvent(s0, 10, 10), 0);
			drag.onPointerMove(slotEvent(s0, 999, 10)); // far right, inside the band
			expect(drag.over).toBe(2);

			drag.onPointerMove(slotEvent(s0, 250, 300)); // far below the strip
			expect(drag.over).toBeNull();
			expect(drag.offsetOf(1)).toBe(0);

			drag.onPointerUp(slotEvent(s0, 250, 300)); // detached release = no drop
			expect(onDrop).not.toHaveBeenCalled();
		});
	});

	it('uses a custom validator instead of moveColumn when given one', () => {
		// The export list reorders OUTPUT positions, which have none of
		// moveColumn's backward-reference constraints — and its entries include
		// the row-number slot, which has no definition column at all.
		const drops: Array<[number, number]> = [];
		const drag = createColumnDrag({
			attr: 'data-export-drop',
			axis: 'y',
			validate: () => true,
			onDrop: (from, to) => drops.push([from, to])
		});
		const target = document.createElement('div');
		target.setAttribute('data-export-drop', '1');
		vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);

		drag.onPointerDown(fakeEvent({ clientX: 0, clientY: 0 }), 0);
		drag.onPointerMove(fakeEvent({ clientX: 0, clientY: 100 })); // past threshold

		expect(drag.from).toBe(0);
		expect(drag.over).toBe(1);
		expect(drag.valid).toBe(true);

		drag.onPointerUp(fakeEvent({ clientX: 0, clientY: 100 }));

		expect(drops).toEqual([[0, 1]]);
	});

	it('resets after a completed valid drop so a second drag starts clean', () => {
		const onDrop = vi.fn();
		const defn = defWithColumns(3);
		const drag: ColumnDragState = createColumnDrag({
			attr: ATTR,
			getDefinition: () => defn,
			onDrop
		});
		vi.spyOn(document, 'elementFromPoint').mockReturnValue(fakeDropTarget(2));
		drag.onPointerDown(fakeEvent({ clientX: 0, clientY: 0 }), 0);
		drag.onPointerMove(fakeEvent({ clientX: 100, clientY: 0 }));
		drag.onPointerUp(fakeEvent({ clientX: 100, clientY: 0 }));

		// A stray pointermove with no prior pointerdown must be a no-op.
		drag.onPointerMove(fakeEvent({ clientX: 200, clientY: 0 }));
		expect(drag.from).toBeNull();
		expect(drag.over).toBeNull();
	});
});

describe('edgeScrollVelocity', () => {
	it('is zero away from both edges', () => {
		expect(edgeScrollVelocity(500, 0, 1000)).toBe(0);
	});

	it('ramps up towards the near edge, negative at the start, positive at the end', () => {
		const shallow = edgeScrollVelocity(AUTO_SCROLL_EDGE_PX - 4, 0, 1000);
		const deep = edgeScrollVelocity(4, 0, 1000);
		expect(shallow).toBeLessThan(0);
		expect(deep).toBeLessThan(shallow);
		expect(edgeScrollVelocity(0, 0, 1000)).toBe(-AUTO_SCROLL_MAX_PX);
		expect(edgeScrollVelocity(1000, 0, 1000)).toBe(AUTO_SCROLL_MAX_PX);
		expect(edgeScrollVelocity(996, 0, 1000)).toBeGreaterThan(0);
	});

	it('keeps scrolling past the edge (an overshooting pointer still scrolls)', () => {
		expect(edgeScrollVelocity(-200, 0, 1000)).toBe(-AUTO_SCROLL_MAX_PX);
		expect(edgeScrollVelocity(1200, 0, 1000)).toBe(AUTO_SCROLL_MAX_PX);
	});

	it('never scrolls a container too small to have two edge bands', () => {
		expect(edgeScrollVelocity(2, 0, 60)).toBe(0);
	});
});

describe('scrolling under a live drag', () => {
	let container: HTMLElement;
	const rects = new Map<number, { left: number; width: number }>();

	function layoutTarget(index: number, left: number, width: number): HTMLElement {
		const el = document.createElement('div');
		el.setAttribute(ATTR, String(index));
		rects.set(index, { left, width });
		// Reads the map on every call, so a test can "scroll" by rewriting it.
		el.getBoundingClientRect = () => {
			const r = rects.get(index)!;
			return {
				left: r.left,
				top: 0,
				width: r.width,
				height: 20,
				right: r.left + r.width,
				bottom: 20,
				x: r.left,
				y: 0,
				toJSON: () => ({})
			} as DOMRect;
		};
		container.appendChild(el);
		return el;
	}

	function slotEvent(target: HTMLElement, clientX: number, clientY: number): PointerEvent {
		return {
			button: 0,
			clientX,
			clientY,
			pointerId: 1,
			currentTarget: target
		} as unknown as PointerEvent;
	}

	beforeEach(() => {
		rects.clear();
		container = document.createElement('div');
		document.body.appendChild(container);
	});

	it('re-measures the slots and re-hit-tests the last pointer position on scroll', () => {
		const onDrop = vi.fn();
		const defn = defWithColumns(3);
		const drag = createColumnDrag({ attr: ATTR, getDefinition: () => defn, onDrop });
		const s0 = layoutTarget(0, 0, 100);
		layoutTarget(1, 100, 100);
		layoutTarget(2, 200, 100);

		drag.onPointerDown(slotEvent(s0, 10, 10), 0);
		drag.onPointerMove(slotEvent(s0, 150, 10));
		expect(drag.over).toBe(1);

		// The list scrolls 100px to the left under a pointer that stays put:
		// slot 2 now spans [100, 200) and is what sits under x=150. The DOM
		// reports rects WITH the live preview translation applied, as a real
		// getBoundingClientRect would.
		for (const [i, r] of rects) rects.set(i, { ...r, left: r.left - 100 + drag.offsetOf(i) });
		container.dispatchEvent(new Event('scroll'));
		expect(drag.over).toBe(2);

		drag.onPointerUp(slotEvent(s0, 150, 10));
		expect(onDrop).toHaveBeenCalledExactlyOnceWith(0, 2);
	});

	it('backs the live preview offset out of a re-measured rect', () => {
		const defn = defWithColumns(3);
		const drag = createColumnDrag({ attr: ATTR, getDefinition: () => defn, onDrop: vi.fn() });
		const s0 = layoutTarget(0, 0, 100);
		layoutTarget(1, 100, 100);
		layoutTarget(2, 200, 100);

		drag.onPointerDown(slotEvent(s0, 10, 10), 0);
		drag.onPointerMove(slotEvent(s0, 250, 10)); // over slot 2: preview [1, 2, 0]
		expect(drag.offsetOf(1)).toBe(-100);
		// The DOM now reports the TRANSLATED rects (the preview is live), and
		// nothing scrolled. A naive re-capture would read slot 1 at x=0 and
		// slot 0 at x=200 and flip the preview; backing the offsets out keeps
		// the untranslated geometry and the preview stable.
		rects.set(1, { left: 0, width: 100 });
		rects.set(2, { left: 100, width: 100 });
		rects.set(0, { left: 200, width: 100 });
		container.dispatchEvent(new Event('scroll'));
		expect(drag.over).toBe(2);
		expect(drag.offsetOf(1)).toBe(-100);
		expect(drag.offsetOf(0)).toBe(200);
		drag.onPointerCancel(slotEvent(s0, 250, 10));
	});

	it('stops listening once the drag ends', () => {
		const defn = defWithColumns(2);
		const drag = createColumnDrag({ attr: ATTR, getDefinition: () => defn, onDrop: vi.fn() });
		const s0 = layoutTarget(0, 0, 100);
		layoutTarget(1, 100, 100);
		drag.onPointerDown(slotEvent(s0, 10, 10), 0);
		drag.onPointerMove(slotEvent(s0, 150, 10));
		drag.onPointerUp(slotEvent(s0, 150, 10));
		const spy = vi.spyOn(document, 'elementFromPoint');
		container.dispatchEvent(new Event('scroll'));
		expect(drag.over).toBeNull();
		expect(spy).not.toHaveBeenCalled();
	});
});
