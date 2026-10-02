import { describe, expect, it } from 'vitest';
import {
	ArtifactSet,
	navigationFetch,
	navigationHasScript,
	orderKey,
	readNavigation,
	readTableDefinition,
	resolveRefs,
	resolveTableRefs,
	resolveTransformSource,
	snippetFetch,
	tableHasScript,
	type CommittedArtifact,
	type NavigationDefinition,
	type ScriptStep,
	type TableDefinition
} from '../../src/index.ts';
import { ReadError } from '../../src/read/errors.ts';
import { resolved } from '../../src/table/route.ts';

type Payload = CommittedArtifact['payload'];

const artifact = (id: string, kind: string, payload: object): CommittedArtifact => ({
	id,
	kind,
	name: id,
	rev: 1,
	payload: payload as Payload
});

const snippet = (code: string) => ({ schema_version: 1, language: 'python', code });

function artifacts(...committed: CommittedArtifact[]): ArtifactSet {
	const set = new ArtifactSet();
	set.setCommitted(committed);
	return set;
}

const stageUpdate = (set: ArtifactSet, id: string, payload: object) =>
	set.setStaged([{ op: 'update', id, payload: payload as Payload }]);

const tableWith = (snip: object): TableDefinition =>
	readTableDefinition(
		{
			row_source: { kind: 'scope', types: ['Node'] },
			columns: [
				{ kind: 'element', header: 'Node' },
				{ kind: 'script', header: 'Computed', snippet: snip }
			]
		},
		'definition'
	);

const scriptColumn = (defn: TableDefinition) => {
	const column = defn.columns[1]!;
	if (column.kind !== 'script') throw new Error('not a script column');
	return column;
};

const scriptStep = (snip: object) => ({ kind: 'script', snippet: snip });

const pathWith = (snip: object): NavigationDefinition =>
	readNavigation(
		{ kind: 'path', start: { kind: 'scope', types: ['Node'] }, steps: [scriptStep(snip)] },
		'definition'
	);

const firstStep = (defn: NavigationDefinition): ScriptStep => {
	if (defn.kind !== 'path') throw new Error('not a path');
	return defn.steps[0] as ScriptStep;
};

const noNavigation = () => {
	throw new Error('no navigation is fetched');
};

describe('a saved snippet', () => {
	it('is fetched from the committed artifacts', () => {
		const set = artifacts(artifact('s1', 'code_snippet', snippet('def value(els): return 1')));
		expect(snippetFetch(set)('s1')).toEqual({ code: 'def value(els): return 1' });
	});

	it('is fetched staged first', () => {
		const set = artifacts(artifact('s1', 'code_snippet', snippet('committed')));
		stageUpdate(set, 's1', snippet('staged'));
		expect(snippetFetch(set)('s1')).toEqual({ code: 'staged' });
		set.setStaged([{ op: 'delete', id: 's1' }]);
		expect(snippetFetch(set)('s1')).toBeNull();
	});

	it('is none when the ref names no artifact or another kind of one', () => {
		const set = artifacts(
			artifact('t1', 'table', {}),
			artifact('s1', 'code_snippet', snippet('x'))
		);
		expect(snippetFetch(set)('nope')).toBeNull();
		expect(snippetFetch(set)('t1')).toBeNull();
	});

	it('refuses a payload that holds no code', () => {
		const set = artifacts(
			artifact('s1', 'code_snippet', { language: 'python' }),
			artifact('s2', 'code_snippet', { code: 5 })
		);
		for (const ref of ['s1', 's2']) {
			expect(() => snippetFetch(set)(ref), ref).toThrow(ReadError);
		}
		expect(() => snippetFetch(set)('s1')).toThrow(/artifact 's1'\.code: must be a string/);
	});
});

