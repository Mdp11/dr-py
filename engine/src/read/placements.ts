const NONE: ReadonlySet<string> = new Set();

/** The element ids each loaded view places, as the shell registers them. */
export class ViewPlacements {
	private readonly byView = new Map<string, ReadonlySet<string>>();

	set(viewId: string, elementIds: readonly string[]): void {
		this.byView.set(viewId, new Set(elementIds));
	}

	drop(viewId: string): void {
		this.byView.delete(viewId);
	}

	/** An unknown, empty or absent view places nothing. */
	placed(viewId: string | null | undefined): ReadonlySet<string> {
		if (viewId === null || viewId === undefined || viewId === '') return NONE;
		return this.byView.get(viewId) ?? NONE;
	}
}
