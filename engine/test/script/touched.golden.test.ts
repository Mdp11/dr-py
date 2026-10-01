import { describe, expect, it } from 'vitest';
import type { MetamodelDoc } from '../../src/index.ts';
import { applyBatch } from '../../src/ops/apply.ts';
import type { ModelOp } from '../../src/ops/types.ts';
import { readKeyText } from '../../src/script/cell-cache.ts';
import { touchedKeys } from '../../src/script/touched.ts';
import { loadFixture } from '../golden/load.ts';
import { loadLines } from '../golden/model-load.ts';

type Case = {
	name: string;
	ops: ModelOp[];
	element_ids: string[];
	relationship_ids: string[];
	moves_containment: boolean;
	keys: [string, string | null][];
};

type Fixture = {
	metamodel: MetamodelDoc;
	elements: string[];
	relationships: string[];
	cases: Case[];
};

const fixture = loadFixture<Fixture>('script_touched');

const freshModel = () => loadLines(fixture.metamodel, fixture.elements, fixture.relationships);

describe('the keys a batch touches match the oracle', () => {
	it('has cases that move containment and cases that do not', () => {
		expect(fixture.cases.length).toBeGreaterThan(15);
		expect(fixture.cases.some((c) => c.moves_containment)).toBe(true);
		expect(fixture.cases.some((c) => !c.moves_containment)).toBe(true);
		expect(fixture.cases.every((c) => c.keys.length > 0)).toBe(true);
	});

	it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
		const model = freshModel();
		const ids = { elementIds: c.element_ids, relationshipIds: c.relationship_ids };
		const touched = touchedKeys(model, model.metamodel, ids);
		applyBatch(model, c.ops);
		touchedKeys(model, model.metamodel, ids, touched);

		const oracle = new Set(c.keys.map(([tag, id]) => readKeyText([tag as 'el', id])));
		expect(oracle.size).toBe(c.keys.length);
		for (const key of oracle) expect(touched, `${JSON.stringify(key)} is touched`).toContain(key);
		if (!c.moves_containment) expect([...touched].toSorted()).toEqual([...oracle].toSorted());
	});
});
