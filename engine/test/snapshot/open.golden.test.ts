import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	Metamodel,
	Model,
	openSnapshot,
	parseJson,
	verifyConsistent,
	type MetamodelDoc,
	type Value
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { observe, type Observed } from '../golden/model-steps.ts';
import { cut, refusal, snapshotText, trickle, utf8 } from './text.ts';

type Fixture = Required<Observed> & {
	metamodel: MetamodelDoc;
	text: string;
	same: { name: string; text: string }[];
	refused: { name: string; text: string; error: string }[];
};

const { metamodel, text, same, refused, ...expected } = loadFixture<Fixture>('snapshot_v2');
const mm = Metamodel.fromJSON(metamodel);

describe('the snapshot the server wrote', () => {
	// One byte at a time cuts every multi-byte character and every line.
	it.each([1, 2, 3, 7, 64, 100_000])('opens from pieces of %i bytes', async (size) => {
		const { header, workingCopy } = await openSnapshot(cut(utf8(text), size), mm);
		expect(header).toEqual(JSON.parse(text.slice(0, text.indexOf('\n'))));
		const seen = observe(workingCopy.model);
		expect(seen.state).toEqual(text.slice(0, -1).split('\n').slice(1));
		expect(seen).toEqual(expected);
		expect([workingCopy.rev, workingCopy.digest]).toEqual([42, expected.digest]);
		expect(workingCopy.verifyDigest()).toBe(true);
		verifyConsistent(workingCopy.model);
	});

	it('opens from a source it has to wait for, every uniqueness key in one bucket', async () => {
		const source = trickle(utf8(text), 5);
		const { workingCopy } = await openSnapshot(source, mm, undefined, { hashKey: () => 0 });
		expect(observe(workingCopy.model)).toEqual(expected);
	});

	it.each(same)('reads $name as the oracle does', async ({ text: variant }) => {
		const { workingCopy } = await openSnapshot(cut(utf8(variant), 16), mm);
		expect(observe(workingCopy.model)).toEqual(expected);
	});

	it.each(refused)("refuses $name in the oracle's words", async ({ text: variant, error }) => {
		for (const size of [1, 16, 100_000]) {
			expect(await refusal(openSnapshot(cut(utf8(variant), size), mm))).toBe(error);
		}
	});
});

type SmartCity = {
	metamodel: MetamodelDoc;
	model_file: string;
	digest: string;
	fingerprint: string;
	indexes: string;
};

it('opens the smart-city example, written as a snapshot, into what the oracle holds', async () => {
	const fixture = loadFixture<SmartCity>('smart_city');
	const file = new URL(`../../../${fixture.model_file}`, import.meta.url);
	const doc = parseJson(readFileSync(file, 'utf-8')) as { [key: string]: Value[] };
	const metamodel = Metamodel.fromJSON(fixture.metamodel);
	const written = new Model(metamodel);
	for (const element of doc['elements']!) written.loadElement(element);
	for (const rel of doc['relationships']!) written.loadRelationship(rel);

	const bytes = utf8(snapshotText(written, 7));
	const { header, workingCopy } = await openSnapshot(trickle(bytes, 4096), metamodel);
	expect([header.rev, header.state_digest]).toEqual([7, fixture.digest]);
	const seen = observe(workingCopy.model);
	expect(JSON.parse(seen.indexes)).toEqual(JSON.parse(fixture.indexes));
	expect(seen.fingerprint).toBe(fixture.fingerprint);
	expect(workingCopy.verifyDigest()).toBe(true);
	verifyConsistent(workingCopy.model);
});
