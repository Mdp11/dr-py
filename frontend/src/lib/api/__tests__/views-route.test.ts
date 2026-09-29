import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { createShadow } from '$lib/engine/shadow';
import { getStagedViewDepth, resetViewEdits, stageViewOp } from '$lib/state/view-edits.svelte';
import type { EngineSeam } from '../engine-route';
import type { Issue, View } from '../types';
import { viewWarnings } from '../views';
import { issuesEngine, uninstallIssuesEngine, type IssuesEngine } from './issues-engine';
import { server } from './server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const made: { dispose(): void }[] = [];

afterEach(() => {
	uninstallIssuesEngine();
	resetViewEdits();
	for (const over of made.splice(0)) over.dispose();
	server.resetHandlers();
});

/** `e_000006` is a Team its Organization owns: placed in a folder, it is warned about. */
const VIEW: View = {
	name: 'Smart',
	folders: [
		{ id: 'f1', name: 'Teams', folders: [], elements: ['e_000001', 'e_000006'], artifacts: [] }
	],
	artifacts: []
};

const CONTAINED: Issue = {
	severity: 'warning',
	message:
		"view 'Smart': element 'e_000006' has a containment parent and cannot be placed in folder 'Teams'; placement ignored",
	target_ids: ['e_000006'],
	check: 'view',
	origin: 'on_server'
};

const SENTINEL: Issue = {
	severity: 'warning',
	message: 'the server said so',
	target_ids: [],
	check: 'view',
	origin: 'on_server'
};

/** `GET /views/v1` answers `VIEW` with `warnings()`; `gets` counts its requests. */
function serveView(engine: IssuesEngine, warnings: () => Issue[]) {
	const gets: string[] = [];
	server.use(
		http.get(`${engine.project.baseUrl}/views/:id`, ({ params }) => {
			gets.push(String(params['id']));
			return HttpResponse.json({ view: VIEW, warnings: warnings(), view_rev: 3 });
		})
	);
	return gets;
}

/** A shadow over the replica whose staged rule is the staged view ops; `done()` awaits the last probe. */
function recording(rev: () => number | null) {
	const lines: string[] = [];
	let last: Promise<void> = Promise.resolve();
	const shadow: NonNullable<EngineSeam['shadow']> = (probe) => {
		last = Promise.resolve(
			createShadow({
				rev,
				quiet: () => Promise.resolve(),
				staged: () => getStagedViewDepth() > 0,
				report: (line) => lines.push(line)
			})(probe)
		);
		return last;
	};
	return { lines, shadow, done: () => last };
}

describe('the views surface', () => {
	it("on the engine answers the engine's issues and asks the server nothing", async () => {
		const engine = await issuesEngine(made, { surfaces: { views: 'engine' } });
		const gets = serveView(engine, () => [SENTINEL]);

		await expect(viewWarnings('v1', VIEW)).resolves.toEqual([CONTAINED]);
		expect(gets).toEqual([]);
	});

	it('on the server answers the warnings of GET /views/{id}', async () => {
		const engine = await issuesEngine(made, { surfaces: { views: 'server' } });
		const gets = serveView(engine, () => [SENTINEL]);

		await expect(viewWarnings('v1', VIEW)).resolves.toEqual([SENTINEL]);
		expect(gets).toEqual(['v1']);
	});

	it('the shadow reports a one-message difference while nothing is staged, and nothing once the sides agree', async () => {
		const { lines, shadow, done } = recording(() => engine.over.sync.status().rev);
		const engine = await issuesEngine(made, { surfaces: { views: 'engine' }, shadow });
		let served: Issue[] = [CONTAINED];
		serveView(engine, () => served);

		await viewWarnings('v1', VIEW);
		await done();
		expect(lines).toEqual([]);

		served = [{ ...CONTAINED, message: `${CONTAINED.message}!` }];
		await viewWarnings('v1', VIEW);
		await done();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^\[shadow\] views validateView \{"view":\{"name":"Smart",/);
	});

	it('with a view op staged, no comparison runs', async () => {
		const { lines, shadow, done } = recording(() => engine.over.sync.status().rev);
		const engine = await issuesEngine(made, { surfaces: { views: 'engine' }, shadow });
		const gets = serveView(engine, () => [SENTINEL]);
		stageViewOp(
			{ kind: 'place_element', view_id: 'v1', element_id: 'e_000002', folder_id: 'f1' },
			'Placed e_000002'
		);

		await expect(viewWarnings('v1', VIEW)).resolves.toEqual([CONTAINED]);
		await done();

		expect(gets).toEqual([]);
		expect(lines).toEqual([]);
	});

	it('while the caller says its document is stale, no comparison runs', async () => {
		const { lines, shadow, done } = recording(() => engine.over.sync.status().rev);
		const engine = await issuesEngine(made, { surfaces: { views: 'engine' }, shadow });
		const gets = serveView(engine, () => [SENTINEL]);

		await expect(viewWarnings('v1', VIEW, undefined, () => true)).resolves.toEqual([CONTAINED]);
		await done();

		expect(gets).toEqual([]);
		expect(lines).toEqual([]);
	});
});
