import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	comparableWhileStaged,
	engineSide,
	installEngineSeam,
	route,
	type EngineCall,
	type EngineSeam,
	type ShadowProbe,
	type Side,
	type Surface
} from '../engine-route';
import { errorForStatus } from '../errors';

class Gone extends Error {}

/** A hand-made seam: `answer` stands for the engine, `sides` for the switches. */
function seamOf(
	answer: (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown>,
	sides: Partial<Record<Surface, Side>> = {},
	shadow?: EngineSeam['shadow']
) {
	const calls: { method: string; params: unknown; signal?: AbortSignal }[] = [];
	const call = (<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> => {
		calls.push({ method, params, ...(signal === undefined ? {} : { signal }) });
		return answer(method, params, signal) as Promise<T>;
	}) as EngineCall;
	const seam: EngineSeam = {
		side: (surface) => sides[surface] ?? 'engine',
		call,
		gone: (error) => error instanceof Gone,
		...(shadow === undefined ? {} : { shadow })
	};
	return { seam, calls };
}

const engineRead = (params: unknown, signal?: AbortSignal) => (call: EngineCall) =>
	call<{ n: number }>('getModelSummary', params, signal).then((body) => body.n);

/** A server closure that counts its calls. */
function serverOf(value: unknown = 'server') {
	const fn = vi.fn(() => Promise.resolve(value));
	return fn as typeof fn & (() => Promise<never>);
}

/** Lets every queued microtask and one macrotask run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => installEngineSeam(null));

describe('route', () => {
	it('goes to the server when no seam is installed', async () => {
		const server = serverOf();
		const engine = vi.fn(engineRead({}));
		await expect(route('summary', undefined, engine, server)).resolves.toBe('server');
		expect(server).toHaveBeenCalledOnce();
		expect(engine).not.toHaveBeenCalled();
	});

	it("goes to the server when the surface's side is server", async () => {
		const { seam, calls } = seamOf(() => Promise.resolve({ n: 1 }), { summary: 'server' });
		installEngineSeam(seam);
		const server = serverOf();
		await expect(route('summary', undefined, engineRead({}), server)).resolves.toBe('server');
		expect(calls).toEqual([]);
	});

	it('goes to the server when the call names its server, whatever the side', async () => {
		const { seam, calls } = seamOf(() => Promise.resolve({ n: 1 }));
		installEngineSeam(seam);
		const server = serverOf();
		await expect(
			route('summary', { baseUrl: 'http://elsewhere/api' }, engineRead({}), server)
		).resolves.toBe('server');
		await expect(route('summary', { fetch }, engineRead({}), server)).resolves.toBe('server');
		expect(server).toHaveBeenCalledTimes(2);
		expect(calls).toEqual([]);
	});

	it("an engine side answers with the engine's value and never calls the server", async () => {
		const { seam, calls } = seamOf(() => Promise.resolve({ n: 7 }));
		installEngineSeam(seam);
		const server = serverOf();
		const signal = new AbortController().signal;
		await expect(route('summary', undefined, engineRead({ a: 1 }, signal), server)).resolves.toBe(
			7
		);
		expect(server).not.toHaveBeenCalled();
		expect(calls).toEqual([{ method: 'getModelSummary', params: { a: 1 }, signal }]);
	});

	it('an engine that is gone is answered by the server', async () => {
		const { seam } = seamOf(() => Promise.reject(new Gone()));
		installEngineSeam(seam);
		const server = serverOf();
		await expect(route('summary', undefined, engineRead({}), server)).resolves.toBe('server');
		expect(server).toHaveBeenCalledOnce();
	});

	it('any other engine error reaches the caller, and the server is not asked', async () => {
		const refused = new Error('refused');
		const { seam } = seamOf(() => Promise.reject(refused));
		installEngineSeam(seam);
		const server = serverOf();
		await expect(route('summary', undefined, engineRead({}), server)).rejects.toBe(refused);
		expect(server).not.toHaveBeenCalled();
	});

	it('an engine read that throws at once rejects instead', async () => {
		const { seam } = seamOf(() => Promise.resolve({ n: 1 }));
		installEngineSeam(seam);
		const broken = new Error('broken');
		const promise = route(
			'summary',
			undefined,
			() => {
				throw broken;
			},
			serverOf()
		);
		await expect(promise).rejects.toBe(broken);
	});

	it('the shadow is handed the surface, the call, the outcome, again and the server', async () => {
		const probes: ShadowProbe[] = [];
		let n = 0;
		const { seam, calls } = seamOf(
			() => Promise.resolve({ n: ++n }),
			{},
			(probe) => void probes.push(probe)
		);
		installEngineSeam(seam);
		const server = serverOf('from server');

		await expect(route('tree', undefined, engineRead({ id: 'x' }), server)).resolves.toBe(1);
		expect(probes).toHaveLength(1);
		const probe = probes[0]!;
		expect(probe).toMatchObject({
			surface: 'tree',
			method: 'getModelSummary',
			params: { id: 'x' },
			engine: { ok: true, value: 1 }
		});
		expect(server).not.toHaveBeenCalled();

		await expect(probe.again()).resolves.toBe(2);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toMatchObject({ method: 'getModelSummary', params: { id: 'x' } });
		await expect(probe.server()).resolves.toBe('from server');
		expect(server).toHaveBeenCalledOnce();
	});

	it('the shadow is handed an engine error as the outcome', async () => {
		const probes: ShadowProbe[] = [];
		const refused = new Error('refused');
		const { seam } = seamOf(
			() => Promise.reject(refused),
			{},
			(probe) => void probes.push(probe)
		);
		installEngineSeam(seam);
		await expect(route('elements', undefined, engineRead({}), serverOf())).rejects.toBe(refused);
		expect(probes).toHaveLength(1);
		expect(probes[0]!.engine).toEqual({ ok: false, error: refused });
	});

	it('the shadow is not handed a read the server answered', async () => {
		const shadow = vi.fn();
		const { seam } = seamOf(() => Promise.reject(new Gone()), {}, shadow);
		installEngineSeam(seam);
		await expect(route('elements', undefined, engineRead({}), serverOf())).resolves.toBe('server');
		installEngineSeam({ ...seam, side: () => 'server' });
		await expect(route('elements', undefined, engineRead({}), serverOf())).resolves.toBe('server');
		expect(shadow).not.toHaveBeenCalled();
	});

	it('the shadow is not awaited', async () => {
		let finished = false;
		const { seam } = seamOf(
			() => Promise.resolve({ n: 3 }),
			{},
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				finished = true;
			}
		);
		installEngineSeam(seam);
		await expect(route('summary', undefined, engineRead({}), serverOf())).resolves.toBe(3);
		expect(finished).toBe(false);
	});

	it('a shadow that throws or rejects changes nothing for the caller', async () => {
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		try {
			const throwing = seamOf(
				() => Promise.resolve({ n: 4 }),
				{},
				() => {
					throw new Error('shadow threw');
				}
			);
			installEngineSeam(throwing.seam);
			await expect(route('summary', undefined, engineRead({}), serverOf())).resolves.toBe(4);

			const rejecting = seamOf(() => Promise.reject(new Error('refused')), {}, (() =>
				Promise.reject(new Error('shadow rejected'))) as unknown as EngineSeam['shadow']);
			installEngineSeam(rejecting.seam);
			await expect(route('summary', undefined, engineRead({}), serverOf())).rejects.toThrow(
				'refused'
			);
			await flush();
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off('unhandledRejection', unhandled);
		}
	});

	it('the seam in place when the read is asked is the one it uses', async () => {
		const first = seamOf(() => Promise.resolve({ n: 1 }));
		installEngineSeam(first.seam);
		const read = route('summary', undefined, engineRead({}), serverOf());
		installEngineSeam(null);
		await expect(read).resolves.toBe(1);
	});
});

describe('the server fallback', () => {
	/** An engine refusal as the engine client makes it: the detail is the message. */
	const refusal = (status: number, detail: string) => errorForStatus(status, { detail }, detail);

	const mark = <T>(value: T, reason: 'script' | 'pattern') => ({ value, reason }) as T;

	it('a 501 "reaches a script" is answered by the server, marked script, with no shadow', async () => {
		const shadow = vi.fn();
		const { seam, calls } = seamOf(
			() => Promise.reject(refusal(501, 'reaches a script')),
			{},
			shadow
		);
		installEngineSeam(seam);
		const server = serverOf('from server');
		await expect(
			route('navigation', undefined, engineRead({ definition: {} }), server, { mark })
		).resolves.toEqual({ value: 'from server', reason: 'script' });
		expect(calls).toHaveLength(1);
		expect(server).toHaveBeenCalledOnce();
		await flush();
		expect(shadow).not.toHaveBeenCalled();
	});

	it('a 501 "reaches an unsupported pattern" is answered by the server, marked pattern', async () => {
		const shadow = vi.fn();
		const { seam } = seamOf(
			() => Promise.reject(refusal(501, 'reaches an unsupported pattern')),
			{},
			shadow
		);
		installEngineSeam(seam);
		const server = serverOf('from server');
		await expect(route('criteria', undefined, engineRead({}), server, { mark })).resolves.toEqual({
			value: 'from server',
			reason: 'pattern'
		});
		expect(server).toHaveBeenCalledOnce();
		await flush();
		expect(shadow).not.toHaveBeenCalled();
	});

	it("without a mark the server's value is the answer as it is", async () => {
		const { seam } = seamOf(() => Promise.reject(refusal(501, 'reaches a script')));
		installEngineSeam(seam);
		await expect(route('navigation', undefined, engineRead({}), serverOf())).resolves.toBe(
			'server'
		);
	});

	it("the server's error on a fallback reaches the caller", async () => {
		const { seam } = seamOf(() => Promise.reject(refusal(501, 'reaches a script')));
		installEngineSeam(seam);
		const failed = new Error('server failed');
		const server = vi.fn(() => Promise.reject(failed));
		await expect(route('navigation', undefined, engineRead({}), server, { mark })).rejects.toBe(
			failed
		);
	});

	it("any other 501, or the same words under another status, is the caller's error", async () => {
		for (const error of [
			refusal(501, 'not implemented'),
			refusal(501, 'Reaches a script'),
			refusal(422, 'reaches a script'),
			refusal(500, 'reaches an unsupported pattern'),
			new Error('reaches a script')
		]) {
			const shadow = vi.fn();
			const { seam } = seamOf(() => Promise.reject(error), {}, shadow);
			installEngineSeam(seam);
			const server = serverOf();
			const marker = vi.fn(mark);
			await expect(
				route('navigation', undefined, engineRead({}), server, { mark: marker })
			).rejects.toBe(error);
			expect(server).not.toHaveBeenCalled();
			expect(marker).not.toHaveBeenCalled();
			expect(shadow).toHaveBeenCalledOnce();
		}
	});

	it('a 501 "reaches unreadable rules" is answered by the server, never marked, with no shadow', async () => {
		const shadow = vi.fn();
		const { seam } = seamOf(
			() => Promise.reject(refusal(501, 'reaches unreadable rules')),
			{},
			shadow
		);
		installEngineSeam(seam);
		const server = serverOf('from server');
		const marker = vi.fn(mark);
		await expect(
			route('issues', undefined, engineRead({}), server, { mark: marker })
		).resolves.toBe('from server');
		await expect(route('issues', undefined, engineRead({}), server)).resolves.toBe('from server');
		expect(server).toHaveBeenCalledTimes(2);
		expect(marker).not.toHaveBeenCalled();
		await flush();
		expect(shadow).not.toHaveBeenCalled();
	});

	it('with the shell sending parses, a rules project reaches the server only for an unreadable document', async () => {
		// The engine answers rule sets now: the refusal a project with any rule set once got is the caller's.
		for (const detail of ['reaches validation rules', 'reaches unreadable rules']) {
			const shadow = vi.fn();
			const error = refusal(501, detail);
			const { seam } = seamOf(() => Promise.reject(error), {}, shadow);
			installEngineSeam(seam);
			const server = serverOf('from server');
			const answered = route('issues', undefined, engineRead({}), server);
			if (detail === 'reaches unreadable rules') {
				await expect(answered).resolves.toBe('from server');
				expect(server).toHaveBeenCalledOnce();
			} else {
				await expect(answered).rejects.toBe(error);
				expect(server).not.toHaveBeenCalled();
			}
		}
	});

	it('a 409 that says the staged batches, the base_rev or the replica moved is answered by the server', async () => {
		for (const detail of ['stale staged batches', 'stale base_rev', 'replica is not ready']) {
			const shadow = vi.fn();
			const { seam, calls } = seamOf(() => Promise.reject(refusal(409, detail)), {}, shadow);
			installEngineSeam(seam);
			const server = serverOf('from server');
			await expect(route('issues', undefined, engineRead({}), server)).resolves.toBe('from server');
			expect(calls).toHaveLength(1);
			expect(server).toHaveBeenCalledOnce();
			await flush();
			expect(shadow).not.toHaveBeenCalled();
		}
	});

	it("any other 409, or the same words under another status, is the caller's error", async () => {
		for (const error of [refusal(409, 'replica closed'), refusal(501, 'stale staged batches')]) {
			const { seam } = seamOf(() => Promise.reject(error));
			installEngineSeam(seam);
			const server = serverOf();
			await expect(route('issues', undefined, engineRead({}), server)).rejects.toBe(error);
			expect(server).not.toHaveBeenCalled();
		}
	});

	it('an engine answer and a server side are never marked', async () => {
		const marker = vi.fn(mark);
		const { seam } = seamOf(() => Promise.resolve({ n: 5 }), { criteria: 'server' });
		installEngineSeam(seam);
		await expect(
			route('navigation', undefined, engineRead({}), serverOf(), { mark: marker })
		).resolves.toBe(5);
		await expect(
			route('criteria', undefined, engineRead({}), serverOf(), { mark: marker })
		).resolves.toBe('server');
		expect(marker).not.toHaveBeenCalled();
	});
});

