import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { modelLines } from '$engine';
import { createShadow } from '$lib/engine/shadow';
import type { ChangeRequest } from '$lib/state/cr';
import { resetModelStore, setModelRev } from '$lib/state/model.svelte';
import { stageProposedOps } from '$lib/state/stage-proposed';
import { compareModel, proposeCr } from '../changeRequest';
import type { EngineSeam, Side } from '../engine-route';
import { ApiError } from '../errors';
import { CompareOutSchema, type ChangesDoc } from '../types';
import { issuesEngine, rename, uninstallIssuesEngine, type IssuesEngine } from './issues-engine';
import { server } from './server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const made: { dispose(): void }[] = [];

afterEach(() => {
	uninstallIssuesEngine();
	resetModelStore();
	for (const over of made.splice(0)) over.dispose();
	server.resetHandlers();
});

type Answer = { [key: string]: unknown };

/** The server's clock, never the client's: the two `createdAt`s always differ. */
const SERVER_CLOCK = '2001-02-03T04:05:06.789Z';
const ISO_MILLISECONDS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

/** The replica's own model as a file, `e_000001` renamed `from file`: its compare modifies that one element. */
function modelFile(engine: IssuesEngine): Blob {
	const { model } = engine.project;
	const lines = modelLines(model);
	const first = JSON.parse(lines[0]!) as { id: string; properties: Answer };
	expect(first.id).toBe('e_000001');
	lines[0] = JSON.stringify({ ...first, properties: { ...first.properties, name: 'from file' } });
	const elements = lines.slice(0, model.elementCount).join(', ');
	const relationships = lines.slice(model.elementCount).join(', ');
	return new Blob([`{"elements": [${elements}], "relationships": [${relationships}]}`]);
}

/** `text` as UTF-16LE behind its byte order mark: the server reads it, the engine does not. */
function utf16(text: string): Blob {
	const bytes = new Uint8Array(2 + text.length * 2);
	bytes.set([0xff, 0xfe]);
	for (let i = 0; i < text.length; i++) {
		bytes[2 + 2 * i] = text.charCodeAt(i) & 0xff;
		bytes[3 + 2 * i] = text.charCodeAt(i) >> 8;
	}
	return new Blob([bytes]);
}

const EMPTY_CR: ChangeRequest = {
	format: 'datarover.cr/v1',
	createdAt: '2026-01-01T00:00:00.000Z',
	baseline: { filename: null, elementCount: 0, relationshipCount: 0 },
	ops: {
		elements: { added: [], modified: [], deleted: [] },
		relationships: { added: [], modified: [], deleted: [] }
	}
};

/** A change request adding an element whose id the model holds already. */
const CONFLICTING: ChangeRequest = {
	...EMPTY_CR,
	ops: {
		...EMPTY_CR.ops,
		elements: {
			added: [{ id: 'e_000001', type_name: 'Organization', properties: {}, rev: 0 }],
			modified: [],
			deleted: []
		}
	}
};

/** A change request pydantic reads, coercing its `rev`, and the engine does not. */
const LAX: ChangeRequest = {
	...EMPTY_CR,
	ops: {
		...EMPTY_CR.ops,
		elements: {
			added: [
				{ id: 'n_new', type_name: 'Organization', properties: {}, rev: '3' as unknown as number }
			],
			modified: [],
			deleted: []
		}
	}
};

/** What the server answers a compare the test answers itself. */
const SERVED_COMPARE = {
	model_rev: 7,
	cr: { ...EMPTY_CR, complete: true },
	other_element_count: 0,
	other_relationship_count: 0
};

/** What the server answers an apply-CR the test answers itself. */
const SERVED_PROPOSAL = { model_rev: 7, cr: { ...EMPTY_CR, complete: true }, ops: [] };

/** `value` without `cr.createdAt` and `workingCopy`, whichever side answered it. */
function masked<T extends { cr: ChangesDoc }>(value: T): Omit<T, 'cr'> & { cr: Answer } {
	const cr: Answer = { ...value.cr };
	delete cr['createdAt'];
	const out: Answer = { ...value, cr };
	delete out['workingCopy'];
	return out as never;
}

/**
 * `POST /model/compare` and `POST /model/apply-cr` as the server answers
 * them: the engine's own answer to the same request, asked directly at
 * `SERVER_CLOCK` and handed through `edit`, a conflict as the 409 body, a
 * refusal as its status and detail; `answer`, when given, answers both
 * instead. `requests` lists the routes asked, in order.
 */
