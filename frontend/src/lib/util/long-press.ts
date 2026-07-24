// Svelte action for a press-and-hold gesture. A primary-button pointer held
// `durationMs` without moving past `moveTolerancePx` fires `onLongPress`, and
// the click that follows the release is suppressed at capture phase
// (preventDefault + stopImmediatePropagation — the latter also defeats
// Svelte's root-delegated onclick handlers) so the node's normal click action
// does not also run. `contextmenu` (right-click / long-press on some touch
// platforms) fires immediately, replacing the native menu.
export type LongPressOptions = {
	onLongPress: () => void;
	durationMs?: number;
	moveTolerancePx?: number;
};

export function longpress(node: HTMLElement, options: LongPressOptions) {
	let opts = options;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let fired = false;
	let startX = 0;
	let startY = 0;

	const cancel = () => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};

	const onPointerDown = (e: PointerEvent) => {
		if (e.button !== 0) return; // primary only; right-click goes via contextmenu
		fired = false;
		startX = e.clientX;
		startY = e.clientY;
		cancel();
		timer = setTimeout(() => {
			timer = null;
			fired = true;
			opts.onLongPress();
		}, opts.durationMs ?? 500);
	};

	const onPointerMove = (e: PointerEvent) => {
		if (timer === null) return;
		const tol = opts.moveTolerancePx ?? 6;
		if (Math.abs(e.clientX - startX) > tol || Math.abs(e.clientY - startY) > tol) cancel();
	};

	const onPointerEnd = () => cancel();

	const onClickCapture = (e: MouseEvent) => {
		if (!fired) return;
		fired = false;
		e.preventDefault();
		e.stopImmediatePropagation();
	};

	const onContextMenu = (e: MouseEvent) => {
		e.preventDefault();
		// On some touch platforms the browser synthesizes `contextmenu` from the
		// very press-and-hold gesture our internal timer is independently timing:
		// the timer fires first (fired = true), the platform then aborts the
		// touch with `pointercancel` and hands the gesture to its own long-press
		// detector, so no `click` ever follows to clear `fired` via
		// onClickCapture. If we called onLongPress again here it would double-fire
		// the same physical gesture, and leaving `fired` stranded true would
		// wrongly suppress a later, unrelated click (e.g. a keyboard-activated
		// Enter/Space click). So a `fired`-true contextmenu is treated as
		// belonging to the gesture the timer already handled: consume it and
		// return without a second onLongPress() call. A genuine desktop
		// right-click never hits this branch — it arrives with `fired` still
		// false since no timer ran.
		if (fired) {
			fired = false;
			return;
		}
		cancel();
		opts.onLongPress();
	};

	node.addEventListener('pointerdown', onPointerDown);
	node.addEventListener('pointermove', onPointerMove);
	node.addEventListener('pointerup', onPointerEnd);
	node.addEventListener('pointerleave', onPointerEnd);
	node.addEventListener('pointercancel', onPointerEnd);
	node.addEventListener('click', onClickCapture, true);
	node.addEventListener('contextmenu', onContextMenu);

	return {
		update(next: LongPressOptions) {
			opts = next;
		},
		destroy() {
			cancel();
			node.removeEventListener('pointerdown', onPointerDown);
			node.removeEventListener('pointermove', onPointerMove);
			node.removeEventListener('pointerup', onPointerEnd);
			node.removeEventListener('pointerleave', onPointerEnd);
			node.removeEventListener('pointercancel', onPointerEnd);
			node.removeEventListener('click', onClickCapture, true);
			node.removeEventListener('contextmenu', onContextMenu);
		}
	};
}
