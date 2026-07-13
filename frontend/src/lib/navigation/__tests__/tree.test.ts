import { describe, expect, it } from 'vitest';
import {
	chainColumns,
	containsRowStart,
	elementStartScope,
	emptyPath,
	emptyRowPath,
	emptyCombine,
	insertNavigation,
	insertNavigationEdit,
	insertRef,
	insertRefEdit,
	isRunnable,
	moveOperand,
	moveOperandEdit,
	nodeAt,
	nodeEntries,
	nodeExistsAt,
	nodeLabel,
	OP_DIVIDER,
	pathKey,
	removeOperand,
	removeOperandEdit,
	setOperandStepIndex,
	titleForPath,
	updateNodeAt,
	wrapRoot,
	type ChainColumn
} from '../tree';
import type { NavigationDefinition, PathNavigation, SetExpression } from '$lib/api/types';

describe('node addressing', () => {
	it('pathKey stringifies positional paths', () => {
		expect(pathKey([])).toBe('');
		expect(pathKey([1, 'start', 0])).toBe('1.start.0');
	});

	it('nodeAt descends operands', () => {
		const inner = emptyPath();
		const root: SetExpression = {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [{ definition: inner, step_index: null }]
		};
		expect(nodeAt(root, [])).toBe(root);
		expect(nodeAt(root, [0])).toEqual(inner);
	});

	it('nodeAt descends into a start segment when the Path start is a set_op', () => {
		const combine = emptyCombine();
		const rootPath: PathNavigation = {
			kind: 'path',
			schema_version: 2,
			start: combine,
			steps: [],
			exclude_visited: true
		};
		expect(nodeAt(rootPath, ['start'])).toEqual(combine);
	});

	it('nodeAt returns null for a start segment when the Path start is a scope', () => {
		const p = emptyPath(); // start is a plain scope, not a node
		expect(nodeAt(p, ['start'])).toBeNull();
	});

	it('updateNodeAt rebuilds immutably through a start segment', () => {
		const combine = emptyCombine();
		const rootPath: PathNavigation = {
			kind: 'path',
			schema_version: 2,
			start: combine,
			steps: [],
			exclude_visited: true
		};
		const next = updateNodeAt(rootPath, ['start'], (n) => ({
			...(n as SetExpression),
			op: 'intersection'
		})) as PathNavigation;
		expect((next.start as SetExpression).op).toBe('intersection');
		expect((rootPath.start as SetExpression).op).toBe('union'); // original untouched
	});
});

describe('composition mutators', () => {
	it('wrapRoot turns a bare path into a 2-operand union', () => {
		const p = emptyPath();
		const wrapped = wrapRoot(p) as SetExpression;
		expect(wrapped.kind).toBe('set_op');
		expect(wrapped.op).toBe('union');
		expect(wrapped.operands).toHaveLength(2);
		expect(wrapped.operands[0].definition).toEqual(p);
	});

	it('insertNavigation on a bare-path root auto-wraps', () => {
		const next = insertNavigation(emptyPath(), []) as SetExpression;
		expect(next.kind).toBe('set_op');
		expect(next.operands).toHaveLength(2);
	});

	it('insertNavigation on a combine appends an operand (N-ary)', () => {
		const c = emptyCombine();
		const next = insertNavigation(c, []) as SetExpression;
		expect(next.operands).toHaveLength(c.operands.length + 1);
	});

	it('removeOperand down to one auto-unwraps to the child', () => {
		const c = emptyCombine(); // 2 operands
		const next = removeOperand(c, [], 1);
		expect(next.kind).toBe('path'); // unwrapped
	});

	it('moveOperand reorders within a combine', () => {
		const c = emptyCombine();
		c.operands[0].step_index = 7;
		const next = moveOperand(c, [], 0, 'down') as SetExpression;
		expect(next.operands[1].step_index).toBe(7);
	});

	it('updateNodeAt rebuilds immutably along the path', () => {
		const c = emptyCombine();
		const next = updateNodeAt(c, [0], (n) => ({
			...(n as PathNavigation),
			exclude_visited: false
		}));
		expect((next as SetExpression).operands[0].definition).not.toBe(c.operands[0].definition);
		expect(c).toEqual(emptyCombine()); // original untouched
	});

	it('insertRef on a bare-Path root auto-wraps into a 2-operand set_op with a ref operand', () => {
		const next = insertRef(emptyPath(), [], 'nav-xyz') as SetExpression;
		expect(next.kind).toBe('set_op');
		expect(next.operands).toHaveLength(2);
		expect(next.operands[1].ref).toBe('nav-xyz');
	});

	it('insertRef on a combine appends a ref operand', () => {
		const c = emptyCombine();
		const originalLength = c.operands.length;
		const next = insertRef(c, [], 'nav-xyz') as SetExpression;
		expect(next.operands).toHaveLength(originalLength + 1);
		expect(next.operands[next.operands.length - 1].ref).toBe('nav-xyz');
	});
});

