import { describe, expect, it } from 'vitest';
import {
	dumpIndexes,
	Metamodel,
	Model,
	modelDigest,
	modelLines,
	openSnapshot,
	type MetamodelDoc
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { observe } from '../golden/model-steps.ts';
import { family, nodeMetamodel } from '../model/fixtures.ts';
import { cut, headerLine, refusal, snapshotText, trickle, utf8 } from './text.ts';

const NOT_V2 = 'not a datarover.snapshot/v2 snapshot';

const open = (text: string | Uint8Array, size = 64) =>
	openSnapshot(cut(typeof text === 'string' ? utf8(text) : text, size), nodeMetamodel());

/** The family's snapshot with one line (the header is line 1) replaced, or dropped. */
function withLine(number: number, line: string | null): string {
	const lines = snapshotText(family(), 3).slice(0, -1).split('\n');
	lines.splice(number - 1, 1, ...(line === null ? [] : [line]));
	return lines.map((each) => each + '\n').join('');
}

describe('opening', () => {
	// 500 lines make a batch; the elements fill the first six.
	it.each([
		[1500, [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500]],
		[1000, [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000]],
		[1250, [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4250]]
	])('reports progress after every batch: %i relationships', async (relationships, expected) => {
		const model = new Model(nodeMetamodel());
		for (let i = 0; i < 3000; i++) model.createElement('Node', `n${i}`);
		for (let i = 0; i < relationships; i++) model.connect('Refers', `n${i}`, `n${i + 1}`, `r${i}`);
		const calls: [number, number][] = [];
		const { workingCopy } = await openSnapshot(
			cut(utf8(snapshotText(model, 1)), 1 << 16),
			nodeMetamodel(),
			(done, total) => calls.push([done, total])
		);
		expect(calls).toEqual(expected.map((done) => [done, 3000 + relationships]));
		expect(observe(workingCopy.model)).toEqual(observe(model));
	});

	it('opens a snapshot of nothing', async () => {
		const empty = new Model(nodeMetamodel());
		const calls: number[] = [];
		const { header, workingCopy } = await openSnapshot(
			[utf8(snapshotText(empty, 9))],
			nodeMetamodel(),
			(done) => calls.push(done)
		);
		expect([header.elements, header.relationships, workingCopy.rev]).toEqual([0, 0, 9]);
		expect(workingCopy.digest).toBe('0'.repeat(16));
		expect(calls).toEqual([]);
	});

	it('adopts the digest of the header without checking it', async () => {
		const text = withLine(1, headerLine(family(), 3, { state_digest: 'f'.repeat(16) }));
		const { workingCopy } = await open(text);
		expect([workingCopy.digest, workingCopy.diverged]).toEqual(['f'.repeat(16), false]);
		expect(workingCopy.verifyDigest()).toBe(false);
		expect(workingCopy.diverged).toBe(true);
	});
});

describe('what is not a v2 snapshot', () => {
	it.each([
		['nothing at all', ''],
		['a v1 document', '{"elements":[],"relationships":[]}'],
		['another format', snapshotText(family(), 3).replace('snapshot/v2', 'snapshot/v3')],
		['a header written with spaces', snapshotText(family(), 3).replace('{"format"', '{ "format"')],
		['a byte order mark', '\u{feff}' + snapshotText(family(), 3)]
	])('refuses %s', async (_, text) => {
		expect(await refusal(open(text))).toBe(NOT_V2);
	});

	it('refuses an endless first line at its first bytes, without reading on', async () => {
		function* source(): Generator<Uint8Array> {
			yield utf8('{"elements":[{"id":"a","type_name":"Node","properties":{},"rev":0},');
			throw new Error('read past the first piece');
		}
		expect(await refusal(openSnapshot(source(), nodeMetamodel()))).toBe(NOT_V2);
	});
});

describe('a text that cannot be read', () => {
	it('refuses bytes that are not UTF-8, in the middle or cut at the end', async () => {
		const bytes = utf8(withLine(2, '{"id":"\u{e9}","type_name":"Node","properties":{},"rev":0}'));
		const at = bytes.indexOf(0xc3);
		expect(await refusal(open(bytes.slice(0, at + 1)))).toBe('snapshot is not valid UTF-8');
		bytes[at] = 0xe9;
		for (const size of [1, 64]) {
			expect(await refusal(open(bytes, size))).toBe('snapshot is not valid UTF-8');
		}
	});

	it.each([
		['no rev', { rev: null }, 'snapshot v2 header carries no valid rev'],
		['a negative rev', { rev: -1 }, 'snapshot v2 header carries no valid rev'],
		['no digest', { state_digest: null }, 'snapshot v2 header carries no valid state digest'],
		[
			'a digest in upper case',
			{ state_digest: 'ABCDEF0123456789' },
			'snapshot v2 header carries no valid state digest'
		],
		['no project', { project_id: null }, 'snapshot v2 header names no project and metamodel'],
		['no metamodel', { metamodel_id: 7 }, 'snapshot v2 header names no project and metamodel']
	])('refuses a header with %s', async (_, changes, message) => {
		expect(await refusal(open(withLine(1, headerLine(family(), 3, changes))))).toBe(message);
	});

	it('refuses a header that is not JSON', async () => {
		const text = withLine(1, '{"format":"datarover.snapshot/v2",');
		expect(await refusal(open(text))).toMatch(/^snapshot v2 header: /);
	});

	it('names the line that does not parse', async () => {
		expect(await refusal(open(withLine(4, '{"id":"c",')))).toMatch(/^snapshot v2 line 4: /);
		expect(await refusal(open(withLine(6, '')))).toMatch(/^snapshot v2 line 6: /);
	});

	it('refuses a line that holds two documents instead of shifting the rest', async () => {
		const lines = snapshotText(family(), 3).slice(0, -1).split('\n');
		// Seven entities on six lines, under a header that promises six.
		const header = headerLine(family(), 3, { elements: 3 });
		const text = [header, `${lines[1]},${lines[2]}`, ...lines.slice(3)].join('\n') + '\n';
		expect(await refusal(open(text))).toMatch(/^snapshot v2 line 2: /);
	});

	it("passes on the bulk loader's refusals", async () => {
		const twice = '{"id":"a","type_name":"Node","properties":{},"rev":0}';
		expect(await refusal(open(withLine(3, twice)))).toBe("Duplicate element id 'a' in snapshot");
		const orphan = '{"id":"a-b","type_name":"Contains","source_id":"x","target_id":"b","rev":0}';
		expect(await refusal(open(withLine(6, orphan)))).toBe(
			"Relationship 'a-b' references unknown source 'x'"
		);
	});
});

describe('an open that yields', () => {
	const fixture = loadFixture<{
		metamodel: MetamodelDoc;
		text: string;
		refused: { name: string; text: string; error: string }[];
	}>('snapshot_v2');
	const mm = Metamodel.fromJSON(fixture.metamodel);

	/** A model of `elements` nodes and `relationships` references between them. */
	function nodes(elements: number, relationships: number): Model {
		const model = new Model(nodeMetamodel());
		for (let i = 0; i < elements; i++) model.createElement('Node', `n${i}`);
		for (let i = 0; i < relationships; i++) model.connect('Refers', `n${i}`, `n${i + 1}`, `r${i}`);
		return model;
	}

	it('pause is asked after every batch and every index step', async () => {
		const log: string[] = [];
		const { workingCopy } = await openSnapshot(
			cut(utf8(fixture.text), 64),
			mm,
			() => log.push('batch'),
			{
				pause: () => void log.push('pause'),
				onIndex: () => log.push('index')
			}
		);
		const lines = fixture.text.split('\n').length - 2;
		expect(log.filter((entry) => entry === 'batch')).toHaveLength(Math.ceil(lines / 500));
		expect(log.indexOf('pause')).toBeGreaterThan(log.indexOf('batch'));
		const indexed = log.slice(log.lastIndexOf('batch'));
		expect(indexed.filter((entry) => entry === 'index').length).toBeGreaterThan(0);
		expect(indexed.filter((entry) => entry === 'pause').length).toBeGreaterThan(
			indexed.filter((entry) => entry === 'index').length - 1
		);

		const { workingCopy: plain } = await openSnapshot(cut(utf8(fixture.text), 64), mm);
		expect(modelLines(workingCopy.model)).toEqual(modelLines(plain.model));
		expect(dumpIndexes(workingCopy.model)).toEqual(dumpIndexes(plain.model));
		expect(modelDigest(workingCopy.model)).toBe(modelDigest(plain.model));
	});

	it('one large chunk still pauses between its batches', async () => {
		// Five batches of 500 lines in a single chunk.
		const model = nodes(2000, 500);
		const log: string[] = [];
		await openSnapshot(
			[utf8(snapshotText(model, 1))],
			nodeMetamodel(),
			(done, total) => log.push(done === total ? 'all' : 'batch'),
			{ pause: () => void log.push('pause') }
		);
		const before = log.slice(0, log.indexOf('all'));
		expect(before.filter((entry) => entry === 'pause').length).toBeGreaterThanOrEqual(4);
	});

	it('a returned promise is awaited', async () => {
		const model = nodes(1200, 600);
		const log: string[] = [];
		let calls = 0;
		const pause = () => {
			if (++calls % 3 !== 0) return undefined;
			log.push('paused');
			return new Promise<void>((resume) =>
				setTimeout(() => {
					log.push('resumed');
					resume();
				}, 0)
			);
		};
		await openSnapshot(
			trickle(utf8(snapshotText(model, 1)), 1 << 15),
			nodeMetamodel(),
			() => log.push('progress'),
			{ pause, onIndex: () => log.push('index') }
		);
		expect(log.filter((entry) => entry === 'paused').length).toBeGreaterThan(1);
		let paused = false;
		for (const entry of log) {
			if (entry === 'paused') paused = true;
			else if (entry === 'resumed') paused = false;
			else expect(paused).toBe(false);
		}
		expect(paused).toBe(false);
	});

	it('onIndex ends at its total, onProgress at the entity count', async () => {
		const model = nodes(1500, 700);
		const progress: [number, number][] = [];
		const index: [number, number][] = [];
		await openSnapshot(
			[utf8(snapshotText(model, 1))],
			nodeMetamodel(),
			(done, total) => progress.push([done, total]),
			{ pause: () => undefined, onIndex: (done, total) => index.push([done, total]) }
		);
		expect(progress.at(-1)).toEqual([2200, 2200]);
		const total = 2 * 1500 + 700 + 1;
		expect(index.at(-1)).toEqual([total, total]);
		expect(index.length).toBeGreaterThan(1);
	});

	it('a refusal still surfaces through a paused open', async () => {
		const cutText = fixture.refused.find((each) => each.name === 'cut inside a line')!;
		const opening = openSnapshot(cut(utf8(cutText.text), 16), mm, undefined, {
			pause: () => Promise.resolve()
		});
		expect(await refusal(opening)).toBe(cutText.error);
	});
});