describe('a table with a script column', () => {
	const committed = artifacts(
		artifact('s1', 'code_snippet', snippet('def value(els): return 1')),
		artifact('t1', 'table', {}),
		artifact('n1', 'navigation', {
			kind: 'path',
			start: { kind: 'scope', types: ['Node'] },
			steps: [scriptStep({ ref: 's1' })]
		})
	);

	function resolve(defn: TableDefinition, set: ArtifactSet = committed) {
		return resolveTableRefs(defn, navigationFetch(set), snippetFetch(set));
	}

	it('takes the snippet a ref names', () => {
		const resolved = scriptColumn(resolve(tableWith({ ref: 's1' })));
		expect(resolved.snippet).toEqual({
			ref: null,
			definition: { code: 'def value(els): return 1' }
		});
	});

	it('takes the staged snippet over the committed one', () => {
		const set = artifacts(artifact('s1', 'code_snippet', snippet('committed')));
		stageUpdate(set, 's1', snippet('staged'));
		expect(scriptColumn(resolve(tableWith({ ref: 's1' }), set)).snippet.definition).toEqual({
			code: 'staged'
		});
	});

	it('is resolved so by the route, saved or inline', () => {
		const set = artifacts(
			artifact('s1', 'code_snippet', snippet('code')),
			artifact('t1', 'table', {
				row_source: { kind: 'scope', types: ['Node'] },
				columns: [{ kind: 'script', header: 'C', snippet: { ref: 's1' } }]
			})
		);
		for (const source of ['t1', tableWith({ ref: 's1' })]) {
			const defn = resolved(set, source);
			expect(defn.columns.map((c) => (c.kind === 'script' ? c.snippet.definition : null))).toEqual(
				source === 't1' ? [{ code: 'code' }] : [null, { code: 'code' }]
			);
		}
	});

	it('keeps a dangling ref, and a ref to what is no snippet', () => {
		expect(scriptColumn(resolve(tableWith({ ref: 'nope' }))).snippet).toEqual({
			ref: 'nope',
			definition: null
		});
		expect(scriptColumn(resolve(tableWith({ ref: 't1' }))).snippet).toEqual({
			ref: 't1',
			definition: null
		});
	});

	it('keeps an inline snippet and an unconfigured one', () => {
		const inline = { definition: { code: 'inline' } };
		expect(scriptColumn(resolve(tableWith(inline))).snippet).toEqual({
			ref: null,
			definition: { code: 'inline' }
		});
		expect(scriptColumn(resolve(tableWith({}))).snippet).toEqual({ ref: null, definition: null });
	});

	it('takes the snippet of a script step in a navigation column', () => {
		const defn = readTableDefinition(
			{
				row_source: { kind: 'scope', types: ['Node'] },
				columns: [{ kind: 'navigation', header: 'Nav', navigation: { ref: 'n1' } }]
			},
			'definition'
		);
		const column = resolve(defn).columns[0]!;
		if (column.kind !== 'navigation') throw new Error('not a navigation column');
		expect(firstStep(column.navigation.definition!).snippet.definition).toEqual({
			code: 'def value(els): return 1'
		});
	});

	it('still reaches a script, resolved or not', () => {
		expect(tableHasScript(resolve(tableWith({ ref: 's1' })))).toBe(true);
		expect(tableHasScript(resolve(tableWith({ ref: 'nope' })))).toBe(true);
		expect(tableHasScript(resolve(tableWith({})))).toBe(false);
	});

	it('is left as it is without a snippet fetch', () => {
		const defn = tableWith({ ref: 's1' });
		expect(scriptColumn(resolveTableRefs(defn, navigationFetch(committed))).snippet).toEqual({
			ref: 's1',
			definition: null
		});
	});

	it('is ordered under another key when its snippet changes', () => {
		const first = artifacts(artifact('s1', 'code_snippet', snippet('return 1')));
		const second = artifacts(artifact('s1', 'code_snippet', snippet('return 2')));
		const defn = tableWith({ ref: 's1' });
		const a = orderKey(resolve(defn, first));
		expect(orderKey(resolve(defn, first))).toBe(a);
		expect(orderKey(resolve(defn, second))).not.toBe(a);
	});

	it('is ordered under the same key when only its snippet metadata changes', () => {
		const a = artifacts(
			artifact('s1', 'code_snippet', { ...snippet('x'), entry_points: ['value'] })
		);
		const b = artifacts(artifact('s1', 'code_snippet', snippet('x')));
		const defn = tableWith({ ref: 's1' });
		expect(orderKey(resolve(defn, a))).toBe(orderKey(resolve(defn, b)));
	});
});

