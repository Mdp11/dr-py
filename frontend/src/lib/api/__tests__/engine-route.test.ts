import { afterEach, describe, expect, it } from 'vitest';
import { EngineUnavailableError, installEngineSeam, route, type EngineSeam } from '../engine-route';
import { ApiError, ConflictError, errorForStatus, ValidationError } from '../errors';

type Deferred = { promise: Promise<void>; open(): void; fail(error: Error): void };

function deferred(): Deferred {
	let open!: () => void;
	let fail!: (error: Error) => void;
	const promise = new Promise<void>((resolve, reject) => {
		open = resolve;
		fail = reject;
	});
	return { promise, open, fail };
}

type Event = 'ready' | 'call';

/**
 * A hand-made seam. `answers` are the engine's replies in order (the last one
 * repeats); `gates`, when given, are the `whenReady()` promises in order, an
 * absent one standing for an open gate. `events` records the order of waits
 * and calls.
 */
function seamOf(answers: (() => Promise<unknown>)[], gates: (Deferred | undefined)[] = []) {
	const events: Event[] = [];
	const calls: {
		method: string;
		params: unknown;
		signal?: AbortSignal;
		transfer?: ArrayBuffer[];
	}[] = [];
	const waits: (AbortSignal | undefined)[] = [];
	const seam: EngineSeam = {
		call: <T>(
			method: string,
			params: unknown,
			signal?: AbortSignal,
			transfer?: ArrayBuffer[]
		): Promise<T> => {
			events.push('call');
			calls.push({
				method,
				params,
				...(signal === undefined ? {} : { signal }),
				...(transfer === undefined ? {} : { transfer })
			});
			const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
			return answer() as Promise<T>;
		},
		whenReady: (signal) => {
			events.push('ready');
			waits.push(signal);
			return gates[waits.length - 1]?.promise ?? Promise.resolve();
		}
	};
	return { seam, events, calls, waits };
}

const ok = (body: unknown) => () => Promise.resolve(body);
const refuse = (status: number, detail: string) => () =>
	Promise.reject(errorForStatus(status, { detail }, detail));

