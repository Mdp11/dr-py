<script lang="ts">
	type Props = {
		/** Current size in px (width for axis 'x', height for axis 'y'). */
		value: number;
		/** Axis to resize along. 'x' = column width, 'y' = row height. */
		axis?: 'x' | 'y';
		/** For axis 'x': 'left' grows on drag-right, 'right' grows on drag-left.
		 *  Ignored for axis 'y' (drag-up always grows). */
		side?: 'left' | 'right';
		min?: number;
		max?: number;
		onchange: (next: number) => void;
	};

	let { value, axis = 'x', side = 'left', min = 160, max = 720, onchange }: Props = $props();

	let dragging = $state(false);
	let start = 0;
	let startSize = 0;

	function coord(e: PointerEvent): number {
		return axis === 'y' ? e.clientY : e.clientX;
	}

	function onPointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		dragging = true;
		start = coord(e);
		startSize = value;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		e.preventDefault();
	}

	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		const delta = coord(e) - start;
		// axis 'y': drag up (negative delta) grows the panel below.
		const signed = axis === 'y' ? -delta : side === 'left' ? delta : -delta;
		const next = Math.max(min, Math.min(max, startSize + signed));
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
	aria-orientation={axis === 'y' ? 'horizontal' : 'vertical'}
	tabindex="-1"
	class="group relative select-none bg-zinc-800 hover:bg-zinc-700"
	class:h-full={axis === 'x'}
	class:w-1={axis === 'x'}
	class:cursor-col-resize={axis === 'x'}
	class:w-full={axis === 'y'}
	class:h-1={axis === 'y'}
	class:cursor-row-resize={axis === 'y'}
	class:bg-sky-600={dragging}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
></div>
