/**
 * Pure helpers over a NavigationDefinition tree: positional node addressing,
 * immutable updates, composition mutators (auto-wrap / auto-unwrap / N-ary
 * insert / reorder), and auto-derived node labels. No Svelte, no I/O — fully
 * unit-testable. Node addresses are POSITIONAL (NodePath): a number descends
 * into operands[i].definition, 'start' descends into a Path's start.
 */
import type {
	NavOperand,
	NavigationDefinition,
	NavScope,
	PathNavigation,
	SetExpression
} from '$lib/api/types';

export type NodePath = ReadonlyArray<number | 'start'>;

export function pathKey(path: NodePath): string {
	return path.join('.');
}

export function emptyPath(): PathNavigation {
	return {
		kind: 'path',
		schema_version: 2,
		start: { kind: 'scope', types: [], criteria: [] },
		steps: [],
		exclude_visited: true
	};
}

export function emptyCombine(): SetExpression {
	return {
		kind: 'set_op',
		schema_version: 2,
		op: 'union',
		operands: [
			{ definition: emptyPath(), step_index: null },
			{ definition: emptyPath(), step_index: null }
		]
	};
}

/** Descend a positional path. Returns the addressed sub-definition, or null
 * for a ref operand / out-of-range / a scope start (not a node). */
export function nodeAt(root: NavigationDefinition, path: NodePath): NavigationDefinition | null {
	let node: NavigationDefinition | null = root;
	for (const seg of path) {
		if (node === null) return null;
		if (seg === 'start') {
			if (node.kind !== 'path') return null;
			node = node.start.kind === 'set_op' ? (node.start as SetExpression) : null;
		} else {
			if (node.kind !== 'set_op') return null;
			node = node.operands[seg]?.definition ?? null;
		}
	}
	return node;
}

/** Immutable update: rebuild spread-copies along `path`, applying `fn` at the
 * addressed node. Unknown/invalid paths return `root` unchanged. */
export function updateNodeAt(
	root: NavigationDefinition,
	path: NodePath,
	fn: (n: NavigationDefinition) => NavigationDefinition
): NavigationDefinition {
	if (path.length === 0) return fn(root);
	const [seg, ...rest] = path;
	if (seg === 'start') {
		if (root.kind !== 'path' || root.start.kind !== 'set_op') return root;
		return { ...root, start: updateNodeAt(root.start, rest, fn) as SetExpression };
	}
	if (root.kind !== 'set_op') return root;
	const child = root.operands[seg]?.definition;
	if (!child) return root;
	const operands = root.operands.map((op, i): NavOperand =>
		i === seg ? { ...op, definition: updateNodeAt(child, rest, fn) } : op
	);
	return { ...root, operands };
}

/** Wrap a definition into a 2-operand union with a fresh empty second operand. */
export function wrapRoot(defn: NavigationDefinition): SetExpression {
	return {
		kind: 'set_op',
		schema_version: 2,
		op: 'union',
		operands: [
			{ definition: defn, step_index: null },
			{ definition: emptyPath(), step_index: null }
		]
	};
}

/** A combine node reduced to one operand collapses to that operand's child
 * (or ref → left as a 1-operand set, since a bare ref is not a definition). */
function unwrapSingleton(node: SetExpression): NavigationDefinition {
	if (node.operands.length === 1 && node.operands[0].definition) {
		return node.operands[0].definition;
	}
	return node;
}

/** Insert an empty Path operand at `path`. On a bare-Path node, auto-wrap. */
export function insertNavigation(root: NavigationDefinition, path: NodePath): NavigationDefinition {
	return updateNodeAt(root, path, (n) => {
		if (n.kind === 'path') return wrapRoot(n);
		return { ...n, operands: [...n.operands, { definition: emptyPath(), step_index: null }] };
	});
}

/** Insert an empty Combine group operand at `path` (auto-wrap on a bare Path). */
export function insertGroup(root: NavigationDefinition, path: NodePath): NavigationDefinition {
	return updateNodeAt(root, path, (n) => {
		if (n.kind === 'path') {
			return {
				...wrapRoot(n),
				operands: [
					{ definition: n, step_index: null },
					{ definition: emptyCombine(), step_index: null }
				]
			};
		}
		return { ...n, operands: [...n.operands, { definition: emptyCombine(), step_index: null }] };
	});
}

