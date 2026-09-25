import type { Progress, Steps } from '../steps/steps.ts';

/** What the host gives the engine to share its thread: a macrotask yield and a clock. */
export type HostDeps = {
	/** Resolves on a later macrotask: a resolved promise is no yield. */
	yieldToHost(): Promise<void>;
	/** Milliseconds, monotonic. */
	now(): number;
};

/**
 * A slice ends once this much of it has passed: half of a 16 ms chunk, the
 * other half left to a collector pause, which lands inside a step now and then.
 */
export const SLICE_TARGET_MS = 8;

/**
 * A unit of engine work. A `read` and a `transition` are one synchronous
 * call; a `scan` is a steps generator that `run()` makes, and makes again if
 * it has to start over. A transition changes the model; the others do not.
 */
export type Job<T> =
	{ kind: 'read'; run(): T } | { kind: 'scan'; run(): Steps<T> } | { kind: 'transition'; run(): T };

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export type Lane = 'control' | 'model';

/**
 * Work for idle time: `start` makes the steps, `progress` is handed what each
 * yields, `done` takes their result.
 */
export type BackgroundTask<P extends Progress = Progress> = {
	start(): Generator<P, boolean, void>;
	progress?(progress: P): void;
	done(result: boolean): void;
};

type Entry = {
	id: string | number;
	job: Job<unknown>;
	done: (outcome: Outcome<unknown>) => void;
};

type Running = { entry: Entry; steps: Steps<unknown>; cancelled: boolean };

/** A background slot: its task, and the steps in flight, made at its first idle step. */
type Slot = { task: BackgroundTask; steps: Steps<boolean> | null };

/**
 * One pump over two lanes, each in arrival order. The control lane holds the
 * replica's own transitions and runs in any state, first. The model lane runs
 * while the scheduler is open: a read or a transition runs whole; a scan runs
 * step by step, and at each slice boundary the reads queued before the first
 * transition are answered before it goes on — other scans are skipped over,
 * never started. So a transition waits for every read that arrived before it
 * and holds everything behind it: a scan never sees the model move under its
 * iterators (a `Map` iterator re-reads everything after a clear and refill,
 * which the ordered iteration of a model does after a rewind).
 *
 * The pump reads the clock after every unit of work — a read, a transition,
 * one step — and past `SLICE_TARGET_MS` yields to the host, whose turn is when
 * messages arrive: engine state is consistent whenever a handler runs. A
 * slice ends there, or when the pump runs out of work; `onSliceEnd` is called
 * at either. Idle and open, it gives its two background slots — the digest
 * check (`setBackground`) and the sweep (`setSweep`) — one step each in turn.
 */
export class Scheduler {
	private readonly deps: HostDeps;
	private readonly onSliceEnd: (() => void) | undefined;
	private readonly control: Entry[] = [];
	private model: Entry[] = [];
	private running: Running | null = null;
	private open = false;
	private background: Slot | null = null;
	private sweep: Slot | null = null;
	// The slot the last idle step went to: the other one goes next.
	private took: 'background' | 'sweep' = 'sweep';
	private sliceStart: number | null = null;
	// Set by a host turn: the reads queued ahead of a running scan go first.
	private boundary = false;
	private pumping = false;
	private kicked = false;
	private idle: (() => void)[] = [];

	constructor(deps: HostDeps, hooks: { onSliceEnd?(): void } = {}) {
		this.deps = deps;
		this.onSliceEnd = hooks.onSliceEnd;
	}

	/** Queues a job; `done` is called once with its outcome, or never if it is cancelled. */
	submit<T>(
		id: string | number,
		lane: Lane,
		job: Job<T>,
		done: (outcome: Outcome<T>) => void
	): void {
		if (lane === 'control' && job.kind === 'scan') {
			throw new Error('the control lane takes reads and transitions only');
		}
		const entry = { id, job, done } as Entry;
		(lane === 'control' ? this.control : this.model).push(entry);
		this.kick();
	}

	/**
	 * Removes a queued job, or drops a running scan at its next step; neither
	 * is answered. A transition that has started runs to its end.
	 */
	cancel(id: string | number): void {
		const index = this.control.findIndex((entry) => entry.id === id);
		if (index >= 0) this.control.splice(index, 1);
		this.model = this.model.filter((entry) => entry.id !== id);
		if (this.running !== null && this.running.entry.id === id) this.running.cancelled = true;
	}

	/**
	 * Closed, the model lane holds its jobs; a scan that was running goes back
	 * to its head and starts over when the scheduler opens again.
	 */
	setOpen(open: boolean): void {
		this.open = open;
		if (open) this.kick();
	}

	setBackground(task: BackgroundTask | null): void {
		this.background = task === null ? null : { task, steps: null };
		this.kick();
	}

	/** Drops the background steps in flight: a new run starts at the next idle slice. */
	restartBackground(): void {
		if (this.background !== null) this.background.steps = null;
	}

	/**
	 * The second background slot, for a task whose steps resume across any
	 * transition: `restartBackground` leaves it alone, and closing only pauses it.
	 */
	setSweep<P extends Progress>(task: BackgroundTask<P> | null): void {
		this.sweep = task === null ? null : { task, steps: null };
		this.kick();
	}

