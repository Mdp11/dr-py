import { describe, expect, it } from 'vitest';
import {
	ArtifactSet,
	compileRuleSets,
	Metamodel,
	readArtifacts,
	readStagedArtifacts,
	ruleSources,
	type RuleSource,
	type RulesParse,
	type WireArtifact,
	type WireStagedArtifact
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import type { StepsFixture } from '../golden/model-steps.ts';

const mm = Metamodel.fromJSON(
	loadFixture<{ runs: StepsFixture[] }>('rules_compile').runs[0]!.metamodel
);

/** A parse of a one-rule set, told apart by the rule's name. */
const parsed = (name: string): RulesParse => ({
	ok: true,
	document: JSON.stringify({
		rules: [{ name, applies_to: 'Leaf', then: { property: 'flag', exists: true } }]
	})
});

const failed: RulesParse = { ok: false, errors: [{ message: 'Malformed rules YAML: nope' }] };

const rulesArtifact = (id: string, name: string, rules?: RulesParse | null): WireArtifact => ({
	id,
	kind: 'validation_rules',
	name,
	artifact_rev: 1,
	payload: { schema_version: 1, yaml: '' },
	...(rules === undefined ? {} : { rules })
});

const update = (id: string, rules?: RulesParse | 'pending'): WireStagedArtifact => ({
	op: 'update',
	id,
	payload: { schema_version: 1, yaml: 'edited' },
	...(rules === undefined ? {} : { rules })
});

const create = (id: string, name: string, rules?: RulesParse | 'pending'): WireStagedArtifact => ({
	op: 'create',
	id,
	kind: 'validation_rules',
	name,
	payload: { schema_version: 1, yaml: 'new' },
	...(rules === undefined ? {} : { rules })
});

function setOf(committed: WireArtifact[], staged: WireStagedArtifact[] = []): ArtifactSet {
	const set = new ArtifactSet();
	set.setCommitted(readArtifacts(committed));
	set.setStaged(readStagedArtifacts(staged));
	return set;
}

/** `[id, name, parse]` per source, in order. */
const listed = (sources: RuleSource[]) =>
	sources.map(({ artifactId, name, parse }) => [artifactId, name, parse]);

describe('ruleSources', () => {
	it('lists the committed rule sets with their committed parse, whatever is staged', () => {
		const set = setOf(
			[
				rulesArtifact('r2', 'Second', parsed('two')),
				{ id: 'n1', kind: 'navigation', name: 'Nav', artifact_rev: 1, payload: {}, rules: null },
				rulesArtifact('r1', 'First', failed)
			],
			[update('r2', parsed('two-staged')), { op: 'delete', id: 'r1' }]
		);
		expect(listed(ruleSources(set, 'committed'))).toEqual([
			['r1', 'First', failed],
			['r2', 'Second', parsed('two')]
		]);
	});

	it('lays the staged overlay over them in the working layer', () => {
		const set = setOf(
			[
				rulesArtifact('r1', 'One', parsed('one')),
				rulesArtifact('r2', 'Two', parsed('two')),
				rulesArtifact('r3', 'Three', parsed('three'))
			],
			[
				update('r1', parsed('one-staged')),
				{ op: 'update', id: 'r2', name: 'A renamed two' },
				{ op: 'delete', id: 'r3' },
				create('tmp_4', 'Four', parsed('four'))
			]
		);
		expect(listed(ruleSources(set, 'working'))).toEqual([
			['r2', 'A renamed two', parsed('two')],
			['tmp_4', 'Four', parsed('four')],
			['r1', 'One', parsed('one-staged')]
		]);
	});

	it("reads 'pending' as the last parse received, and as the committed one after a discard", () => {
		const set = setOf([rulesArtifact('r1', 'One', parsed('committed'))]);
		const working = () => listed(ruleSources(set, 'working'));

		// an update pending before any staged parse: the committed parse
		set.setStaged(readStagedArtifacts([update('r1', 'pending')]));
		expect(working()).toEqual([['r1', 'One', parsed('committed')]]);

		set.setStaged(readStagedArtifacts([update('r1', parsed('staged'))]));
		expect(working()).toEqual([['r1', 'One', parsed('staged')]]);
		set.setStaged(readStagedArtifacts([update('r1', 'pending')]));
		expect(working()).toEqual([['r1', 'One', parsed('staged')]]);
		expect(listed(ruleSources(set, 'committed'))).toEqual([['r1', 'One', parsed('committed')]]);

		// the edit is discarded, then edited again
		set.setStaged([]);
		expect(working()).toEqual([['r1', 'One', parsed('committed')]]);
		set.setStaged(readStagedArtifacts([update('r1', 'pending')]));
		expect(working()).toEqual([['r1', 'One', parsed('committed')]]);

		// a newer committed parse is the last one received
		set.setStaged(readStagedArtifacts([update('r1', parsed('staged'))]));
		set.put(readArtifacts([rulesArtifact('r1', 'One', parsed('committed-2'))]), []);
		set.setStaged(readStagedArtifacts([update('r1', 'pending')]));
		expect(working()).toEqual([['r1', 'One', parsed('committed-2')]]);
	});

	it("leaves out a 'pending' create with no parse yet, and keeps its last one after", () => {
		const set = setOf([]);
		set.setStaged(readStagedArtifacts([create('tmp_1', 'New', 'pending')]));
		expect(ruleSources(set, 'working')).toEqual([]);
		set.setStaged(readStagedArtifacts([create('tmp_1', 'New', parsed('first'))]));
		set.setStaged(readStagedArtifacts([create('tmp_1', 'New', 'pending')]));
		expect(listed(ruleSources(set, 'working'))).toEqual([['tmp_1', 'New', parsed('first')]]);
		// dropped, then created again under the same temp id: nothing to fall back to
		set.setStaged([]);
		set.setStaged(readStagedArtifacts([create('tmp_1', 'New', 'pending')]));
		expect(ruleSources(set, 'working')).toEqual([]);
	});

	it('marks a layer unreadable when a rule set arrives with no parse', () => {
		const compile = (set: ArtifactSet, layer: 'committed' | 'working') =>
			compileRuleSets(ruleSources(set, layer), mm);

		const bare = setOf([rulesArtifact('r1', 'One'), rulesArtifact('r2', 'Two', parsed('two'))]);
		expect(listed(ruleSources(bare, 'committed'))).toEqual([
			['r1', 'One', null],
			['r2', 'Two', parsed('two')]
		]);
		expect(compile(bare, 'committed')).toMatchObject({ unreadable: true, total: 1 });
		expect(compile(bare, 'working').unreadable).toBe(true);
		expect(compile(setOf([rulesArtifact('r1', 'One', null)]), 'committed').unreadable).toBe(true);

		const staged = setOf(
			[rulesArtifact('r1', 'One', parsed('one'))],
			[create('tmp_2', 'Two'), update('r1')]
		);
		expect(compile(staged, 'committed')).toMatchObject({ unreadable: false, total: 1 });
		expect(listed(ruleSources(staged, 'working'))).toEqual([
			['r1', 'One', null],
			['tmp_2', 'Two', null]
		]);
		expect(compile(staged, 'working').unreadable).toBe(true);

		// a document the reader refuses is unreadable too; a failed parse is a skip
		const refused = setOf([
			rulesArtifact('r1', 'One', { ok: true, document: '{"rules":[],"x":1}' }),
			rulesArtifact('r2', 'Two', failed)
		]);
		expect(compile(refused, 'committed')).toMatchObject({
			unreadable: true,
			skipped: [{ artifact_id: 'r2', set_name: 'Two', rule: '', reason: failed.errors[0]!.message }]
		});
	});

	it('orders by name, code point by code point, then by id', () => {
		const set = setOf([
			rulesArtifact('r5', '\u{1F600}', parsed('e')),
			rulesArtifact('r4', '￿', parsed('d')),
			rulesArtifact('r3', 'b', parsed('c')),
			rulesArtifact('r2', 'a', parsed('b')),
			rulesArtifact('r10', 'a', parsed('a'))
		]);
		const order = ruleSources(set, 'committed').map((source) => source.artifactId);
		expect(order).toEqual(['r10', 'r2', 'r3', 'r4', 'r5']);
		expect(ruleSources(set, 'working').map((source) => source.artifactId)).toEqual(order);
	});
});
