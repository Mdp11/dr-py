// The body of a script worker: Pyodide and the guest, for ONE batch. The host-specific parts come in as
// parameters: how a message crosses, the global scope, and how Pyodide loads. The transport posts a
// request and BLOCKS on the reply buffer until the pool has written the whole reply, so this is the one
// place that calls `Atomics.wait`.
import { utf8Decoder } from '../snapshot/utf8.ts';
import { armReply, readReply } from './bridge-buffer.ts';
import {
	createGuest,
	DEFAULT_HARNESS_LIMITS,
	prepareGuest,
	type Guest,
	type HarnessLimits,
	type Interpreter
} from './guest.ts';
import { beginWindow, channelView, endWindow, flagView } from './interrupt.ts';
import { batchFromWire, type WireBatch } from './wire.ts';

/** What a worker has of its host. */
export type WorkerScope = {
	post(message: unknown, transfer?: ArrayBuffer[]): void;
	onMessage(handler: (message: unknown) => void): void;
	globals: typeof globalThis;
};

/** The part of a loaded Pyodide the worker uses. */
type Pyodide = {
	runPython(code: string): unknown;
	globals: { get(name: string): unknown; set(name: string, value: unknown): void };
	setInterruptBuffer(buffer: Int32Array): void;
	/** Pyodide's private image of its whole memory; it needs the `_makeSnapshot` boot option. */
	makeMemorySnapshot(): Uint8Array;
};

type Init = {
	reply: SharedArrayBuffer;
	interrupt: SharedArrayBuffer;
	limits?: HarnessLimits;
	/** An image to boot from; a boot that cannot use it is a cold one. */
	snapshot?: ArrayBuffer;
	/** Make an image and post it, and serve no batch. */
	make?: true;
};

type Run = { batch: WireBatch; roots: string[] };

const PINNED_NOW_MS = 1750000000000;
const PINNED_BYTE = 0x42;

/**
 * Makes the scope deterministic before any script can run: `Date.now`, `Date`'s local time (UTC, as
 * on the server) and `crypto.getRandomValues`. Pyodide reads all three, so `time`, `datetime`,
 * `os.urandom` and the first seed of `random` follow. Only the scope it is given changes.
 */
function pinScope(globals: typeof globalThis): void {
	// `crypto` is a DOM type the engine's sources do not see; every worker scope has it.
	const { Date: DateClass, crypto } = globals as unknown as {
		Date: DateConstructor;
		crypto: { getRandomValues<T>(array: T): T };
	};
	DateClass.now = () => PINNED_NOW_MS;
	// Emscripten's `localtime` reads these; the environment's `TZ` does not reach it.
	const date = DateClass.prototype;
	date.getSeconds = date.getUTCSeconds;
	date.getMinutes = date.getUTCMinutes;
	date.getHours = date.getUTCHours;
	date.getDate = date.getUTCDate;
	date.getMonth = date.getUTCMonth;
	date.getFullYear = date.getUTCFullYear;
	date.getDay = date.getUTCDay;
	date.getTimezoneOffset = () => 0;
	crypto.getRandomValues = (array) => {
		const view = array as unknown as ArrayBufferView;
		new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(PINNED_BYTE);
		return array;
	};
}

/** Every boot's options: a fixed hash seed, so `hash` and the order of a set are the same everywhere. */
const BOOT_OPTIONS = { env: { PYTHONHASHSEED: '0' } };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Serves one pool: `init` boots Pyodide and answers `ready`, `run` runs the one batch this worker
 * will ever hold and answers `done`. A second `run`, or one before `ready`, is refused with `failed`,
 * and the pool ends the worker on either. An `init` with `make` boots cold, runs the guest's
 * bootstrap, posts Pyodide's image of that state as `snapshot` and serves nothing: it never binds a
 * transport, so no script runs in it. An `init` with `snapshot` boots from the image and binds the
 * transport after the restore, and falls back to a cold boot when any part of that fails.
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
	let channel: Int32Array | null = null;
	let started = false;
	let ran = false;
	let trips = 0;

	const interpreterOf = (py: Pyodide): Interpreter => ({
		runPython: (code) => py.runPython(code),
		globals: {
			get: (name) => py.globals.get(name),
			set: (name, value) => py.globals.set(name, value)
		}
	});

	async function makeSnapshot(): Promise<void> {
		const py = (await loadPyodide({ ...BOOT_OPTIONS, _makeSnapshot: true })) as Pyodide;
		prepareGuest(interpreterOf(py));
		// A copy: the image is a view the interpreter may own, and what is posted is transferred.
		const bytes = py.makeMemorySnapshot().slice().buffer;
		post({ type: 'snapshot', bytes }, [bytes]);
	}

	async function boot({ reply, interrupt, limits, snapshot }: Init): Promise<'snapshot' | 'cold'> {
		const start = async (image: ArrayBuffer | undefined): Promise<Guest> => {
			const py = (await loadPyodide(
				image === undefined ? BOOT_OPTIONS : { ...BOOT_OPTIONS, _loadSnapshot: image }
			)) as Pyodide;
			// Set on a restored interpreter too: the image holds no interrupt buffer.
			py.setInterruptBuffer(flagView(interrupt));
			channel = channelView(interrupt);
			// Armed before the post: a reply can land the instant the request is out, and arming
			// after would erase it and block for good.
			return createGuest(
				interpreterOf(py),
				(requestText) => {
					trips++;
					armReply(reply);
					post({ type: 'bridge', text: requestText });
					return decoder.decode(readReply(reply, () => post({ type: 'more' })));
				},
				limits ?? DEFAULT_HARNESS_LIMITS,
				image !== undefined
			);
		};
		if (snapshot !== undefined) {
			try {
				guest = await start(snapshot);
				return 'snapshot';
			} catch {
				// The image cannot be used here; what the pool is told is that this boot was cold.
			}
		}
		guest = await start(undefined);
		return 'cold';
	}

	async function init(data: Init): Promise<void> {
		const t0 = now();
		pinScope(scope.globals);
		if (data.make === true) {
			await makeSnapshot();
			return;
		}
		const how = await boot(data);
		post({ type: 'ready', ms: now() - t0, boot: how });
	}

	function run({ batch, roots }: Run): void {
		if (guest === null) throw new Error('the script worker is not booted');
		if (ran) throw new Error('the script worker already ran its batch');
		ran = true;
		trips = 0;
		const t0 = now();
		const stops = channel;
		if (stops === null) throw new Error('the script worker is not booted');
		// Window `n` is the module-level code (`i` -1) or call `i`; the pool times each by these.
		const results = guest.run(batchFromWire(batch), roots, {
			callStart: (i) => {
				beginWindow(stops, i + 1);
				post({ type: 'call-start', i });
			},
			callEnd: (i, text) => {
				endWindow(stops, i + 1);
				post({ type: 'call-end', i, text });
			}
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