/** Add a ref operand at `path` (auto-wrap on a bare Path). */
export function insertRef(root: NavigationDefinition, path: NodePath, ref: string): NavigationDefinition {
	return updateNodeAt(root, path, (n) => {
		if (n.kind === 'path') {
			return {
				...wrapRoot(n),
				operands: [
					{ definition: n, step_index: null },
					{ ref, step_index: null }
				]
			};
		}
		return { ...n, operands: [...n.operands, { ref, step_index: null }] };
	});
}

/** Remove operand `i` from the combine at `path`; auto-unwrap to one child. */
export function removeOperand(root: NavigationDefinition, path: NodePath, i: number): NavigationDefinition {
	return updateNodeAt(root, path, (n) => {
		if (n.kind !== 'set_op') return n;
		const operands = n.operands.filter((_, idx) => idx !== i);
		return unwrapSingleton({ ...n, operands });
	});
}

/** Move operand `i` up/down within the combine at `path`. */
export function moveOperand(
	root: NavigationDefinition,
	path: NodePath,
	i: number,
	dir: 'up' | 'down'
): NavigationDefinition {
	return updateNodeAt(root, path, (n) => {
		if (n.kind !== 'set_op') return n;
		const j = dir === 'up' ? i - 1 : i + 1;
		if (j < 0 || j >= n.operands.length) return n;
		const operands = [...n.operands];
		[operands[i], operands[j]] = [operands[j], operands[i]];
		return { ...n, operands };
	});
}

const OP_GLYPH: Record<SetExpression['op'], string> = {
	union: '∪',
	intersection: '∩',
	difference: '−',
	symmetric_difference: '⊕'
};

/** Auto-derived collapsed-node summary (no schema field). */
export function nodeLabel(defn: NavigationDefinition): string {
	if (defn.kind === 'set_op') return `${OP_GLYPH[defn.op]} of ${defn.operands.length}`;
	const startTypes = defn.start.kind === 'scope' ? defn.start.types : [];
	const head =
		defn.start.kind === 'set_op'
			? '(combination)'
			: startTypes.length
				? startTypes.join('/')
				: 'Any';
	const hops = defn.steps
		.filter((s): s is Extract<typeof s, { kind: 'relationship' }> => s.kind === 'relationship')
		.map((s) => s.relationship_type || '?');
	return [head, ...hops].join(' → ');
}

/** Label for one operand (ref → its saved name resolved by the caller). */
export function operandLabel(op: NavOperand, refName?: string): string {
	if (op.ref) return `(ref) ${refName ?? op.ref}`;
	return op.definition ? nodeLabel(op.definition) : '(empty)';
}

/** True when a definition is complete enough to evaluate. A set-op needs ≥1
 * operand; a path needs every relationship step to have a relationship_type and
 * must not be a pristine empty draft. */
export function isRunnable(defn: NavigationDefinition): boolean {
	if (defn.kind === 'set_op') return defn.operands.length > 0;
	if (defn.steps.some((s) => s.kind === 'relationship' && !s.relationship_type)) return false;
	const { start } = defn;
	const pristine =
		start.kind === 'scope' && start.types.length === 0 && start.criteria.length === 0;
	return !(pristine && defn.steps.length === 0);
}

/** A Scope selecting exactly one element by id (Specific-element start). */
export function elementStartScope(elementId: string): NavScope {
	return {
		kind: 'scope',
		types: [],
		criteria: [{ type: 'name_id', field: 'id', op: 'equals', value: elementId }]
	};
}

/** If `scope` is an element-start (empty types + one id-equals criterion),
 * return the element id; else null (→ the editor shows Filter mode). */
export function readElementStart(scope: NavScope): string | null {
	if (scope.types.length !== 0 || scope.criteria.length !== 1) return null;
	const c = scope.criteria[0] as { type?: string; field?: string; op?: string; value?: string };
	return c.type === 'name_id' && c.field === 'id' && c.op === 'equals' ? (c.value ?? '') : null;
}

/**
 * Types flowing into `steps[index]` — the nearest PRECEDING relationship
 * step's `target_types`, scanning `steps[0..index-1]` backward; if no
 * relationship step precedes it, the path's own start types (`[]` for a
 * combine start or an element-start scope, meaning "any type"). Shared by a
 * relationship step's rel-type/target-type pickers (types flowing IN) and a
 * filter step's property-picker scope (types already REACHED at that point —
 * the same set, since a filter step never changes the frontier's type).
 */
export function precedingTargetTypes(node: PathNavigation, index: number): string[] {
	for (let i = index - 1; i >= 0; i--) {
		const step = node.steps[i];
		if (step.kind === 'relationship') return step.target_types;
	}
	return node.start.kind === 'scope' ? node.start.types : [];
}
