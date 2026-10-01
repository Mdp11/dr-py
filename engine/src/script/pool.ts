// The pool of script workers, for any host that can spawn one: it is written against `WorkerPort`,
// never a Worker. A worker boots, waits as a spare, runs exactly ONE batch and is terminated, so no
// interpreter or JS state of one script reaches another. What a worker posts is untrusted beyond its
// own batch: a forged message can change only the answer of the batch that worker holds. Workers boot
// from a memory image of Pyodide with the guest loaded, which one more worker, the maker, takes once
// per pool and which runs no batch; each worker gets a copy of the image of its own.
import { utf8Encoder } from '../export/utf8.ts';
import type { Value } from '../value/types.ts';
import { createReplyBuffer, ReplyWriter } from './bridge-buffer.ts';
import { DEFAULT_HARNESS_LIMITS, type HarnessLimits } from './guest.ts';
import { hostErrorResults, hostErrorText, type HostErrorKind } from './host-error.ts';
import type { Bridge, RawScriptResult, ScriptBatch, ScriptHost, ScriptRun } from './host.ts';
import { channelView, INTERRUPT_BYTES, raiseAgain, stopWindow, windowEnded } from './interrupt.ts';
import { batchToWire } from './wire.ts';

/** What the pool holds of a worker. The handlers are set once, straight after the spawn. */
export type WorkerPort = {
	/** `transfer` lists the buffers the message moves to the worker instead of copying. */
	post(message: unknown, transfer?: ArrayBuffer[]): void;
	onMessage(handler: (message: unknown) => void): void;
	onError(handler: (message: string) => void): void;
	terminate(): void;
};

/** Starts a worker that will be `init`ed with these buffers. */
export type WorkerSpawner = (buffers: {
	reply: SharedArrayBuffer;
	interrupt: SharedArrayBuffer;
}) => WorkerPort;

/**
 * `callMs` is a call's wall limit and `batchMs` the batch's; a call's deadline is the lesser of
 * `callMs` and what remains of `batchMs`. `graceMs` is how long a soft-stopped call has to end before
 * its worker is. `bootMs` is how long a worker has to boot.
 */
export type RunLimits = {
	callMs: number;
	batchMs: number;
	graceMs: number;
	bootMs: number;
} & HarnessLimits;

export const DEFAULT_RUN_LIMITS: RunLimits = Object.freeze({
	callMs: 10_000,
	batchMs: 30_000,
	graceMs: 1_500,
	bootMs: 30_000,
	...DEFAULT_HARNESS_LIMITS
});

export type PoolOptions = {
	/** The most workers alive at once, booting, spare or running. */
	cap: number;
	/** How long a spare beyond the first stays once no run waits. */
	spareIdleMs?: number;
	limits?: Partial<RunLimits>;
	now(): number;
	/** Called with each CSP violation a worker reports; a throw is ignored. */
	onViolation?(violation: { directive: string; blocked: string }): void;
	/** Called once, when the pool gives up on booting workers from an image and boots them cold. */
	onWarning?(message: string): void;
	/** `false` boots every worker cold, without a maker. Default `true`. */
	snapshots?: boolean;
};

const DEFAULT_SPARE_IDLE_MS = 30_000;

/** The pool's size for `parallelism` cores: two are left to the engine and the page, and it is between one and four. */
export function poolCap(parallelism: number): number {
	return Math.max(1, Math.min(4, parallelism - 2));
}

type Settle<T> = { resolve(value: T): void; reject(error: Error): void };

/** A run that has not got a worker yet, or the one it got. */
type Waiting = Settle<ScriptRun> & { batch: ScriptBatch; bridge: Bridge; slot: Slot | null };

type Stop = 'timeout' | 'cancelled';

type Timer = unknown;

/**
 * The run a worker holds. A window is a stretch in which a script's code runs, as in
 * `interrupt.ts`: 0 is the module-level code of an embedded run, call `i` is `i + 1`. Each timer is
 * armed and cleared only here and in `end`.
 */
