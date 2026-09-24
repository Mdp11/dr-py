import type { EngineSeam, Side, Surface } from '$lib/api/engine-route';
import { EngineGoneError } from './client';
import type { ReplicaSync } from './sync';

/** Per surface, whether the engine holds what that surface reads yet. */
export type SurfaceGates = Partial<Record<Surface, () => boolean>>;

/**
 * The engine seam over a replica sync. A surface is on the engine when its
 * switch says so, its gate (if any) is open and the replica is neither `off`
 * nor `server`; a read the engine cannot answer at all (`EngineGoneError`) is
 * the server's.
 */
export function createEngineSeam(
	sync: Pick<ReplicaSync, 'call' | 'status'>,
	surfaces: Readonly<Record<Surface, Side>>,
	shadow?: EngineSeam['shadow'],
	gates: SurfaceGates = {}
): EngineSeam {
	const switches = { ...surfaces };
	return {
		side(surface) {
			if (switches[surface] !== 'engine') return 'server';
			if (gates[surface]?.() === false) return 'server';
			const { phase } = sync.status();
			return phase === 'off' || phase === 'server' ? 'server' : 'engine';
		},
		call: <T>(method: string, params: unknown, signal?: AbortSignal) =>
			sync.call<T>(method, params, signal === undefined ? {} : { signal }),
		gone: (error) => error instanceof EngineGoneError,
		...(shadow === undefined ? {} : { shadow })
	};
}
