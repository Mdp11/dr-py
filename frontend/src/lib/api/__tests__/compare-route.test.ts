import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { modelLines } from '$engine';
import type { ChangeRequest } from '$lib/state/cr';
import { resetModelStore, setModelRev } from '$lib/state/model.svelte';
import { stageProposedOps } from '$lib/state/stage-proposed';
import { compareModel, proposeCr } from '../changeRequest';
import { EngineUnavailableError } from '../engine-route';
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

/** A clock the client never reads, so an answer that carries it came from the engine's own request. */
const OTHER_CLOCK = '2001-02-03T04:05:06.789Z';
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

/** `text` as UTF-16LE behind its byte order mark: an encoding the engine refuses. */
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

/** A change request whose `rev` is a string, which the engine's strict reader refuses. */
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

/** `value` without `cr.createdAt` and `workingCopy`: the clocks of two requests differ. */
function masked<T extends { cr: ChangesDoc }>(value: T): Omit<T, 'cr'> & { cr: Answer } {
	const cr: Answer = { ...value.cr };
	delete cr['createdAt'];
	const out: Answer = { ...value, cr };
	delete out['workingCopy'];
	return out as never;
}

/** How many times the seam asked the engine `method`. */
const asked = (engine: IssuesEngine, method: string) =>
	engine.over.methods().filter((called) => called === method).length;

describe('the compare reads on the engine', () => {
	it("compareModel answers the engine's CompareOut, at the client's clock", async () => {
		const engine = await issuesEngine(made);
		const file = modelFile(engine);

		const answer = await compareModel(file);

		expect(asked(engine, 'compareModel')).toBe(1);
		expect(answer.workingCopy).toBe(true);
		expect(answer.cr.createdAt).toMatch(ISO_MILLISECONDS);
		expect(answer.cr.createdAt).not.toBe(OTHER_CLOCK);
		const direct = await engine.over.link!.client.call('compareModel', {
			file: await file.arrayBuffer(),
			created_at: OTHER_CLOCK
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

	it("compareModel transfers the file's buffer to the engine", async () => {
		const engine = await issuesEngine(made);

		await compareModel(modelFile(engine));

		const call = engine.over.calls.find((entry) => entry.method === 'compareModel')!;
		expect((call.params as { file: ArrayBuffer }).file.byteLength).toBe(0);
	});

	it("proposeCr answers the engine's proposal as ok, and a conflict as not ok", async () => {
		const engine = await issuesEngine(made);
		const { cr } = await compareModel(modelFile(engine));

		const proposal = await proposeCr([cr]);
		const conflict = await proposeCr([EMPTY_CR, CONFLICTING]);

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

	it('a UTF-16 file is a 422 from the engine, and so is a change request with a rev of "3"', async () => {
		const engine = await issuesEngine(made);

		const file = compareModel(utf16('{"elements": []}'));
		await expect(file).rejects.toMatchObject({ status: 422 });
		await expect(file).rejects.toThrow('not a UTF-8 JSON model file');

		const request = proposeCr([LAX]);
		await expect(request).rejects.toMatchObject({ status: 422 });
		await expect(request).rejects.toThrow('"rev" must be an integer');
		expect(asked(engine, 'compareModel')).toBe(1);
		expect(asked(engine, 'proposeCr')).toBe(1);
	});

	it("after a peer's commit the answer carries the new committed rev, and the earlier one stages nothing", async () => {
		const engine = await issuesEngine(made);
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
		await expect(stageProposedOps(before.ops, { rev: before.modelRev })).resolves.toEqual({
			ok: false,
			reason: 'stale'
		});
	});

	it('a staged edit is in the compare, and a call after the engine is gone is unavailable', async () => {
		const engine = await issuesEngine(made);
		await engine.stage([rename('e_000002', 'staged')]);

		const { cr } = await compareModel(modelFile(engine));
		expect(cr.ops.elements.modified.map((entry) => entry.id)).toEqual(['e_000001', 'e_000002']);

		engine.over.link!.dispose();
		await expect(compareModel(modelFile(engine))).rejects.toBeInstanceOf(EngineUnavailableError);
		await engine.over.sync.settled();
	});
});
