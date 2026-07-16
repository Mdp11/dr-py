import { moveColumn } from './columns';
import type { TableDefinition } from '$lib/api/types';

const DRAG_THRESHOLD_PX = 4;

export interface ColumnDragState {
	from: number | null; // definition index being dragged (null = idle)
	over: number | null; // definition index currently hovered as drop target
	valid: boolean; // would moveColumn(from, over) succeed?
	onPointerDown(e: PointerEvent, index: number): void;
	onPointerMove(e: PointerEvent): void;
	onPointerUp(e: PointerEvent): void;
	onPointerCancel(e: PointerEvent): void;
}

/** Pointer-driven column reorder shared by the settings list and the grid
 * header. Same idiom as the tree's drag controller: threshold-gated
 * pointerdown, hit-testing via document.elementFromPoint + closest(attr)
 * (works across both hosts' DOM without per-target dragover handlers), and
 * the move validated with the PURE moveColumn before the drop is offered —
 * a forward-ref-violating drop shows as invalid instead of throwing late. */
export function createColumnDrag(opts: {
	attr: string;
	getDefinition: () => TableDefinition | undefined;
	onDrop: (from: number, to: number) => void;
}): ColumnDragState {
	let from = $state<number | null>(null);
	let over = $state<number | null>(null);
	let valid = $state(false);
	let armed: { index: number; x: number; y: number } | null = null;

	function reset(): void {
		from = null;
		over = null;
		valid = false;
		armed = null;
	}

	return {
		get from() {
			return from;
		},
		get over() {
			return over;
		},
		get valid() {
			return valid;
		},
		onPointerDown(e: PointerEvent, index: number): void {
			if (e.button !== 0) return;
			armed = { index, x: e.clientX, y: e.clientY };
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		},
		onPointerMove(e: PointerEvent): void {
			if (!armed) return;
			if (from === null) {
				if (Math.hypot(e.clientX - armed.x, e.clientY - armed.y) < DRAG_THRESHOLD_PX) return;
				from = armed.index;
			}
			const hit = document
				.elementFromPoint(e.clientX, e.clientY)
				?.closest(`[${opts.attr}]`) as HTMLElement | null;
			const t = hit ? Number(hit.getAttribute(opts.attr)) : NaN;
			over = Number.isInteger(t) ? t : null;
			const defn = opts.getDefinition();
			if (over === null || from === over || !defn) {
				valid = false;
				return;
			}
			try {
				moveColumn(defn, from, over);
				valid = true;
			} catch {
				valid = false;
			}
		},
		onPointerUp(): void {
			if (from !== null && over !== null && valid && from !== over) opts.onDrop(from, over);
			reset();
		},
		onPointerCancel(): void {
			// The browser aborted the gesture (multi-touch conflict, OS gesture,
			// capture loss) — this is NOT a confirmed drop, unlike pointerup.
			reset();
		}
	};
}
