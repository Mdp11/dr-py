import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExportResult } from '$lib/api/tables';
import { downloadExport } from '../export-download';
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

describe('downloadExport', () => {
	it('calls the export once and downloads the file it returns', async () => {
		const names = downloads();
		const ready: ExportResult = {
			kind: 'ready',
			blob: new Blob(['a,b\r\n']),
			filename: 't.csv',
			truncated: true
		};
		const run = vi.fn<() => Promise<ExportResult>>().mockResolvedValue(ready);

		const result = await downloadExport(run);

		expect(result).toBe(ready);
		expect(run).toHaveBeenCalledTimes(1);
		expect(names).toEqual(['t.csv']);
	});

	it('downloads nothing when the export fails', async () => {
		const names = downloads();
		await expect(downloadExport(() => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
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
