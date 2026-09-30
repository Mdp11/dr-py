// The pool of script workers, for any host that can spawn one: it is written against `WorkerPort`,
// never a Worker. A worker boots, waits as a spare, runs exactly ONE batch and is terminated, so no
// interpreter or JS state of one script reaches another. What a worker posts is untrusted beyond its
// own batch: a forged message can change only the answer of the batch that worker holds.
import { utf8Encoder } from '../export/utf8.ts';
import type { Value } from '../value/types.ts';
import { createReplyBuffer, ReplyWriter } from './bridge-buffer.ts';
import { DEFAULT_HARNESS_LIMITS, type HarnessLimits } from './guest.ts';
import { hostErrorResults } from './host-error.ts';
import type { Bridge, RawScriptResult, ScriptBatch, ScriptHost, ScriptRun } from './host.ts';
import { batchToWire } from './wire.ts';

/** What the pool holds of a worker. The handlers are set once, straight after the spawn. */
export type WorkerPort = {
	post(message: unknown): void;
	onMessage(handler: (message: unknown) => void): void;
	onError(handler: (message: string) => void): void;
	terminate(): void;
};

/** Starts a worker that will be `init`ed with these buffers. */
export type WorkerSpawner = (buffers: {
	reply: SharedArrayBuffer;
	interrupt: SharedArrayBuffer;
}) => WorkerPort;

export type RunLimits = { callMs: number; batchMs: number; graceMs: number } & HarnessLimits;

export const DEFAULT_RUN_LIMITS: RunLimits = Object.freeze({
	callMs: 10_000,
	batchMs: 30_000,
	graceMs: 1_500,
	...DEFAULT_HARNESS_LIMITS
});

export type PoolOptions = {
	/** The most workers alive at once, booting, spare or running. */
	cap: number;
	/** How long a spare beyond the first stays once no run waits. */
	spareIdleMs?: number;
	limits?: Partial<RunLimits>;
	now(): number;
	/** Called with each CSP violation a worker reports. */
	onViolation?(violation: { directive: string; blocked: string }): void;
};

const DEFAULT_SPARE_IDLE_MS = 30_000;

type Settle<T> = { resolve(value: T): void; reject(error: Error): void };

/** A run that has not got a worker yet. */
type Waiting = Settle<ScriptRun> & { batch: ScriptBatch; bridge: Bridge };

/** The run a worker holds. */
type Active = { waiting: Waiting; trips: number; startedAt: number };

type Slot = {
	readonly port: WorkerPort;
	readonly writer: ReplyWriter;
	/** `ended` is final: nothing the worker says after it is read. */
	phase: 'booting' | 'ready' | 'running' | 'ended';
	bootMs: number;
	boot: 'snapshot' | 'cold';
	readyAt: number;
	active: Active | null;
};

type Timers = {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
};

const timers = () => globalThis as unknown as Timers;

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

type Message = { [key: string]: unknown };

const isRecord = (value: unknown): value is Message =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

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
 * The pool over `spawn`. It keeps `min(cap, running + waiting + 1)` workers alive: one for each
 * run that waits (FIFO) and one spare ahead, which is also the one spare it keeps when idle; spares
 * beyond one (a run that never started leaves one) end after `spareIdleMs` without a waiting run. A boot that
 * fails fails one waiting run, or the pending `boot()`s if none waits, and stops every spawn that
 * no run or `boot()` asked for, until a worker boots.
 */
