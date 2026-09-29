import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProject } from '$lib/engine/__tests__/support/project-server';
import type { ShadowProbe } from '../engine-route';
import { ApiError } from '../errors';
import { diffMetamodel } from '../metamodel';
import { MetamodelDiffSchema } from '../types';
import {
	issuesEngine,
	longerNamesDoc,
	rename,
	SERVER_DIFF,
	STRUCTURAL,
	TOO_LONG,
	TOO_LONG_MESSAGE,
	uninstallIssuesEngine,
	unsupportedPatternDoc
} from './issues-engine';
import { server } from './server';

const BLOB = '# candidate\nelements: []\n';

describe('diffMetamodel on the engine', () => {
	const made: { dispose(): void }[] = [];

	beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
	afterEach(() => {
		uninstallIssuesEngine();
		for (const over of made.splice(0)) over.dispose();
		server.resetHandlers();
		vi.restoreAllMocks();
	});
	afterAll(() => server.close());

	it("joins the engine's model half and structural-diff's answer, and asks no /metamodel/diff", async () => {
		const engine = await issuesEngine(made, { surfaces: { metamodel: 'engine' } });
		await engine.stage([rename('e_000001', TOO_LONG)]);
		const candidate = longerNamesDoc(engine.project.doc);

		const diff = await diffMetamodel(BLOB);

		const direct = await engine.over.link!.client.call<object>('candidateIssues', {
			metamodel: candidate
		});
		expect(diff).toEqual(MetamodelDiffSchema.parse({ ...direct, structural: STRUCTURAL }));
		expect(diff.now_failing).toEqual([]);
		expect(diff.now_passing.map((issue) => issue.message)).toEqual([TOO_LONG_MESSAGE]);
		expect(
			engine.over.calls.filter((call) => call.method === 'candidateIssues').map((c) => c.params)
		).toEqual([{ metamodel: candidate }]);
		expect(engine.requests).toEqual([
			{ route: 'lint', body: BLOB },
			{ route: 'structural-diff', body: BLOB }
		]);
	});

	it('a lint not ok rejects with a 422 and asks the engine nothing', async () => {
		const engine = await issuesEngine(made, {
			surfaces: { metamodel: 'engine' },
			lint: () => ({ ok: false, errors: [{ message: 'bad', line: 1, column: 2 }], document: null })
		});

		const failure = await diffMetamodel(BLOB).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ApiError);
		expect((failure as ApiError).status).toBe(422);
		expect(engine.over.methods()).not.toContain('candidateIssues');
		expect(engine.requests).toEqual([{ route: 'lint', body: BLOB }]);
	});

	it('a candidate pattern the engine refuses is answered by /metamodel/diff', async () => {
		const project = fakeProject();
		const engine = await issuesEngine(made, {
			project,
			surfaces: { metamodel: 'engine' },
			lint: () => ({ ok: true, errors: [], document: unsupportedPatternDoc(project.doc) })
		});

		const diff = await diffMetamodel(BLOB);

		expect(diff).toEqual(MetamodelDiffSchema.parse(SERVER_DIFF));
		expect(engine.over.methods()).toContain('candidateIssues');
		expect(engine.requests.filter((request) => request.route === 'diff')).toEqual([
			{ route: 'diff', body: BLOB }
		]);
	});

	it('with the switch on the server only /metamodel/diff is asked', async () => {
		const engine = await issuesEngine(made, { surfaces: { metamodel: 'server' } });

		const diff = await diffMetamodel(BLOB);

		expect(diff).toEqual(MetamodelDiffSchema.parse(SERVER_DIFF));
		expect(engine.requests).toEqual([{ route: 'diff', body: BLOB }]);
		expect(engine.over.methods()).not.toContain('candidateIssues');
	});

	it('with the gate closed only /metamodel/diff is asked', async () => {
		const engine = await issuesEngine(made, {
			surfaces: { metamodel: 'engine' },
			seeded: () => false
		});

		await diffMetamodel(BLOB);

		expect(engine.requests).toEqual([{ route: 'diff', body: BLOB }]);
		expect(engine.over.methods()).not.toContain('candidateIssues');
	});

	it('is shadowed only while nothing is staged', async () => {
		const probes: ShadowProbe[] = [];
		await issuesEngine(made, {
			surfaces: { metamodel: 'engine' },
			shadow: (probe) => void probes.push(probe)
		});

		await diffMetamodel(BLOB);

		expect(probes).toHaveLength(1);
		expect(probes[0]).toMatchObject({ surface: 'metamodel', method: 'candidateIssues' });
		expect(probes[0]!.whileStaged).toBeUndefined();
	});
});
