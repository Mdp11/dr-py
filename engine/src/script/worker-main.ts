// The body of a script worker: Pyodide and the guest, for ONE batch. The host-specific parts come in as
// parameters: how a message crosses, the global scope, and how Pyodide loads. The transport posts a
// request and BLOCKS on the reply buffer until the pool has written the whole reply, so this is the one
// place that calls `Atomics.wait`.
import { utf8Decoder } from '../snapshot/utf8.ts';
import { armReply, readReply } from './bridge-buffer.ts';
import {
	createGuest,
	DEFAULT_HARNESS_LIMITS,
	type Guest,
	type HarnessLimits,
	type Interpreter
} from './guest.ts';
import { batchFromWire, type WireBatch } from './wire.ts';

/** What a worker has of its host. */
export type WorkerScope = {
	post(message: unknown): void;
	onMessage(handler: (message: unknown) => void): void;
	globals: typeof globalThis;
};

/** The part of a loaded Pyodide the worker uses. */
type Pyodide = {
	runPython(code: string): unknown;
	globals: { get(name: string): unknown; set(name: string, value: unknown): void };
	setInterruptBuffer(buffer: Int32Array): void;
};

type Init = {
	reply: SharedArrayBuffer;
	interrupt: SharedArrayBuffer;
	limits?: HarnessLimits;
};

type Run = { batch: WireBatch; roots: string[] };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Serves one pool: `init` boots Pyodide and answers `ready`, `run` runs the one batch this worker
 * will ever hold and answers `done`. A second `run`, or one before `ready`, is refused with `failed`,
 * and the pool ends the worker on either.
 */
export function runWorker(
	scope: WorkerScope,
	loadPyodide: (options: object) => Promise<unknown>
): void {
	// Everything this worker says is built from these, bound before any script can run.
	const post = scope.post;
	const clock = (scope.globals as unknown as { performance: { now(): number } }).performance;
	const now = clock.now.bind(clock);
	const decoder = utf8Decoder();
	const fail = (error: unknown) => post({ type: 'failed', message: message(error) });

	let guest: Guest | null = null;
	let started = false;
	let ran = false;
	let trips = 0;

	async function init({ reply, interrupt, limits }: Init): Promise<void> {
		const t0 = now();
		const py = (await loadPyodide({})) as Pyodide;
		py.setInterruptBuffer(new Int32Array(interrupt));
		const interpreter: Interpreter = {
			runPython: (code) => py.runPython(code),
			globals: {
				get: (name) => py.globals.get(name),
				set: (name, value) => py.globals.set(name, value)
			}
		};
		// Armed before the post: a reply can land the instant the request is out, and arming
		// after would erase it and block for good.
		guest = createGuest(
			interpreter,
			(requestText) => {
				trips++;
				armReply(reply);
				post({ type: 'bridge', text: requestText });
				return decoder.decode(readReply(reply, () => post({ type: 'more' })));
			},
			limits ?? DEFAULT_HARNESS_LIMITS
		);
		post({ type: 'ready', ms: now() - t0, boot: 'cold' });
	}

	function run({ batch, roots }: Run): void {
		if (guest === null) throw new Error('the script worker is not booted');
		if (ran) throw new Error('the script worker already ran its batch');
		ran = true;
		trips = 0;
		const t0 = now();
		const results = guest.run(batchFromWire(batch), roots, {
			callStart: (i) => post({ type: 'call-start', i }),
			callEnd: (i) => post({ type: 'call-end', i })
		});
		post({ type: 'done', results, trips, ms: now() - t0 });
	}

	scope.onMessage((data) => {
		try {
			const { type } = data as { type?: unknown };
			if (type === 'init') {
				if (started) throw new Error('the script worker was initialised twice');
				started = true;
				init(data as Init).catch(fail);
			} else if (type === 'run') {
				run(data as Run);
			}
		} catch (error) {
			fail(error);
		}
	});
}