export function createPool(spawn: WorkerSpawner, options: PoolOptions): ScriptHost {
	const cap = Math.max(1, Math.floor(options.cap));
	const spareIdleMs = options.spareIdleMs ?? DEFAULT_SPARE_IDLE_MS;
	const limits: RunLimits = { ...DEFAULT_RUN_LIMITS, ...options.limits };
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

	const count = (phase: Slot['phase']) => [...slots].filter((slot) => slot.phase === phase).length;
	const unassigned = () => count('booting') + count('ready');
	/** The ready spares, the longest idle first. */
	const spares = () =>
		[...slots].filter((slot) => slot.phase === 'ready').sort((a, b) => a.readyAt - b.readyAt);

	function end(slot: Slot): void {
		if (slot.phase === 'ended') return;
		slot.phase = 'ended';
		slots.delete(slot);
		try {
			slot.port.terminate();
		} catch {
			// Already gone.
		}
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

	/** Ends `slot` for `error`: a run it held answers every call as failed. */
	function lose(slot: Slot, error: Error): void {
		const { phase, active } = slot;
		if (phase === 'ended') return;
		end(slot);
		if (phase === 'booting') bootFailed(error);
		else if (phase === 'ready') held = true;
		else if (active !== null) {
			active.waiting.resolve({
				results: hostErrorResults(active.waiting.batch, 'runtime', error.message),
				trips: active.trips,
				ms: now() - active.startedAt,
				bootMs: slot.bootMs,
				boot: slot.boot
			});
		}
		fill();
	}

	function spawnOne(): void {
		const buffers = { reply: createReplyBuffer(), interrupt: new SharedArrayBuffer(4) };
		let slot: Slot | undefined;
		try {
			const port = spawn(buffers);
			slot = {
				port,
				writer: new ReplyWriter(buffers.reply),
				phase: 'booting',
				bootMs: 0,
				boot: 'cold',
				readyAt: 0,
				active: null
			};
			slots.add(slot);
			const mine = slot;
			port.onMessage((data) => onMessage(mine, data));
			port.onError((text) => lose(mine, new Error(text)));
			port.post({ type: 'init', ...buffers, limits: harness });
		} catch (error) {
			if (slot !== undefined) end(slot);
			bootFailed(toError(error));
		}
	}

	/** One worker on its way, for a `boot()` or `prewarm()`. */
	function ensureOne(): void {
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
		slot.active = { waiting, trips: 0, startedAt: now() };
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
		if (warm && !held) {
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
				options.onViolation?.({ directive, blocked });
			}
			return;
		}
		if (type === 'failed') {
			lose(
				slot,
				new Error(
					typeof message.message === 'string' ? message.message : 'the script worker failed'
				)
			);
			return;
		}
		if (slot.phase === 'booting' && type === 'ready') onReady(slot, message);
		else if (slot.phase === 'running' && slot.active !== null)
			onRunning(slot, slot.active, message);
		else lose(slot, new Error(`the script worker sent ${describeType(type)} while ${slot.phase}`));
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
		slot.phase = 'ready';
		slot.bootMs = ms;
		slot.boot = boot;
		slot.readyAt = now();
		held = false;
		const waiters = bootWaiters;
		bootWaiters = [];
		for (const waiter of waiters) waiter.resolve({ ms });
		fill();
	}

	function onRunning(slot: Slot, active: Active, message: Message): void {
		const { batch, bridge } = active.waiting;
		switch (message.type) {
			case 'bridge': {
				if (typeof message.text !== 'string') break;
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
				slot.writer.more();
				return;
			case 'call-start':
			case 'call-end': {
				const { i } = message;
				if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < batch.calls.length)
					return;
				break;
			}
			case 'done': {
				const results = doneResults(message, batch);
				if (typeof results === 'string') {
					lose(slot, new Error(results));
					return;
				}
				end(slot);
				active.waiting.resolve({
					results: results.results,
					trips: active.trips,
					ms: results.ms,
					bootMs: slot.bootMs,
					boot: slot.boot
				});
				fill();
				return;
			}
		}
		lose(slot, new Error(`the script worker sent a bad ${describeType(message.type)}`));
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
		run(batch, bridge) {
			if (disposed) return Promise.reject(new Error('script host is disposed'));
			warm = true;
			return new Promise((resolve, reject) => {
				queue.push({ batch, bridge, resolve, reject });
				fill();
			});
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			if (trimTimer !== null) timers().clearTimeout(trimTimer);
			trimTimer = null;
			const error = new Error('script host is disposed');
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
