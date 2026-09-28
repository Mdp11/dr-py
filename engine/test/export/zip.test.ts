import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { zipEntries, type ZipFile } from '../../src/index.ts';

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

	it('refuses a path that looks like an array index rather than reorder it', () => {
		expect(() => zipEntries([file('0', 'x')])).toThrow(/array index/);
		expect(() => zipEntries([file('12', 'x')])).toThrow(/array index/);
	});

	it('accepts a path that merely starts with digits', () => {
		const zipped = zipEntries([file('12.json', 'x')]);
		expect(Object.keys(unzipSync(zipped))).toEqual(['12.json']);
	});
});
