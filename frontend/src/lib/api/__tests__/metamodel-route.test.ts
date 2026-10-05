import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeProject } from '$lib/engine/__tests__/support/project-server';
import { ApiError } from '../errors';
import { diffMetamodel } from '../metamodel';
import { MetamodelDiffSchema } from '../types';
import {
	issuesEngine,
	longerNamesDoc,
	rename,
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
		const engine = await issuesEngine(made);
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
			lint: () => ({ ok: false, errors: [{ message: 'bad', line: 1, column: 2 }], document: null })
		});

		const failure = await diffMetamodel(BLOB).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ApiError);
		expect((failure as ApiError).status).toBe(422);
		expect(engine.over.methods()).not.toContain('candidateIssues');
		expect(engine.requests).toEqual([{ route: 'lint', body: BLOB }]);
	});

	it('a candidate pattern the engine cannot translate is a 422 that names it', async () => {
		const project = fakeProject();
		const engine = await issuesEngine(made, {
			project,
			lint: () => ({ ok: true, errors: [], document: unsupportedPatternDoc(project.doc) })
		});

		const failure = await diffMetamodel(BLOB).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ApiError);
		expect((failure as ApiError).status).toBe(422);
		expect((failure as ApiError).message).toContain('cannot be checked');
		expect(engine.over.methods()).toContain('candidateIssues');
		expect(engine.requests.map((request) => request.route)).not.toContain('diff');
	});

	it('an ok lint without a document is a 422 too', async () => {
		const engine = await issuesEngine(made, {
			lint: () => ({ ok: true, errors: [], document: null })
		});

		const failure = await diffMetamodel(BLOB).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ApiError);
		expect((failure as ApiError).status).toBe(422);
		expect(engine.over.methods()).not.toContain('candidateIssues');
	});

	it('waits for the gate before asking the engine', async () => {
		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => (entered = resolve));
		const engine = await issuesEngine(made, {
			whenReady: () => {
				entered();
				return gate;
			}
		});

		const pending = diffMetamodel(BLOB);
		await waiting;
		expect(engine.over.methods()).not.toContain('candidateIssues');

		open();
		await pending;
		expect(engine.over.methods()).toContain('candidateIssues');
	});
});