describe('structural edits (mutator + path remap)', () => {
	/** A 3-operand union for shift/swap tests. */
	function combine3(): SetExpression {
		return {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [
				{ definition: emptyPath(), step_index: null },
				{ definition: emptyPath(), step_index: null },
				{ definition: emptyPath(), step_index: null }
			]
		};
	}

	it('insertNavigationEdit on a bare path remaps the wrapped node to operand 0', () => {
		const { defn, remapPath } = insertNavigationEdit(emptyPath(), []);
		expect(defn.kind).toBe('set_op');
		expect(remapPath([])).toEqual([0]);
		expect(remapPath(['start'])).toEqual([0, 'start']);
	});

	it('insertNavigationEdit on a combine is an identity remap (append)', () => {
		const { defn, remapPath } = insertNavigationEdit(emptyCombine(), []);
		expect((defn as SetExpression).operands).toHaveLength(3);
		expect(remapPath([1])).toEqual([1]);
		expect(remapPath([])).toEqual([]);
	});

	it('insertRefEdit auto-wrap remaps like insertNavigationEdit', () => {
		const { remapPath } = insertRefEdit(emptyPath(), [], 'nav-1');
		expect(remapPath([])).toEqual([0]);
	});

	it('removeOperandEdit shifts later siblings down and drops the removed subtree', () => {
		const { defn, remapPath } = removeOperandEdit(combine3(), [], 0);
		expect((defn as SetExpression).operands).toHaveLength(2);
		expect(remapPath([0])).toBeNull();
		expect(remapPath([0, 'start'])).toBeNull();
		expect(remapPath([1])).toEqual([0]);
		expect(remapPath([2])).toEqual([1]);
		expect(remapPath([2, 'start', 0])).toEqual([1, 'start', 0]);
		expect(remapPath([])).toEqual([]);
	});

	it('removeOperandEdit lifts the lone survivor’s subtree on unwrap', () => {
		const { defn, remapPath } = removeOperandEdit(emptyCombine(), [], 0);
		expect(defn.kind).toBe('path'); // unwrapped
		expect(remapPath([1])).toEqual([]);
		expect(remapPath([1, 'start'])).toEqual(['start']);
		expect(remapPath([0])).toBeNull();
	});

	it('removeOperandEdit does NOT lift when the survivor is a ref (1-op set stays)', () => {
		const c: SetExpression = {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [
				{ definition: emptyPath(), step_index: null },
				{ ref: 'nav-1', step_index: null }
			]
		};
		const { defn, remapPath } = removeOperandEdit(c, [], 0);
		expect(defn.kind).toBe('set_op');
		expect(remapPath([1])).toEqual([0]);
	});

	it('moveOperandEdit swaps the two positions and everything under them', () => {
		const { defn, remapPath } = moveOperandEdit(combine3(), [], 0, 'down');
		expect(defn.kind).toBe('set_op');
		expect(remapPath([0])).toEqual([1]);
		expect(remapPath([1])).toEqual([0]);
		expect(remapPath([2])).toEqual([2]);
		expect(remapPath([0, 'start'])).toEqual([1, 'start']);
	});

	it('moveOperandEdit out of range is an identity remap', () => {
		const { remapPath } = moveOperandEdit(combine3(), [], 0, 'up');
		expect(remapPath([0])).toEqual([0]);
	});

	it('edits at a NESTED path only remap keys under that path', () => {
		// root combine whose operand 1 is itself a combine — remove ITS operand 0.
		const nested: SetExpression = {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [
				{ definition: emptyPath(), step_index: null },
				{ definition: combine3(), step_index: null }
			]
		};
		const { remapPath } = removeOperandEdit(nested, [1], 0);
		expect(remapPath([0])).toEqual([0]); // sibling branch untouched
		expect(remapPath([1])).toEqual([1]); // the edited combine itself
		expect(remapPath([1, 0])).toBeNull();
		expect(remapPath([1, 2])).toEqual([1, 1]);
	});
});

