import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExportResult } from '$lib/api/tables';
import { retryAndDownload } from '../export-download';
import { utcDate } from '../utc-date';

afterEach(() => {
	vi.restoreAllMocks();
});

/** Spies on the synthetic download: each anchor clicked, by its `download` name. */
function downloads(): string[] {
	const names: string[] = [];
	vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
	vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
		this: HTMLAnchorElement
	) {
		names.push(this.download);
	});
	return names;
}

describe('retryAndDownload', () => {
	it('returns the ready result it downloaded, its marks included', async () => {
		const names = downloads();
		const ready: ExportResult = {
			kind: 'ready',
			blob: new Blob(['a,b\r\n']),
			filename: 't.csv',
			truncated: true,
			fallback: 'pattern'
		};
		const run = vi
			.fn<() => Promise<ExportResult>>()
			.mockResolvedValueOnce({ kind: 'preparing', done: 0, total: 2 })
			.mockResolvedValueOnce(ready);

		const result = await retryAndDownload(run);

		expect(result).toBe(ready);
		expect(run).toHaveBeenCalledTimes(2);
		expect(names).toEqual(['t.csv']);
	});

	it('an abort while preparing returns the last result, downloading nothing', async () => {
		const names = downloads();
		const controller = new AbortController();
		const preparing: ExportResult = { kind: 'preparing', done: 1, total: 2 };
		const run = vi.fn(() => {
			controller.abort();
			return Promise.resolve(preparing);
		});

		const result = await retryAndDownload(run, { signal: controller.signal });

		expect(result).toBe(preparing);
		expect(names).toEqual([]);
	});
});

describe('utcDate', () => {
	it("is the UTC day's YYYYMMDD, whatever the local zone says", () => {
		expect(utcDate(new Date(Date.UTC(2026, 0, 5, 23, 59, 59)))).toBe('20260105');
		expect(utcDate(new Date(Date.UTC(2026, 11, 31, 0, 0, 0)))).toBe('20261231');
		expect(utcDate()).toMatch(/^\d{8}$/);
	});
});
