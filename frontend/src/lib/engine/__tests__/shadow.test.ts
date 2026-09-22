import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { drain, isSteps, READS, ViewPlacements, type ReadParams, type Steps } from '$engine';
import { server } from '$lib/api/__tests__/server';
import { setActiveBaseUrl } from '$lib/api/client';
import {
	installEngineSeam,
	type EngineSeam,
	type ShadowProbe,
	type Side,
	type Surface
} from '$lib/api/engine-route';
import { NotFoundError } from '$lib/api/errors';
import { listContainmentRoots } from '$lib/api/model-read';
import { EngineGoneError } from '../client';
import { createEngineSeam } from '../seam';
import { createShadow, shadowEnabled } from '../shadow';
import { SURFACES } from '../surfaces';
import { fakeProject, syncOver, type FakeProject } from './support/project-server';

/** Runs `createShadow`'s probe with `rev` fixed and `quiet` resolving at once,
 * unless the test overrides them. */
function run(
	probe: Omit<ShadowProbe, 'surface' | 'method' | 'params'> &
		Partial<Pick<ShadowProbe, 'surface' | 'method' | 'params'>>,
	deps: Partial<{ rev(): number | null; quiet(): Promise<void> }> = {},
	report: (line: string) => void = () => undefined
): Promise<void> {
	const shadow = createShadow({
		rev: deps.rev ?? (() => 1),
		quiet: deps.quiet ?? (() => Promise.resolve()),
		report
	});
	// `EngineSeam['shadow']` is typed `void` (nothing it returns reaches the caller);
	// the real implementation is an async function, so the test awaits it through
	// `Promise.resolve`, which infers `T` from the argument and so stays `Promise<void>`.
	return Promise.resolve(
		shadow({
			surface: 'tree',
			method: 'listContainmentRoots',
			params: { limit: 500 },
			...probe
		})
	);
}

const abort = () => new DOMException('The operation was aborted.', 'AbortError');

