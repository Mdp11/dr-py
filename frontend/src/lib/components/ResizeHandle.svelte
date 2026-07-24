<script lang="ts">
	type Props = {
		/** Current size in px (width for axis 'x', height for axis 'y'). */
		value: number;
		/** Axis to resize along. 'x' = column width, 'y' = row height. */
		axis?: 'x' | 'y';
		/** Which side of the handle grows on drag.
		 *  axis 'x': 'left' grows on drag-right, 'right' grows on drag-left.
		 *  axis 'y': 'top' grows on drag-DOWN (the handle sits under the panel it
		 *  sizes), 'bottom' grows on drag-UP (the handle sits above it).
		 *
		 *  The default is 'left', which for axis 'y' falls through to the
		 *  drag-up-grows branch — deliberate, and load-bearing: the two
		 *  pre-existing axis='y' call sites (the workspace results panel and
		 *  NavigationBuilder's results dock) pass no `side` and must keep their
		 *  current behaviour. Do not "tidy" this into separate defaults per axis. */
		side?: 'left' | 'right' | 'top' | 'bottom';
		min?: number;
		max?: number;
		/** Accessible name for the separator. */
		label?: string;
		onchange: (next: number) => void;
	};

	let {
		value,
		axis = 'x',
		side = 'left',
		min = 160,
		max = 720,
		label,
		onchange
	}: Props = $props();

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
		const signed =
			axis === 'y' ? (side === 'top' ? delta : -delta) : side === 'left' ? delta : -delta;
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
	aria-label={label}
	tabindex="-1"
	class="group relative select-none bg-border hover:bg-primary/50"
	class:h-full={axis === 'x'}
	class:w-1={axis === 'x'}
	class:cursor-col-resize={axis === 'x'}
	class:w-full={axis === 'y'}
	class:h-1={axis === 'y'}
	class:cursor-row-resize={axis === 'y'}
	class:bg-primary={dragging}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
></div>
