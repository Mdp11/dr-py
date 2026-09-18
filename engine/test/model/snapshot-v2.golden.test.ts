import { expect, it } from 'vitest';
import { verifyConsistent, type MetamodelDoc } from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { loadLines } from '../golden/model-load.ts';
import { observe, type Observed } from '../golden/model-steps.ts';

type Fixture = Required<Observed> & { metamodel: MetamodelDoc; text: string };

type Header = {
	format: string;
	rev: number;
	elements: number;
	relationships: number;
	state_digest: string;
};

it('reads the entity lines of a v2 snapshot back into the state the server wrote', () => {
	const { metamodel, text, ...expected } = loadFixture<Fixture>('snapshot_v2');
	expect(text.endsWith('\n')).toBe(true);
	const [first, ...lines] = text.slice(0, -1).split('\n');
	const header = JSON.parse(first!) as Header;
	expect(header.format).toBe('datarover.snapshot/v2');
	expect(lines).toHaveLength(header.elements + header.relationships);

	const model = loadLines(metamodel, lines.slice(0, header.elements), lines.slice(header.elements));
	const seen = observe(model);
	expect(seen.state).toEqual(lines);
	expect(seen).toEqual(expected);
	expect(seen.digest).toBe(header.state_digest);
	verifyConsistent(model);
});