describe('createShadow', () => {
	it('equal values report nothing; key order does not matter', async () => {
		const report = vi.fn();
		const again = vi.fn();
		const serverCall = vi.fn(() => Promise.resolve({ b: [1, 2, 3], a: 1 }));
		await run(
			{ engine: { ok: true, value: { a: 1, b: [1, 2, 3] } }, again, server: serverCall },
			{},
			report
		);
		expect(report).not.toHaveBeenCalled();
		expect(again).not.toHaveBeenCalled();
		expect(serverCall).toHaveBeenCalledOnce();
	});

	it('array order does matter', async () => {
		const lines: string[] = [];
		const value = { items: [1, 2, 3] };
		const flipped = { items: [3, 2, 1] };
		await run(
			{
				engine: { ok: true, value },
				again: () => Promise.resolve(value),
				server: () => Promise.resolve(flipped)
			},
			{},
			(l) => lines.push(l)
		);
		expect(lines).toHaveLength(1);
	});

	it('1 and 1.0 are equal (both are numbers after the schemas)', async () => {
		const report = vi.fn();
		await run(
			{
				engine: { ok: true, value: 1 },
				again: () => Promise.resolve(1),
				server: () => Promise.resolve(1.0)
			},
			{},
			report
		);
		expect(report).not.toHaveBeenCalled();
	});

	it('a mismatch that heals on the re-test, awaited after quiet(), reports nothing', async () => {
		const order: string[] = [];
		const report = vi.fn();
		let serverCalls = 0;
		await run(
			{
				engine: { ok: true, value: { total: 1 } },
				again: () => {
					order.push('again');
					return Promise.resolve({ total: 2 });
				},
				server: () => {
					order.push('server');
					serverCalls++;
					return Promise.resolve({ total: serverCalls === 1 ? 9 : 2 });
				}
			},
			{
				quiet: () => {
					order.push('quiet');
					return Promise.resolve();
				}
			},
			report
		);
		expect(report).not.toHaveBeenCalled();
		expect(order).toEqual(['server', 'quiet', 'again', 'server']);
	});

	it('a mismatch that survives the re-test reports one line', async () => {
		const lines: string[] = [];
		await run(
			{
				engine: { ok: true, value: { items: [], total: 0 } },
				again: () => Promise.resolve({ items: [], total: 0 }),
				server: () => Promise.resolve({ items: [{ id: 'x' }], total: 1 })
			},
			{},
			(l) => lines.push(l)
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^\[shadow\] tree listContainmentRoots \{"limit":500\}:/);
	});

	it('a rev that moves during the re-test is retried; a stable round decides it', async () => {
		const revs = [1, 2, 2, 2];
		let i = 0;
		const rev = () => revs[Math.min(i++, revs.length - 1)]!;
		const report = vi.fn();
		let calls = 0;
		await run(
			{
				engine: { ok: true, value: { total: 1 } },
				again: () => Promise.resolve({ total: 2 }),
				server: () => {
					calls++;
					// call 1 (the initial compare) and call 2 (the first, discarded, round
					// where the rev moved) mismatch; call 3 (the stable round) heals.
					return Promise.resolve({ total: calls === 3 ? 2 : 9 });
				}
			},
			{ rev },
			report
		);
		expect(report).not.toHaveBeenCalled();
		expect(calls).toBe(3);
	});

	it('three moving rounds give up silently: a replica that never rests is not a mismatch', async () => {
		let n = 0;
		const rev = () => n++;
		const report = vi.fn();
		let calls = 0;
		await run(
			{
				engine: { ok: true, value: { total: 1 } },
				again: () => {
					calls++;
					return Promise.resolve({ total: 2 });
				},
				server: () => Promise.resolve({ total: 9 })
			},
			{ rev },
			report
		);
		expect(report).not.toHaveBeenCalled();
		expect(calls).toBe(3);
	});

	it('a 404 on both sides is equal whatever the text', async () => {
		const report = vi.fn();
		await run(
			{
				engine: { ok: false, error: new NotFoundError(404, {}, "No element with id 'x'") },
				again: () => Promise.reject(new NotFoundError(404, {}, 'unused')),
				server: () => Promise.reject(new NotFoundError(404, {}, 'a different text entirely'))
			},
			{},
			report
		);
		expect(report).not.toHaveBeenCalled();
	});

	it('a 404 against a value differs', async () => {
		const report = vi.fn();
		await run(
			{
				engine: { ok: false, error: new NotFoundError(404, {}, "No element with id 'x'") },
				again: () => Promise.reject(new NotFoundError(404, {}, 'still missing')),
				server: () => Promise.resolve({ id: 'x' })
			},
			{},
			report
		);
		expect(report).toHaveBeenCalledOnce();
	});

	it('an AbortError on the engine side ends it without a report', async () => {
		const serverCall = vi.fn();
		const report = vi.fn();
		await run(
			{ engine: { ok: false, error: abort() }, again: vi.fn(), server: serverCall },
			{},
			report
		);
		expect(serverCall).not.toHaveBeenCalled();
		expect(report).not.toHaveBeenCalled();
	});

	it('an AbortError on the server side ends it without a report', async () => {
		const again = vi.fn();
		const report = vi.fn();
		await run(
			{ engine: { ok: true, value: { id: 'x' } }, again, server: () => Promise.reject(abort()) },
			{},
			report
		);
		expect(again).not.toHaveBeenCalled();
		expect(report).not.toHaveBeenCalled();
	});

	it('an AbortError during the re-test ends it without a report', async () => {
		const report = vi.fn();
		await run(
			{
				engine: { ok: true, value: { id: 'a' } },
				again: () => Promise.reject(abort()),
				server: () => Promise.resolve({ id: 'b' })
			},
			{},
			report
		);
		expect(report).not.toHaveBeenCalled();
	});

	it('an EngineGoneError on the first engine outcome ends it without a report', async () => {
		const serverCall = vi.fn();
		const report = vi.fn();
		await run(
			{ engine: { ok: false, error: new EngineGoneError() }, again: vi.fn(), server: serverCall },
			{},
			report
		);
		expect(serverCall).not.toHaveBeenCalled();
		expect(report).not.toHaveBeenCalled();
	});

	it('an EngineGoneError from again() during the re-test ends it without a report — a rev gone to null on a stop() must not read as a stable round', async () => {
		const report = vi.fn();
		// The engine differed from the server before the model went away (a
		// real race, not a mismatch): the first compare must see a difference
		// so the re-test loop is entered at all.
		await run(
			{
				engine: { ok: true, value: { id: 'a' } },
				again: () => Promise.reject(new EngineGoneError()),
				server: () => Promise.resolve({ id: 'b' })
			},
			// rev() -> null both before and after the round: a stop() clears it,
			// so `null === null` alone must never be read as "the rev held still".
			{ rev: () => null },
			report
		);
		expect(report).not.toHaveBeenCalled();
	});

	it('summary ignores issue_counts and undo_depth, and only those', async () => {
		const report = vi.fn();
		const engineValue = { model_rev: 3, element_count: 5, issue_counts: null, undo_depth: 0 };
		const serverValue = {
			model_rev: 3,
			element_count: 5,
			issue_counts: { conformance: 2 },
			undo_depth: 4
		};
		await run(
			{
				surface: 'summary',
				method: 'getModelSummary',
				params: {},
				engine: { ok: true, value: engineValue },
				again: () => Promise.resolve(engineValue),
				server: () => Promise.resolve(serverValue)
			},
			{},
			report
		);
		expect(report).not.toHaveBeenCalled();

		const differing = { ...serverValue, element_count: 6 };
		await run(
			{
				surface: 'summary',
				method: 'getModelSummary',
				params: {},
				engine: { ok: true, value: engineValue },
				again: () => Promise.resolve(engineValue),
				server: () => Promise.resolve(differing)
			},
			{},
			report
		);
		expect(report).toHaveBeenCalledOnce();
	});

	it('the line is cut: a 10,000-character difference gives a line under 1,000', async () => {
		const lines: string[] = [];
		const engineValue = { a: 'x'.repeat(10000) };
		const serverValue = { a: 'y'.repeat(10000) };
		await run(
			{
				engine: { ok: true, value: engineValue },
				again: () => Promise.resolve(engineValue),
				server: () => Promise.resolve(serverValue)
			},
			{},
			(l) => lines.push(l)
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]!.length).toBeLessThan(1000);
	});
});