describe('chainColumns', () => {
	function path(start: PathNavigation['start'], steps: PathNavigation['steps']): PathNavigation {
		return { kind: 'path', schema_version: 2, start, steps, exclude_visited: true };
	}
	const hop = (rt: string, targets: string[] = []) => ({
		kind: 'relationship' as const,
		relationship_type: rt,
		direction: 'out' as const,
		target_types: targets,
		children: []
	});

	it('a bare start scope is a single column labelled Start', () => {
		const cols: ChainColumn[] = chainColumns(path({ kind: 'scope', types: [], criteria: [] }, []));
		expect(cols).toEqual([{ index: 0, label: 'Start', sub: undefined }]);
	});

	it('the start column sub-label lists the start types', () => {
		const cols = chainColumns(path({ kind: 'scope', types: ['B', 'A'], criteria: [] }, []));
		expect(cols[0].sub).toBe('A, B');
	});

	it('an element start sub-labels as "one element"', () => {
		const cols = chainColumns(path(elementStartScope('e1'), []));
		expect(cols[0].sub).toBe('one element');
	});

	it('a combination start sub-labels as "combination"', () => {
		const cols = chainColumns(path(emptyCombine(), []));
		expect(cols[0].sub).toBe('combination');
	});

	it('each relationship step adds one numbered column; filter steps add none', () => {
		const cols = chainColumns(
			path({ kind: 'scope', types: ['SoftwareSystem'], criteria: [] }, [
				hop('SystemContainsComponent', ['Component']),
				{ kind: 'filter', criteria: [] },
				hop('DependsOn')
			])
		);
		expect(cols.map((c) => c.index)).toEqual([0, 1, 2]);
		expect(cols.map((c) => c.label)).toEqual(['Start', 'SystemContainsComponent', 'DependsOn']);
		expect(cols[1].sub).toBe('Component');
		expect(cols[2].sub).toBeUndefined(); // "any type"
	});

	it('an unset relationship type is labelled "unset step"', () => {
		const cols = chainColumns(path({ kind: 'scope', types: [], criteria: [] }, [hop('')]));
		expect(cols[1].label).toBe('unset step');
	});
});

describe('nodeEntries', () => {
	it('a bare root path is a single entry titled "Path"', () => {
		const entries = nodeEntries(emptyPath());
		expect(entries).toEqual([{ path: [], kind: 'path', title: 'Path', depth: 0 }]);
	});

	it('letters paths depth-first and puts the root combination last', () => {
		const root: SetExpression = {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [
				{ definition: emptyPath(), step_index: null },
				{ definition: emptyPath(), step_index: null }
			]
		};
		const entries = nodeEntries(root);
		expect(entries.map((e) => e.title)).toEqual(['Path A', 'Path B', 'Whole combination']);
		expect(entries.map((e) => pathKey(e.path))).toEqual(['0', '1', '']);
		expect(entries.map((e) => e.depth)).toEqual([1, 1, 0]);
	});

	it('nested combinations deepen the entries and are titled "Combination"', () => {
		const root: SetExpression = {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [
				{ definition: emptyPath(), step_index: null },
				{
					definition: {
						kind: 'set_op',
						schema_version: 2,
						op: 'intersection',
						operands: [
							{ definition: emptyPath(), step_index: null },
							{ definition: emptyPath(), step_index: null }
						]
					},
					step_index: null
				}
			]
		};
		const entries = nodeEntries(root);
		expect(entries.map((e) => e.title)).toEqual([
			'Path A',
			'Path B',
			'Path C',
			'Combination',
			'Whole combination'
		]);
		expect(entries.map((e) => pathKey(e.path))).toEqual(['0', '1.0', '1.1', '1', '']);
		expect(entries.find((e) => e.title === 'Path B')?.depth).toBe(2);
	});

	it('a ref operand becomes a ref entry whose title resolves through refName', () => {
		const root: SetExpression = {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [
				{ definition: emptyPath(), step_index: null },
				{ ref: 'nav-1', step_index: null }
			]
		};
		const entries = nodeEntries(root, (id) => (id === 'nav-1' ? 'Sensors network' : undefined));
		expect(entries[1]).toEqual({
			path: [1],
			kind: 'ref',
			title: 'Sensors network',
			depth: 1,
			ref: 'nav-1'
		});
		// unresolved refs fall back to the id
		expect(nodeEntries(root)[1].title).toBe('nav-1');
	});

	it('a combination start is walked through the "start" segment', () => {
		const root: PathNavigation = { ...emptyPath(), start: emptyCombine() };
		const entries = nodeEntries(root);
		expect(entries.map((e) => pathKey(e.path))).toEqual(['start.0', 'start.1', 'start', '']);
	});

	it('lettering continues past Z as AA', () => {
		const operands = Array.from({ length: 27 }, () => ({
			definition: emptyPath(),
			step_index: null
		}));
		const entries = nodeEntries({ kind: 'set_op', schema_version: 2, op: 'union', operands });
		expect(entries[25].title).toBe('Path Z');
		expect(entries[26].title).toBe('Path AA');
	});
});

