import { moveColumn } from './columns';
import type { TableDefinition } from '$lib/api/types';

const DRAG_THRESHOLD_PX = 4;
// How far the pointer may stray from the strip on the cross axis before the
// drag detaches (over -> null, no reflow, releasing cancels the drop).
const CROSS_AXIS_BAND_PX = 48;
/** Within this many px of the scroll container's edge (along the drag axis)
 * the container auto-scrolls, faster the closer to the edge. */
export const AUTO_SCROLL_EDGE_PX = 48;
/** Auto-scroll speed at the very edge, in px per animation frame. */
export const AUTO_SCROLL_MAX_PX = 18;

/** One drop target's geometry, captured at drag start and re-captured after
 * every scroll. Hit-testing runs against this snapshot instead of the live
 * DOM because the live preview translates targets under the pointer —
 * hit-testing the moved elements would oscillate (shift → different element
 * under pointer → shift back). */
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

/** Auto-scroll velocity for a pointer at `pos` inside a container spanning
 * [`start`, `end`] along the drag axis: 0 away from the edges, ramping to
 * ±`AUTO_SCROLL_MAX_PX` at (or past) the edge itself. Pure, for tests. */
export function edgeScrollVelocity(pos: number, start: number, end: number): number {
	if (end - start <= 2 * AUTO_SCROLL_EDGE_PX) return 0; // too small to have edges
	const nearStart = pos - start;
	const nearEnd = end - pos;
	if (nearStart < AUTO_SCROLL_EDGE_PX) {
		const depth = Math.min(1, Math.max(0, 1 - nearStart / AUTO_SCROLL_EDGE_PX));
		return -Math.ceil(depth * AUTO_SCROLL_MAX_PX);
	}
	if (nearEnd < AUTO_SCROLL_EDGE_PX) {
		const depth = Math.min(1, Math.max(0, 1 - nearEnd / AUTO_SCROLL_EDGE_PX));
		return Math.ceil(depth * AUTO_SCROLL_MAX_PX);
	}
	return 0;
}

/** Nearest ancestor of `el` that scrolls along `axis`. */
function scrollParentOf(el: HTMLElement | null, axis: 'x' | 'y'): HTMLElement | null {
	let node = el?.parentElement ?? null;
	while (node && node !== document.body) {
		const style = getComputedStyle(node);
		const overflow = axis === 'x' ? style.overflowX : style.overflowY;
		const scrollable = overflow === 'auto' || overflow === 'scroll';
		const canScroll =
			axis === 'x' ? node.scrollWidth > node.clientWidth : node.scrollHeight > node.clientHeight;
		if (scrollable && canScroll) return node;
		node = node.parentElement;
	}
	return null;
}

/** Pointer-driven column reorder shared by the settings list and the grid
 * header. Threshold-gated pointerdown; at drag start the drop targets'
 * rects are snapshotted and hit-testing runs against that geometry, which
 * stays stable while the live preview translates the real elements. The
 * snapshot is refreshed after every scroll (wheel, keyboard, or the
 * controller's own edge auto-scroll) and the last pointer position is
 * re-hit-tested, so the drop target keeps tracking the pointer while the
 * list moves underneath it. In layoutless environments (unit tests under
 * happy-dom, where every rect is zero) hit-testing falls back to
 * document.elementFromPoint + closest(attr) — the previous mechanism, which
 * the test suites stub. The move is validated with the PURE moveColumn before
 * the drop is offered, so a forward-ref-violating drop shows as invalid
 * instead of throwing late — unless the host supplies its own `validate`,
 * which bypasses moveColumn entirely (the export list and the grid header
 * reorder OUTPUT positions, which have no such constraint). */