describe('a navigation with a script step', () => {
	const set = artifacts(
		artifact('s1', 'code_snippet', snippet('committed')),
		artifact('inner', 'navigation', {
			kind: 'path',
			start: { kind: 'scope', types: ['Node'] },
			steps: [scriptStep({ ref: 's1' })]
		})
	);
	const resolve = (defn: NavigationDefinition, from: ArtifactSet = set) =>
		resolveRefs(defn, navigationFetch(from), new Set(), snippetFetch(from));

	it('takes the snippet a ref names, committed or staged', () => {
		expect(firstStep(resolve(pathWith({ ref: 's1' }))).snippet).toEqual({
			ref: null,
			definition: { code: 'committed' }
		});
		const staged = artifacts(artifact('s1', 'code_snippet', snippet('committed')));
		stageUpdate(staged, 's1', snippet('staged'));
		expect(firstStep(resolve(pathWith({ ref: 's1' }), staged)).snippet.definition).toEqual({
			code: 'staged'
		});
	});

	it('keeps a dangling ref and a ref to what is no snippet', () => {
		expect(firstStep(resolve(pathWith({ ref: 'nope' }))).snippet).toEqual({
			ref: 'nope',
			definition: null
		});
		expect(firstStep(resolve(pathWith({ ref: 'inner' }))).snippet).toEqual({
			ref: 'inner',
			definition: null
		});
	});

	it('takes the snippet of a step inside the operands of a set operation, saved or inline', () => {
		const defn = readNavigation(
			{
				kind: 'set_op',
				op: 'union',
				operands: [
					{ ref: 'inner' },
					{
						definition: {
							kind: 'path',
							start: { kind: 'scope', types: ['Node'] },
							steps: [scriptStep({ ref: 's1' })]
						}
					}
				]
			},
			'definition'
		);
		const resolved = resolve(defn);
		if (resolved.kind !== 'set_op') throw new Error('not a set operation');
		for (const operand of resolved.operands) {
			expect(operand.ref).toBeNull();
			expect(firstStep(operand.definition!).snippet).toEqual({
				ref: null,
				definition: { code: 'committed' }
			});
		}
	});

	it('takes the snippet of a step after a set-operation start', () => {
		const defn = readNavigation(
			{
				kind: 'path',
				start: { kind: 'set_op', op: 'union', operands: [{ ref: 'inner' }] },
				steps: [scriptStep({ ref: 's1' })]
			},
			'definition'
		);
		const resolved = resolve(defn);
		expect(firstStep(resolved).snippet.definition).toEqual({ code: 'committed' });
		if (resolved.kind !== 'path' || resolved.start.kind !== 'set_op') throw new Error('no start');
		expect(firstStep(resolved.start.operands[0]!.definition!).snippet.definition).toEqual({
			code: 'committed'
		});
	});

	it('is the same definition when no step has a snippet to take', () => {
		const defn = readNavigation(
			{ kind: 'path', start: { kind: 'scope', types: ['Node'] }, steps: [scriptStep({})] },
			'definition'
		);
		expect(resolve(defn)).toBe(defn);
		expect(resolveRefs(pathWith({ ref: 's1' }), noNavigation)).toEqual(pathWith({ ref: 's1' }));
	});

	it('still reaches a script, resolved or not', () => {
		expect(navigationHasScript(resolve(pathWith({ ref: 's1' })))).toBe(true);
		expect(navigationHasScript(resolve(pathWith({ ref: 'nope' })))).toBe(true);
		expect(navigationHasScript(resolve(pathWith({})))).toBe(false);
	});
});