describe('titleForPath', () => {
	it('returns the entry title for a node path, else an empty string', () => {
		const root: SetExpression = {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [
				{ definition: emptyPath(), step_index: null },
				{ definition: emptyPath(), step_index: null }
			]
		};
		expect(titleForPath(root, [1])).toBe('Path B');
		expect(titleForPath(root, [])).toBe('Whole combination');
		expect(titleForPath(root, [9])).toBe('');
	});
});

describe('nodeExistsAt', () => {
	const root: SetExpression = {
		kind: 'set_op',
		schema_version: 2,
		op: 'union',
		operands: [
			{ definition: emptyPath(), step_index: null },
			{ ref: 'nav-1', step_index: null }
		]
	};

	it('is true for the root and for definition operands', () => {
		expect(nodeExistsAt(root, [])).toBe(true);
		expect(nodeExistsAt(root, [0])).toBe(true);
	});

	it('is true for a REF operand (which nodeAt cannot address)', () => {
		expect(nodeExistsAt(root, [1])).toBe(true);
		expect(nodeAt(root, [1])).toBeNull();
	});

	it('is false past a ref, out of range, or through a scope start', () => {
		expect(nodeExistsAt(root, [1, 0])).toBe(false);
		expect(nodeExistsAt(root, [5])).toBe(false);
		expect(nodeExistsAt(root, [0, 'start'])).toBe(false);
	});
});

describe('setOperandStepIndex', () => {
	const root: SetExpression = {
		kind: 'set_op',
		schema_version: 2,
		op: 'union',
		operands: [
			{ definition: emptyPath(), step_index: null },
			{ definition: emptyPath(), step_index: 2 }
		]
	};

	it('writes null (last step), 0 (start) and k (column k)', () => {
		expect((setOperandStepIndex(root, [], 0, 0) as SetExpression).operands[0].step_index).toBe(0);
		expect((setOperandStepIndex(root, [], 0, 3) as SetExpression).operands[0].step_index).toBe(3);
		expect((setOperandStepIndex(root, [], 1, null) as SetExpression).operands[1].step_index).toBe(
			null
		);
	});

	it('leaves the sibling operands untouched', () => {
		const next = setOperandStepIndex(root, [], 0, 1) as SetExpression;
		expect(next.operands[1].step_index).toBe(2);
	});

	it('is a no-op on a non-set_op parent path', () => {
		expect(setOperandStepIndex(emptyPath(), [], 0, 1)).toEqual(emptyPath());
	});
});

describe('OP_DIVIDER', () => {
	it('carries the glyph + word for every operator', () => {
		expect(OP_DIVIDER.union).toBe('∪ union');
		expect(OP_DIVIDER.intersection).toBe('∩ intersection');
		expect(OP_DIVIDER.difference).toBe('− minus');
		expect(OP_DIVIDER.symmetric_difference).toBe('⊕ symmetric difference');
	});
});

describe('RowStart', () => {
	it('emptyRowPath is a runnable row-rooted path', () => {
		const p = emptyRowPath();
		expect(p.start).toEqual({ kind: 'row' });
		expect(isRunnable(p)).toBe(true); // "the row element itself" is a valid column
		expect(containsRowStart(p)).toBe(true);
	});

	it('containsRowStart finds a row start nested inside a set-op operand', () => {
		const defn: NavigationDefinition = {
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: [
				{ definition: emptyPath(), step_index: null },
				{ definition: emptyRowPath(), step_index: null }
			]
		};
		expect(containsRowStart(defn)).toBe(true);
		expect(containsRowStart(emptyPath())).toBe(false);
	});

	it('chainColumns labels a row start without touching scope fields', () => {
		expect(chainColumns(emptyRowPath())[0]).toEqual({
			index: 0,
			label: 'Start',
			sub: 'row element'
		});
	});

	it('nodeLabel heads a row-rooted path with Row', () => {
		expect(nodeLabel(emptyRowPath())).toBe('Row');
		expect(
			nodeLabel({ ...emptyRowPath(), steps: [{ kind: 'relationship', relationship_type: 'Owns', direction: 'out', target_types: [], children: [] }] })
		).toBe('Row → Owns');
	});
});