type Active = {
	waiting: Waiting;
	trips: number;
	startedAt: number;
	/** What each ended call answered, for a run that ends without a `done`. */
	texts: (string | undefined)[];
	/** The window the worker is in; `null` between windows. */
	window: number | null;
	/** The index `call-start` must carry next: -1 is the module-level code of an embedded run. */
	next: number;
	/** The windows the pool stopped, by window. */
	stopped: Map<number, Stop>;
	cancelled: boolean;
	/** Soft stop of the current window. */
	deadline: Timer | null;
	/** Raises the interrupt again while a stopped window has not ended. */
	retry: Timer | null;
	/** Hard stop, after a soft stop. */
	grace: Timer | null;
	/** Hard stop of a run that outlives its batch budget, whatever the worker says. */
	watchdog: Timer | null;
};

type Slot = {
	readonly port: WorkerPort;
	readonly writer: ReplyWriter;
	/** The reply buffer's header, to see whether a reply is in flight. */
	readonly reply: Int32Array;
	readonly channel: Int32Array;
	/** A worker that has not said `ready` (or, the maker, `snapshot`) by `bootMs` is ended. */
	bootTimer: Timer | null;
	/** `ended` is final: nothing the worker says after it is read. */
	phase: 'booting' | 'ready' | 'running' | 'ended' | 'making';
	/** It was given the image to boot from. */
	imaged: boolean;
	bootMs: number;
	boot: 'snapshot' | 'cold';
	readyAt: number;
	active: Active | null;
};

type Timers = {
	setTimeout(handler: () => void, ms: number): Timer;
	clearTimeout(handle: Timer): void;
};

/** `ArrayBuffer` across realms: a worker's message is rebuilt in the receiver's. */
const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
	Object.prototype.toString.call(value) === '[object ArrayBuffer]';

const timers = () => globalThis as unknown as Timers;

/** Clears `handle` if it is armed, and answers `null` to store. */
function clearTimer(handle: Timer | null): null {
	if (handle !== null) timers().clearTimeout(handle);
	return null;
}

/** Text that says a worker ran out of memory, as a crash of it reports it. */
const OUT_OF_MEMORY =
	/MemoryError|out of memory|memory limit|allocation failed|Cannot enlarge memory|could not allocate memory|\bOOM\b/i;

const CANCELLED_MESSAGE = 'the run was cancelled';
const MEMORY_MESSAGE = 'guest exceeded its memory budget';

/** A console run answers as one; an embedded run carries module-level code, timed as window 0. */
const isConsole = (batch: ScriptBatch) => batch.console === true || batch.entry === 'script';

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

type Message = { [key: string]: unknown };

const isRecord = (value: unknown): value is Message =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** What a run answers that was cancelled before it had a worker. */
function cancelledRun(batch: ScriptBatch): ScriptRun {
	return {
		results: hostErrorResults(batch, 'cancelled', CANCELLED_MESSAGE),
		trips: 0,
		ms: 0,
		bootMs: 0,
		boot: 'cold'
	};
}

/** A name for a message's type that is safe to put in an error. */
const describeType = (type: unknown) =>
	typeof type === 'string' ? JSON.stringify(type.slice(0, 40)) : 'untyped';

/** The elements an input names, in the order it lists them. */
function inputElementIds(inputs: Value | undefined): string[] {
	if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) return [];
	const ids: string[] = [];
	for (const spec of Object.values(inputs) as { kind?: Value; ids?: Value }[]) {
		if (spec?.kind === 'elements' && Array.isArray(spec.ids)) {
			for (const id of spec.ids) if (typeof id === 'string') ids.push(id);
		}
	}
	return ids;
}

/**
 * Each call's roots text: its elements and its input elements, once each, projected by the
 * bridge; `'[]'` for a transform, for a console run (which reads no roots) and for a call with
 * nothing to project.
 */
function rootsOf(batch: ScriptBatch, bridge: Bridge, readMemoMax: number): string[] {
	const consoleRun = batch.console === true || batch.entry === 'script';
	return batch.calls.map((call) => {
		if (batch.entry === 'transform' || consoleRun || readMemoMax <= 0) return '[]';
		const ids = [...new Set([...call.elementIds, ...inputElementIds(call.inputs)])];
		return ids.length > 0 ? bridge.roots(ids) : '[]';
	});
}

