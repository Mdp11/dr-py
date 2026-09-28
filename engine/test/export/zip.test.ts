import { crc32, inflateRawSync } from 'node:zlib';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
	Meter,
	ReadError,
	zipEntries,
	zipSteps,
	type ZipFile,
	type ZipMember
} from '../../src/index.ts';
import { counted, EveryUnit, NoEnd } from './meters.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const file = (path: string, text: string): ZipFile => ({ path, bytes: encoder.encode(text) });

/** One member of a zip's central directory, read straight off the bytes. */
type CentralEntry = { name: string; date: number; time: number };

/**
 * The central directory's members, in the order they are written: found
 * through the end-of-central-directory record (searched from the end, since
 * `fflate` writes no archive comment) rather than trusted to sit at a fixed
 * offset.
 */
function centralDirectory(zip: Uint8Array): CentralEntry[] {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let eocd = -1;
	for (let i = zip.length - 22; i >= 0; i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error('no end-of-central-directory record found');
	const count = view.getUint16(eocd + 10, true);
	let at = view.getUint32(eocd + 16, true);
	const entries: CentralEntry[] = [];
	for (let n = 0; n < count; n++) {
		if (view.getUint32(at, true) !== 0x02014b50)
			throw new Error(`bad central directory header at ${at}`);
		const time = view.getUint16(at + 12, true);
		const date = view.getUint16(at + 14, true);
		const nameLen = view.getUint16(at + 28, true);
		const extraLen = view.getUint16(at + 30, true);
		const commentLen = view.getUint16(at + 32, true);
		const name = decoder.decode(zip.slice(at + 46, at + 46 + nameLen));
		entries.push({ name, date, time });
		at += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}

// 1980-01-01 00:00:00 as a DOS date/time pair (year offset from 1980, no seconds).
const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;
const DOS_TIME_MIDNIGHT = 0;

describe('zipEntries', () => {
	it('zips its files in the given order, read back through unzipSync', () => {
		const files = [file('c.json', 'C'), file('a.json', 'A'), file('b.json', 'B')];
		const zipped = zipEntries(files);
		expect(Object.keys(unzipSync(zipped))).toEqual(['c.json', 'a.json', 'b.json']);
		const unzipped = unzipSync(zipped);
		for (const { path, bytes } of files) {
			expect(decoder.decode(unzipped[path]!)).toBe(decoder.decode(bytes));
		}
	});

	it("stamps every member's DOS date and time 1980-01-01 00:00, read from the central directory", () => {
		const zipped = zipEntries([file('a.json', 'A'), file('b.json', 'B')]);
		const entries = centralDirectory(zipped);
		expect(entries).toHaveLength(2);
		for (const entry of entries) {
			expect(entry.date).toBe(DOS_DATE_1980_01_01);
			expect(entry.time).toBe(DOS_TIME_MIDNIGHT);
		}
	});

	it('zips identical input to identical bytes', () => {
		const files = [file('a.json', 'A'), file('b.json', 'B'.repeat(50))];
		const once = zipEntries(files);
		const twice = zipEntries([file('a.json', 'A'), file('b.json', 'B'.repeat(50))]);
		expect([...once]).toEqual([...twice]);
	});

	it('zips zero files to a valid, empty archive', () => {
		const zipped = zipEntries([]);
		expect(Object.keys(unzipSync(zipped))).toEqual([]);
	});

	it('keeps a path that looks like an array index in its place', () => {
		const zipped = zipEntries([file('b.json', 'B'), file('12', 'x'), file('0', 'y')]);
		expect(centralDirectory(zipped).map((entry) => entry.name)).toEqual(['b.json', '12', '0']);
	});

	it('accepts a path that merely starts with digits', () => {
		const zipped = zipEntries([file('12.json', 'x')]);
		expect(Object.keys(unzipSync(zipped))).toEqual(['12.json']);
	});
});

/** One member as its local header and its central directory record say, read straight off the bytes. */
type Member = {
	name: string;
	/** Every header field but the sizes, CRC-32 and offsets, local and central, in order. */
	fields: number[];
	crc: number;
	size: number;
	data: Uint8Array;
};

/**
 * Every member, reading each local header in turn from the archive's first
 * byte and each central record from the end record's offset, as a strict
 * reader does: the two must agree, and the members must tile the archive.
 */
function members(zip: Uint8Array): Member[] {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	const end = zip.length - 22;
	expect(view.getUint32(end, true)).toBe(0x06054b50);
	const count = view.getUint16(end + 8, true);
	expect(view.getUint16(end + 10, true)).toBe(count);
	expect(view.getUint16(end + 20, true)).toBe(0);
	const centralAt = view.getUint32(end + 16, true);
	expect(centralAt + view.getUint32(end + 12, true)).toBe(end);
	const out: Member[] = [];
	let local = 0;
	let central = centralAt;
	for (let n = 0; n < count; n++) {
		expect(view.getUint32(central, true)).toBe(0x02014b50);
		expect(view.getUint32(central + 42, true)).toBe(local);
		expect(view.getUint32(local, true)).toBe(0x04034b50);
		const nameLen = view.getUint16(local + 26, true);
		expect(view.getUint16(local + 28, true)).toBe(0);
		const name = decoder.decode(zip.subarray(local + 30, local + 30 + nameLen));
		const csize = view.getUint32(local + 18, true);
		// Local and central agree from the version needed through the name's length.
		const shared = (at: number) => [...zip.subarray(at, at + 24)];
		expect(shared(central + 6)).toEqual(shared(local + 4));
		expect(decoder.decode(zip.subarray(central + 46, central + 46 + nameLen))).toBe(name);
		const u16 = (at: number) => view.getUint16(at, true);
		out.push({
			name,
			fields: [
				...[4, 6, 8, 10, 12, 26, 28].map((at) => u16(local + at)),
				...[4, 6, 8, 10, 12, 14, 28, 30, 32, 34, 36].map((at) => u16(central + at)),
				view.getUint32(central + 38, true)
			],
			crc: view.getUint32(local + 14, true),
			size: view.getUint32(local + 22, true),
			data: zip.subarray(local + 30 + nameLen, local + 30 + nameLen + csize)
		});
		local += 30 + nameLen + csize;
		central += 46 + nameLen;
	}
	expect(local).toBe(centralAt);
	expect(central).toBe(end);
	return out;
}

/** `files` zipped by `fflate`'s own `zipSync`, level 6 and the fixed stamp. */
function fflateZip(files: readonly ZipFile[]): Uint8Array {
	const data: Zippable = {};
	for (const { path, bytes } of files) {
		data[path] = [bytes, { level: 6, mtime: new Date(1980, 0, 1) }];
	}
	return zipSync(data);
}

/** Text that deflates about as worksheet XML does: repetitive, never quite the same. */
function sheetLike(chars: number): string {
	let text = '';
	for (let r = 1; text.length < chars; r++) {
		text += `<row r="${r}" spans="1:2"><c r="A${r}" s="2" t="s"><v>${(r * 7919) % 100003}</v></c></row>`;
	}
	return text.slice(0, chars);
}

/** Bytes that do not deflate. */
function noise(bytes: number): Uint8Array {
	const out = new Uint8Array(bytes);
	let x = 2463534242;
	for (let i = 0; i < bytes; i++) {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		out[i] = x & 0xff;
	}
	return out;
}

const KiB = 1024;

/** Members either side of one push, streamed and whole, text and bytes, ASCII and not. */
function mixed(): { files: ZipMember[]; contents: Uint8Array[] } {
	const files: ZipMember[] = [
		file('empty.json', ''),
		file('Straße.json', '{"Person": "Straße"}'),
		{ path: 'one-push.bin', bytes: noise(64 * KiB) },
		{ path: 'past-one-push.bin', bytes: noise(64 * KiB + 1) },
		{ path: 'sheet.xml', pieces: ['<sheetData>', sheetLike(700 * KiB), '</sheetData>'] },
		{ path: 'ümlaut/𝒜.txt', pieces: Array.from({ length: 5000 }, (_, i) => `𝒜${i}é\n`) },
		file('last.json', '[]')
	];
	const contents = files.map((member) =>
		'bytes' in member ? member.bytes : encoder.encode([...member.pieces].join(''))
	);
	return { files, contents };
}

describe('zipSteps', () => {
	it("writes zipSync's bytes when every member fits one push", () => {
		const files = [
			file('c.json', 'C'),
			file('empty.json', ''),
			file('Straße/µ.json', '{"a": "ß"}'.repeat(100)),
			{ path: 'one-push.bin', bytes: noise(64 * KiB) },
			file('sheet.xml', sheetLike(64 * KiB))
		];
		expect(Buffer.compare(zipEntries(files), fflateZip(files))).toBe(0);
		expect(Buffer.compare(zipEntries([]), fflateZip([]))).toBe(0);
	});

	it("streams a longer member in zipSync's layout: its CRC-32, sizes and deflate hold", () => {
		const { files, contents } = mixed();
		const zipped = zipEntries(files);
		const ours = members(zipped);
		const theirs = members(
			fflateZip(files.map((member, i) => ({ path: member.path, bytes: contents[i]! })))
		);
		expect(ours.map((m) => m.name)).toEqual(files.map((member) => member.path));
		expect(ours.map((m) => m.fields)).toEqual(theirs.map((m) => m.fields));
		for (const [i, member] of ours.entries()) {
			expect(member.size).toBe(contents[i]!.length);
			expect(member.crc).toBe(crc32(contents[i]!));
			expect(Buffer.compare(inflateRawSync(member.data), contents[i]!)).toBe(0);
		}
		// A member of one push is zipSync's own deflate; a longer one is streamed.
		expect(Buffer.compare(ours[2]!.data, theirs[2]!.data)).toBe(0);
		expect(Buffer.compare(ours[4]!.data, theirs[4]!.data)).not.toBe(0);
		const unzipped = unzipSync(zipped);
		for (const [i, member] of files.entries()) {
			expect(Buffer.compare(unzipped[member.path]!, contents[i]!)).toBe(0);
		}
	});

	it("writes the same bytes whatever the meter's budget, and again", () => {
		const small = Array.from({ length: 300 }, (_, i) => file(`p${i}.json`, `{"i": ${i}}`));
		const all = [...mixed().files, ...small];
		const once = zipEntries(all);
		for (const meter of [new EveryUnit(0), new NoEnd(0), new Meter(0)]) {
			expect(Buffer.compare(counted(zipSteps(all, meter)).value, once)).toBe(0);
		}
		expect(Buffer.compare(zipEntries([...mixed().files, ...small]), once)).toBe(0);
	});

	it('ends a step at every push of a streamed member, and every so many small members', () => {
		const pushes = 12;
		const big = { path: 'big.bin', bytes: noise(pushes * 64 * KiB + 1) };
		expect(counted(zipSteps([big], new Meter(0))).yields).toBeGreaterThanOrEqual(pushes);
		expect(counted(zipSteps([big], new NoEnd(0))).yields).toBe(0);
		const small = Array.from({ length: 1000 }, (_, i) => file(`p${i}.json`, `{"i": ${i}}`));
		expect(counted(zipSteps(small, new Meter(0))).yields).toBeGreaterThanOrEqual(1000 / 64);
	});

	it('refuses more than 65,535 members with 422 before its first step', () => {
		const empty = Array.from({ length: 65_536 }, (_, i) => ({
			path: `p${i}.json`,
			bytes: new Uint8Array(0)
		}));
		const refusal = (() => {
			try {
				zipSteps(empty, new EveryUnit(0)).next();
			} catch (error) {
				return error;
			}
			return null;
		})();
		expect(refusal).toBeInstanceOf(ReadError);
		expect(refusal).toMatchObject({
			status: 422,
			detail: 'export too large for a zip: 65536 files (at most 65,535)'
		});
		expect(zipSteps(empty.slice(1), new EveryUnit(0)).next().done).toBe(false);
	});
});
