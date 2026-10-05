import { EngineUnavailableError } from '$lib/api/engine-route';

/**
 * Where the replica stands for a read: it can answer (`open`), will be able
 * to (`closed`: opening, re-bootstrapping or not yet swept), or never will
 * without a retry (`unavailable`, with the reason a caller is told).
 */
export type GateState =
	| { state: 'open' }
	| { state: 'closed' }
	| { state: 'unavailable'; reason: string };

export type Gate = {
	/**
	 * Resolves once the gate is open. A closed gate holds every caller on one
	 * promise per epoch — from the first caller to a closed gate to the gate
	 * leaving `closed` — which an open gate resolves and an unavailable one
	 * rejects with `EngineUnavailableError`. `signal` rejects one caller alone.
	 */
	whenReady(signal?: AbortSignal): Promise<void>;
	/** Reads the state again: called whenever something it reads moved. */
	moved(): void;
};

type Epoch = { promise: Promise<void>; open(): void; fail(error: Error): void };

const aborted = () => new DOMException('The operation was aborted.', 'AbortError');

/** A gate over `read`. */
export function createGate(read: () => GateState): Gate {
	let epoch: Epoch | null = null;

	return {
		whenReady(signal) {
			if (signal?.aborted) return Promise.reject(aborted());
			const state = read();
			if (state.state === 'open') return Promise.resolve();
			if (state.state === 'unavailable') {
				return Promise.reject(new EngineUnavailableError(state.reason));
			}
			if (epoch === null) {
				let open!: () => void;
				let fail!: (error: Error) => void;
				const promise = new Promise<void>((resolve, reject) => {
					open = resolve;
					fail = reject;
				});
				epoch = { promise, open, fail };
			}
			const shared = epoch.promise;
			if (signal === undefined) return shared;
			return new Promise<void>((resolve, reject) => {
				const onAbort = () => reject(aborted());
				signal.addEventListener('abort', onAbort, { once: true });
				shared.then(
					() => {
						signal.removeEventListener('abort', onAbort);
						resolve();
					},
					(error: unknown) => {
						signal.removeEventListener('abort', onAbort);
						reject(error);
					}
				);
			});
		},
		moved() {
			if (epoch === null) return;
			const state = read();
			if (state.state === 'closed') return;
			const settled = epoch;
			epoch = null;
			if (state.state === 'open') settled.open();
			else settled.fail(new EngineUnavailableError(state.reason));
		}
	};
}
