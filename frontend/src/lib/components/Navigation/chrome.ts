import type { NodePath } from '$lib/navigation/tree';

/**
 * The chrome a Combination frame hands to each PART it renders: where the part
 * sits among its siblings (move/remove + the Difference `base` badge) and the
 * `step_index` its feeds chip edits. `null` means the node is not an operand
 * (the root, or a path's combination start), so it gets no toolbar and no chip.
 */
export interface OperandChrome {
	parentPath: NodePath;
	index: number;
	total: number;
	stepIndex: number | null;
	isBase: boolean;
}
