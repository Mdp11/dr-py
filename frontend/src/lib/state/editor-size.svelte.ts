/**
 * Editor size preferences, GLOBAL PER KIND: one remembered height shared by
 * every inline snippet editor, one remembered ratio for the standalone
 * snippet tab's editor/console split.
 *
 * Global rather than per-instance because per-instance memory cannot work for
 * the navigation-script-step case: `SnippetSourceEditor`'s `collapseKey` doc
 * comment records that a nav step's key is minted fresh on every dialog open
 * (`navemb:${crypto.randomUUID()}`), so a per-key size would reset every
 * time. Global also means dragging one inline editor resizes every mounted
 * one live, which is the behaviour a shared preference should have.
 *
 * State is seeded EAGERLY at module load rather than lazily on first read:
 * a lazy read that assigns during a component's render pass trips Svelte's
 * `state_unsafe_mutation`.
 */
import {
	clampInlineHeight,
	clampSplitRatio,
	loadInlineHeight,
	loadSplitRatio,
	saveInlineHeight,
	saveSplitRatio
} from '$lib/editor/editor-size';

let _inlineH = $state(loadInlineHeight());
let _splitRatio = $state(loadSplitRatio());

export function getInlineEditorHeight(): number {
	return _inlineH;
}

export function setInlineEditorHeight(px: number): void {
	const next = clampInlineHeight(px);
	if (next === _inlineH) return;
	_inlineH = next;
	saveInlineHeight(next);
}

export function getSnippetSplitRatio(): number {
	return _splitRatio;
}

export function setSnippetSplitRatio(r: number): void {
	const next = clampSplitRatio(r);
	if (next === _splitRatio) return;
	_splitRatio = next;
	saveSplitRatio(next);
}

/** Re-read both values from storage. Test isolation AND test seeding: a test
 * that writes the storage keys before mounting calls this to pick them up,
 * since module state was seeded once at import. */
export function resetEditorSize(): void {
	_inlineH = loadInlineHeight();
	_splitRatio = loadSplitRatio();
}
