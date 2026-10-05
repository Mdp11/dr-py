import { EngineUnavailableError, type EngineSeam } from '$lib/api/engine-route';
import { EngineGoneError } from './client';
import type { ReplicaSync } from './sync';

/**
 * The engine seam over a replica sync: its calls, and `whenReady` as the
 * caller supplies it. A call the engine cannot answer at all
 * (`EngineGoneError`) is the engine being unavailable.
 */
export function createEngineSeam(
	sync: Pick<ReplicaSync, 'call'>,
	whenReady: EngineSeam['whenReady']
): EngineSeam {
	return {
		call: <T>(method: string, params: unknown, signal?: AbortSignal, transfer?: ArrayBuffer[]) =>
			sync
				.call<T>(method, params, {
					...(signal === undefined ? {} : { signal }),
					...(transfer === undefined ? {} : { transfer })
				})
				.catch((error: unknown) => {
					if (error instanceof EngineGoneError) throw new EngineUnavailableError(error.message);
					throw error;
				}),
		whenReady
	};
}
