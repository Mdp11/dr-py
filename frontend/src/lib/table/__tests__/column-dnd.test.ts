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
import { createColumnDrag, type ColumnDragState } from '../column-dnd.svelte';

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
