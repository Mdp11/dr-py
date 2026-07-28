/**
 * Pickable chain steps for every "which step of this navigation" field in the
 * table editor (`RowSource.step_index`, `NavigationColumn.step_index`,
 * `RowSlot.chain_index`, `ColumnRef.step_index`).
 *
 * The numbering is NOT invented here: it is `chainColumns`' — the same one the
 * editor rail, the results headers and the `→ feeds` popover badge (column 0
 * is the start; each relationship/property/script hop adds one; filter steps
 * add none). So "step 2" in a table editor is the step badged 2 in the
 * navigation editor, and the option labels say which step that is by name.
 */
import { chainColumns } from '$lib/navigation/tree';
import type { NavigationDefinition } from '$lib/api/types';

export interface ChainStepOption {
	index: number;
	/** Ready-to-render option text, e.g. `1: Contains (Room)`. */
	label: string;
}

/**
 * The step options of `defn`, or null when the definition is UNKNOWN — no
 * navigation picked yet, or a saved ref whose payload hasn't arrived (or
 * failed to). Callers degrade to a free numeric input on null rather than
 * offering an empty list; the backend still 422s an out-of-range index.
 *
 * A set_op definition evaluates to single-element chains, so its only
 * addressable step is 0 (mirrors `navMaxStepIndex` and the backend's
 * `_check_step_index`).
 *
 * The leading digit spells out the badge because a native `<option>` is
 * text-only — never the unicode circled glyphs (⓪①②), which render as tofu in
 * some fonts (see ChainBadge.svelte).
 */
export function chainStepOptions(
	defn: NavigationDefinition | null | undefined
): ChainStepOption[] | null {
	if (!defn) return null;
	if (defn.kind !== 'path') return [{ index: 0, label: '0: Combined elements' }];
	return chainColumns(defn).map((col) => ({
		index: col.index,
		// `sub` repeats the label for a script hop ("script"/"script") — show it
		// once. Otherwise it is the type list / 'property' / 'row element' the
		// rail shows under the badge.
		label:
			col.sub && col.sub !== col.label
				? `${col.index}: ${col.label} (${col.sub})`
				: `${col.index}: ${col.label}`
	}));
}