/**
 * The pool over `spawn`. The first worker it spawns comes with a maker: a worker that boots cold,
 * loads the guest without binding anything of the host, posts the image of its memory and is ended,
 * and every worker spawned after the image arrives boots from a copy of it (`boot: 'snapshot'`).
 * The maker holds no slot of the cap and is sent no batch. While it works no spare is kept ahead,
 * so the first spare is the first from an image. A maker or an image that fails, here or in a
 * worker, ends images for the pool's life: every worker boots cold and `onWarning` is told once.
 * It keeps `min(cap, running + waiting + 1)` workers alive: one for each
 * run that waits (FIFO) and one spare ahead, which is also the one spare it keeps when idle; spares
 * beyond one (a run that never started, or was cancelled while it waited, leaves one) end after
 * `spareIdleMs` without a waiting run. A boot that fails, or takes longer than `bootMs`, fails one
 * waiting run, or the pending `boot()`s if none waits, and stops every spawn that no run or `boot()`
 * asked for, until a worker boots.
 *
 * Calls are timed from the pool's side, by the windows the worker reports (`call-start`,
 * `call-end`). A call's deadline is `min(callMs, what remains of batchMs)`. At it the interrupt is
 * raised for that call (the soft stop) and the batch moves on in the same worker; `graceMs` later a
 * call still not ended ends its worker (the hard stop) and every call not ended answers `timeout`.
 * A cancel does the same, answering `cancelled`, and ends the worker when the stopped call ends.
 * Only a call the pool stopped is rewritten: what the worker says of the others is what they answer.
 */
