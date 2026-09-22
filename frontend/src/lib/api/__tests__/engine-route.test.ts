import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	engineSide,
	installEngineSeam,
	route,
	type EngineCall,
	type EngineSeam,
	type ShadowProbe,
	type Side,
	type Surface
} from '../engine-route';

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