describe('shadowEnabled', () => {
	const storing = (value: string | null) => ({
		getItem: (key: string) => (key === 'dr.shadow' ? value : null)
	});

	it("'1' turns it on", () => {
		expect(shadowEnabled(storing('1'))).toBe(true);
	});

	it('an absent key is off', () => {
		expect(shadowEnabled(storing(null))).toBe(false);
	});

	it('another value is off', () => {
		expect(shadowEnabled(storing('true'))).toBe(false);
		expect(shadowEnabled(storing('0'))).toBe(false);
	});

	it('a throwing storage is off', () => {
		const throwing = {
			getItem: (): string | null => {
				throw new DOMException('denied', 'SecurityError');
			}
		};
		expect(shadowEnabled(throwing)).toBe(false);
	});
});

describe('shadow over the real engine', () => {
	beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
	afterAll(() => server.close());

	const made: ReturnType<typeof syncOver>[] = [];
	afterEach(() => {
		installEngineSeam(null);
		setActiveBaseUrl(null);
		for (const over of made.splice(0)) over.dispose();
		server.resetHandlers();
	});

	const sides = (only: Surface) =>
		Object.fromEntries(SURFACES.map((s) => [s, s === only ? 'engine' : 'server'])) as Record<
			Surface,
			Side
		>;

	function direct(project: FakeProject, method: string, params: ReadParams) {
		const result = READS[method]!(project.model, new ViewPlacements(), params);
		const value = isSteps(result) ? drain(result as Steps<unknown>) : result;
		return JSON.parse(JSON.stringify(value)) as unknown;
	}

	it('reports the server disagreeing with the engine, and nothing once it agrees', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const over = syncOver(project);
		made.push(over);
		over.sync.open(project.projectId);
		await over.sync.settled();
		expect(over.sync.status()).toMatchObject({ phase: 'ready', rev: project.rev });

		const lines: string[] = [];
		let done: Promise<void> = Promise.resolve();
		const shadow: NonNullable<EngineSeam['shadow']> = (probe) => {
			done = Promise.resolve(
				createShadow({
					rev: () => over.sync.status().rev,
					quiet: () => Promise.resolve(),
					report: (line) => lines.push(line)
				})(probe)
			);
			return done;
		};
		installEngineSeam(
			createEngineSeam(
				{ status: () => over.sync.status(), call: over.sync.call },
				sides('tree'),
				shadow
			)
		);
		setActiveBaseUrl(project.baseUrl);

		server.use(
			http.get(`${project.baseUrl}/model/containment/roots`, () =>
				HttpResponse.json({ items: [], total: 0 })
			)
		);
		await listContainmentRoots({ limit: 5 });
		await done;
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^\[shadow\] tree listContainmentRoots/);

		lines.length = 0;
		server.use(
			http.get(`${project.baseUrl}/model/containment/roots`, () =>
				HttpResponse.json(
					direct(project, 'listContainmentRoots', { limit: 5 }) as Record<string, unknown>
				)
			)
		);
		await listContainmentRoots({ limit: 5 });
		await done;
		expect(lines).toHaveLength(0);
	});
});