export function createPool(spawn: WorkerSpawner, options: PoolOptions): ScriptHost {
	const cap = Math.max(1, Math.floor(options.cap));
	const spareIdleMs = options.spareIdleMs ?? DEFAULT_SPARE_IDLE_MS;
	const limits: RunLimits = { ...DEFAULT_RUN_LIMITS, ...options.limits };
	const timeoutMessage = `execution exceeded the wall timeout of ${limits.callMs / 1000}s`;
	const retryMs = Math.max(10, Math.min(100, Math.floor(limits.graceMs / 4)));
	const stopMessage = (stop: HostErrorKind) =>
		stop === 'cancelled' ? CANCELLED_MESSAGE : timeoutMessage;
	const harness: HarnessLimits = {
		stdoutChars: limits.stdoutChars,
		reprChars: limits.reprChars,
		readMemoMax: limits.readMemoMax
	};
	const { now } = options;
	const encoder = utf8Encoder();

	const slots = new Set<Slot>();
	const queue: Waiting[] = [];
	let bootWaiters: Settle<{ ms: number }>[] = [];
	let disposed = false;
	// Something asked for a worker, so one spare is kept from now on.
	let warm = false;
	// A boot failed and none has succeeded since: nothing is spawned unasked.
	let held = false;
	let trimTimer: unknown = null;
	// 'idle': no maker yet; 'making': the maker works; 'ready': `image` is kept; 'off': cold boots.
	let imaging: 'idle' | 'making' | 'ready' | 'off' = options.snapshots === false ? 'off' : 'idle';
	let image: ArrayBuffer | null = null;
	let maker: Slot | null = null;

	const count = (phase: Slot['phase']) => [...slots].filter((slot) => slot.phase === phase).length;
	const unassigned = () => count('booting') + count('ready');
	/** The ready spares, the longest idle first. */
	const spares = () =>
		[...slots].filter((slot) => slot.phase === 'ready').sort((a, b) => a.readyAt - b.readyAt);

	function end(slot: Slot): void {
		if (slot.phase === 'ended') return;
		slot.phase = 'ended';
		slots.delete(slot);
		slot.bootTimer = clearTimer(slot.bootTimer);
		const { active } = slot;
		if (active !== null) {
			active.deadline = clearTimer(active.deadline);
			active.retry = clearTimer(active.retry);
			active.grace = clearTimer(active.grace);
			active.watchdog = clearTimer(active.watchdog);
		}
		try {
			slot.port.terminate();
		} catch {
			// Already gone.
		}
	}

	/** Boots cold from now on, and says so once. */
	function giveUp(reason: string): void {
		if (imaging === 'off') return;
		imaging = 'off';
		image = null;
		if (maker !== null) end(maker);
		maker = null;
		try {
			options.onWarning?.(`script workers boot cold: ${reason}`);
		} catch {
			// A warning that throws changes nothing.
		}
		fill();
	}

	/** A worker that failed to boot, or was never made. */
	function bootFailed(error: Error): void {
		held = true;
		const coming = unassigned();
		if (queue.length > coming) queue.shift()?.reject(error);
		if (coming === 0) {
			const waiters = bootWaiters;
			bootWaiters = [];
			for (const waiter of waiters) waiter.reject(error);
		}
	}

	/**
	 * What each call of `active` answers: the pool's stop for a call it stopped (every call, if it
	 * stopped the module-level code), else `given[i]`, else `failure`.
	 */
	function answers(
		active: Active,
		given: readonly (string | undefined)[],
		failure: { kind: HostErrorKind; message: string }
	): RawScriptResult[] {
		const { batch } = active.waiting;
		const opening = active.stopped.get(0);
		return batch.calls.map((_, i) => {
			const stop = opening ?? active.stopped.get(i + 1);
			if (stop !== undefined) return { text: hostErrorText(batch, stop, stopMessage(stop)) };
			return { text: given[i] ?? hostErrorText(batch, failure.kind, failure.message) };
		});
	}

	/** Settles the run `slot` holds; the caller has ended the slot. */
	function settle(slot: Slot, active: Active, results: readonly RawScriptResult[], ms?: number) {
		active.waiting.resolve({
			results,
			trips: active.trips,
			ms: ms ?? now() - active.startedAt,
			bootMs: slot.bootMs,
			boot: slot.boot
		});
	}

	/** Ends `slot` for `error`: the calls of a run it held that had not ended answer as failed. */
	function lose(slot: Slot, error: Error, crashed = false): void {
		const { phase, active } = slot;
		if (phase === 'ended') return;
		if (phase === 'making') {
			giveUp(`the snapshot could not be made: ${error.message}`);
			return;
		}
		end(slot);
		if (phase === 'booting' && slot.imaged && imaging === 'ready') {
			// Not yet a boot that cannot work: the image may be what it could not use.
			giveUp(`a worker could not boot from the snapshot: ${error.message}`);
			return;
		}
		if (phase === 'booting') bootFailed(error);
		else if (phase === 'ready') held = true;
		else if (active !== null) {
			// `crashed`: the text is the worker's own, so it may say the worker ran out of memory.
			const failure: { kind: HostErrorKind; message: string } = active.cancelled
				? { kind: 'cancelled', message: CANCELLED_MESSAGE }
				: crashed && OUT_OF_MEMORY.test(error.message)
					? { kind: 'memory', message: MEMORY_MESSAGE }
					: { kind: 'runtime', message: error.message };
			settle(slot, active, answers(active, active.texts, failure));
		}
		fill();
	}

	/** Ends the worker of a running run, for want of a stop that works: what has not ended answers `kind`. */
	function hardStop(slot: Slot, kind: Stop): void {
		const { active } = slot;
		if (slot.phase !== 'running' || active === null) return;
		if (active.window !== null && !active.stopped.has(active.window)) {
			active.stopped.set(active.window, kind);
		}
		end(slot);
		settle(slot, active, answers(active, active.texts, { kind, message: stopMessage(kind) }));
		fill();
	}

	const buffers = () => ({
		reply: createReplyBuffer(),
		interrupt: new SharedArrayBuffer(INTERRUPT_BYTES)
	});

	/** A slot over a worker just spawned, with its boot deadline running. */
	function slotOf(
		port: WorkerPort,
		made: ReturnType<typeof buffers>,
		phase: 'booting' | 'making',
		imaged: boolean
	): Slot {
		const slot: Slot = {
			port,
			writer: new ReplyWriter(made.reply),
			reply: new Int32Array(made.reply, 0, 4),
			channel: channelView(made.interrupt),
			bootTimer: null,
			phase,
			imaged,
			bootMs: 0,
			boot: 'cold',
			readyAt: 0,
			active: null
		};
		slot.bootTimer = timers().setTimeout(() => {
			slot.bootTimer = null;
			if (slot.phase === 'booting' || slot.phase === 'making') {
				lose(slot, new Error(`the script worker did not boot within ${limits.bootMs / 1000}s`));
			}
		}, limits.bootMs);
		return slot;
	}

	function startMaker(): void {
		imaging = 'making';
		const made = buffers();
		let port: WorkerPort | undefined;
		try {
			port = spawn(made);
			const mine = slotOf(port, made, 'making', false);
			maker = mine;
			port.onMessage((data) => onMessage(mine, data));
			port.onError((text) => lose(mine, new Error(text), true));
			port.post({ type: 'init', ...made, limits: harness, make: true });
		} catch (error) {
			if (maker !== null) end(maker);
			else endPort(port);
			maker = null;
			giveUp(`the snapshot could not be made: ${toError(error).message}`);
		}
	}

	/** Ends a worker that never got a slot. */
	function endPort(port: WorkerPort | undefined): void {
		try {
			port?.terminate();
		} catch {
			// Already gone.
		}
	}

	function spawnOne(): void {
		const made = buffers();
		let port: WorkerPort | undefined;
		let slot: Slot | undefined;
		try {
			// Its own copy, moved: no worker shares bytes with the pool or with another worker. Taken
			// before the spawn, so a copy that fails leaves no thread behind.
			const copy = image?.slice(0);
			port = spawn(made);
			slot = slotOf(port, made, 'booting', copy !== undefined);
			slots.add(slot);
			const mine = slot;
			port.onMessage((data) => onMessage(mine, data));
			port.onError((text) => lose(mine, new Error(text), true));
			port.post(
				{
					type: 'init',
					...made,
					limits: harness,
					...(copy !== undefined && { snapshot: copy })
				},
				copy === undefined ? [] : [copy]
			);
			if (imaging === 'idle') startMaker();
		} catch (error) {
			if (slot !== undefined) end(slot);
			else endPort(port);
			bootFailed(toError(error));
		}
	}

	/** One worker on its way, for a `boot()` or `prewarm()`. */
	function ensureOne(): void {
		// While the maker works, a spare waits for its image unless nothing is alive.
		if (imaging === 'making' && slots.size > 0) return;
		if (unassigned() === 0 && slots.size < cap) spawnOne();
	}

	function start(slot: Slot, waiting: Waiting): void {
		let roots: string[];
		try {
			roots = rootsOf(waiting.batch, waiting.bridge, limits.readMemoMax);
		} catch (error) {
			waiting.reject(toError(error));
			return;
		}
		slot.phase = 'running';
		const active: Active = {
			waiting,
			trips: 0,
			startedAt: now(),
			texts: waiting.batch.calls.map(() => undefined),
			window: null,
			next: isConsole(waiting.batch) ? 0 : -1,
			stopped: new Map(),
			cancelled: false,
			deadline: null,
			retry: null,
			grace: null,
			watchdog: null
		};
		slot.active = active;
		waiting.slot = slot;
		// Whatever the worker says, it does not outlive its batch's budget and one grace.
		active.watchdog = timers().setTimeout(() => {
			active.watchdog = null;
			if (slot.active === active) hardStop(slot, active.cancelled ? 'cancelled' : 'timeout');
		}, limits.batchMs + limits.graceMs);
		try {
			slot.port.post({ type: 'run', batch: batchToWire(waiting.batch), roots });
		} catch (error) {
			lose(slot, toError(error));
		}
	}

	/** Gives waiting runs the spares, then spawns what the state asks for. */
	function fill(): void {
		if (disposed) return;
		for (let slot = spares()[0]; queue.length > 0 && slot !== undefined; slot = spares()[0]) {
			const waiting = queue.shift();
			if (waiting !== undefined) start(slot, waiting);
		}
		while (queue.length > count('booting') && slots.size < cap) spawnOne();
		if (warm && !held && imaging !== 'making') {
			// A run waiting is served by its own worker, and one more is kept ahead.
			while (!held && !disposed && unassigned() <= queue.length && slots.size < cap) spawnOne();
		} else if (queue.length === 0 && bootWaiters.length > 0) ensureOne();
		scheduleTrim();
	}

	function scheduleTrim(): void {
		if (trimTimer !== null || disposed) return;
		const extra = spares().slice(1);
		if (extra.length === 0) return;
		const due = Math.min(...extra.map((slot) => slot.readyAt + spareIdleMs)) - now();
		trimTimer = timers().setTimeout(trim, Math.max(1, due));
	}

	function trim(): void {
		trimTimer = null;
		if (disposed) return;
		if (queue.length === 0) {
			const at = now();
			for (const slot of spares().slice(1)) if (at - slot.readyAt >= spareIdleMs) end(slot);
		}
		scheduleTrim();
	}

	function onMessage(slot: Slot, data: unknown): void {
		if (slot.phase === 'ended') return;
		const message: Message = isRecord(data) ? data : {};
		const { type } = message;
		if (type === 'csp-violation') {
			const { directive, blocked } = message;
			if (typeof directive === 'string' && typeof blocked === 'string') {
				try {
					options.onViolation?.({ directive, blocked });
				} catch {
					// A report that cannot be made changes nothing, and must not throw into the host's message loop.
				}
			}
			return;
		}
		if (slot.phase === 'making') {
			onMaker(message);
			return;
		}
		if (type === 'failed') {
			lose(
				slot,
				new Error(
					typeof message.message === 'string' ? message.message : 'the script worker failed'
				),
				true
			);
			return;
		}
		if (slot.phase === 'booting' && type === 'ready') onReady(slot, message);
		else if (slot.phase === 'running' && slot.active !== null)
			onRunning(slot, slot.active, message);
		else lose(slot, new Error(`the script worker sent ${describeType(type)} while ${slot.phase}`));
	}

	function onMaker(message: Message): void {
		const { type, bytes } = message;
		if (type === 'failed') {
			giveUp(
				`the snapshot could not be made: ${typeof message.message === 'string' ? message.message : 'the maker failed'}`
			);
		} else if (type === 'snapshot' && isArrayBuffer(bytes) && bytes.byteLength > 0) {
			if (maker !== null) end(maker);
			maker = null;
			image = bytes;
			imaging = 'ready';
			fill();
		} else {
			giveUp(`the snapshot maker sent ${describeType(type)}`);
		}
	}

	function onReady(slot: Slot, message: Message): void {
		const { ms, boot } = message;
		if (
			typeof ms !== 'number' ||
			!Number.isFinite(ms) ||
			ms < 0 ||
			(boot !== 'snapshot' && boot !== 'cold')
		) {
			lose(slot, new Error('the script worker sent a bad ready'));
			return;
		}
		slot.bootTimer = clearTimer(slot.bootTimer);
		slot.phase = 'ready';
		slot.bootMs = ms;
		slot.boot = boot;
		slot.readyAt = now();
		held = false;
		const waiters = bootWaiters;
		bootWaiters = [];
		for (const waiter of waiters) waiter.resolve({ ms });
		fill();
		if (slot.imaged && boot === 'cold') giveUp('a worker could not boot from the snapshot');
	}

	function onRunning(slot: Slot, active: Active, message: Message): void {
		const { batch, bridge } = active.waiting;
		switch (message.type) {
			case 'bridge': {
				if (typeof message.text !== 'string') break;
				// An honest worker posts a request with its reply state armed at 0 and no chunk pending.
				if (slot.writer.pending || Atomics.load(slot.reply, 0) !== 0) {
					lose(
						slot,
						new Error('the script worker sent a bridge request while a reply was in flight')
					);
					return;
				}
				// The worker is blocked until a reply is written, so a bridge that throws ends it.
				let reply: Uint8Array;
				active.trips++;
				try {
					reply = encoder.encode(bridge.dispatch(message.text));
				} catch (error) {
					lose(slot, new Error(`the bridge failed: ${toError(error).message}`));
					return;
				}
				slot.writer.begin(reply);
				return;
			}
			case 'more':
				// Asked for after a chunk was copied and the state reset, and only while chunks remain.
				if (!slot.writer.pending || Atomics.load(slot.reply, 0) !== 0) {
					lose(slot, new Error('the script worker asked for a chunk that is not pending'));
					return;
				}
				slot.writer.more();
				return;
			case 'call-start': {
				const { i } = message;
				if (!isWindow(i, batch) || active.window !== null || i !== active.next) break;
				active.window = i + 1;
				active.next = i + 1;
				const remaining = limits.batchMs - (now() - active.startedAt);
				if (remaining <= 0) {
					// The batch's budget is spent: nothing more runs, as on a dead session.
					hardStop(slot, 'timeout');
					return;
				}
				const n = active.window;
				active.deadline = timers().setTimeout(
					() => onDeadline(slot, active, n),
					Math.min(limits.callMs, remaining)
				);
				return;
			}
			case 'call-end': {
				const { i, text } = message;
				if (!isWindow(i, batch) || typeof text !== 'string' || active.window !== i + 1) break;
				active.deadline = clearTimer(active.deadline);
				active.retry = clearTimer(active.retry);
				active.grace = clearTimer(active.grace);
				active.window = null;
				if (i >= 0) active.texts[i] = text;
				// A cancelled run, or module-level code the pool stopped (the calls would all answer its
				// failure), has nothing more to run.
				if (active.cancelled) hardStop(slot, 'cancelled');
				else if (active.stopped.has(0)) hardStop(slot, 'timeout');
				return;
			}
			case 'done': {
				const results = doneResults(message, batch);
				if (typeof results === 'string' || active.window !== null) {
					lose(
						slot,
						new Error(typeof results === 'string' ? results : 'the script worker ended mid-call')
					);
					return;
				}
				end(slot);
				const given = results.results.map((one) => one.text);
				settle(
					slot,
					active,
					answers(active, given, { kind: 'runtime', message: 'the script worker gave no result' }),
					results.ms
				);
				fill();
				return;
			}
		}
		lose(slot, new Error(`the script worker sent a bad ${describeType(message.type)}`));
	}

	/** A call index a worker may report: -1 is the module-level code of an embedded run. */
	function isWindow(i: unknown, batch: ScriptBatch): i is number {
		return (
			typeof i === 'number' &&
			Number.isInteger(i) &&
			i >= (isConsole(batch) ? 0 : -1) &&
			i < batch.calls.length
		);
	}

	/** The soft stop: the window `n` outlived its deadline. */
	function onDeadline(slot: Slot, active: Active, n: number): void {
		if (slot.phase !== 'running' || slot.active !== active || active.window !== n) return;
		active.deadline = null;
		// A lost race means the call ended a moment ago and its `call-end` is on its way; the hard
		// stop is armed all the same, and `call-end` disarms it.
		if (stopWindow(slot.channel, n)) {
			active.stopped.set(n, 'timeout');
			armRetry(slot, active, n);
		}
		armGrace(slot, active, n);
	}

	/**
	 * An interrupt raised once can be lost: Pyodide's `_Py_CheckEmscriptenSignals_Helper`
	 * (`pyodide.asm.mjs`) reads the flag and then clears it, not atomically, so a store between the
	 * two never reaches Python. So it is raised again, over the grace, until the call ends. The
	 * retry can also re-interrupt a script's own `KeyboardInterrupt` cleanup that outlasts it.
	 */
	function armRetry(slot: Slot, active: Active, n: number): void {
		active.retry = timers().setTimeout(() => {
			active.retry = null;
			if (slot.phase !== 'running' || slot.active !== active || active.window !== n) return;
			if (raiseAgain(slot.channel, n)) armRetry(slot, active, n);
		}, retryMs);
	}

	function armGrace(slot: Slot, active: Active, n: number, deferred = false): void {
		if (active.grace !== null) return;
		active.grace = timers().setTimeout(() => {
			active.grace = null;
			if (slot.phase !== 'running' || slot.active !== active || active.window !== n) return;
			// Timers run before messages: a pool thread that was busy past the grace sees the grace
			// first, with the `call-end` of a worker that ended its call in time still queued. The
			// worker's own word says so, and the `call-end` gets one more period.
			if (!deferred && windowEnded(slot.channel, n)) armGrace(slot, active, n, true);
			else hardStop(slot, active.cancelled ? 'cancelled' : 'timeout');
		}, limits.graceMs);
	}

	/** Stops the run `slot` holds: the soft stop of its call, then the hard stop. */
	function cancelRun(slot: Slot): void {
		const { active } = slot;
		if (slot.phase !== 'running' || active === null || active.cancelled) return;
		active.cancelled = true;
		const n = active.window;
		// No script code runs between windows: nothing to interrupt.
		if (n === null) {
			hardStop(slot, 'cancelled');
			return;
		}
		active.deadline = clearTimer(active.deadline);
		if (stopWindow(slot.channel, n)) {
			active.stopped.set(n, 'cancelled');
			armRetry(slot, active, n);
		}
		armGrace(slot, active, n);
	}

	/** What a `done` holds, or why it is refused. */
	function doneResults(
		message: Message,
		batch: ScriptBatch
	): { results: RawScriptResult[]; ms: number } | string {
		const { results, ms } = message;
		if (!Array.isArray(results) || results.length !== batch.calls.length) {
			return `the script worker answered ${Array.isArray(results) ? results.length : 'no'} results for ${batch.calls.length} calls`;
		}
		const texts: RawScriptResult[] = [];
		for (const one of results as unknown[]) {
			if (!isRecord(one) || typeof one.text !== 'string') {
				return 'the script worker answered a result without text';
			}
			texts.push({ text: one.text });
		}
		if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
			return 'the script worker sent a bad run time';
		}
		return { results: texts, ms };
	}

	return {
		boot() {
			if (disposed) return Promise.reject(new Error('script host is disposed'));
			warm = true;
			const spare = spares()[0];
			if (spare !== undefined) return Promise.resolve({ ms: spare.bootMs });
			return new Promise((resolve, reject) => {
				bootWaiters.push({ resolve, reject });
				ensureOne();
			});
		},
		prewarm() {
			if (disposed) return;
			warm = true;
			ensureOne();
		},
		run(batch, bridge, signal) {
			if (disposed) return Promise.reject(new Error('script host is disposed'));
			if (signal?.aborted === true) return Promise.resolve(cancelledRun(batch));
			warm = true;
			return new Promise((resolve, reject) => {
				const onAbort = () => {
					const at = queue.indexOf(waiting);
					if (at >= 0) {
						// Still queued: it leaves, and no worker is spawned or consumed for it.
						queue.splice(at, 1);
						waiting.resolve(cancelledRun(batch));
						fill();
					} else if (waiting.slot !== null) cancelRun(waiting.slot);
				};
				const detach = () => signal?.removeEventListener('abort', onAbort);
				const waiting: Waiting = {
					batch,
					bridge,
					slot: null,
					resolve: (run) => (detach(), resolve(run)),
					reject: (error) => (detach(), reject(error))
				};
				signal?.addEventListener('abort', onAbort, { once: true });
				queue.push(waiting);
				fill();
			});
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			if (trimTimer !== null) timers().clearTimeout(trimTimer);
			trimTimer = null;
			const error = new Error('script host is disposed');
			if (maker !== null) end(maker);
			maker = null;
			image = null;
			for (const slot of [...slots]) {
				const { active } = slot;
				end(slot);
				active?.waiting.reject(error);
			}
			for (const waiting of queue.splice(0)) waiting.reject(error);
			const waiters = bootWaiters;
			bootWaiters = [];
			for (const waiter of waiters) waiter.reject(error);
		}
	};
}
