import { describe, expect, it } from 'vitest';
import {
	addNeighbourhood,
	applyBatch,
	DirtyCollector,
	ISSUES_RESPONSE_MAX,
	IssueStore,
	Metamodel,
	Model,
	storeListBody,
	type Issue,
	type ModelOp,
	type Props,
	type Severity
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { seededRandom, type StepsFixture } from '../golden/model-steps.ts';

function issue(owner: string, message: string, severity: Severity = 'error'): Issue {
	return { severity, message, targetIds: [owner], category: 'conformance', check: 'facets' };
}

const messages = (store: IssueStore) =>
	[...store.iter()].map((i) => `${i.targetIds[0]}:${i.message}`);

/** `ValidationState.counts()`: one walk of the store, severities in the order met. */
function walkedCounts(store: IssueStore): { [severity: string]: number } {
	const out: { [severity: string]: number } = {};
	for (const i of store.iter()) out[i.severity] = (out[i.severity] ?? 0) + 1;
	return out;
}

describe('IssueStore', () => {
	it('drops the dirty owners and files the new issues, a returning owner last', () => {
		const store = new IssueStore();
		store.replace(
			['a', 'b', 'c'],
			[issue('a', '1'), issue('b', '2'), issue('a', '3'), issue('c', '4')]
		);
		expect(messages(store)).toEqual(['a:1', 'a:3', 'b:2', 'c:4']);
		store.replace(['a'], [issue('a', '5')]);
		expect(messages(store)).toEqual(['b:2', 'c:4', 'a:5']);
		// a new owner lands last; an owner with nothing left goes
		store.replace(['d', 'b'], [issue('d', '6')]);
		expect(messages(store)).toEqual(['c:4', 'a:5', 'd:6']);
		expect([...store.owners()]).toEqual(['c', 'a', 'd']);
		expect(store.size).toBe(3);
		expect(store.issuesOf('a').map((i) => i.message)).toEqual(['5']);
		expect(store.issuesOf('b')).toEqual([]);
	});

	it('files owners in the order their first issue comes, whatever the dirty order', () => {
		const store = new IssueStore();
		store.replace(['a', 'b'], [issue('b', '1'), issue('a', '2'), issue('b', '3')]);
		expect(messages(store)).toEqual(['b:1', 'b:3', 'a:2']);
	});

	it('says whether any owner now holds other issues than before', () => {
		const store = new IssueStore();
		expect(store.replace(['a'], [])).toBe(false);
		expect(store.replace(['a', 'b'], [issue('a', '1'), issue('b', '2')])).toBe(true);
		// equal content, fresh objects: nothing moved, though `a` now comes last
		expect(store.replace(['a'], [issue('a', '1')])).toBe(false);
		expect(messages(store)).toEqual(['b:2', 'a:1']);
		expect(store.replace(['a', 'b', 'x'], [issue('b', '2'), issue('a', '1')])).toBe(false);
		expect(store.replace(['a'], [issue('a', '1'), issue('a', '1')])).toBe(true);
		expect(store.replace(['a'], [issue('a', '1')])).toBe(true);
		expect(store.replace(['a'], [issue('a', '1', 'warning')])).toBe(true);
		expect(store.replace(['a'], [{ ...issue('a', '1', 'warning'), check: 'rule:x' }])).toBe(true);
		expect(
			store.replace(
				['a'],
				[{ ...issue('a', '1', 'warning'), check: 'rule:x', targetIds: ['a', 'b'] }]
			)
		).toBe(true);
		expect(store.replace(['b'], [])).toBe(true);
		expect(store.replace(['c'], [issue('c', '3')])).toBe(true);
	});

	it('refuses an issue owned outside the dirty set, before anything moves', () => {
		const store = new IssueStore();
		store.replace(['a'], [issue('a', '1')]);
		expect(() => store.replace(['a'], [issue('b', '2')])).toThrow(/not in the dirty set/);
		expect(messages(store)).toEqual(['a:1']);
		expect(store.counts()).toEqual({ error: 1 });
	});

	it('counts per severity in the order a walk meets them, {} when empty', () => {
		const store = new IssueStore();
		expect(store.counts()).toEqual({});
		store.replace(['a', 'b'], [issue('a', '1', 'warning'), issue('b', '2'), issue('b', '3')]);
		expect(Object.entries(store.counts())).toEqual([
			['warning', 1],
			['error', 2]
		]);
		// `a` goes behind `b`
		store.replace(['a'], [issue('a', '4', 'warning')]);
		expect(Object.entries(store.counts())).toEqual([
			['error', 2],
			['warning', 1]
		]);
		// within one owner, the first issue decides
		store.replace(['b', 'a'], [issue('b', '5', 'warning'), issue('b', '6')]);
		expect(Object.entries(store.counts())).toEqual([
			['warning', 1],
			['error', 1]
		]);
		store.replace(['b'], []);
		expect(store.counts()).toEqual({});
		expect(store.size).toBe(0);
	});

	it('keeps its counts equal to a walk of the store through any churn', () => {
		const random = seededRandom(20260924);
		const owners = ['a', 'b', 'c', 'd', 'e', 'f'];
		const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
		const store = new IssueStore();
		for (let round = 0; round < 500; round++) {
			const dirty = owners.filter(() => random() < 0.4);
			const issues: Issue[] = [];
			const n = Math.floor(random() * 6);
			for (let k = 0; k < n && dirty.length > 0; k++) {
				issues.push(issue(pick(dirty), String(k), random() < 0.5 ? 'error' : 'warning'));
			}
			store.replace(dirty, issues);
			expect(JSON.stringify(store.counts()), `round ${round}`).toBe(
				JSON.stringify(walkedCounts(store))
			);
			expect(store.size).toBe([...store.iter()].length);
		}
	});
});

describe('storeListBody', () => {
	it('is the GET /model/issues body, every origin on_server by default', () => {
		const store = new IssueStore();
		store.replace(['e-1'], [issue('e-1', 'n: 9 above max 5.0')]);
		expect(JSON.stringify(storeListBody(store, 6))).toBe(
			JSON.stringify({
				model_rev: 6,
				issues: [
					{
						severity: 'error',
						message: 'n: 9 above max 5.0',
						target_ids: ['e-1'],
						category: 'conformance',
						check: 'facets',
						origin: 'on_server'
					}
				],
				counts: { error: 1 },
				truncated: false,
				rules_status: { total: 0, skipped: [], eval_errors: {} }
			})
		);
		expect(storeListBody(store, 6, () => 'uncommitted').issues[0]!.origin).toBe('uncommitted');
	});

	it('sends the first issues in store order, and exact counts past the cap', () => {
		const store = new IssueStore();
		const ids = Array.from({ length: ISSUES_RESPONSE_MAX + 1 }, (_, k) => `e-${k}`);
		store.replace(
			ids,
			ids.map((id) => issue(id, 'm'))
		);
		const body = storeListBody(store, 1);
		expect(body.issues).toHaveLength(ISSUES_RESPONSE_MAX);
		expect(body.issues.at(-1)!.target_ids).toEqual([`e-${ISSUES_RESPONSE_MAX - 1}`]);
		expect(body.truncated).toBe(true);
		expect(body.counts).toEqual({ error: ISSUES_RESPONSE_MAX + 1 });
		store.replace(['e-0'], []);
		expect(storeListBody(store, 2).truncated).toBe(false);
	});
});

describe('DirtyCollector', () => {
	it('is an ordered set: an id keeps its first place', () => {
		const dirty = new DirtyCollector();
		dirty.add('b', 'a', 'b');
		dirty.update(['c', 'a']);
		expect(dirty.ids).toEqual(['b', 'a', 'c']);
		expect(dirty.size).toBe(3);
		expect(dirty.has('c')).toBe(true);
	});
});

describe('addNeighbourhood', () => {
	const { metamodel } = loadFixture<StepsFixture>('validation_dirty');

	function el(id: string, type: string, properties: Props = {}): ModelOp {
		return { kind: 'create_element', temp_id: `tmp_${id}`, id, type_name: type, properties };
	}

	function rel(id: string, type: string, source: string, target: string): ModelOp {
		return {
			kind: 'create_relationship',
			temp_id: `tmp_${id}`,
			id,
			type_name: type,
			source_id: source,
			target_id: target,
			properties: {}
		};
	}

	function build(): Model {
		const model = new Model(Metamodel.fromJSON(metamodel));
		applyBatch(model, [
			el('p', 'Node', { code: 'P' }),
			el('x', 'Node', { code: 'A' }),
			el('y', 'Node', { code: 'A' }),
			el('z', 'Node', { code: 'A' }),
			el('q', 'Node', { code: 'Q' }),
			el('s', 'Node', { code: 'S', refs: ['y', 'gone'] }),
			el('r', 'Node', { code: 'R', ref: 'y' }),
			el('t', 'Tag'),
			rel('l-2', 'Link', 'y', 'q'),
			rel('l-1', 'Link', 'y', 'y'),
			rel('l-0', 'Link', 'q', 'y'),
			rel('h-1', 'Has', 'p', 'q'),
			rel('h-0', 'Has', 'y', 't')
		]);
		return model;
	}

	it('adds an id naming nothing alone', () => {
		const into = new DirtyCollector();
		addNeighbourhood(build(), ['gone'], into);
		expect(into.ids).toEqual(['gone']);
	});

	it("adds an element, its group, its referencers, then its relationships' other ends, each once", () => {
		const into = new DirtyCollector();
		addNeighbourhood(build(), ['y'], into);
		expect(into.ids).toEqual([
			// itself and its group, sorted
			'y',
			'x',
			'z',
			// its referencers, sorted
			'r',
			's',
			// outgoing, sorted, each with its target
			'h-0',
			't',
			'l-1',
			'l-2',
			'q',
			// incoming, sorted, each with its source
			'l-0'
		]);
	});

	it('adds a relationship, its ends, and for containment its target group', () => {
		const model = build();
		const into = new DirtyCollector();
		addNeighbourhood(model, ['l-0', 'h-1'], into);
		expect(into.ids).toEqual(['l-0', 'q', 'y', 'h-1', 'p']);
		// a Tag under y: its group is every Tag identical to it under y
		applyBatch(model, [el('u', 'Tag'), rel('h-2', 'Has', 'y', 'u')]);
		const group = new DirtyCollector();
		addNeighbourhood(model, ['h-2'], group);
		expect(group.ids).toEqual(['h-2', 'y', 'u', 't']);
	});
});
