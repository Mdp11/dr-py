import { describe, expect, it } from 'vitest';
import {
	emptyPath,
	emptyCombine,
	insertNavigation,
	insertNavigationEdit,
	insertRef,
	insertRefEdit,
	moveOperand,
	moveOperandEdit,
	nodeAt,
	pathKey,
	removeOperand,
	removeOperandEdit,
	updateNodeAt,
	wrapRoot
} from '../tree';
import type { PathNavigation, SetExpression } from '$lib/api/types';

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
