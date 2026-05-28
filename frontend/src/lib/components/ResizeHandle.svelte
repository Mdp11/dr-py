<script lang="ts">
	type Props = {
		/** Current width in px. */
		value: number;
		/** Drag direction: 'left' = handle on right side of the left pane (drag right = grow);
		 *  'right' = handle on left side of the right pane (drag left = grow). */
		side: 'left' | 'right';
		min?: number;
		max?: number;
		onchange: (next: number) => void;
	};

	let { value, side, min = 160, max = 720, onchange }: Props = $props();

	let dragging = $state(false);
	let startX = 0;
	let startWidth = 0;

	function onPointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		dragging = true;
		startX = e.clientX;
		startWidth = value;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		e.preventDefault();
	}

	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		const delta = e.clientX - startX;
		const signed = side === 'left' ? delta : -delta;
		const next = Math.max(min, Math.min(max, startWidth + signed));
		onchange(next);
	}

	function onPointerUp(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
	}
</script>

<div
	role="separator"
	aria-orientation="vertical"
	tabindex="-1"
	class="group relative h-full w-1 cursor-col-resize select-none bg-zinc-800 hover:bg-zinc-700"
	class:bg-sky-600={dragging}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
></div>
