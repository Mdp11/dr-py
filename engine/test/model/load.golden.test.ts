import { describe, expect, it } from 'vitest';
import { SnapshotError, verifyConsistent, type MetamodelDoc } from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { loadLines } from '../golden/model-load.ts';
import { observe, type Observed } from '../golden/model-steps.ts';
import { thrown } from '../golden/thrown.ts';

type Lines = { elements: string[]; relationships: string[] };

type Fixture = {
	metamodel: MetamodelDoc;
	accepted: Lines & Required<Observed>;
	refused: (Lines & { name: string; error: string })[];
};

const fixture = loadFixture<Fixture>('model_load');

describe('bulk load matches the oracle', () => {
	it('loads unknown types, absent properties and absent revs', () => {
		const { elements, relationships, ...expected } = fixture.accepted;
		const model = loadLines(fixture.metamodel, elements, relationships);
		expect(observe(model)).toEqual(expected);
		verifyConsistent(model);
	});

	it.each(fixture.refused)('refuses: $name', (c) => {
		const error = thrown(() => loadLines(fixture.metamodel, c.elements, c.relationships));
		expect(error).toBeInstanceOf(SnapshotError);
		expect((error as Error).message).toBe(c.error);
	});
});