describe('the shadow option', () => {
	it('by default the probe is compared only while nothing is staged', async () => {
		const probes: ShadowProbe[] = [];
		const { seam } = seamOf(
			() => Promise.resolve({ n: 1 }),
			{},
			(probe) => void probes.push(probe)
		);
		installEngineSeam(seam);
		await route('issues', undefined, engineRead({}), serverOf());
		await route('issues', undefined, engineRead({}), serverOf(), { shadow: 'unstaged' });
		expect(probes).toHaveLength(2);
		for (const probe of probes) expect(probe.whileStaged).toBeUndefined();
	});

	it("'always' hands the probe over to be compared while staged", async () => {
		const probes: ShadowProbe[] = [];
		const { seam } = seamOf(
			() => Promise.resolve({ n: 1 }),
			{},
			(probe) => void probes.push(probe)
		);
		installEngineSeam(seam);
		await route('issues', undefined, engineRead({}), serverOf(), { shadow: 'always' });
		expect(probes).toHaveLength(1);
		expect(probes[0]).toMatchObject({ surface: 'issues', whileStaged: true });
	});

	it("'never' hands the shadow nothing, an answer or an error", async () => {
		const shadow = vi.fn();
		const answering = seamOf(() => Promise.resolve({ n: 1 }), {}, shadow);
		installEngineSeam(answering.seam);
		await route('issues', undefined, engineRead({}), serverOf(), { shadow: 'never' });
		const refused = new Error('refused');
		const failing = seamOf(() => Promise.reject(refused), {}, shadow);
		installEngineSeam(failing.seam);
		await expect(
			route('issues', undefined, engineRead({}), serverOf(), { shadow: 'never' })
		).rejects.toBe(refused);
		await flush();
		expect(shadow).not.toHaveBeenCalled();
	});

	it('comparableWhileStaged is always, unless an op creates an entity', () => {
		const update = { kind: 'update_element' };
		expect(comparableWhileStaged([])).toBe('always');
		expect(comparableWhileStaged([update, { kind: 'delete_relationship' }])).toBe('always');
		expect(comparableWhileStaged([update, { kind: 'create_element' }])).toBe('never');
		expect(comparableWhileStaged([{ kind: 'create_relationship' }])).toBe('never');
	});
});