/** Lets the microtasks a pending `route()` has queued run: none of them waits on a timer. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

afterEach(() => installEngineSeam(null));

describe('route', () => {
	it('rejects as unavailable when no seam is installed', async () => {
		await expect(route('getModelSummary', {})).rejects.toBeInstanceOf(EngineUnavailableError);
	});

	it("answers with the engine's body, after the gate, with the signal on both", async () => {
		const { seam, events, calls, waits } = seamOf([ok({ n: 7 })]);
		installEngineSeam(seam);
		const signal = new AbortController().signal;

		await expect(route('getModelSummary', { a: 1 }, { signal })).resolves.toEqual({ n: 7 });

		expect(events).toEqual(['ready', 'call']);
		expect(calls).toEqual([{ method: 'getModelSummary', params: { a: 1 }, signal }]);
		expect(waits).toEqual([signal]);
	});

	it('a call made while the gate is closed waits and answers from the engine', async () => {
		const gate = deferred();
		const { seam, calls } = seamOf([ok({ n: 3 })], [gate]);
		installEngineSeam(seam);

		let answered: unknown = undefined;
		const pending = route('getModelSummary', {}).then((body) => (answered = body));
		await settle();
		expect(calls).toEqual([]);
		expect(answered).toBeUndefined();

		gate.open();
		await pending;
		expect(answered).toEqual({ n: 3 });
		expect(calls).toHaveLength(1);
	});

	it('a call waiting on the gate rejects when the replica fails', async () => {
		const gate = deferred();
		const { seam, calls } = seamOf([ok({ n: 1 })], [gate]);
		installEngineSeam(seam);

		const pending = route('getModelSummary', {});
		const unavailable = new EngineUnavailableError('the replica failed');
		gate.fail(unavailable);

		await expect(pending).rejects.toBe(unavailable);
		expect(calls).toEqual([]);
	});

	it('the transfer list reaches the seam', async () => {
		const { seam, calls } = seamOf([ok({ n: 1 })]);
		installEngineSeam(seam);
		const file = new ArrayBuffer(8);

		await route('compareModel', { file }, { transfer: [file] });

		expect(calls).toEqual([{ method: 'compareModel', params: { file }, transfer: [file] }]);
	});

	it('an engine error that is not a moved 409 reaches the caller, unchanged and not retried', async () => {
		const refused = new Error('refused');
		const { seam, events } = seamOf([() => Promise.reject(refused)]);
		installEngineSeam(seam);

		await expect(route('getModelSummary', {})).rejects.toBe(refused);
		expect(events).toEqual(['ready', 'call']);
	});

	it('the seam in place when the call is asked is the one it uses throughout', async () => {
		const gate = deferred();
		const first = seamOf([ok({ n: 1 })], [gate]);
		const second = seamOf([ok({ n: 2 })]);
		installEngineSeam(first.seam);

		const pending = route('getModelSummary', {});
		installEngineSeam(second.seam);
		gate.open();

		await expect(pending).resolves.toEqual({ n: 1 });
		expect(second.events).toEqual([]);
	});
});

describe('a 422 from the engine', () => {
	it('reaches the caller unchanged and is not retried', async () => {
		const { seam, events } = seamOf([refuse(422, 'reaches an unreadable thing')]);
		installEngineSeam(seam);

		const rejected = route('evaluateTable', {});
		await expect(rejected).rejects.toBeInstanceOf(ValidationError);
		await expect(rejected).rejects.toMatchObject({
			status: 422,
			message: 'reaches an unreadable thing'
		});
		expect(events).toEqual(['ready', 'call']);
	});

	it('a 501 or a 404 is the caller too, whatever its words', async () => {
		for (const status of [404, 501]) {
			const { seam, events } = seamOf([refuse(status, 'stale base_rev')]);
			installEngineSeam(seam);
			await expect(route('x', {})).rejects.toMatchObject({ status, message: 'stale base_rev' });
			expect(events).toEqual(['ready', 'call']);
		}
	});
});

describe('a moved 409', () => {
	const MOVED = [
		'stale base_rev',
		'stale staged batches',
		'replica is not ready',
		'replica closed'
	];

	it.each(MOVED)('"%s" is retried once after the gate settles', async (detail) => {
		const { seam, events, calls } = seamOf([refuse(409, detail), ok({ n: 9 })]);
		installEngineSeam(seam);
		const params = { base_rev: 4 };

		await expect(route('previewCommit', params)).resolves.toEqual({ n: 9 });

		expect(events).toEqual(['ready', 'call', 'ready', 'call']);
		expect(calls).toHaveLength(2);
		expect(calls[1]!.params).toBe(params);
	});

	it('is retried once after the gate settles, not before', async () => {
		const settled = deferred();
		const { seam, calls } = seamOf(
			[refuse(409, 'stale base_rev'), ok({ n: 5 })],
			[undefined, settled]
		);
		installEngineSeam(seam);

		const pending = route('previewCommit', {});
		await settle();
		expect(calls).toHaveLength(1);

		settled.open();
		await expect(pending).resolves.toEqual({ n: 5 });
		expect(calls).toHaveLength(2);
	});

	it('the retry carries the signal', async () => {
		const { seam, calls, waits } = seamOf([refuse(409, 'replica closed'), ok({ n: 1 })]);
		installEngineSeam(seam);
		const signal = new AbortController().signal;

		await route('getModelSummary', {}, { signal });

		expect(waits).toEqual([signal, signal]);
		expect(calls.map((call) => call.signal)).toEqual([signal, signal]);
	});

	it('a second moved 409 reaches the caller', async () => {
		const first = errorForStatus(409, { detail: 'stale base_rev' }, 'stale base_rev');
		const second = errorForStatus(409, { detail: 'replica closed' }, 'replica closed');
		const { seam, calls } = seamOf([() => Promise.reject(first), () => Promise.reject(second)]);
		installEngineSeam(seam);

		const rejected = route('previewCommit', {});
		await expect(rejected).rejects.toBe(second);
		await expect(rejected).rejects.toBeInstanceOf(ConflictError);
		await expect(rejected).rejects.toMatchObject({ status: 409, message: 'replica closed' });
		expect(calls).toHaveLength(2);
	});

	it('a retry whose wait for the gate fails rejects as unavailable', async () => {
		const settled = deferred();
		const { seam, calls } = seamOf(
			[refuse(409, 'replica is not ready'), ok({ n: 1 })],
			[undefined, settled]
		);
		installEngineSeam(seam);

		const pending = route('previewCommit', {});
		await settle();
		const unavailable = new EngineUnavailableError('the replica failed');
		settled.fail(unavailable);

		await expect(pending).rejects.toBe(unavailable);
		expect(calls).toHaveLength(1);
	});

	it('any other 409 reaches the caller and is not retried', async () => {
		const { seam, events } = seamOf([refuse(409, 'scripts need the engine')]);
		installEngineSeam(seam);

		await expect(route('exportTable', {})).rejects.toMatchObject({
			status: 409,
			message: 'scripts need the engine'
		});
		expect(events).toEqual(['ready', 'call']);
	});

	it('the same words under another status are not retried', async () => {
		const { seam, events } = seamOf([refuse(422, 'stale base_rev')]);
		installEngineSeam(seam);

		await expect(route('previewCommit', {})).rejects.toBeInstanceOf(ApiError);
		expect(events).toEqual(['ready', 'call']);
	});

	it('a call that moved fixed buffers to the engine is not retried: they are detached', async () => {
		const moved = errorForStatus(409, { detail: 'replica closed' }, 'replica closed');
		const { seam, events } = seamOf([() => Promise.reject(moved), ok({ n: 1 })]);
		installEngineSeam(seam);
		const file = new ArrayBuffer(8);

		await expect(route('compareModel', { file }, { transfer: [file] })).rejects.toBe(moved);
		expect(events).toEqual(['ready', 'call']);
	});

	it('params made afresh for each attempt, with their buffers named afresh, are retried', async () => {
		const { seam, events, calls } = seamOf([refuse(409, 'replica closed'), ok({ n: 4 })]);
		installEngineSeam(seam);
		const made: ArrayBuffer[] = [];

		await expect(
			route(
				'compareModel',
				() => {
					const file = new ArrayBuffer(8);
					made.push(file);
					return { file };
				},
				{ transfer: (params) => [(params as { file: ArrayBuffer }).file] }
			)
		).resolves.toEqual({ n: 4 });

		expect(events).toEqual(['ready', 'call', 'ready', 'call']);
		expect(made).toHaveLength(2);
		expect(made[0]).not.toBe(made[1]);
		expect(calls).toEqual([
			{ method: 'compareModel', params: { file: made[0] }, transfer: [made[0]] },
			{ method: 'compareModel', params: { file: made[1] }, transfer: [made[1]] }
		]);
	});
});