function serve(
	engine: IssuesEngine,
	options: { edit?: (answer: Answer) => void; answer?: () => Response } = {}
) {
	const requests: string[] = [];
	const direct = async (method: string, params: Answer): Promise<Answer | ApiError> => {
		try {
			const answer = await engine.over.link!.client.call<Answer>(method, {
				...params,
				created_at: SERVER_CLOCK
			});
			options.edit?.(answer);
			return answer;
		} catch (error) {
			if (error instanceof ApiError) return error;
			throw error;
		}
	};
	const respond = (answer: Answer | ApiError) => {
		if (answer instanceof ApiError) {
			return HttpResponse.json({ detail: answer.message }, { status: answer.status });
		}
		if ('conflict' in answer)
			return HttpResponse.json(answer['conflict'] as Answer, { status: 409 });
		return HttpResponse.json(answer);
	};
	const base = engine.project.baseUrl;
	server.use(
		http.post(`${base}/model/compare`, async ({ request }) => {
			requests.push('compare');
			if (options.answer !== undefined) return options.answer();
			return respond(await direct('compareModel', { file: await request.arrayBuffer() }));
		}),
		http.post(`${base}/model/apply-cr`, async ({ request }) => {
			requests.push('apply-cr');
			if (options.answer !== undefined) return options.answer();
			const { crs } = (await request.json()) as { crs: unknown };
			return respond(await direct('proposeCr', { crs }));
		})
	);
	return requests;
}

/** How many times the seam asked the engine `method`. */
const asked = (engine: IssuesEngine, method: string) =>
	engine.over.methods().filter((called) => called === method).length;

/** A replica with `compare` on `side`, and a shadow when given. */
const compareEngine = (side: Side, shadow?: EngineSeam['shadow']) =>
	issuesEngine(made, { surfaces: { compare: side }, ...(shadow === undefined ? {} : { shadow }) });

/** A shadow over the replica whose staged rule is `staged.now`; `done()` awaits the last probe. */
function recording(rev: () => number | null) {
	const lines: string[] = [];
	const staged = { now: false };
	let last: Promise<void> = Promise.resolve();
	const shadow: NonNullable<EngineSeam['shadow']> = (probe) => {
		last = Promise.resolve(
			createShadow({
				rev,
				quiet: () => Promise.resolve(),
				staged: () => staged.now,
				report: (line) => lines.push(line)
			})(probe)
		);
		return last;
	};
	return { lines, staged, shadow, done: () => last };
}

describe('the compare surface on the engine', () => {
	it("compareModel answers the engine's CompareOut, at the client's clock, and asks the server nothing", async () => {
		const engine = await compareEngine('engine');
		const requests = serve(engine);
		const file = modelFile(engine);

		const answer = await compareModel(file);

		expect(requests).toEqual([]);
		expect(asked(engine, 'compareModel')).toBe(1);
		expect(answer.workingCopy).toBe(true);
		expect(answer.cr.createdAt).toMatch(ISO_MILLISECONDS);
		expect(answer.cr.createdAt).not.toBe(SERVER_CLOCK);
		const direct = await engine.over.link!.client.call('compareModel', {
			file: await file.arrayBuffer(),
			created_at: SERVER_CLOCK
		});
		expect(masked(answer)).toEqual(masked(CompareOutSchema.parse(direct)));
		expect(answer).toMatchObject({
			model_rev: engine.project.rev,
			other_element_count: engine.project.model.elementCount
		});
		expect(answer.cr.ops.elements.modified).toMatchObject([
			{ id: 'e_000001', after: { properties: { name: 'from file' } } }
		]);
	});

	it("proposeCr answers the engine's proposal as ok, and a conflict as not ok, asking the server nothing", async () => {
		const engine = await compareEngine('engine');
		const requests = serve(engine);
		const { cr } = await compareModel(modelFile(engine));

		const proposal = await proposeCr([cr]);
		const conflict = await proposeCr([EMPTY_CR, CONFLICTING]);

		expect(requests).toEqual([]);
		expect(asked(engine, 'proposeCr')).toBe(2);
		expect(proposal).toMatchObject({
			ok: true,
			workingCopy: true,
			modelRev: engine.project.rev,
			ops: [{ kind: 'update_element', id: 'e_000001', properties_patch: { name: 'from file' } }]
		});
		expect(proposal.ok && proposal.cr.createdAt).toMatch(ISO_MILLISECONDS);
		expect(conflict).toEqual({
			ok: false,
			modelRev: engine.project.rev,
			crIndex: 1,
			workingCopy: true,
			conflicts: [
				{
					kind: 'id_exists',
					entity: 'element',
					id: 'e_000001',
					reason: "Element 'e_000001' already exists in the model"
				}
			]
		});
	});

	it('a UTF-16 file and a change request with a rev of "3" are the server\'s, unmarked', async () => {
		const engine = await compareEngine('engine');
		let served: Answer = SERVED_COMPARE;
		const requests = serve(engine, { answer: () => HttpResponse.json(served) });

		await expect(compareModel(utf16('{"elements": []}'))).resolves.toEqual({
			...SERVED_COMPARE,
			workingCopy: false
		});
		served = SERVED_PROPOSAL;
		await expect(proposeCr([LAX])).resolves.toEqual({
			ok: true,
			modelRev: 7,
			cr: SERVED_PROPOSAL.cr,
			ops: [],
			workingCopy: false
		});

		expect(requests).toEqual(['compare', 'apply-cr']);
		expect(asked(engine, 'compareModel')).toBe(1);
		expect(asked(engine, 'proposeCr')).toBe(1);
	});

	it("after a peer's commit the answer carries the new committed rev, and the earlier one stages nothing", async () => {
		const engine = await compareEngine('engine');
		serve(engine);
		const { cr } = await compareModel(modelFile(engine));
		const before = await proposeCr([cr]);
		const committed = engine.project.commit([
			{ kind: 'update_element', id: 'e_000002', properties_patch: { name: 'from a peer' } }
		]);
		engine.over.sync.feedCommit(committed.eventText, engine.project.rev);
		await engine.over.until((status) => status.rev === engine.project.rev);

		const after = await proposeCr([cr]);

		expect(before.modelRev).toBe(engine.project.rev - 1);
		expect(after.modelRev).toBe(engine.project.rev);
		expect(after.modelRev).toBe(engine.over.sync.status().rev);
		setModelRev(engine.project.rev);
		expect(before.ok).toBe(true);
		if (!before.ok) return;
		await expect(stageProposedOps(before.ops, before.modelRev)).resolves.toEqual({
			ok: false,
			reason: 'stale'
		});
	});

	it('an engine that is gone is answered by the server', async () => {
		const engine = await compareEngine('engine');
		const requests = serve(engine, { answer: () => HttpResponse.json(SERVED_COMPARE) });
		engine.over.link!.dispose();

		await expect(compareModel(modelFile(engine))).resolves.toEqual({
			...SERVED_COMPARE,
			workingCopy: false
		});

		expect(requests).toEqual(['compare']);
		await engine.over.sync.settled();
	});
});

