// Workers that are scripts, not Pyodide: a spawner whose workers answer what a test tells them to,
// so the pool's protocol handling can be driven (and forged against) without a boot per worker.
import type { WorkerPort, WorkerSpawner } from '../../../src/script/pool.ts';

export type Message = { type?: unknown; [key: string]: unknown };

export type Fake = {
	readonly index: number;
	readonly buffers: { reply: SharedArrayBuffer; interrupt: SharedArrayBuffer };
	/** Everything the pool posted to it. */
	readonly posted: Message[];
	/** The transfer list of each post, in order. */
	readonly transfers: (ArrayBuffer[] | undefined)[];
	terminated: boolean;
	/** Delivers `message` to the pool, on a later turn, terminated or not: a dead worker's queue can still drain. */
	say(message: unknown): void;
	/** Delivers an `error` event. */
	crash(text: string): void;
};

export type Behaviour = (fake: Fake, message: Message) => void;

/** `ready` after `init`, and as many `text` results as calls after `run`. */
export const honest: Behaviour = (fake, message) => {
	if (message.type === 'init') fake.say({ type: 'ready', ms: 5, boot: 'cold' });
	else if (message.type === 'run') {
		const calls = (message.batch as { calls: unknown[] }).calls;
		fake.say({ type: 'done', results: calls.map((_, i) => ({ text: `r${i}` })), trips: 0, ms: 2 });
	}
};

/** Fake `i` answers with `behaviours[i]`, the last one for every fake after it. */
export function fakeWorkers(...behaviours: Behaviour[]) {
	const fakes: Fake[] = [];
	let peak = 0;
	const alive = () => fakes.filter((fake) => !fake.terminated).length;
	const spawn: WorkerSpawner = (buffers) => {
		let onMessage: (message: unknown) => void = () => {};
		let onError: (message: string) => void = () => {};
		const index = fakes.length;
		const fake: Fake = {
			index,
			buffers,
			posted: [],
			transfers: [],
			terminated: false,
			say: (message) => void setTimeout(() => onMessage(message), 0),
			crash: (text) => void setTimeout(() => onError(text), 0)
		};
		fakes.push(fake);
		peak = Math.max(peak, alive());
		const port: WorkerPort = {
			post(message, transfer) {
				const m = message as Message;
				fake.posted.push(m);
				fake.transfers.push(transfer);
				(behaviours[Math.min(index, behaviours.length - 1)] ?? honest)(fake, m);
			},
			onMessage: (handler) => void (onMessage = handler),
			onError: (handler) => void (onError = handler),
			terminate: () => void (fake.terminated = true)
		};
		return port;
	};
	return { spawn, fakes, alive, peak: () => peak };
}

/** Lets every pending message and timer of a fake run. */
export const settle = (ms = 30) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it holds, for up to `limitMs`. */
export async function until(check: () => boolean, limitMs = 3000): Promise<void> {
	const end = Date.now() + limitMs;
	while (!check()) {
		if (Date.now() > end) throw new Error('the condition did not hold in time');
		await settle(5);
	}
}