describe('an export transform', () => {
	const set = artifacts(
		artifact('s1', 'code_snippet', snippet('def transform(doc): return doc')),
		artifact('t1', 'table', {})
	);
	const label = 'entry 0';
	const refusal = (transform: Parameters<typeof resolveTransformSource>[1], from = set) => {
		try {
			resolveTransformSource(from, transform, label);
		} catch (error) {
			expect(error).toBeInstanceOf(ReadError);
			return error as ReadError;
		}
		throw new Error('resolved');
	};

	it('answers the code of its snippet, staged first', () => {
		expect(resolveTransformSource(set, { ref: 's1', definition: null }, label)).toBe(
			'def transform(doc): return doc'
		);
		const staged = artifacts(
			artifact('s1', 'code_snippet', snippet('def transform(doc):\n    return 0\n'))
		);
		const code = 'def transform(doc):\n    return 1\n';
		stageUpdate(staged, 's1', snippet(code));
		expect(resolveTransformSource(staged, { ref: 's1', definition: null }, label)).toBe(code);
	});

	it('answers its inline code', () => {
		const code = 'def transform(doc):\n    return [doc]\n';
		const transform = { ref: null, definition: { code } };
		expect(resolveTransformSource(set, transform, label)).toBe(code);
	});

	const inline = (code: string) => refusal({ ref: null, definition: { code } });
	const unparseable = 'entry 0: transform code does not parse';
	const noEntry = 'entry 0: transform code does not define a one-argument top-level transform(doc)';

	it('refuses inline code that does not parse, or that defines no transform of one argument', () => {
		expect(inline('def transform(doc:\n    return doc\n').detail).toBe(unparseable);
		expect(inline('x = (1,\n').detail).toBe(unparseable);
		for (const code of [
			'x = 1\n',
			'def transform(a, b):\n    return a\n',
			'def transform():\n    return 1\n',
			'async def transform(doc):\n    return doc\n',
			'if True:\n    def transform(doc):\n        return doc\n',
			'def transformer(doc):\n    return doc\n'
		]) {
			expect([inline(code).status, inline(code).detail], code).toEqual([422, noEntry]);
		}
	});

	it('takes a one-argument transform wherever it stands among the same name, as the oracle does', () => {
		const code = 'def transform(a, b):\n    return a\n\ndef transform(doc):\n    return doc\n';
		expect(resolveTransformSource(set, { ref: null, definition: { code } }, label)).toBe(code);
	});

	it('refuses a saved snippet that defines no transform of one argument, with its id', () => {
		const saved = artifacts(
			artifact('none', 'code_snippet', snippet('x = 1\n')),
			artifact('two', 'code_snippet', snippet('def transform(a, b):\n    return a\n')),
			artifact('broken', 'code_snippet', snippet('def transform(doc:\n'))
		);
		for (const ref of ['none', 'two', 'broken']) {
			const error = refusal({ ref, definition: null }, saved);
			expect([error.status, error.detail]).toEqual([
				422,
				`entry 0: snippet ${ref} does not define a one-argument top-level transform(doc)`
			]);
		}
	});

	it('refuses a ref that names no artifact with the oracle text', () => {
		const error = refusal({ ref: 'nope', definition: null });
		expect([error.status, error.detail]).toEqual([422, 'entry 0: unknown transform snippet nope']);
	});

	it('refuses a ref to another kind of artifact with the same text', () => {
		const error = refusal({ ref: 't1', definition: null });
		expect([error.status, error.detail]).toEqual([422, 'entry 0: unknown transform snippet t1']);
	});

	it('refuses a ref staged for deletion', () => {
		const staged = artifacts(artifact('s1', 'code_snippet', snippet('x')));
		staged.setStaged([{ op: 'delete', id: 's1' }]);
		expect(refusal({ ref: 's1', definition: null }, staged).detail).toBe(
			'entry 0: unknown transform snippet s1'
		);
	});

	it('refuses a source that is neither a ref nor code', () => {
		const error = refusal({ ref: null, definition: null });
		expect(error.status).toBe(422);
		expect(error.detail).toMatch(/^entry 0: /);
	});
});