	/**
	 * For work outside the pump, such as a snapshot open: `undefined` while the
	 * slice has room, else the host's turn, after which a new slice has begun.
	 */
	pause(): Promise<void> | undefined {
		if (this.sliceStart === null) {
			this.sliceStart = this.deps.now();
			return undefined;
		}
		return this.elapsed() < SLICE_TARGET_MS ? undefined : this.endSlice();
	}

	/** Resolves once the pump has nothing left it may do. */
	whenIdle(): Promise<void> {
		if (!this.pumping && !this.kicked) return Promise.resolve();
		return new Promise((resolve) => this.idle.push(resolve));
	}

	// -- the pump ------------------------------------------------------------

	private kick(): void {
		if (this.pumping || this.kicked) return;
		this.kicked = true;
		// On a microtask: every job a message brings is queued before any runs.
		void Promise.resolve().then(() => {
			this.kicked = false;
			void this.pump();
		});
	}

	private elapsed(): number {
		const now = this.deps.now();
		this.sliceStart ??= now;
		return now - this.sliceStart;
	}

	private async endSlice(): Promise<void> {
		this.onSliceEnd?.();
		this.sliceStart = null;
		await this.deps.yieldToHost();
		this.sliceStart = this.deps.now();
		this.boundary = true;
	}

	private async pump(): Promise<void> {
		this.pumping = true;
		try {
			this.sliceStart ??= this.deps.now();
			while (this.unit()) {
				if (this.elapsed() >= SLICE_TARGET_MS) await this.endSlice();
			}
		} finally {
			this.pumping = false;
			this.sliceStart = null;
			this.onSliceEnd?.();
			for (const resolve of this.idle.splice(0)) resolve();
		}
	}

	/** Does one unit of work; `false` when there is none it may do. */
	private unit(): boolean {
		const control = this.control.shift();
		if (control !== undefined) {
			if (control.job.kind === 'transition') this.interruptScan();
			this.runWhole(control);
			return true;
		}
		if (!this.open) {
			this.interruptScan();
			return false;
		}
		if (this.running !== null) {
			if (this.running.cancelled) {
				this.running = null;
				return true;
			}
			if (this.boundary) {
				const at = this.readAhead();
				if (at >= 0) {
					this.runWhole(this.model.splice(at, 1)[0]!);
					return true;
				}
				this.boundary = false;
			}
			this.advance(this.running);
			return true;
		}
		const head = this.model.shift();
		if (head !== undefined) {
			if (head.job.kind === 'scan') this.startScan(head, head.job);
			else this.runWhole(head);
			return true;
		}
		const slot = this.idleSlot();
		if (slot !== null) {
			this.advanceBackground(slot);
			return true;
		}
		return false;
	}

	/** The background slot whose turn it is: each in turn while both are set. */
	private idleSlot(): Slot | null {
		const { background, sweep } = this;
		if (background !== null && (sweep === null || this.took === 'sweep')) {
			this.took = 'background';
			return background;
		}
		if (sweep !== null) this.took = 'sweep';
		return sweep;
	}

	/** The first read queued before the first transition, or -1. */
	private readAhead(): number {
		for (let i = 0; i < this.model.length; i++) {
			const kind = this.model[i]!.job.kind;
			if (kind === 'transition') return -1;
			if (kind === 'read') return i;
		}
		return -1;
	}

	private runWhole(entry: Entry): void {
		let outcome: Outcome<unknown>;
		try {
			outcome = { ok: true, value: (entry.job as { run(): unknown }).run() };
		} catch (error) {
			outcome = { ok: false, error };
		}
		entry.done(outcome);
	}

	private startScan(entry: Entry, job: { run(): Steps<unknown> }): void {
		let steps: Steps<unknown>;
		try {
			steps = job.run();
		} catch (error) {
			entry.done({ ok: false, error });
			return;
		}
		this.boundary = false;
		this.running = { entry, steps, cancelled: false };
		this.advance(this.running);
	}

	private advance(running: Running): void {
		let next: IteratorResult<Progress, unknown>;
		try {
			next = running.steps.next();
		} catch (error) {
			this.running = null;
			running.entry.done({ ok: false, error });
			return;
		}
		if (next.done !== true) return;
		this.running = null;
		running.entry.done({ ok: true, value: next.value });
	}

	/** A scan whose model may change under it goes back to the head, to start over. */
	private interruptScan(): void {
		if (this.running === null) return;
		if (!this.running.cancelled) this.model.unshift(this.running.entry);
		this.running = null;
	}

	/** A background task that throws is a bug; it ends as a failed one. */
	private advanceBackground(slot: Slot): void {
		let next: IteratorResult<Progress, boolean>;
		try {
			slot.steps ??= slot.task.start();
			next = slot.steps.next();
		} catch {
			next = { done: true, value: false };
		}
		if (next.done !== true) {
			slot.task.progress?.(next.value);
			return;
		}
		if (this.background === slot) this.background = null;
		if (this.sweep === slot) this.sweep = null;
		slot.task.done(next.value);
	}
}