describe('recheck', () => {
	it("an answer that comes once the surface's side is the server's is replaced by the server's", async () => {
		let side: Side = 'engine';
		const shadow = vi.fn();
		const { seam } = seamOf(
			() => {
				side = 'server';
				return Promise.resolve({ n: 1 });
			},
			{},
			shadow
		);
		installEngineSeam({ ...seam, side: () => side });
		const server = serverOf('from server');
		await expect(
			route('issues', undefined, engineRead({}), server, { recheck: true })
		).resolves.toBe('from server');
		expect(server).toHaveBeenCalledOnce();
		await flush();
		expect(shadow).not.toHaveBeenCalled();
	});

	it("without it, or with the side unmoved, the engine's answer stands", async () => {
		let side: Side = 'engine';
		const { seam } = seamOf(() => {
			side = 'server';
			return Promise.resolve({ n: 1 });
		});
		installEngineSeam({ ...seam, side: () => side });
		const server = serverOf();
		await expect(route('issues', undefined, engineRead({}), server)).resolves.toBe(1);
		const steady = seamOf(() => Promise.resolve({ n: 2 }));
		installEngineSeam(steady.seam);
		await expect(
			route('issues', undefined, engineRead({}), server, { recheck: true })
		).resolves.toBe(2);
		expect(server).not.toHaveBeenCalled();
	});
});

describe('engineSide', () => {
	it('is server without a seam, else what the seam says', () => {
		expect(engineSide('tree')).toBe('server');
		const { seam } = seamOf(() => Promise.resolve({ n: 1 }), { tree: 'server' });
		installEngineSeam(seam);
		expect(engineSide('tree')).toBe('server');
		expect(engineSide('search')).toBe('engine');
		installEngineSeam(null);
		expect(engineSide('search')).toBe('server');
	});
});
