/**
 * `use:portal` — re-parent a node under `document.body` for its lifetime.
 *
 * For `position: fixed` overlays (drag ghosts) rendered by a component that
 * sits inside a transformed or scrolling ancestor: a transform makes that
 * ancestor the containing block of every `fixed` descendant, so the overlay
 * scrolls with the panel and clips to it — exactly what `fixed` was meant to
 * avoid. Moving the node to `<body>` restores viewport coordinates. Svelte
 * keeps managing the node's content wherever it lives; on destroy the node is
 * removed explicitly, since Svelte's own teardown only detaches it from the
 * parent it rendered into.
 */
export function portal(node: HTMLElement): { destroy(): void } {
	document.body.appendChild(node);
	return {
		destroy() {
			node.remove();
		}
	};
}
