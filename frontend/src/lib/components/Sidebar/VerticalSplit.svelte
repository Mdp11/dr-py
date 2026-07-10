<script lang="ts">
	import type { Snippet } from 'svelte';
	import { panelHeights, clampRatio } from './split';

	// Controlled split: the parent owns `collapsed`/`ratio` (and their persistence).
	// `ratio` is the fraction of the expandable area given to the TOP panel.
	type Props = {
		collapsed: boolean;
		ratio: number;
		headerH?: number;
		dividerH?: number;
		minPanelH?: number;
		/** In-view tree viewport. */
		top: Snippet;
		/** Pool header bar (collapse toggle + count). Rendered in BOTH states. */
		header: Snippet;
		/** Pool body viewport. Rendered only when expanded. */
		body: Snippet;
	};
	let {
		collapsed = $bindable(),
		ratio = $bindable(),
		headerH = 28,
		dividerH = 6,
		minPanelH = 80,
		top,
		header,
		body
	}: Props = $props();

	let containerEl: HTMLElement | null = $state(null);
	let containerH = $state(0);

	$effect(() => {
		if (!containerEl) return;
		containerH = containerEl.clientHeight;
		const ro = new ResizeObserver(() => {
			if (containerEl) containerH = containerEl.clientHeight;
		});
		ro.observe(containerEl);
		return () => ro.disconnect();
	});

	const heights = $derived(
		panelHeights({ containerH, ratio, collapsed, headerH, dividerH, minPanelH })
	);

	// Plain `let` (not `$state`): internal drag bookkeeping, never read in the
	// template, so no reactivity is needed.
	let dragging = false;

	function onDividerPointerDown(e: PointerEvent): void {
		if (e.button !== 0 || !e.isPrimary) return;
		e.preventDefault();
		dragging = true;
		(e.target as HTMLElement).setPointerCapture(e.pointerId);
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
		// pointercancel (system interruption) must end the drag too, or the divider
		// would stay locked to the pointer — mirrors ContainmentTree's drag teardown.
		window.addEventListener('pointercancel', onPointerUp);
	}
	function onPointerMove(e: PointerEvent): void {
		if (!dragging || containerEl === null) return;
		const rect = containerEl.getBoundingClientRect();
		ratio = clampRatio({
			pointerY: e.clientY - rect.top,
			containerH: rect.height,
			headerH,
			dividerH,
			minPanelH
		});
	}
	function onPointerUp(): void {
		dragging = false;
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
		window.removeEventListener('pointercancel', onPointerUp);
	}
	$effect(() => onPointerUp); // remove window listeners on unmount
</script>

<div bind:this={containerEl} class="flex min-h-0 flex-1 flex-col">
	<div class="min-h-0 overflow-hidden" style="height: {heights.topH}px">
		{@render top()}
	</div>
	{#if !collapsed}
		<div
			class="shrink-0 cursor-row-resize bg-border transition-colors hover:bg-primary/50"
			style="height: {dividerH}px"
			role="separator"
			aria-orientation="horizontal"
			aria-label="Resize tree and excluded panels"
			onpointerdown={onDividerPointerDown}
		></div>
	{/if}
	<div class="shrink-0" style="height: {headerH}px">
		{@render header()}
	</div>
	{#if !collapsed}
		<div class="min-h-0 overflow-hidden" style="height: {heights.bottomH}px">
			{@render body()}
		</div>
	{/if}
</div>