describe('the compare surface on the server', () => {
	it('only the server is asked', async () => {
		const engine = await compareEngine('server');
		const requests = serve(engine);

		const { cr } = await compareModel(modelFile(engine));
		const proposal = await proposeCr([cr]);
		const conflict = await proposeCr([CONFLICTING]);

		expect(requests).toEqual(['compare', 'apply-cr', 'apply-cr']);
		expect(asked(engine, 'compareModel')).toBe(0);
		expect(asked(engine, 'proposeCr')).toBe(0);
		expect(cr.createdAt).toBe(SERVER_CLOCK);
		expect(proposal).toMatchObject({ ok: true, modelRev: engine.project.rev });
		expect(conflict).toMatchObject({ ok: false, crIndex: 0 });
	});
});

describe('the compare shadow', () => {
	it('with nothing staged and equal bodies nothing is reported, whatever the two clocks said', async () => {
		const { lines, shadow, done } = recording(() => engine.over.sync.status().rev);
		const engine = await compareEngine('engine', shadow);
		const requests = serve(engine);

		const { cr } = await compareModel(modelFile(engine));
		await done();
		await proposeCr([cr]);
		await done();
		await proposeCr([CONFLICTING]);
		await done();

		expect(requests).toEqual(['compare', 'apply-cr', 'apply-cr']);
		expect(lines).toEqual([]);
	});

	it('a one-field difference in the ops of a compare reports one line, the engine asked again with the file', async () => {
		const { lines, shadow, done } = recording(() => engine.over.sync.status().rev);
		const engine = await compareEngine('engine', shadow);
		serve(engine, {
			edit: (answer) => {
				const modified = (answer['cr'] as ChangesDoc).ops.elements.modified;
				modified[0]!.after.properties['name'] = 'from the server';
			}
		});

		await compareModel(modelFile(engine));
		await done();

		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^\[shadow\] compare compareModel /);
		expect(lines[0]).toContain('engine {"model_rev":');
		expect(asked(engine, 'compareModel')).toBe(2);
	});

	it('a conflict list differing in one reason reports one line on proposeCr', async () => {
		const { lines, shadow, done } = recording(() => engine.over.sync.status().rev);
		const engine = await compareEngine('engine', shadow);
		serve(engine, {
			edit: (answer) => {
				const conflict = answer['conflict'] as { conflicts: { reason: string }[] } | undefined;
				if (conflict !== undefined) conflict.conflicts[0]!.reason = 'the server says otherwise';
			}
		});

		await proposeCr([CONFLICTING]);
		await done();

		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^\[shadow\] compare proposeCr /);
	});

	it('with an edit staged, no comparison runs', async () => {
		const { lines, staged, shadow, done } = recording(() => engine.over.sync.status().rev);
		const engine = await compareEngine('engine', shadow);
		const requests = serve(engine, {
			edit: (answer) => {
				answer['model_rev'] = -1;
			}
		});
		await engine.stage([rename('e_000002', 'staged')]);
		staged.now = true;

		const { cr } = await compareModel(modelFile(engine));
		await done();
		await proposeCr([cr]);
		await done();

		expect(requests).toEqual([]);
		expect(lines).toEqual([]);
		expect(cr.ops.elements.modified.map((entry) => entry.id)).toEqual(['e_000001', 'e_000002']);
	});
});
