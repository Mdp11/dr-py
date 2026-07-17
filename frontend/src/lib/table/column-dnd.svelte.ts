import { moveColumn } from './columns';
import type { TableDefinition } from '$lib/api/types';

const DRAG_THRESHOLD_PX = 4;
// How far the pointer may stray from the strip on the cross axis before the
// drag detaches (over -> null, no reflow, releasing cancels the drop).
const CROSS_AXIS_BAND_PX = 48;

/** One drop target's geometry, captured ONCE at drag start. Hit-testing runs
 * against this snapshot instead of the live DOM because the live preview
 * translates targets under the pointer — hit-testing the moved elements would
 * oscillate (shift → different element under pointer → shift back). */
interface Slot {
	index: number;
	start: number;
	size: number;
	crossStart: number;
	crossSize: number;
}

export interface ColumnDragState {
	from: number | null; // definition index being dragged (null = idle)
	over: number | null; // definition index currently hovered as drop target
	valid: boolean; // would moveColumn(from, over) succeed?
	dragging: boolean; // threshold crossed, drag live
	/** Pointer-following ghost anchor: the dragged item's rect, translated with
	 * the pointer from its grab point. Hosts render the ghost themselves. */
	ghost: { x: number; y: number; w: number; h: number } | null;
	/** Live-reflow preview: px translation (along the drag axis) that moves the
	 * item at definition index `i` to its would-be position after the drop.
	 * 0 while idle, over an invalid target, or in layoutless environments. */
	offsetOf(i: number): number;
	onPointerDown(e: PointerEvent, index: number): void;
	onPointerMove(e: PointerEvent): void;
	onPointerUp(e: PointerEvent): void;
	onPointerCancel(e: PointerEvent): void;
}

/** Pointer-driven column reorder shared by the settings list and the grid
 * header. Threshold-gated pointerdown; at drag start the drop targets'
 * rects are snapshotted and hit-testing runs against that geometry, which
 * stays stable while the live preview translates the real elements. In
 * layoutless environments (unit tests under happy-dom, where every rect is
 * zero) hit-testing falls back to document.elementFromPoint + closest(attr) —
 * the previous mechanism, which the test suites stub. The move is validated
 * with the PURE moveColumn before the drop is offered, so a forward-ref-
 * violating drop shows as invalid instead of throwing late. */
