import { describe, expect, it } from 'vitest';
import { EngineUnavailableError } from '$lib/api/engine-route';
import { ConflictError } from '$lib/api/errors';
import { EngineGoneError } from '../client';
import { createEngineSeam } from '../seam';

const ready = () => Promise.resolve();

describe('the engine seam', () => {
	it("call hands the sync the read's signal and the buffers it transfers", async () => {
		const seen: unknown[][] = [];
		const sync = {
			call: <T>(method: string, params?: unknown, options?: unknown): Promise<T> => {
				seen.push([method, params, options]);
				return Promise.resolve(null as T);
			}
		};
		const seam = createEngineSeam(sync, ready);
		const file = new ArrayBuffer(4);
		const { signal } = new AbortController();

		await seam.call('compareModel', { file }, signal, [file]);
		await seam.call('compareModel', { file }, undefined, [file]);
		await seam.call('getModelSummary', {});

		expect(seen).toEqual([
			['compareModel', { file }, { signal, transfer: [file] }],
			['compareModel', { file }, { transfer: [file] }],
			['getModelSummary', {}, {}]
		]);
	});

	it('whenReady is the one it was given', async () => {
		const seen: (AbortSignal | undefined)[] = [];
		const seam = createEngineSeam(
			{ call: () => Promise.reject(new Error('not called')) },
			(signal) => {
				seen.push(signal);
				return Promise.resolve();
			}
		);
		const { signal } = new AbortController();

		await seam.whenReady(signal);

		expect(seen).toEqual([signal]);
	});

	it('an engine that is gone is unavailable, and any other error is as it was', async () => {
		const conflict = new ConflictError(409, { detail: 'stale base_rev' }, 'stale base_rev');
		let failure: Error = new EngineGoneError();
		const seam = createEngineSeam({ call: () => Promise.reject(failure) }, ready);

		await expect(seam.call('getModelSummary', {})).rejects.toBeInstanceOf(EngineUnavailableError);
		await expect(seam.call('getModelSummary', {})).rejects.toThrow('the engine is gone');

		failure = conflict;
		await expect(seam.call('getModelSummary', {})).rejects.toBe(conflict);
	});
});
