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

/** A fresh path rooted at the caller-supplied row element (RowStart). The
 * embedded column editor's seed — a standalone builder never creates one. */
export function emptyRowPath(): PathNavigation {
	return {
		kind: 'path',
		schema_version: 2,
		start: { kind: 'row' },
		steps: [],
		exclude_visited: true
	};
}

/** True when any path in the tree is row-rooted — such a definition is only
 * evaluable with a row binding (previews skip / hint without one). */
export function containsRowStart(defn: NavigationDefinition): boolean {
	if (defn.kind === 'path') {
		if (defn.start.kind === 'row') return true;
		return defn.start.kind === 'set_op' ? containsRowStart(defn.start) : false;
	}
	return defn.operands.some((op) => (op.definition ? containsRowStart(op.definition) : false));
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
	const operands = root.operands.map(
		(op, i): NavOperand => (i === seg ? { ...op, definition: updateNodeAt(child, rest, fn) } : op)
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
export function insertRef(
	root: NavigationDefinition,
	path: NodePath,
	ref: string
): NavigationDefinition {
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
export function removeOperand(
	root: NavigationDefinition,
	path: NodePath,
	i: number
): NavigationDefinition {
	return updateNodeAt(root, path, (n) => {
		if (n.kind !== 'set_op') return n;
		const operands = n.operands.filter((_, idx) => idx !== i);
		return unwrapSingleton({ ...n, operands });
	});
}

/**
 * A structural mutation bundled with its path translation. The editor keys
 * per-node UI state (expansion, previews) by POSITIONAL NodePath; a mutation
 * that MOVES nodes (auto-wrap, operand removal/reorder) would silently orphan
 * that state — an expanded operand would stop auto-running because its key
 * still points at the old position. `remapPath` maps every pre-edit node path
 * to its post-edit location (null = the node was removed) so the store can
 * carry expansion along with the node (see `applyStructuralEdit`).
 */
export interface StructuralEdit {
	defn: NavigationDefinition;
	remapPath: (p: NodePath) => NodePath | null;
}

const identityRemap = (p: NodePath): NodePath => p;

function isPathPrefix(prefix: NodePath, p: NodePath): boolean {
	return p.length >= prefix.length && prefix.every((seg, i) => p[i] === seg);
}

/** Auto-wrap at `at`: the node formerly AT `at` becomes operand 0 there. */
function wrapRemap(at: NodePath): (p: NodePath) => NodePath {
	return (p) => (isPathPrefix(at, p) ? [...at, 0, ...p.slice(at.length)] : p);
}

export function insertNavigationEdit(root: NavigationDefinition, path: NodePath): StructuralEdit {
	const target = nodeAt(root, path);
	const defn = insertNavigation(root, path);
	// A bare Path auto-wraps (the node moves to operand 0); a set_op appends
	// (no node moves).
	return { defn, remapPath: target?.kind === 'path' ? wrapRemap(path) : identityRemap };
}

export function insertGroupEdit(root: NavigationDefinition, path: NodePath): StructuralEdit {
	const target = nodeAt(root, path);
	const defn = insertGroup(root, path);
	return { defn, remapPath: target?.kind === 'path' ? wrapRemap(path) : identityRemap };
}

export function insertRefEdit(
	root: NavigationDefinition,
	path: NodePath,
	ref: string
): StructuralEdit {
	const target = nodeAt(root, path);
	const defn = insertRef(root, path, ref);
	return { defn, remapPath: target?.kind === 'path' ? wrapRemap(path) : identityRemap };
}

export function removeOperandEdit(
	root: NavigationDefinition,
	path: NodePath,
	i: number
): StructuralEdit {
	const target = nodeAt(root, path);
	const defn = removeOperand(root, path, i);
	if (target?.kind !== 'set_op') return { defn, remapPath: identityRemap };
	const survivors = target.operands.filter((_, idx) => idx !== i);
	// unwrapSingleton lifted the lone surviving DEFINITION operand into `path`
	// itself (a lone ref stays as a 1-operand set — a bare ref is not a node).
	const unwrapped = survivors.length === 1 && survivors[0].definition !== undefined;
	return {
		defn,
		remapPath: (p) => {
			if (!isPathPrefix(path, p) || p.length === path.length) return p;
			const seg = p[path.length];
			if (typeof seg !== 'number') return p; // set_op children are indexed
			if (seg === i) return null; // the removed subtree
			const rest = p.slice(path.length + 1);
			if (unwrapped) return [...path, ...rest]; // survivor lifted into `path`
			return [...path, seg > i ? seg - 1 : seg, ...rest];
		}
	};
}

export function moveOperandEdit(
	root: NavigationDefinition,
	path: NodePath,
	i: number,
	dir: 'up' | 'down'
): StructuralEdit {
	const target = nodeAt(root, path);
	const defn = moveOperand(root, path, i, dir);
	const j = dir === 'up' ? i - 1 : i + 1;
	if (target?.kind !== 'set_op' || j < 0 || j >= target.operands.length) {
		return { defn, remapPath: identityRemap };
	}
	return {
		defn,
		remapPath: (p) => {
			if (!isPathPrefix(path, p) || p.length === path.length) return p;
			const seg = p[path.length];
			const rest = p.slice(path.length + 1);
			if (seg === i) return [...path, j, ...rest];
			if (seg === j) return [...path, i, ...rest];
			return p;
		}
	};
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
			: defn.start.kind === 'row'
				? 'Row'
				: startTypes.length
					? startTypes.join('/')
					: 'Any';
	const hops = defn.steps
		.filter((s) => s.kind !== 'filter')
		.map((s) =>
			s.kind === 'relationship'
				? s.relationship_type || '?'
				: s.kind === 'script'
					? s.comment || 'script'
					: `.${s.property_name || '?'}`
		);
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
	if (
		defn.steps.some(
			(s) =>
				(s.kind === 'relationship' && !s.relationship_type) ||
				(s.kind === 'property' && !s.property_name)
		)
	)
		return false;
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
 * the same set, since a filter step never changes the frontier's type). A
 * property step also stops the scan short with `[]`: this pure helper has no
 * metamodel to resolve the property's target type with (`frontierTypesAt` is
 * the precise, metamodel-aware version).
 */
export function precedingTargetTypes(node: PathNavigation, index: number): string[] {
	for (let i = index - 1; i >= 0; i--) {
		const step = node.steps[i];
		if (step.kind === 'property') return []; // metamodel-free fallback: "any type" (frontierTypesAt is the precise version)
		if (step.kind === 'relationship') return step.target_types;
	}
	return node.start.kind === 'scope' ? node.start.types : [];
}

/** Plain-language operator labels for the combination frame's `<select>`. */
export const OP_LABEL: Record<SetExpression['op'], string> = {
	union: 'Union — keeps elements found in ANY part',
	intersection: 'Intersection — keeps elements found in EVERY part',
	difference: 'Difference — first part minus all the others',
	symmetric_difference: 'Symmetric difference — in exactly one part'
};

/** Glyph + word shown on the dashed divider between consecutive parts. */
export const OP_DIVIDER: Record<SetExpression['op'], string> = {
	union: '∪ union',
	intersection: '∩ intersection',
	difference: '− minus',
	symmetric_difference: '⊕ symmetric difference'
};

/** The dock's muted note under a combination node's single column header. */
export const OP_NOTE: Record<SetExpression['op'], string> = {
	union: "(union of the parts' fed steps)",
	intersection: "(intersection of the parts' fed steps)",
	difference: "(first part's fed step minus the others)",
	symmetric_difference: "(in exactly one of the parts' fed steps)"
};

/**
 * One numbered column of the CHAINS a path evaluates to. Column 0 is the
 * start; each RELATIONSHIP or PROPERTY step adds one column; filter steps add
 * none (they narrow the frontier, they don't advance it). This is the single
 * source of truth for the three places the circled-number badge appears: the
 * editor rail, the results-table headers, and the `→ feeds` popover.
 */
export interface ChainColumn {
	index: number;
	/** 'Start' for column 0; the relationship type for a hop. */
	label: string;
	/** Start types / 'one element' / 'combination' for column 0; the hop's
	 * target types otherwise. Undefined means "any type" (nothing to show). */
	sub?: string;
}

export function chainColumns(node: PathNavigation): ChainColumn[] {
	const { start } = node;
	let sub: string | undefined;
	if (start.kind === 'set_op') sub = 'combination';
	else if (start.kind === 'row') sub = 'row element';
	else if (readElementStart(start) !== null) sub = 'one element';
	else if (start.types.length > 0) sub = [...start.types].sort().join(', ');
	const cols: ChainColumn[] = [{ index: 0, label: 'Start', sub }];
	for (const step of node.steps) {
		if (step.kind === 'filter') continue;
		if (step.kind === 'relationship') {
			cols.push({
				index: cols.length,
				label: step.relationship_type || 'unset step',
				sub: step.target_types.length > 0 ? [...step.target_types].sort().join(', ') : undefined
			});
		} else if (step.kind === 'script') {
			// A script hop advances the chain exactly like a relationship or
			// property hop; there is no target type to show.
			cols.push({ index: cols.length, label: step.comment || 'script', sub: 'script' });
		} else {
			// A property hop advances the chain exactly like a relationship hop.
			// `sub: 'property'` (not a type list): the pure helper has no
			// metamodel to resolve the datatype with.
			cols.push({ index: cols.length, label: step.property_name || 'unset step', sub: 'property' });
		}
	}
	return cols;
}

/** Spreadsheet lettering: 0 -> A … 25 -> Z, 26 -> AA. */
function pathLetter(i: number): string {
	let n = i;
	let out = '';
	do {
		out = String.fromCharCode(65 + (n % 26)) + out;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return out;
}

/**
 * One selectable node of the definition tree, depth-first. Paths are lettered
 * `Path A`, `Path B`, … in visit order (a lone root path is just `Path`); a
 * set_op is emitted AFTER its children (`Whole combination` at the root,
 * `Combination` when nested) so the dock picker reads exactly like the mock;
 * ref operands are emitted in place (they carry no definition, so `nodeAt`
 * cannot address them — that's what `kind: 'ref'` is for).
 *
 * A path's user-chosen `name` overrides its automatic letter, but the letter
 * counter still advances past it — renaming Path A must not shift every later
 * sibling's letter (Path B stays Path B).
 */
export interface NodeEntry {
	path: NodePath;
	kind: 'path' | 'set_op' | 'ref';
	title: string;
	depth: number;
	ref?: string;
}

export function nodeEntries(
	root: NavigationDefinition,
	refName?: (id: string) => string | undefined
): NodeEntry[] {
	const entries: NodeEntry[] = [];
	const lettered = root.kind === 'set_op' || root.start.kind === 'set_op';
	let letter = 0;

	function visit(node: NavigationDefinition, path: NodePath, depth: number): void {
		if (node.kind === 'path') {
			if (node.start.kind === 'set_op') visit(node.start, [...path, 'start'], depth + 1);
			const auto = lettered ? `Path ${pathLetter(letter++)}` : 'Path';
			entries.push({
				path,
				kind: 'path',
				title: node.name?.trim() ? node.name.trim() : auto,
				depth
			});
			return;
		}
		node.operands.forEach((op, i) => {
			const childPath = [...path, i];
			if (op.definition) visit(op.definition, childPath, depth + 1);
			else if (op.ref)
				entries.push({
					path: childPath,
					kind: 'ref',
					title: refName?.(op.ref) ?? op.ref,
					depth: depth + 1,
					ref: op.ref
				});
		});
		entries.push({
			path,
			kind: 'set_op',
			title: path.length === 0 ? 'Whole combination' : 'Combination',
			depth
		});
	}

	visit(root, [], 0);
	return entries;
}

/** The `nodeEntries` title of the node at `path` (`''` when it has none). */
export function titleForPath(
	root: NavigationDefinition,
	path: NodePath,
	refName?: (id: string) => string | undefined
): string {
	const key = pathKey(path);
	return nodeEntries(root, refName).find((e) => pathKey(e.path) === key)?.title ?? '';
}

/**
 * True when `path` addresses something that EXISTS in the tree — a definition
 * node (like `nodeAt`) or a REF operand (which `nodeAt` reports as null
 * because it has no definition to return). Selection may land on a ref, so it
 * needs this laxer existence check, not `nodeAt(...) !== null`.
 */
export function nodeExistsAt(root: NavigationDefinition, path: NodePath): boolean {
	let node: NavigationDefinition = root;
	for (let i = 0; i < path.length; i++) {
		const seg = path[i];
		if (seg === 'start') {
			if (node.kind !== 'path' || node.start.kind !== 'set_op') return false;
			node = node.start;
			continue;
		}
		if (node.kind !== 'set_op') return false;
		const op = node.operands[seg];
		if (!op) return false;
		if (!op.definition) return op.ref !== undefined && i === path.length - 1; // a ref is a leaf
		node = op.definition;
	}
	return true;
}

/** Set operand `i`'s `step_index` on the combine at `parentPath` (null = the
 * path's last step; 0 = its start; k = chain column k). Field edit — moves no
 * nodes, so callers route it through `updateDefinition`, not
 * `applyStructuralEdit`. */
export function setOperandStepIndex(
	root: NavigationDefinition,
	parentPath: NodePath,
	i: number,
	stepIndex: number | null
): NavigationDefinition {
	return updateNodeAt(root, parentPath, (n) => {
		if (n.kind !== 'set_op') return n;
		const operands = n.operands.map(
			(op, idx): NavOperand => (idx === i ? { ...op, step_index: stepIndex } : op)
		);
		return { ...n, operands };
	});
}
