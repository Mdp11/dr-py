import { spawnNodeWorker } from '../../../node/script-host.ts';
import type { WorkerPort, WorkerSpawner } from '../../../src/script/pool.ts';

export type Seen = {
	runs: number;
	terminated: boolean;
	/** It was told to make the snapshot: it serves no batch and holds no slot of the cap. */
	maker: boolean;
	messages: { type?: unknown; i?: unknown; at?: number }[];
};

/** `spawnNodeWorker`, counting what each worker is asked and says, and when it is ended. */
export function instrumented(inner: WorkerSpawner = spawnNodeWorker) {
	const seen: Seen[] = [];
	let peak = 0;
	const alive = () => seen.filter((one) => !one.terminated && !one.maker).length;
	const spawn: WorkerSpawner = (buffers) => {
		const port = inner(buffers);
		const here: Seen = { runs: 0, terminated: false, maker: false, messages: [] };
		seen.push(here);
		const wrapped: WorkerPort = {
			post(message, transfer) {
				const { type, make } = message as { type?: unknown; make?: unknown };
				if (type === 'run') here.runs++;
				if (type === 'init') {
					here.maker = make === true;
					peak = Math.max(peak, alive());
				}
				port.post(message, transfer);
			},
			onMessage: (handler) =>
				port.onMessage((message) => {
					here.messages.push({
						...(message as Seen['messages'][number]),
						at: Math.round(performance.now())
					});
					handler(message);
				}),
			onError: (handler) => port.onError(handler),
			terminate() {
				here.terminated = true;
				port.terminate();
			}
		};
		return wrapped;
	};
	return { spawn, seen, alive, peak: () => peak };
}