export function createColumnDrag(opts: {
	attr: string;
	/** Drag axis: 'x' for the horizontal header strip, 'y' for the settings
	 * list. Defaults to 'x'. */
	axis?: 'x' | 'y';
	getDefinition: () => TableDefinition | undefined;
	onDrop: (from: number, to: number) => void;
}): ColumnDragState {
	const axis = opts.axis ?? 'x';
	let from = $state<number | null>(null);
	let over = $state<number | null>(null);
	let valid = $state(false);
	let ghost = $state<{ x: number; y: number; w: number; h: number } | null>(null);
	let offsets = $state<Record<number, number>>({});
	let armed: { index: number; x: number; y: number; source: HTMLElement | null } | null = null;
	let slots: Slot[] | null = null;
	let grab = { dx: 0, dy: 0, w: 0, h: 0 };

	function reset(): void {
		from = null;
		over = null;
		valid = false;
		ghost = null;
		offsets = {};
		armed = null;
		slots = null;
	}

	/** Snapshot every drop target's rect, scoped to the dragged item's siblings
	 * (all targets share one parent in both hosts) so a second, hidden host on
	 * the page can't pollute the slot list. */
	function captureSlots(): void {
		const scope = armed?.source?.parentElement ?? document;
		const list: Slot[] = [];
		for (const el of scope.querySelectorAll(`[${opts.attr}]`)) {
			const i = Number(el.getAttribute(opts.attr));
			if (!Number.isInteger(i)) continue;
			const r = el.getBoundingClientRect();
			list.push(
				axis === 'x'
					? { index: i, start: r.left, size: r.width, crossStart: r.top, crossSize: r.height }
					: { index: i, start: r.top, size: r.height, crossStart: r.left, crossSize: r.width }
			);
		}
		list.sort((a, b) => a.start - b.start);
		slots = list;
	}

	function geometryUsable(): boolean {
		return slots !== null && slots.length > 0 && slots.some((s) => s.size > 0);
	}

	/** Slot under (or nearest to) the pointer along the drag axis. Outside the
	 * strip's cross-axis band the drag is detached (null → releasing cancels);
	 * along the axis the pointer clamps to the strip, so overshooting the first/
	 * last column still targets it. */
	function hitTest(p: number, cross: number): number | null {
		const list = slots!;
		let lo = Infinity;
		let hi = -Infinity;
		for (const s of list) {
			lo = Math.min(lo, s.crossStart);
			hi = Math.max(hi, s.crossStart + s.crossSize);
		}
		if (cross < lo - CROSS_AXIS_BAND_PX || cross > hi + CROSS_AXIS_BAND_PX) return null;
		const first = list[0];
		const last = list[list.length - 1];
		const clamped = Math.min(Math.max(p, first.start), last.start + last.size - 1);
		let best: number | null = null;
		let bestDist = Infinity;
		for (const s of list) {
			if (clamped >= s.start && clamped < s.start + s.size) return s.index;
			const d = Math.abs(clamped - (s.start + s.size / 2));
			if (d < bestDist) {
				bestDist = d;
				best = s.index;
			}
		}
		return best;
	}

	/** Per-index translation previewing the drop: simulate the final layout
	 * (same splice semantics as moveColumn) over the snapshotted slot geometry
	 * and diff each slot's new start against its original one. */
	function computeOffsets(): void {
		if (!geometryUsable() || from === null || over === null || from === over || !valid) {
			offsets = {};
			return;
		}
		const list = slots!;
		const pf = list.findIndex((s) => s.index === from);
		const po = list.findIndex((s) => s.index === over);
		if (pf < 0 || po < 0) {
			offsets = {};
			return;
		}
		let gap = 0;
		for (let i = 0; i + 1 < list.length; i++) {
			const d = list[i + 1].start - (list[i].start + list[i].size);
			if (d > 0) {
				gap = d;
				break;
			}
		}
		const order = list.map((_, i) => i);
		order.splice(po, 0, order.splice(pf, 1)[0]);
		const next: Record<number, number> = {};
		let cursor = list[0].start;
		for (const pos of order) {
			next[list[pos].index] = cursor - list[pos].start;
			cursor += list[pos].size + gap;
		}
		offsets = next;
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
		get dragging() {
			return from !== null;
		},
		get ghost() {
			return ghost;
		},
		offsetOf(i: number): number {
			return offsets[i] ?? 0;
		},
		onPointerDown(e: PointerEvent, index: number): void {
			if (e.button !== 0) return;
			const target = e.currentTarget as HTMLElement;
			armed = {
				index,
				x: e.clientX,
				y: e.clientY,
				source: (target.closest?.(`[${opts.attr}]`) as HTMLElement | null) ?? null
			};
			target.setPointerCapture(e.pointerId);
		},
		onPointerMove(e: PointerEvent): void {
			if (!armed) return;
			if (from === null) {
				if (Math.hypot(e.clientX - armed.x, e.clientY - armed.y) < DRAG_THRESHOLD_PX) return;
				from = armed.index;
				captureSlots();
				const r = armed.source?.getBoundingClientRect();
				grab =
					r && (r.width > 0 || r.height > 0)
						? { dx: armed.x - r.left, dy: armed.y - r.top, w: r.width, h: r.height }
						: { dx: 0, dy: 0, w: 0, h: 0 };
			}
			ghost = { x: e.clientX - grab.dx, y: e.clientY - grab.dy, w: grab.w, h: grab.h };
			if (geometryUsable()) {
				over = hitTest(axis === 'x' ? e.clientX : e.clientY, axis === 'x' ? e.clientY : e.clientX);
			} else {
				// layoutless fallback (unit tests): hit-test the live DOM
				const hit = document
					.elementFromPoint(e.clientX, e.clientY)
					?.closest(`[${opts.attr}]`) as HTMLElement | null;
				const t = hit ? Number(hit.getAttribute(opts.attr)) : NaN;
				over = Number.isInteger(t) ? t : null;
			}
			const defn = opts.getDefinition();
			if (over === null || from === over || !defn) {
				valid = false;
				computeOffsets();
				return;
			}
			try {
				moveColumn(defn, from, over);
				valid = true;
			} catch {
				valid = false;
			}
			computeOffsets();
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
