import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetViewEdits } from '$lib/state/view-edits.svelte';
import type { Issue, View } from '../types';
import { viewWarnings } from '../views';
import { issuesEngine, uninstallIssuesEngine } from './issues-engine';
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

describe('the view warnings on the engine', () => {
	it("answer the engine's issues over the document as staged", async () => {
		const engine = await issuesEngine(made);

		await expect(viewWarnings(VIEW)).resolves.toEqual([CONTAINED]);

		expect(engine.over.methods()).toContain('validateView');
		expect(engine.requests).toEqual([]);
	});

	it('hold a document held in a proxy as the plain JSON the engine is sent', async () => {
		const engine = await issuesEngine(made);

		await expect(viewWarnings(new Proxy(VIEW, {}))).resolves.toEqual([CONTAINED]);

		const call = engine.over.calls.find((entry) => entry.method === 'validateView')!;
		expect(call.params).toEqual({ view: VIEW });
	});

	it('wait for the gate', async () => {
		let open!: () => void;
		const gate = new Promise<void>((resolve) => (open = resolve));
		const engine = await issuesEngine(made, { whenReady: () => gate });

		const pending = viewWarnings(VIEW);
		for (let turn = 0; turn < 20; turn++) await Promise.resolve();
		expect(engine.over.methods()).not.toContain('validateView');

		open();
		await expect(pending).resolves.toEqual([CONTAINED]);
	});
});
