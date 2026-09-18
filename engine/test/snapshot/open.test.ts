import { describe, expect, it } from 'vitest';
import { Model, openSnapshot } from '../../src/index.ts';
import { observe } from '../golden/model-steps.ts';
import { family, nodeMetamodel } from '../model/fixtures.ts';
import { cut, headerLine, refusal, snapshotText, utf8 } from './text.ts';

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
	// 2,000 lines make a batch; the elements end inside the second one.
	it.each([
		[1500, [2000, 4000, 4500]],
		[1000, [2000, 4000]]
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