export function createColumnDrag(opts: {
	attr: string;
	/** Drag axis: 'x' for the horizontal header strip, 'y' for the settings
	 * list. Defaults to 'x'. */
	axis?: 'x' | 'y';
	/** Only needed by the DEFAULT validator. */
	getDefinition?: () => TableDefinition | undefined;
	/** Whether a drop is offered. Defaults to "moveColumn would succeed",
	 * which is right for the host that reorders DEFINITION columns
	 * (backward-only ColumnRef). The export list and the grid header reorder
	 * OUTPUT/DISPLAY positions, which carry no such constraint (and the export
	 * list includes a slot with no definition column at all), so they supply
	 * their own. */
	validate?: (from: number, to: number) => boolean;
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
	let last = { x: 0, y: 0 };
	let scrollParent: HTMLElement | null = null;
	let scrollVelocity = 0;
	let scrollFrame: number | null = null;
	let listening = false;

	function reset(): void {
		from = null;
		over = null;
		valid = false;
		ghost = null;
		offsets = {};
		armed = null;
		slots = null;
		scrollParent = null;
		stopAutoScroll();
		if (listening) {
			window.removeEventListener('scroll', onAnyScroll, true);
			listening = false;
		}
	}

	/** Snapshot every drop target's rect, scoped to the dragged item's siblings
	 * (all targets share one parent in every host) so a second, hidden host on
	 * the page can't pollute the slot list. A live preview offset is backed out
	 * of the measured rect, so a re-capture mid-drag (after a scroll) yields
	 * the same untranslated geometry the first capture did. */
	function captureSlots(): void {
		const scope = armed?.source?.parentElement ?? document;
		const list: Slot[] = [];
		for (const el of scope.querySelectorAll(`[${opts.attr}]`)) {
			const i = Number(el.getAttribute(opts.attr));
			if (!Number.isInteger(i)) continue;
			const r = el.getBoundingClientRect();
			const shift = offsets[i] ?? 0;
			list.push(
				axis === 'x'
					? {
							index: i,
							start: r.left - shift,
							size: r.width,
							crossStart: r.top,
							crossSize: r.height
						}
					: {
							index: i,
							start: r.top - shift,
							size: r.height,
							crossStart: r.left,
							crossSize: r.width
						}
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

	/** Resolve the drop target and preview for the pointer at (`x`, `y`). */
	function track(x: number, y: number): void {
		if (from === null) return;
		if (geometryUsable()) {
			over = hitTest(axis === 'x' ? x : y, axis === 'x' ? y : x);
		} else {
			// layoutless fallback (unit tests): hit-test the live DOM
			const hit = document.elementFromPoint(x, y)?.closest(`[${opts.attr}]`) as HTMLElement | null;
			const t = hit ? Number(hit.getAttribute(opts.attr)) : NaN;
			over = Number.isInteger(t) ? t : null;
		}
		if (over === null || from === over) {
			valid = false;
			computeOffsets();
			return;
		}
		if (opts.validate) {
			valid = opts.validate(from, over);
		} else {
			const defn = opts.getDefinition?.();
			if (!defn) {
				valid = false;
			} else {
				try {
					moveColumn(defn, from, over);
					valid = true;
				} catch {
					valid = false;
				}
			}
		}
		computeOffsets();
	}

	/** Any scroll anywhere while a drag is live (wheel over the list, a
	 * keyboard scroll, the auto-scroll below): the slots moved under a pointer
	 * that did not, so re-measure and re-hit-test at the last known position. */
	function onAnyScroll(): void {
		if (from === null || !geometryUsable()) return;
		captureSlots();
		track(last.x, last.y);
	}

	function stopAutoScroll(): void {
		scrollVelocity = 0;
		if (scrollFrame !== null) {
			cancelAnimationFrame(scrollFrame);
			scrollFrame = null;
		}
	}

	function autoScrollStep(): void {
		scrollFrame = null;
		if (!scrollParent || scrollVelocity === 0 || from === null) return;
		const before = axis === 'x' ? scrollParent.scrollLeft : scrollParent.scrollTop;
		if (axis === 'x') scrollParent.scrollLeft = before + scrollVelocity;
		else scrollParent.scrollTop = before + scrollVelocity;
		const after = axis === 'x' ? scrollParent.scrollLeft : scrollParent.scrollTop;
		if (after === before) return; // hit the end: stop until the pointer moves
		// The scroll event re-hit-tests asynchronously; do it now too so the
		// preview never lags a frame behind the scrolling list.
		onAnyScroll();
		scrollFrame = requestAnimationFrame(autoScrollStep);
	}

	/** Start/stop the edge auto-scroll for the pointer at (`x`, `y`). */
	function updateAutoScroll(x: number, y: number): void {
		if (!scrollParent) return;
		const r = scrollParent.getBoundingClientRect();
		const v =
			axis === 'x'
				? edgeScrollVelocity(x, r.left, r.right)
				: edgeScrollVelocity(y, r.top, r.bottom);
		scrollVelocity = v;
		if (v === 0) {
			stopAutoScroll();
		} else if (scrollFrame === null) {
			scrollFrame = requestAnimationFrame(autoScrollStep);
		}
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
				scrollParent = geometryUsable() ? scrollParentOf(armed.source, axis) : null;
				window.addEventListener('scroll', onAnyScroll, true);
				listening = true;
			}
			last = { x: e.clientX, y: e.clientY };
			ghost = { x: e.clientX - grab.dx, y: e.clientY - grab.dy, w: grab.w, h: grab.h };
			track(e.clientX, e.clientY);
			updateAutoScroll(e.clientX, e.clientY);
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
