import { describe, expect, it } from 'vitest';
import {
	ArtifactSet,
	drain,
	evaluateTable,
	NavMemo,
	readTableDefinition,
	ReadError,
	ViewPlacements,
	type CommittedArtifact,
	type MemoEntry,
	type NavigationColumn,
	type ReadParams,
	type TablePageBody
} from '../../src/index.ts';
import { thrown } from '../golden/thrown.ts';
import { family } from '../model/fixtures.ts';

type Payload = CommittedArtifact['payload'];

const CODE = { code: 'def step(el):\n    return el\n' };
const scope = { kind: 'scope', types: ['Node'] };
const rowPath = (...steps: object[]) => ({ kind: 'path', start: { kind: 'row' }, steps });
const refers = { kind: 'relationship', relationship_type: 'Refers' };
const scriptStep = { kind: 'script', snippet: { definition: CODE } };
const table = (...columns: object[]) => ({ row_source: scope, columns });
const navColumn = (navigation: object) => ({ kind: 'navigation', navigation });

describe('NavMemo', () => {
	const col = readTableDefinition(table(navColumn({ definition: rowPath(refers) })), 'definition')
		.columns[0] as NavigationColumn;
	const entry = (id: string): MemoEntry => ({ chains: [[id]], truncated: false });

	it('keeps 64 entries, the least recently used leaving first', () => {
		const memo = new NavMemo();
		const entries = Array.from({ length: 65 }, (_, i) => entry(`r${i}`));
		entries.slice(0, 64).forEach((e, i) => memo.put(memo.key(col, [`r${i}`]), e));
		expect(memo.size).toBe(64);
		// A hit returns the very nodes put, and makes its entry the most recent.
		expect(memo.get(memo.key(col, ['r0']))).toBe(entries[0]);
		memo.put(memo.key(col, ['r64']), entries[64]!);
		expect(memo.size).toBe(64);
		expect(memo.get(memo.key(col, ['r1']))).toBeUndefined();
		expect(memo.get(memo.key(col, ['r0']))).toBe(entries[0]);
		expect(memo.get(memo.key(col, ['r64']))).toBe(entries[64]);
	});

	it('evicts the first of 65 distinct roots', () => {
		const memo = new NavMemo();
		for (let i = 0; i < 65; i++) memo.put(memo.key(col, [`r${i}`]), entry(`r${i}`));
		expect(memo.get(memo.key(col, ['r0']))).toBeUndefined();
		expect(memo.get(memo.key(col, ['r1']))?.chains).toEqual([['r1']]);
	});

	it('keys a column and its roots in order', () => {
		const memo = new NavMemo();
		const other = { ...col };
		expect(memo.key(col, ['a', 'b'])).not.toBe(memo.key(col, ['b', 'a']));
		expect(memo.key(col, ['a'])).not.toBe(memo.key(other, ['a']));
		expect(memo.key(col, ['a'])).toBe(memo.key(col, ['a']));
	});
});

describe('evaluateTable and scripts', () => {
	function evaluate(artifacts: ArtifactSet, params: ReadParams): TablePageBody {
		return drain(
			evaluateTable({ model: family(), artifacts, placements: new ViewPlacements() }, params)
		);
	}

	/** The refusal, thrown before the evaluation has a first step to run. */
	const refusal = (artifacts: ArtifactSet, params: ReadParams) =>
		thrown(() =>
			evaluateTable({ model: family(), artifacts, placements: new ViewPlacements() }, params)
		);

	function saved(): ArtifactSet {
		const artifacts = new ArtifactSet();
		const committed: CommittedArtifact[] = [
			{ id: 'nr', kind: 'navigation', name: 'R', rev: 1, payload: rowPath(refers) as Payload },
			{ id: 'ns', kind: 'navigation', name: 'S', rev: 1, payload: rowPath(scriptStep) as Payload },
			{ id: 's1', kind: 'code_snippet', name: 'C', rev: 1, payload: CODE as Payload },
			{
				id: 't1',
				kind: 'table',
				name: 'T',
				rev: 1,
				payload: table({ kind: 'element' }, navColumn({ ref: 'nr' })) as Payload
			}
		];
		artifacts.setCommitted(committed);
		return artifacts;
	}

	it.each([
		['a saved snippet', { kind: 'script', snippet: { ref: 's1' } }],
		['a dangling snippet', { kind: 'script', snippet: { ref: 'gone' }, mode: 'expand' }],
		['inline code, empty', { kind: 'script', snippet: { definition: { code: '' } } }],
		['a navigation with a script step', navColumn({ definition: rowPath(scriptStep) })],
		['a saved navigation with a script step', navColumn({ ref: 'ns' })]
	])('refuses a table reaching %s with 501, before any step', (_, column) => {
		const error = refusal(saved(), { definition: table({ kind: 'element' }, column) });
		expect(error).toBeInstanceOf(ReadError);
		expect(error).toMatchObject({ status: 501, detail: 'reaches a script' });
	});

	it('refuses a row source reaching a script', () => {
		const definition = {
			row_source: { kind: 'chains', navigation: { ref: 'ns' } },
			columns: [{ kind: 'element' }]
		};
		expect(refusal(saved(), { definition })).toMatchObject({ status: 501 });
	});

	it('flips to 501 while a staged navigation gains a script step, and back', () => {
		const artifacts = saved();
		const before = evaluate(artifacts, { artifact_id: 't1' });
		expect(before.rows.map((row) => row.cells[1]!.items?.map((item) => item.id))).toEqual([
			['c'],
			[],
			[],
			[]
		]);
		artifacts.setStaged([
			{ op: 'update', id: 'nr', payload: rowPath(refers, scriptStep) as Payload }
		]);
		expect(refusal(artifacts, { artifact_id: 't1' })).toMatchObject({
			status: 501,
			detail: 'reaches a script'
		});
		artifacts.setStaged([]);
		expect(evaluate(artifacts, { artifact_id: 't1' })).toEqual(before);
	});

	it('answers an unconfigured script column as empty cells', () => {
		const page = evaluate(saved(), {
			definition: table({ kind: 'element' }, { kind: 'script', snippet: {} })
		});
		expect(page.warnings).toEqual([]);
		expect(page.script_status).toBeNull();
		expect(page.rows[0]!.cells[1]).toMatchObject({ kind: 'value', present: false, value: null });
	});
});
